"""One native MCP server, one durable inbox, optional sidecar wake channels.

The WebSocket adapter protocol is intentionally independent from MCP:
agents call MCP directly; adapters only report UI state and receive wake hints.
"""
from __future__ import annotations

import asyncio
import contextlib
import functools
import os
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.mcpserver import MCPServer
from pydantic import BaseModel

from .store import Store, opaque_id


@dataclass
class Config:
    database: str = "data/agent-network.db"
    inactive_seconds: float = 60.0
    wake_cooldown_seconds: float = 90.0
    wake_scan_seconds: float = 2.0
    maintenance_seconds: float = 300.0


class AgentCreate(BaseModel):
    name: str
    role: str
    kind: str = "chatgpt"
    purpose: str = ""
    description: str = ""
    agent_id: str = ""
    token: str = ""


class AgentProfile(BaseModel):
    agent_id: str
    token: str
    role: str
    purpose: str = ""
    description: str = ""


class DashboardEnable(BaseModel):
    name: str
    agent_id: str = ""
    token: str = ""


class DashboardSend(BaseModel):
    to: str
    text: str
    client_message_id: str = ""


class DashboardAck(BaseModel):
    message_id: str


class Broker:
    def __init__(self, store: Store, config: Config):
        self.store = store
        self.config = config
        self.connections: dict[str, tuple[str, str, WebSocket]] = {}
        self.worker: asyncio.Task | None = None
        self.last_maintenance = 0.0

    async def start(self):
        self.store.disconnect_all_channels()
        self.run_maintenance()
        self.worker = asyncio.create_task(self.loop(), name="agent-network-wake")

    def run_maintenance(self):
        self.store.prune_messages()
        self.store.prune_channels()
        self.store.prune_agents(
            exclude_ids={owner for owner, _, _ in self.connections.values()}
        )
        self.last_maintenance = time.monotonic()

    async def disconnect_agent(self, agent_id: str) -> None:
        """Invalidate an agent's active wake adapters after identity deletion."""
        for channel_id, (owner, _, ws) in list(self.connections.items()):
            if owner == agent_id:
                self.connections.pop(channel_id, None)
                try:
                    await ws.close(code=1008, reason="Agent was deleted")
                except Exception:
                    pass

    async def stop(self):
        if self.worker is not None:
            self.worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.worker
        for channel_id in list(self.connections):
            self.store.disconnect_channel(channel_id)
        self.connections.clear()

    async def loop(self):
        while True:
            await asyncio.sleep(self.config.wake_scan_seconds)
            try:
                if time.monotonic() - self.last_maintenance >= self.config.maintenance_seconds:
                    self.run_maintenance()
                await self.dispatch_pending()
            except Exception:
                # A transient channel failure must not kill the entire dispatcher.
                import logging
                logging.getLogger(__name__).exception("Wake dispatcher failed")

    async def dispatch_pending(self):
        for agent in self.store.candidates(
            self.config.inactive_seconds, self.config.wake_cooldown_seconds
        ):
            agent_id = agent["agent_id"]
            # Channels are ephemeral: they cannot be inferred from a stored identifier.
            channels = [
                (channel_id, kind, ws)
                for channel_id, (owner, kind, ws) in self.connections.items()
                if owner == agent_id
            ]
            for channel_id, kind, ws in channels:
                row = self.store.db.execute(
                    "SELECT state FROM channels WHERE channel_id=?", (channel_id,)
                ).fetchone()
                if row is None or row["state"] != "idle":
                    continue
                # Commit intent *before* emitting a signal, so a lost WS ACK will
                # not trigger immediate duplicate user-visible chat messages.
                self.store.mark_wake(agent_id)
                try:
                    await ws.send_json({
                        "type": "wake",
                        "wake_id": opaque_id(),
                        "agent_id": agent_id,
                        "pending_count": agent["pending_count"],
                    })
                except Exception:
                    self.store.wake_result(agent_id, "socket_failed")
                    self.store.disconnect_channel(channel_id)
                    self.connections.pop(channel_id, None)
                break

    async def socket(self, ws: WebSocket):
        origin = ws.headers.get("origin")
        # Browser pages are not allowed to connect to localhost WebSockets.
        # Extensions use chrome-extension://<id>. Python CLI usually sends no Origin.
        if origin and not origin.startswith("chrome-extension://"):
            await ws.close(code=1008, reason="Origin not allowed")
            return
        await ws.accept()
        channel_id = None
        agent_id = None
        try:
            hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
            if hello.get("type") != "register":
                await ws.close(code=1008, reason="Expected registration")
                return
            agent_id = str(hello.get("agent_id", ""))
            token = str(hello.get("token", ""))
            kind = str(hello.get("kind", ""))
            state = str(hello.get("state", "unknown"))
            channel_id = opaque_id()
            self.store.connect_channel(agent_id, token, kind, channel_id, state)
            self.connections[channel_id] = (agent_id, kind, ws)
            await ws.send_json({"type": "registered", "channel_id": channel_id})
            while True:
                msg = await ws.receive_json()
                event = msg.get("type")
                if event == "ping":
                    self.store.update_channel(channel_id, msg.get("state", "unknown"))
                    await ws.send_json({"type": "pong"})
                elif event == "wake_result":
                    result = str(msg.get("status", "unknown"))[:120]
                    self.store.channel_result(channel_id, result)
                    self.store.wake_result(agent_id, result)
                else:
                    await ws.send_json({"type": "error", "error": "Unsupported adapter event"})
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except (PermissionError, ValueError) as exc:
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "error", "error": str(exc)})
                await ws.close(code=1008)
        except Exception:
            with contextlib.suppress(Exception):
                await ws.close(code=1011)
        finally:
            if channel_id:
                self.store.disconnect_channel(channel_id)
                self.connections.pop(channel_id, None)


def create_app(config: Config | None = None) -> FastAPI:
    config = config or Config(
        database=os.getenv("AGENT_NETWORK_DB", "data/agent-network.db"),
        inactive_seconds=float(os.getenv("AGENT_NETWORK_INACTIVE_SECONDS", "60")),
    )
    store = Store(config.database)
    broker = Broker(store, config)
    started_at = time.time()

    mcp = MCPServer(
        "agent-network",
        instructions=(
            "Messages are delivered over native MCP. Register a stable agent identity "
            "once, retain its per-agent token, and use that identity in further calls. "
            "Use get_messages to read pending messages and ack_message only after "
            "you have received them. Do not continuously poll while idle; optional "
            "local wake adapters can signal inactive clients."
        ),
    )

    def audit(fn):
        """Time MCP tools without storing input arguments, tokens or message bodies."""
        @functools.wraps(fn)
        def logged(*args, **kwargs):
            started = time.perf_counter()
            status = "ok"
            try:
                return fn(*args, **kwargs)
            except Exception:
                status = "error"
                raise
            finally:
                store.record_tool_call(
                    fn.__name__, status,
                    (time.perf_counter() - started) * 1000,
                    agent_id=str(kwargs.get("agent_id") or "")
                )
        return logged

    @mcp.tool()
    @audit
    def register_agent(name: str, role: str, kind: str = "other", purpose: str = "",
                       description: str = "", agent_id: str = "", token: str = "") -> dict:
        """Register an agent. Returns a new per-agent token once; for reconnection
        supply the original agent_id and token. Keep token private."""
        return store.register(name, role, kind, purpose, description, agent_id, token)

    @mcp.tool()
    @audit
    def list_agents(agent_id: str, token: str) -> list[dict]:
        """List registered agents, descriptions, task state and presence."""
        store.touch_mcp(agent_id, token)
        return store.agents(present_ids={x[0] for x in broker.connections.values()})

    @mcp.tool()
    @audit
    def send_message(agent_id: str, token: str, to: str, text: str,
                     task_id: str = "", client_message_id: str = "") -> dict:
        """Durably send a direct message. Client message ID deduplicates retries."""
        return store.send(agent_id, token, to, text, task_id, client_message_id)

    @mcp.tool()
    @audit
    def get_messages(agent_id: str, token: str, limit: int = 30) -> list[dict]:
        """Read pending messages without consuming them; call ack_message after receipt."""
        return store.inbox(agent_id, token, limit)

    @mcp.tool()
    @audit
    def ack_message(agent_id: str, token: str, message_id: str) -> dict:
        """Acknowledge a specific inbox message after processing or saving it."""
        return store.acknowledge(agent_id, token, message_id)

    @mcp.tool()
    @audit
    def update_task(agent_id: str, token: str, task: str, status: str) -> dict:
        """Set current task and status: idle, working, blocked, done or failed."""
        return store.update_task(agent_id, token, task, status)

    @mcp.tool()
    @audit
    def heartbeat(agent_id: str, token: str) -> dict:
        """Mark MCP activity for the authenticated agent."""
        store.touch_mcp(agent_id, token)
        return {"ok": True}

    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
    )

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with mcp.session_manager.run():
            await broker.start()
            try:
                yield
            finally:
                await broker.stop()
                store.close()

    app = FastAPI(title="Agent Network", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.broker = broker
    app.state.mcp = mcp

    @app.get("/api/v1/health")
    def health() -> dict:
        return {"status": "ok", "agents": len(store.agents()),
                "channels_connected": len(broker.connections)}

    @app.get("/api/v1/dashboard")
    def dashboard_data() -> JSONResponse:
        snapshot = store.dashboard_snapshot(
            present_ids={x[0] for x in broker.connections.values()}
        )
        snapshot["server"] = {
            "status": "online", "started_at": started_at,
            "now": time.time(), "uptime_seconds": round(time.time() - started_at),
            "transport": "MCP stdio + HTTP wake/dashboard",
        }
        return JSONResponse(snapshot, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/tool-history")
    def dashboard_tool_history(page: int = Query(default=1, ge=1, le=10)) -> JSONResponse:
        return JSONResponse(store.tool_history(page=page),
                            headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/message-history")
    def dashboard_message_history(page: int = Query(default=1, ge=1)) -> JSONResponse:
        return JSONResponse(store.message_history(page=page),
                            headers={"Cache-Control": "no-store"})

    def require_dashboard_origin(req: Request):
        """Only same-origin dashboard documents may invoke browser-only write APIs."""
        origin = req.headers.get("origin")
        expected = f"{req.url.scheme}://{req.headers.get('host', '')}"
        fetch_site = req.headers.get("sec-fetch-site", "")
        if origin and origin != expected:
            raise HTTPException(403, "Cross-origin dashboard requests are forbidden")
        if fetch_site not in ("", "same-origin", "none"):
            raise HTTPException(403, "Dashboard requires same-origin access")

    def dashboard_credentials(req: Request) -> tuple[str, str]:
        require_dashboard_origin(req)
        agent_id = req.headers.get("x-agent-id", "")
        token = req.headers.get("x-agent-token", "")
        if not agent_id or not token:
            raise HTTPException(401, "Dashboard agent credentials required")
        try:
            store.dashboard_auth(agent_id, token)
        except (PermissionError, ValueError) as exc:
            raise HTTPException(403, str(exc)) from exc
        return agent_id, token

    @app.delete("/api/v1/dashboard/agents/{target_agent_id}")
    async def dashboard_delete_agent(target_agent_id: str, req: Request) -> dict:
        """Delete a named agent and its messages; dashboard operator only.

        A human must explicitly confirm deletion in the dashboard UI.
        Invalidates the agent's token and frees its name for new registrations.
        """
        operator_id, _ = dashboard_credentials(req)
        try:
            result = store.delete_agent(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        await broker.disconnect_agent(target_agent_id)
        result["deleted_self"] = target_agent_id == operator_id
        return result

    @app.post("/api/v1/dashboard-agent/enable")
    def dashboard_enable(body: DashboardEnable, req: Request) -> JSONResponse:
        require_dashboard_origin(req)
        try:
            result = store.enable_dashboard(body.name, body.agent_id, body.token)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/v1/dashboard-agent/disable")
    def dashboard_disable(req: Request) -> dict:
        agent_id, token = dashboard_credentials(req)
        return store.disable_dashboard(agent_id, token)

    @app.post("/api/v1/dashboard-agent/heartbeat")
    def dashboard_heartbeat(req: Request) -> dict:
        agent_id, token = dashboard_credentials(req)
        return {"ok": True, "agent": store.dashboard_auth(agent_id, token)}

    @app.get("/api/v1/dashboard-agent/inbox")
    def dashboard_inbox(req: Request) -> JSONResponse:
        agent_id, token = dashboard_credentials(req)
        return JSONResponse(
            {"items": store.inbox(agent_id, token, limit=100, source="dashboard")},
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/api/v1/dashboard-agent/send")
    def dashboard_send(body: DashboardSend, req: Request) -> dict:
        agent_id, token = dashboard_credentials(req)
        try:
            return store.send(
                agent_id, token, body.to, body.text,
                client_message_id=body.client_message_id, source="dashboard"
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/v1/dashboard-agent/ack")
    def dashboard_ack(body: DashboardAck, req: Request) -> dict:
        agent_id, token = dashboard_credentials(req)
        try:
            return store.acknowledge(
                agent_id, token, body.message_id, source="dashboard"
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc

    dashboard_dir = Path(__file__).resolve().parents[1] / "dashboard"
    app.mount("/dashboard-assets", StaticFiles(directory=str(dashboard_dir)), name="dashboard-assets")

    @app.get("/dashboard")
    @app.get("/dashboard/")
    def dashboard() -> FileResponse:
        return FileResponse(
            dashboard_dir / "index.html",
            media_type="text/html",
            headers={"Cache-Control": "no-store",
                     "Content-Security-Policy":
                     "default-src 'self'; script-src 'self'; style-src 'self';"
                     " img-src 'self' data:; connect-src 'self'; object-src 'none';"
                     " base-uri 'none'; frame-ancestors 'none'"},
        )

    @app.post("/api/v1/agents/register")
    def register_api(req: AgentCreate) -> dict:
        try:
            return store.register(**req.model_dump())
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/v1/agents/profile")
    def profile_api(req: AgentProfile) -> dict:
        try:
            return store.update_profile(**req.model_dump())
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/agents")
    def agents_api() -> list[dict]:
        # Metadata only; no inbox contents and no credentials.
        return store.agents(present_ids={x[0] for x in broker.connections.values()})

    @app.websocket("/api/v1/channels/ws")
    async def channels_ws(ws: WebSocket):
        await broker.socket(ws)

    # MCP lives in the same process, sharing the same registry and inbox,
    # but no agent message travels through a sidecar adapter.
    app.mount("/", mcp_app)
    return app


def main():
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Run native MCP Agent Network server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default="data/agent-network.db")
    parser.add_argument("--inactive-seconds", type=float, default=60.0)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        parser.error("MVP is loopback-only. Use a protected private tunnel for remote agents.")
    uvicorn.run(create_app(Config(database=args.db, inactive_seconds=args.inactive_seconds)),
                host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
