"""Run native MCP stdio and the optional dashboard/wake HTTP listener in ONE process.

Spawned and supervised by mcp-hub via stdio. There is no service/daemon.
When the hub closes stdin (or sends termination), the HTTP listener stops too.
All MCP protocol output stays on stdout; HTTP logs go to stderr.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
from pathlib import Path

import uvicorn

from .server import Config, create_app


async def serve(*, host: str, port: int, database: str, inactive_seconds: float):
    app = create_app(Config(database=database, inactive_seconds=inactive_seconds))
    server = uvicorn.Server(uvicorn.Config(
        app, host=host, port=port, log_level="warning", access_log=False,
        lifespan="on",
    ))
    http_task = asyncio.create_task(server.serve(), name="agent-network-http")
    stdio_task = None
    try:
        # Do not announce an MCP server before HTTP bootstrap has succeeded.
        for _ in range(100):
            if http_task.done():
                await http_task
                raise RuntimeError("Dashboard/wake HTTP listener failed to start")
            if server.started:
                break
            await asyncio.sleep(0.05)
        else:
            raise RuntimeError("Dashboard HTTP listener startup timeout")
        # Diagnostic logging sees only requests arriving at Agent Network
        # (after mcp-hub forwarding and SDK JSON-RPC validation).
        from .mcp_debug import DEFAULT_LOG, debug_enabled, run_logged_stdio

        debug_path = Path(os.environ.get(
            "AGENT_NETWORK_DEBUG_LOG", str(DEFAULT_LOG)
        ))
        mcp_stdio = (
            run_logged_stdio(app.state.mcp, debug_path)
            if debug_enabled() else app.state.mcp.run_stdio_async()
        )
        stdio_task = asyncio.create_task(
            mcp_stdio, name="agent-network-mcp-stdio"
        )
        done, _ = await asyncio.wait(
            [stdio_task, http_task], return_when=asyncio.FIRST_COMPLETED
        )
        # Unexpected HTTP exit means the sidecar is unavailable; stop stdio too.
        for finished in done:
            exc = finished.exception() if not finished.cancelled() else None
            if exc:
                raise exc
    finally:
        server.should_exit = True
        if stdio_task and not stdio_task.done():
            stdio_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stdio_task
        if not http_task.done():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(http_task, 5.0)
        if not http_task.done():
            http_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await http_task


def main():
    parser = argparse.ArgumentParser(description="MCP stdio + dashboard/wake HTTP in the same process")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default=str(Path(__file__).resolve().parents[1] / "data" / "agent-network.db"))
    parser.add_argument("--inactive-seconds", type=float, default=60.0)
    opts = parser.parse_args()
    if opts.host not in ("127.0.0.1", "::1", "localhost"):
        parser.error("Only loopback is allowed. Use a protected reverse proxy for remote adapters.")
    logging.basicConfig(level=logging.WARNING, stream=__import__("sys").stderr)
    asyncio.run(serve(
        host=opts.host, port=opts.port, database=opts.db,
        inactive_seconds=opts.inactive_seconds,
    ))


if __name__ == "__main__":
    main()
