"""Opt-in, secret-redacted trace of MCP JSON-RPC requests reaching this process.

This traces parsed SDK transport messages, not the byte-exact upstream wire:
mcp-hub or the MCP SDK may already have removed upstream metadata.
No interception or modification of mcp-hub is required.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from anyio import EndOfStream
from mcp.server.stdio import stdio_server

DEFAULT_LOG = Path(__file__).resolve().parents[1] / "data" / "mcp-debug.jsonl"
_ENABLED = {"1", "true", "yes", "on"}
_SECRET_KEY = re.compile(
    r"(?:^|[/_.-])(token|password|secret|authorization|cookie|api[_-]?key)"
    r"(?:$|[/_.-])",
    re.IGNORECASE,
)


def debug_enabled() -> bool:
    return os.environ.get("AGENT_NETWORK_DEBUG", "").strip().lower() in _ENABLED


def is_secret_field(key: Any) -> bool:
    """Shared secret-field predicate for debug logs and persisted tool inputs."""
    return isinstance(key, str) and bool(
        _SECRET_KEY.search(key) or key.lower().endswith(("token", "secret"))
    )


def redact(data: Any) -> Any:
    """Retain arbitrary request metadata while removing credential field values."""
    if isinstance(data, dict):
        return {
            key: "[REDACTED]" if is_secret_field(key) else redact(value)
            for key, value in data.items()
        }
    if isinstance(data, (list, tuple)):
        return [redact(value) for value in data]
    return data


class McpDebugLog:
    """Append-only local JSONL log, closed with the MCP transport."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags, 0o600)
        os.fchmod(fd, 0o600)
        self._file = os.fdopen(fd, "a", encoding="utf-8", buffering=1)
        self._failed = False

    def record(self, item: Any) -> None:
        try:
            if isinstance(item, Exception):
                payload = {"parse_error": type(item).__name__}
            else:
                payload = item.message.model_dump(mode="json", by_alias=True, exclude_unset=True)
            entry = {"ts": time.time(), "direction": "incoming", "jsonrpc": redact(payload)}
            self._file.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except (OSError, TypeError, ValueError) as exc:
            if not self._failed:
                self._failed = True
                print("agent-network: MCP debug logging failed: " + type(exc).__name__,
                      file=sys.stderr)

    def close(self) -> None:
        self._file.close()


class LoggedReceiveStream:
    """Observe SDK-parsed incoming messages without consuming or changing them."""

    def __init__(self, source: Any, logger: McpDebugLog):
        self._source = source
        self._logger = logger

    async def receive(self) -> Any:
        item = await self._source.receive()
        self._logger.record(item)
        return item

    async def aclose(self) -> None:
        await self._source.aclose()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.receive()
        except EndOfStream:
            raise StopAsyncIteration from None


async def run_logged_stdio(mcp: Any, path: Path) -> None:
    """Use the SDK stdio transport and tap parsed incoming messages only."""
    logger = McpDebugLog(path)
    try:
        async with stdio_server() as (reader, writer):
            await mcp._lowlevel_server.run(
                LoggedReceiveStream(reader, logger),
                writer,
                mcp._lowlevel_server.create_initialization_options(),
            )
    finally:
        logger.close()
