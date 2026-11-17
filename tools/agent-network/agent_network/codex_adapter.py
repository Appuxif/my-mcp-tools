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
from pathlib import Path

import websockets


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
              thread: str, codex: str, resume: bool):
    delay = 1
    while True:
        try:
            async with websockets.connect(
                server, origin=None, ping_interval=20, max_size=65536
            ) as socket:
                await socket.send(json.dumps({
                    "type": "register", "agent_id": agent_id,
                    "token": token, "kind": "codex", "state": "idle",
                }))
                first = json.loads(await socket.recv())
                if first.get("type") != "registered":
                    raise RuntimeError(f"Registration rejected: {first.get('error', first)}")
                print(f"Codex wake sidecar connected for agent {agent_id}", flush=True)
                delay = 1
                while True:
                    msg = json.loads(await socket.recv())
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
    if not a.server.startswith(("ws://127.0.0.1:", "ws://localhost:", "ws://[::1]:")):
        p.error("MVP wake sidecar accepts only a loopback WebSocket endpoint")
    try:
        asyncio.run(run(a.server, a.agent_id, token, a.thread, a.codex,
                        not a.no_resume))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
