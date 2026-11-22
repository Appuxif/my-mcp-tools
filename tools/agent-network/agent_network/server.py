"""One native MCP server, one durable inbox, optional sidecar wake channels.

The WebSocket adapter protocol is intentionally independent from MCP:
agents call MCP directly; adapters only report UI state and receive wake hints.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import functools
import inspect
import os
import re
import secrets
import stat
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
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
    admin_token_file: str = ""  # default: alongside the private SQLite database


class AgentCreate(BaseModel):
    name: str
    role: str
    kind: str = "chatgpt"
    purpose: str = ""
    description: str = ""
    agent_id: str = ""
    token: str = ""


class AdminAgentCreate(BaseModel):
    name: str
    role: str
    kind: str = "other"
    purpose: str = ""
    description: str = ""
    instructions: str = ""
    teams: list[str]


class AgentInstructionsUpdate(BaseModel):
    instructions: str
    expected_revision: int


class AgentChatCredentialRequest(BaseModel):
    chat_url: str
    replace_existing: bool = False


class AgentChatTransferRequest(BaseModel):
    source_token_id: str = ""
    old_chat_url: str
    new_chat_url: str
    legacy_primary_token: str = ""
    admin_recovery: bool = False
    expected_source_token_id: str | None = None
    expected_source_chat_url: str | None = None


class ExtensionChatAgentCreate(BaseModel):
    name: str
    role: str
    purpose: str = ""
    description: str = ""
    chat_url: str


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


class TeamAssignment(BaseModel):
    teams: list[str]


def load_admin_token(database: str, configured_file: str = "") -> tuple[str, str]:
    """Persistent independent admin capability; never return it over HTTP."""
    path = Path(configured_file) if configured_file else (
        Path(database).resolve().parent / "admin-token"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        try:
            with os.fdopen(fd, "w") as file:
                file.write(secrets.token_urlsafe(40) + "\n")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077:
        raise RuntimeError(f"Admin token file must be a private regular file (chmod 600): {path}")
    token = path.read_text().strip()
    if len(token) < 40:
        raise RuntimeError("Agent Network admin token file is invalid")
    return token, str(path)


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
        self.store.prune_notes()
        self.store.prune_channels()
        self.store.prune_chat_tokens()
        # Agent identities and compact context are deleted only by the admin.
        self.store.maintain_storage()
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
                    await asyncio.to_thread(self.run_maintenance)
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
                    self.store.verify(agent_id, token)
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
    # Loopback listeners are vulnerable to DNS rebinding without Host checks.
    # Extra names support explicitly trusted private reverse proxies.
    extra_hosts = tuple(
        host.strip().lower()
        for host in os.getenv("AGENT_NETWORK_TRUSTED_HOSTS", "").split(",")
        if host.strip()
    )
    if any("*" in host or "/" in host for host in extra_hosts):
        raise ValueError("AGENT_NETWORK_TRUSTED_HOSTS must contain literal hostnames")
    store = Store(config.database)
    broker = Broker(store, config)
    admin_token, admin_token_path = load_admin_token(
        config.database, config.admin_token_file
    )
    logging.getLogger(__name__).info("Admin token file: %s", admin_token_path)
    started_at = time.time()

    mcp = MCPServer(
        "agent-network",
        instructions=(
            "Agents communicate only with peers sharing at least one team. "
            "Team membership and identity creation are read-only for agents. "
            "Only a human administrator can create an agent through Dashboard or "
            "an authorized Chrome extension. The administrator provides your "
            "existing agent_id and token; native MCP has no registration tool. "
            "Never create an alternate identity. list_agents is scoped to shared "
            "teams. Messages are delivered over native MCP. "
            "Use get_messages to read pending messages and ack_message only after "
            "you have received them. Notes are private drafts until explicitly "
            "finalized; finalization never delivers a message or wakes an agent. "
            "To share a finalized note, explicitly include note_id in the text of "
            "a separate send_message. Notes expire 48 hours after creation. "
            "On agent initialization, call read_instructions once to obtain "
            "administrator-managed persistent instructions, which are distinct "
            "from compact context and cannot be edited by the agent. "
            "Only on explicit user request, use save_context "
            "to store a compact summary. Use read_context on user request or after "
            "the user migrates this agent to a new chat; do not poll these tools. "
            "Agent identities and summaries persist until manual deletion. "
            "Do not continuously poll while idle; optional local wake adapters "
            "can signal inactive clients."
        ),
    )

    def audit(fn):
        """Record tool input with credential fields removed before SQLite storage."""
        signature = inspect.signature(fn)
        @functools.wraps(fn)
        def logged(*args, **kwargs):
            started = time.perf_counter()
            status = "ok"
            resolved_agent_id = ""
            try:
                result = fn(*args, **kwargs)
                # An invalid credential must never attribute a call to its
                # claimed agent_id; record only an authenticated identity.
                resolved_agent_id = str(signature.bind(*args, **kwargs).arguments.get("agent_id") or "")
                return result
            except Exception:
                status = "error"
                raise
            finally:
                # Bind positional or keyword inputs, omitting omitted defaults.
                try:
                    arguments = dict(signature.bind_partial(*args, **kwargs).arguments)
                except TypeError:
                    arguments = {"_invalid_arguments": True}
                store.record_tool_call(
                    fn.__name__, status,
                    (time.perf_counter() - started) * 1000,
                    agent_id=resolved_agent_id,
                    arguments=arguments,
                )
        return logged

    @mcp.tool()
    @audit
    def list_agents(agent_id: str, token: str) -> list[dict]:
        """List registered agents, descriptions, task state and presence."""
        store.touch_mcp(agent_id, token)
        return store.agents(
            present_ids={x[0] for x in broker.connections.values()},
            requester_id=agent_id,
        )

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
    def save_context(agent_id: str, token: str, context: str) -> dict:
        """Overwrite this agent's durable compact summary (max 128 KiB). Call ONLY
        after an explicit user request to /compact or save work; never automatically
        or on a timer. Not for secrets or routine message exchange."""
        return store.save_context(agent_id, token, context)

    @mcp.tool()
    @audit
    def read_context(agent_id: str, token: str) -> dict:
        """Read this agent's stored summary (or exists=false). Use ONLY on an
        explicit user request or user-initiated migration to a new chat; do not
        poll or reread for each task/wake. Context is private to this agent."""
        return store.read_context(agent_id, token)

    @mcp.tool()
    @audit
    def read_instructions(agent_id: str, token: str) -> dict:
        """Read your own administrator-managed persistent instructions/prompt.
        Call once at initialization or when explicitly reminded to reload them.
        Read-only for agents; instructions are independent of saved context."""
        return store.read_instructions(agent_id, token)

    @mcp.tool()
    @audit
    def create_note(agent_id: str, token: str, title: str,
                    description: str) -> dict:
        """Create a private draft note (48h TTL). Does not notify other agents."""
        return store.create_note(agent_id, token, title, description)

    @mcp.tool()
    @audit
    def add_to_note(agent_id: str, token: str, note_id: str,
                    title: str, description: str) -> dict:
        """Add a titled subnote to your own draft. Returns subnote_id."""
        return store.add_to_note(agent_id, token, note_id, title, description)

    @mcp.tool()
    @audit
    def update_subnote(agent_id: str, token: str, note_id: str, subnote_id: str,
                       title: str, description: str) -> dict:
        """Revise a subnote in your draft before finalizing."""
        return store.update_subnote(
            agent_id, token, note_id, subnote_id, title, description
        )

    @mcp.tool()
    @audit
    def remove_from_note(agent_id: str, token: str, note_id: str,
                         subnote_id: str) -> dict:
        """Remove a subnote from your draft; finalized notes are immutable."""
        return store.remove_from_note(agent_id, token, note_id, subnote_id)

    @mcp.tool()
    @audit
    def finalize_note(agent_id: str, token: str, note_id: str) -> dict:
        """Make note immutable/shareable; does NOT send or notify anyone.
        To deliver it, explicitly send_message with note_id in text."""
        return store.finalize_note(agent_id, token, note_id)

    @mcp.tool()
    @audit
    def read_note(agent_id: str, token: str, note_id: str) -> dict:
        """Read your draft or a finalized note of a shared-team agent by ID.
        Reading does not consume a note; notes expire 48h after creation."""
        return store.read_note(agent_id, token, note_id)

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
    app.state.admin_token_file = admin_token_path

    def is_admin_route(path: str, method: str) -> bool:
        return (
            path.rstrip("/") == "/dashboard"
            or path.startswith("/dashboard-assets/")
            or path.startswith("/api/v1/dashboard")
            or (path == "/api/v1/agents" and method == "GET")
            or path == "/api/v1/health"
            or path in ("/docs", "/redoc", "/openapi.json")
        )

    def admin_authenticated(req: Request) -> bool:
        """HTTP Basic: admin / password from the existing private admin-token file."""
        if (req.url.hostname or "").lower() not in ("localhost", "127.0.0.1", "::1"):
            return False
        if not req.client or req.client.host not in (
            "localhost", "127.0.0.1", "::1", "testclient"
        ):
            return False
        raw = req.headers.get("authorization", "")
        prefix, _, encoded = raw.partition(" ")
        if prefix.lower() != "basic" or not encoded or len(encoded) > 512:
            return False
        try:
            decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
            username, password = decoded.split(":", 1)
        except (ValueError, UnicodeError, binascii.Error):
            return False
        return (
            secrets.compare_digest(username, "admin")
            and secrets.compare_digest(password, admin_token)
        )

    @app.middleware("http")
    async def dashboard_basic_auth(req: Request, call_next):
        if is_admin_route(req.url.path, req.method):
            # Authentication precedes access to every dashboard resource and API.
            if not admin_authenticated(req):
                return Response(
                    status_code=401,
                    headers={
                        "WWW-Authenticate":
                            'Basic realm="Agent Network Dashboard", charset="UTF-8"',
                        "Cache-Control":"no-store",
                        "X-Content-Type-Options":"nosniff",
                    },
                )
            # CSRF protection for admin operations; origin isn't enough for auth.
            origin = req.headers.get("origin")
            expected = f"{req.url.scheme}://{req.headers.get('host', '')}"
            site = req.headers.get("sec-fetch-site", "")
            if (origin and origin != expected) or site not in (
                "", "same-origin", "none"
            ):
                return Response(status_code=403,
                                headers={"Cache-Control":"no-store"})
            response = await call_next(req)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response
        return await call_next(req)

    @app.get("/api/v1/agents/hud")
    def agent_hud(req: Request) -> JSONResponse:
        """Agent-scoped metadata for extension HUD; never Basic/admin access."""
        agent_id = req.headers.get("x-agent-id", "")
        token = req.headers.get("x-agent-token", "")
        try:
            snapshot = store.agent_hud_snapshot(
                agent_id, token,
                present_ids={x[0] for x in broker.connections.values()},
            )
        except (ValueError, PermissionError) as exc:
            raise HTTPException(403, "Invalid agent credentials") from exc
        return JSONResponse(snapshot, headers={"Cache-Control":"no-store"})

    def agent_view_credentials(req: Request) -> tuple[str, str]:
        agent_id = req.headers.get("x-agent-id", "")
        token = req.headers.get("x-agent-token", "")
        try:
            store.verify(agent_id, token)
        except (ValueError, PermissionError) as exc:
            raise HTTPException(403, "Invalid agent credentials") from exc
        return agent_id, token

    @app.get("/api/v1/agents/conversations")
    def agent_conversations(req: Request) -> JSONResponse:
        """Read-only peer list, scoped to this token's registered agent."""
        agent_id, token = agent_view_credentials(req)
        return JSONResponse(
            store.agent_conversations(agent_id, token),
            headers={"Cache-Control":"no-store"},
        )

    @app.get("/api/v1/agents/conversations/{peer_id}/messages")
    def agent_conversation_messages(
        peer_id: str, req: Request,
        before: str = Query(default="", max_length=64),
        limit: int = Query(default=30, ge=1, le=50),
    ) -> JSONResponse:
        """Only messages between token owner and peer; never arbitrary agent pairs."""
        agent_id, token = agent_view_credentials(req)
        try:
            data = store.agent_conversation_messages(
                agent_id, token, peer_id, before=before, limit=limit
            )
        except ValueError as exc:
            if str(exc) == "Conversation not found":
                raise HTTPException(404, "Conversation not found") from exc
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse(data, headers={"Cache-Control":"no-store"})

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

    @app.get("/api/v1/dashboard/tool-history/{call_id}")
    def dashboard_tool_call_detail(call_id: int, req: Request) -> JSONResponse:
        """Basic-protected read-only MCP call arguments (credentials redacted)."""
        require_dashboard_admin(req)
        try:
            data = store.tool_call_detail(call_id)
        except ValueError as exc:
            raise HTTPException(404, "Tool call not found") from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

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

    def require_dashboard_admin(req: Request) -> None:
        """All dashboard paths are already protected by HTTP Basic middleware."""
        require_dashboard_origin(req)
        if not admin_authenticated(req):
            raise HTTPException(
                401, "Administrator authentication required",
                headers={"WWW-Authenticate":'Basic realm="Agent Network Dashboard"'},
            )

    @app.get("/api/v1/dashboard/teams")
    def dashboard_teams(req: Request) -> JSONResponse:
        require_dashboard_admin(req)
        return JSONResponse({"items": store.team_list()},
                            headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/dashboard/agents")
    def dashboard_create_agent(body: AdminAgentCreate, req: Request) -> JSONResponse:
        """Explicit administrator provision; one-time credential response."""
        require_dashboard_admin(req)
        if body.kind not in ("chatgpt", "codex", "claude", "other"):
            raise HTTPException(400, "Invalid agent kind")
        try:
            result = store.register(body.name, body.role, body.kind,
                                    body.purpose, body.description, teams=body.teams,
                                    instructions=body.instructions)
        except ValueError as exc:
            status = 409 if ("already registered" in str(exc) or
                             "Team assignment is not allowed on reconnect" in str(exc)) else 400
            raise HTTPException(status, str(exc)) from exc
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/agents/{target_agent_id}/instructions")
    def dashboard_read_instructions(target_agent_id: str, req: Request) -> JSONResponse:
        """Only the authenticated Dashboard can inspect the full prompt."""
        require_dashboard_admin(req)
        try:
            data = store.admin_read_instructions(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, "Agent not found") from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.put("/api/v1/dashboard/agents/{target_agent_id}/instructions")
    def dashboard_edit_instructions(target_agent_id: str, body: AgentInstructionsUpdate,
                                    req: Request) -> JSONResponse:
        """Only a human admin may modify persistent agent instructions."""
        require_dashboard_admin(req)
        try:
            data = store.admin_update_instructions(
                target_agent_id, body.instructions, body.expected_revision
            )
        except ValueError as exc:
            status = (404 if str(exc) == "Unknown agent_id" else
                      409 if str(exc) == "Instructions revision conflict" else 400)
            raise HTTPException(status, str(exc)) from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/dashboard/agents/{target_agent_id}/credentials/rotate")
    async def dashboard_rotate_credentials(target_agent_id: str, req: Request) -> JSONResponse:
        """Explicit admin token rotation; old tokens become invalid."""
        require_dashboard_admin(req)
        try:
            credentials = store.rotate_agent_token(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, "Agent not found") from exc
        await broker.disconnect_agent(target_agent_id)
        return JSONResponse(credentials, headers={"Cache-Control": "no-store"})

    @app.put("/api/v1/dashboard/agents/{target_agent_id}/teams")
    def dashboard_assign_teams(target_agent_id: str, body: TeamAssignment,
                               req: Request) -> dict:
        require_dashboard_admin(req)
        try:
            return store.assign_teams(target_agent_id, body.teams)
        except ValueError as exc:
            status = 404 if str(exc) == "Unknown agent_id" else 400
            raise HTTPException(status, str(exc)) from exc

    def require_extension_admin(req: Request) -> None:
        """Allow only authenticated, local administrative extension requests.

        No browser Basic auth, admin token or token hints are ever returned to
        page content, a content script or an agent's MCP session.
        """
        if (req.url.hostname or "").lower() not in ("localhost", "127.0.0.1", "::1"):
            raise HTTPException(403, "Administrative access is loopback-only")
        if not req.client or req.client.host not in (
            "localhost", "127.0.0.1", "::1", "testclient"
        ):
            raise HTTPException(403, "Administrative access is loopback-only")
        origin = req.headers.get("origin", "")
        if origin and not origin.startswith("chrome-extension://"):
            raise HTTPException(403, "Extension origin required")
        secret = req.headers.get("x-agent-network-admin-token", "")
        if not secret or not secrets.compare_digest(secret, admin_token):
            raise HTTPException(403, "Invalid administrator token")

    @app.get("/api/v1/admin/agents")
    def extension_agent_catalog(req: Request) -> JSONResponse:
        """Authoritative metadata for the trusted Chrome popup, no credentials."""
        require_extension_admin(req)
        items = [{
            "agent_id": a["agent_id"], "name": a["name"], "kind": a["kind"],
            "role": a["role"], "purpose": a["purpose"],
            "description": a["description"], "teams": a["teams"],
        } for a in store.agents()]
        return JSONResponse({"items": items}, headers={"Cache-Control": "no-store"})

    def validate_chat_url(url: str) -> None:
        if not re.fullmatch(r"https://chatgpt[.]com/c/[a-zA-Z0-9-]{8,100}", url):
            raise HTTPException(400, "Invalid ChatGPT conversation URL")

    @app.post("/api/v1/admin/chatgpt-agents")
    def extension_create_chatgpt_agent(body: ExtensionChatAgentCreate,
                                       req: Request) -> JSONResponse:
        """Create a new identity, returning only a revocable chat token."""
        require_extension_admin(req)
        validate_chat_url(body.chat_url)
        try:
            registered = store.register(
                body.name, body.role, "chatgpt", body.purpose, body.description
            )
        except ValueError as exc:
            raise HTTPException(409 if "already registered" in str(exc)
                                else 400, str(exc)) from exc
        agent_id = registered["agent"]["agent_id"]
        try:
            issued = store.issue_chat_token(agent_id, body.chat_url)
        except Exception as exc:
            store.delete_agent(agent_id)
            if isinstance(exc, ValueError):
                raise HTTPException(409, str(exc)) from exc
            raise
        return JSONResponse({**issued, "created": True},
                            headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/admin/agents/{target_agent_id}/chat-credentials")
    async def extension_issue_chat_credential(target_agent_id: str,
                                              body: AgentChatCredentialRequest,
                                              req: Request) -> JSONResponse:
        """Admin-issued credential only when binding to an existing chat."""
        require_extension_admin(req)
        validate_chat_url(body.chat_url)
        try:
            issued = store.issue_chat_token(
                target_agent_id, body.chat_url,
                replace_existing=body.replace_existing,
            )
        except ValueError as exc:
            raise HTTPException(404 if str(exc) == "Unknown agent_id"
                                else 409 if ("active binding" in str(exc) or
                                             "bound to another agent" in str(exc))
                                else 400,
                                str(exc)) from exc
        if body.replace_existing:
            # Reclaimed lease invalidates the previous wake channel immediately.
            await broker.disconnect_agent(target_agent_id)
        return JSONResponse(issued, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/admin/agents/{target_agent_id}/chat-binding")
    def extension_get_chat_binding(target_agent_id: str, req: Request) -> JSONResponse:
        """Metadata-only reconciliation after an ambiguous transfer response."""
        require_extension_admin(req)
        try:
            binding = store.chat_binding(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return JSONResponse(binding, headers={"Cache-Control":"no-store"})

    @app.post("/api/v1/admin/agents/{target_agent_id}/chat-transfers")
    def extension_prepare_chat_transfer(target_agent_id: str,
                                        body: AgentChatTransferRequest,
                                        req: Request) -> JSONResponse:
        require_extension_admin(req)
        validate_chat_url(body.old_chat_url)
        validate_chat_url(body.new_chat_url)
        try:
            prepared = store.prepare_chat_transfer(
                target_agent_id, body.source_token_id,
                body.old_chat_url, body.new_chat_url,
                legacy_primary_token=body.legacy_primary_token,
                admin_recovery=body.admin_recovery,
                expected_source_token_id=body.expected_source_token_id,
                expected_source_chat_url=body.expected_source_chat_url,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return JSONResponse(prepared, headers={"Cache-Control":"no-store"})

    @app.post("/api/v1/admin/agents/{target_agent_id}/chat-transfers/{transfer_id}/commit")
    async def extension_commit_chat_transfer(target_agent_id: str,
                                             transfer_id: str,
                                             req: Request) -> JSONResponse:
        require_extension_admin(req)
        try:
            committed = store.commit_chat_transfer(target_agent_id, transfer_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        # A's old credential is now revoked. Terminate its established WS.
        await broker.disconnect_agent(target_agent_id)
        return JSONResponse(committed, headers={"Cache-Control":"no-store"})

    @app.delete("/api/v1/admin/agents/{target_agent_id}/chat-transfers/{transfer_id}")
    def extension_abort_chat_transfer(target_agent_id: str,
                                      transfer_id: str,
                                      req: Request) -> JSONResponse:
        require_extension_admin(req)
        aborted = store.abort_chat_transfer(target_agent_id, transfer_id)
        return JSONResponse({"aborted":aborted},
                            headers={"Cache-Control":"no-store"})

    @app.delete("/api/v1/admin/agents/{target_agent_id}/chat-credentials/{token_id}")
    async def extension_revoke_chat_credential(target_agent_id: str, token_id: str,
                                         req: Request) -> JSONResponse:
        """Revoke a chat's token, leaving all other credentials alone."""
        require_extension_admin(req)
        revoked = store.revoke_chat_token(target_agent_id, token_id)
        if revoked:
            await broker.disconnect_agent(target_agent_id)
        return JSONResponse({"revoked": revoked}, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/admin/agent-ids")
    def extension_agent_ids(req: Request) -> JSONResponse:
        """Authoritative identity IDs for cleaning stale extension registrations.

        Restricted to the same local administrator access as team management.
        Never exposes credentials or agent profiles.
        """
        require_extension_admin(req)
        return JSONResponse({"agent_ids": [
            agent["agent_id"] for agent in store.agents()
        ]}, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/admin/teams")
    def extension_team_list(req: Request) -> JSONResponse:
        require_extension_admin(req)
        return JSONResponse({"items": store.team_list()},
                            headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/admin/me/teams")
    def extension_own_teams(req: Request) -> dict:
        require_extension_admin(req)
        agent_id, token = agent_view_credentials(req)
        with store.lock:
            store.verify(agent_id, token)
            return {"agent_id": agent_id, "teams": store._teams(agent_id)}

    @app.put("/api/v1/admin/me/teams")
    def extension_assign_teams(body: TeamAssignment, req: Request) -> dict:
        require_extension_admin(req)
        agent_id, token = agent_view_credentials(req)
        try:
            # Only the locally bound agent may be managed from its popup.
            store.verify(agent_id, token)
            return store.assign_teams(agent_id, body.teams)
        except ValueError as exc:
            status = 404 if str(exc) == "Unknown agent_id" else 400
            raise HTTPException(status, str(exc)) from exc

    @app.get("/api/v1/dashboard/notes")
    def dashboard_notes(req: Request,
                        page: int = Query(default=1, ge=1, le=10000)) -> JSONResponse:
        """Administrator-only list of unexpired Notes (drafts included)."""
        require_dashboard_admin(req)
        return JSONResponse(store.admin_list_notes(page=page),
                            headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/notes/{note_id}")
    def dashboard_note(note_id: str, req: Request) -> JSONResponse:
        """Administrator-only Note details, without consuming its contents."""
        require_dashboard_admin(req)
        try:
            data = store.admin_read_note(note_id)
        except ValueError as exc:
            raise HTTPException(404, "Note not found") from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/agents/{target_agent_id}/context")
    def dashboard_agent_context(target_agent_id: str, req: Request) -> JSONResponse:
        """Administrator-only read of an agent's saved compact context."""
        require_dashboard_admin(req)
        try:
            data = store.admin_read_context(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, "Agent not found") from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/conversations")
    def dashboard_conversations(agent_id: str, req: Request) -> JSONResponse:
        """Administrator-only peer list. Never returns message content or tokens."""
        require_dashboard_admin(req)
        try:
            data = store.conversations(agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/dashboard/conversations/{agent_id}/{peer_id}/messages")
    def dashboard_conversation_messages(
        agent_id: str, peer_id: str, req: Request,
        before: str = Query(default="", max_length=64),
        limit: int = Query(default=30, ge=1, le=50),
    ) -> JSONResponse:
        """Administrator-only, read-only chat history with a stable older cursor."""
        require_dashboard_admin(req)
        try:
            data = store.conversation_messages(agent_id, peer_id,
                                               before=before, limit=limit)
        except ValueError as exc:
            if "Unknown agent_id" in str(exc):
                raise HTTPException(404, str(exc)) from exc
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.delete("/api/v1/dashboard/agents/{target_agent_id}")
    async def dashboard_delete_agent(target_agent_id: str, req: Request) -> dict:
        """Delete an identity and its messages with explicit administrator auth."""
        require_dashboard_admin(req)
        try:
            result = store.delete_agent(target_agent_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        await broker.disconnect_agent(target_agent_id)
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
    def register_api(body: AgentCreate, req: Request) -> JSONResponse:
        """Chrome extension: new identities need the admin token.

        An existing identity can reconnect using its own registered ID/token
        without admin approval. Neither route can change team memberships.
        """
        if not (body.agent_id and body.token):
            require_extension_admin(req)
            if body.agent_id or body.token:
                raise HTTPException(400, "Reconnect requires both agent_id and token")
            if body.kind != "chatgpt":
                raise HTTPException(400, "Extension registration requires kind=chatgpt")
        try:
            result = store.register(**body.model_dump())
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
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
        # Admin-only metadata across all teams, no message content or credentials.
        return store.agents(present_ids={x[0] for x in broker.connections.values()})

    @app.websocket("/api/v1/channels/ws")
    async def channels_ws(ws: WebSocket):
        await broker.socket(ws)

    # MCP lives in the same process, sharing the same registry and inbox,
    # but no agent message travels through a sidecar adapter.
    app.mount("/", mcp_app)
    # Add last so it runs before authentication/routes for both HTTP and WS.
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["127.0.0.1", "localhost", "::1", *extra_hosts],
        www_redirect=False,
    )
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
