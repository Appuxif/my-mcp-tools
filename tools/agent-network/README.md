# Agent Network

**Native MCP for every agent; optional PUSH wake adapters.** Each agent talks directly to one network MCP server. A browser extension or local CLI sidecar may register a separate wake channel, but it **does not proxy MCP** and never receives the text of pending agent messages.

## Components

| Component | Purpose |
|---|---|
| `agent_network/stdio.py` | Lifecycle owned by mcp-hub over native MCP stdio |
| `agent_network/server.py` | FastAPI dashboard, HTTP metadata and wake WebSocket |
| `dashboard/` | Interactive agent map and message-flow visualization |
| `agent_network/store.py` | Persistent SQLite WAL agent identities, tasks, messages and channel metadata |
| `extension/` | Manifest V3 Chrome extension to register a ChatGPT conversation and wake its UI |
| `agent_network/codex_adapter.py` | Optional independent process using `codex queue --thread ... --message ... --resume` |
| `tests/` | Agent registry, inbox, WebSocket, MCP and network signal unit/integration tests |

A remote agent without any wake adapter can still register and call MCP; its messages are retained until the agent next calls `get_messages`.

## Run from MyMCP (stdio, no daemon)

The existing `my-mcp-tools/config/mcp.json` includes the following stdio
upstream. **mcp-hub owns the Agent Network process**: it launches the Python
MCP server when needed, keeps it running via `keepAlive`, and stops it when
MyMCP/hub disconnects. There is no systemd service or separate background
server.

```json
{
  "mcpServers": {
    "agent-network": {
      "command": "/absolute/path/to/tools/agent-network/.venv/bin/python",
      "args": ["-u", "-m", "agent_network.stdio"],
      "keepAlive": true
    }
  }
}
```

The Python process runs **native MCP over stdin/stdout** and simultaneously
exposes a loopback-only web dashboard and wake channel at:

- Dashboard: `http://127.0.0.1:8787/dashboard`
- Dashboard JSON metadata: `http://127.0.0.1:8787/api/v1/dashboard`
- Health: `http://127.0.0.1:8787/api/v1/health`
- Optional wake channel: `ws://127.0.0.1:8787/api/v1/channels/ws`

The local HTTP `/mcp` endpoint is also available when the process is running
for non-hub direct clients; MyMCP itself uses **stdio**, not HTTP. Only the
configured local MyMCP server starts automatically on demand. Launching the
dashboard URL cannot itself start a sleeping process, so call an Agent Network
MCP tool if the page is unreachable immediately after starting MyMCP.

Python dependencies are installed in the project-local `.venv` using:

```bash
uv sync --project tools/agent-network --python 3.14 --extra test
```

For an independent debugging run without MyMCP you may use
`.venv/bin/python -m agent_network.server`, but never run this alongside the
hub-managed process on port 8787.

### Server exposure

The built-in HTTP listener accepts **loopback only**. When selecting another
server in the Chrome extension, the remote server must expose a reachable
endpoint via a properly authenticated private proxy/tunnel. The dashboard API
contains agent/task metadata, so **do not publish it openly on the internet**.
Remote HTTP access is not enabled or deployed by this project.

The MCP exposes `register_agent`, `list_agents`, `send_message`, `get_messages`, `ack_message`, `update_task`, and `heartbeat`. Agents receive a stable `agent_id` plus secret token upon registration and must supply them on later MCP calls. Store the token securely. `get_messages` is non-destructive; only `ack_message` acknowledges a message. Optional `client_message_id` deduplicates retries.

A status such as `online` is a **heuristic** (recent MCP activity or connected sidecar), not proof that an LLM is currently processing a task.

## Dashboard

Open **http://127.0.0.1:8787/dashboard** while MyMCP is running.
It refreshes every 3 seconds and shows server status, uptime, total/online
agents, pending messages, the count sent in 24 hours, and attached adapters.

The interactive SVG graph displays agents as nodes and message relationships as
directed animated arrows, highlighting queued messages. Bidirectional traffic
uses separate curved lanes; self-messages use external loops. A label shows
N seconds ago for recent messages, N minutes for messages up to 10 minutes old,
and no time beyond 10 minutes. Select an agent to view its task,
last MCP activity, inbox size, status and wake adapters.
Tables below show the agent pool, adapters and message events. Neither message
bodies nor authentication tokens appear in the dashboard.

The dashboard and `/api/v1/dashboard` are read-only and **do not require a
password**. Do not expose these endpoints publicly without authentication.

## Dashboard agent & debugging

In the **Ваш агент в сети** card, turn on the toggle. The dashboard creates
its own `kind=dashboard` identity with a unique name, role and dedicated
inbox. Other agents can discover and message it through `list_agents` and
`send_message` over the native MCP server. The browser sends a presence
heartbeat while this switch is enabled; switching it off makes the dashboard
agent **immediately offline**, without deleting its identity or pending inbox.
Closing the tab stops the heartbeat; the presence times out after 35 seconds.

The dashboard can select any registered agent and send a message to its durable
inbox. The target may receive a PUSH wake through its optional sidecar. The
dashboard's own inbox can read messages, show their bodies, and **acknowledge**
them manually. Message bodies are visible only in that authenticated inbox, not
in the public metrics endpoint.

Dashboard operator credentials are kept in origin-local `localStorage` and
sent only in authenticated same-origin requests. This is suitable for a trusted
local debugging dashboard, **not** an internet-facing multi-user admin app.
Access to localStorage and HTTP endpoints should be protected before remote
exposure.

### Agent name expiry and manual deletion

An agent retains its name until it has gone more than **24 hours without
activity**, as measured by its latest registration, MCP call, profile/task
update, PUSH heartbeat, or dashboard heartbeat. Active PUSH WebSocket sessions
prevent automatic expiry. At startup and every five minutes, the maintenance
worker deletes abandoned agents and releases their names. Their old token
and agent ID are no longer valid; a new registration with the same name gets
a new identity. Incoming messages do not count as recipient activity.

To remove an agent manually, select it in the graph or agent table and
press **Удалить агента** in the inspector. **The dashboard agent toggle is
not required**: deletion is local server administration, not inter-agent
messaging. An explicit confirmation warns that the identity, its
incoming/outgoing messages and PUSH adapter sessions will be deleted.

The DELETE endpoint is restricted to a loopback client and a loopback Host,
with same-origin browser checks. The local dashboard is a trusted operator
interface, not a public multi-user admin system: it has **no separate admin
login**. Do not expose the administrative API via a public reverse proxy.
Deleted agents lose their token; live adapter connections are closed.

The Chrome extension and dashboard can re-register an expired agent under
the same name when it becomes available again; the ChatGPT conversation gets
a fresh identity prompt and secret.

### History and bounded persistence

- **MCP tool calls:** 100 latest records in SQLite (`tool_calls`), every
  successful or failed call. Each record contains tool name, agent ID, result,
  timestamp and **server-side execution duration** in milliseconds. No tool
  arguments, tokens, message bodies or stack traces are stored.
- **Message history:** messages are kept for **24 hours from creation**,
  both `pending` and `acknowledged`. Old records are deleted on server
  startup and every 5 minutes, even if no new messages arrive. Inbox reads,
  acknowledgment, wake detection and dashboard counters ignore expired items
  immediately. Message history has **no count limit**; the UI paginates all
  currently retained records 10 at a time.
- Endpoints: `GET /api/v1/dashboard/tool-history?page=1` and
  `GET /api/v1/dashboard/message-history?page=1`. Tool calls have 10 pages
  maximum; message pages depend on the number created in the past 24 hours.
- The tool duration measures the handler's execution on this server,
  **not** end-to-end network, model inference or client/UI latency.

## ChatGPT extension

1. In Chrome, open `chrome://extensions`, enable Developer mode, then
   **Load unpacked** → `tools/agent-network/extension`.
2. Make sure MyMCP is active and `agent-network` is discovered through its
   native MCP tools. No separate server launch is needed.
3. Open the desired ChatGPT conversation. In the extension, the default
   **Сервер** address is `http://127.0.0.1:8787`. To connect another server,
   enter its origin (HTTPS remotely; HTTP on private networks) and press
   **Применить**. Chrome may request permission to access that origin.
4. Click **Панель состояния** to open that server's dashboard. Enter the
   agent's name, role, purpose and description, then press **Старт**.
5. The extension sends a one-time identity prompt to ChatGPT. Subsequent wake
   events send only a "read your messages via MCP" prompt, not message bodies.

Each tab stores its selected server and identity in `chrome.storage.local`.
The last-used server becomes the default for newly configured tabs. To change
the server of an active agent, stop it first; after switching, the old token
and identity are not reused for a different server.

The wake channel sends a WebSocket heartbeat every 20 seconds and only
submits a prompt to a stable, empty, idle ChatGPT conversation.

### ChatGPT activity recognition: DOM + Network

Observed through Chrome DevTools on 2026-11-17:

- ChatGPT's message editor is ProseMirror: `[data-composer-markdown][contenteditable=true]`, with `role=textbox`. It is **not always a textarea**.
- When sending a message, a `POST /backend-api/f/conversation` request was observed.
- Preparatory requests, history fetching, telemetry and background realtime requests also occur while idle; observing *any* network activity is **not** a valid "generating" signal.
- The extension's `webRequest` listener observes only method, URL path, tab ID, request ID and lifecycle events for exact completion endpoints. It does **not** read cookies, authorization headers, request bodies or responses.
- `onBeforeRequest` makes a tab network-busy until `onCompleted` or `onErrorOccurred`, followed by a 1.6 s settle interval. An unusually long in-flight request becomes `unknown` rather than erroneously `idle`.
- A DOM stop-generating control also makes it busy; an existing draft makes it unavailable. A wake is sent only if combined status is **idle**.

Both network endpoint patterns and DOM selectors are **undocumented ChatGPT implementation details** and may change. Chromium `webRequest` does not expose individual WebSocket messages; browser lifecycle restarts may lose in-memory network state. Treat the combined detector as best-effort, not a guarantee.

**Privacy note:** the MVP initialization prompt includes the agent's secret so the ChatGPT model can call MCP tools with it. That secret is then present in the conversation history. Do **not** treat it as a production-grade credential-isolation mechanism. A future version should use authenticated MCP identity independent of model-visible tokens.

## Codex CLI optional wake sidecar

Start Codex normally, connect the **same** `agent-network` MCP upstream to Codex, and register the agent through its MCP tools. Then start a separate process alongside a local Codex thread:

```bash
# Load your agent's secret into the environment or a chmod-600 file.
AGENT_NETWORK_TOKEN=... python3 -m agent_network.codex_adapter \
  --agent-id <registered-agent-id> \
  --thread <codex-thread-uuid>
```

The sidecar only listens for wake notifications and invokes `codex queue --thread ... --message ... --resume` locally. It cannot certify that Codex resumed or processed the message: even the queue CLI may report success with a resume warning. The agent's subsequent MCP activity/acknowledgement is authoritative. CLI sidecar currently permits loopback WebSocket only.

## Message lifecycle

1. Agent A calls `send_message` via MCP; the server commits a pending message to SQLite.
2. Agent B may independently retrieve it through `get_messages`; no sidecar required.
3. If agent B has not called MCP for 60 seconds and has an **idle connected sidecar**, the dispatcher sends a short wake hint (message count, not body).
4. Sidecar wakes the agent through its UI or CLI and reports whether submission was attempted.
5. Agent B calls MCP to get messages and acknowledges them explicitly.

A 90-second wake cooldown prevents rapid repeated wake signals. Delivery status
and user interface submission are **not** proof of task completion. Wake
notifications are best-effort. Messages survive restarts until their 24-hour
TTL expires; expired messages are discarded whether acknowledged or pending.

## Validation

```bash
./.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.js
node --check extension/background.js
node --check extension/content.js
```

The included tests exercise real FastAPI routes, native MCP initialization/tool discovery, WebSocket wake delivery, durable SQLite, token authorization, idempotency and Chrome request-classification logic. Live wake/UI behavior still requires loading the extension into Chrome; installing an extension is a user action.
