"""Optional wake-only sidecar for a locally installed Codex CLI session.

The agent connects to the native MCP server directly. This process ONLY listens
for wake hints, and invokes codex queue for the configured local thread.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

from websockets.asyncio.client import connect as WebSocketConnect

from .codex_state import detect_state
from pathlib import Path

import websockets


def validate_server_url(raw: str) -> str:
    """Validate the *parsed* WebSocket endpoint, never a string prefix."""
    try:
        uri = urlsplit(raw)
        if (uri.scheme != "ws" or uri.hostname not in
                ("localhost", "127.0.0.1", "::1") or
                uri.username is not None or uri.password is not None or
                uri.path != "/api/v1/channels/ws" or uri.query or uri.fragment or
                not uri.port):
            raise ValueError("Codex wake requires a loopback WebSocket endpoint")
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid local WebSocket URL") from exc
    return raw


class LocalOnlyConnect(WebSocketConnect):
    def process_redirect(self, exc):
        redirect = super().process_redirect(exc)
        # Even redirects to another loopback port can leak the bearer secret.
        if isinstance(redirect, str):
            return ValueError("Codex wake WebSocket redirects are forbidden")
        return redirect


def queue_wake(thread: str, agent_id: str, count: int,
               *, codex: str = "codex", resume: bool = True) -> tuple[str, str]:
    if not shutil.which(codex):
        return "error", "codex binary not found"
    text = (
        f"[Agent Network wake] Pending messages: {count}. "
        f"Resume your registered agent identity {agent_id} and call the native "
        "agent-network MCP get_messages tool. Acknowledge messages after reading. "
        "Do not infer message content from this wake signal."
    )
    cmd = [codex, "queue", "--thread", thread, "--message", text]
    if resume:
        cmd.append("--resume")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=50, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "error", str(exc)[:150]
    output = (result.stdout + "\n" + result.stderr).lower()
    if result.returncode != 0:
        return "error", f"codex exited {result.returncode}: {output[-180:]}"
    # A successful command may still have failed to wake the CLI process.
    if "warning" in output or "предупрежден" in output or "failed to resume" in output:
        return "queued_warning", output[-180:]
    return "queued", "Codex accepted the queue command; MCP processing not yet confirmed"


async def run(server: str, agent_id: str, token: str,
              thread: str, codex: str, resume: bool,
              state_file: Path | None = None, assume_idle: bool = False):
    delay = 1
    while True:
        try:
            state = await asyncio.to_thread(
                detect_state, thread, state_file=state_file, assume_idle=assume_idle
            )
            async with LocalOnlyConnect(
                server, origin=None, ping_interval=20, max_size=65536,
                proxy=None,
            ) as socket:
                await socket.send(json.dumps({
                    "type": "register", "agent_id": agent_id,
                    "token": token, "kind": "codex", "state": state,
                }))
                first = json.loads(await socket.recv())
                if first.get("type") != "registered":
                    raise RuntimeError(f"Registration rejected: {first.get('error', first)}")
                print(f"Codex wake sidecar connected for agent {agent_id}", flush=True)
                delay = 1
                while True:
                    try:
                        message = await asyncio.wait_for(socket.recv(), timeout=20)
                    except asyncio.TimeoutError:
                        state = await asyncio.to_thread(
                            detect_state, thread, state_file=state_file,
                            assume_idle=assume_idle
                        )
                        await socket.send(json.dumps({"type":"ping","state":state}))
                        continue
                    msg = json.loads(message)
                    if msg.get("type") == "wake":
                        status, detail = await asyncio.to_thread(
                            queue_wake, thread, agent_id, int(msg.get("pending_count", 0)),
                            codex=codex, resume=resume
                        )
                        await socket.send(json.dumps({
                            "type": "wake_result", "wake_id": msg.get("wake_id"),
                            "status": status
                        }))
                        print(f"Wake: {status}: {detail}", flush=True)
                    elif msg.get("type") == "error":
                        raise RuntimeError(msg.get("error", "Server rejected request"))
                    elif msg.get("type") == "pong":
                        continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"Channel disconnected: {exc}; retry in {delay}s", file=sys.stderr, flush=True)
            await asyncio.sleep(delay)
            delay = min(30, delay * 2)


def main():
    p = argparse.ArgumentParser(description="Codex CLI wake adapter (not an MCP proxy)")
    p.add_argument("--agent-id", required=True)
    p.add_argument("--thread", required=True, help="Codex UUID or exact session name")
    p.add_argument("--server", default="ws://127.0.0.1:8787/api/v1/channels/ws")
    p.add_argument("--token-file", help="File containing the per-agent secret (chmod 600)")
    p.add_argument("--codex", default="codex")
    p.add_argument("--no-resume", action="store_true")
    p.add_argument("--state-file",
                   help="File periodically written by the Codex launcher: idle/busy/unknown")
    p.add_argument("--assume-idle", action="store_true",
                   help="Unsafe compatibility mode if the thread cannot be inspected")
    a = p.parse_args()
    if a.token_file:
        path = Path(a.token_file)
        if path.stat().st_mode & 0o077:
            p.error("Token file must not be group/world readable (chmod 600)")
        token = path.read_text().strip()
    else:
        token = os.getenv("AGENT_NETWORK_TOKEN", "")
    if not token:
        p.error("Set AGENT_NETWORK_TOKEN or provide --token-file")
    try:
        validate_server_url(a.server)
    except ValueError as exc:
        p.error(str(exc))
    try:
        asyncio.run(run(a.server, a.agent_id, token, a.thread, a.codex,
                        not a.no_resume,
                        state_file=Path(a.state_file) if a.state_file else None,
                        assume_idle=a.assume_idle))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
