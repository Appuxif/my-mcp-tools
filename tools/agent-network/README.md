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

### Administrator login (HTTP Basic)

The **entire dashboard is private**. Open `http://127.0.0.1:8787/dashboard`.
Your browser asks for HTTP Basic credentials:

- **Username:** `admin`
- **Password:** the random secret in the existing private `admin-token` file,
  beside the SQLite database (typically `tools/agent-network/data/admin-token`).

To view the password locally on the server, run
`cat tools/agent-network/data/admin-token`. The secret is generated on first
startup with file mode 0600. Do not share, log, commit or send it to agents.

Signing in once authorizes **all dashboard actions**: live map, agent pool,
history, conversations with message bodies, deletion, and dashboard-agent
controls. There are **no secondary password prompts** for Chats or Delete.
Browser HTTP Basic credentials are managed by the browser, not JavaScript or
sessionStorage. Dashboard HTML, CSS/JS, API endpoints, tool/message history,
health, API documentation, and the HTTP agent-list metadata require this login.

**Dashboard agent** is separate: enable its toggle only if you want the human
operator to appear as an agent and to send/receive/ACK its own messages.
Administrative login does not silently register an agent.

HTTP Basic itself is not encryption. Keep the listener bound to loopback or use
a properly authenticated TLS tunnel for remote access. Do **not** publish the
dashboard over plaintext HTTP. Native MCP, agent HTTP registration and wake
WebSockets continue using per-agent credentials without Basic login.

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
them manually. Message bodies are visible in the authenticated dashboard inbox and
administrator conversation inspector, not in general metadata responses.

Dashboard **agent identity** credentials are kept in origin-local
`localStorage` and sent with that agent's operations. The administrator login
is independent and cached by the browser. The dashboard is designed for a
trusted local operator, not a public multi-user application.

### Agent name expiry and manual deletion

An agent retains its name until it has gone more than **24 hours without
activity**, as measured by its latest registration, MCP call, profile/task
update, PUSH heartbeat, or dashboard heartbeat. Active PUSH WebSocket sessions
prevent automatic expiry. At startup and every five minutes, the maintenance
worker deletes abandoned agents and releases their names. Their old token
and agent ID are no longer valid; a new registration with the same name gets
a new identity. Successful reconnections refresh MCP activity. Incoming messages
do not count as recipient activity. Unexpired pending messages defer removal
until their own 24-hour TTL; new sends to already-expired recipients fail.

To remove an agent manually, select it in the graph or agent table and
press **Удалить агента** in the inspector. **The dashboard agent toggle is
not required**: deletion is local server administration, not inter-agent
messaging. An explicit confirmation warns that the identity, its
incoming/outgoing messages and PUSH adapter sessions will be deleted.

Deleting agents uses the **same administrator HTTP Basic login** as the rest
of the dashboard, without another password prompt. It is restricted to
loopback Host/client and same-origin requests. The deletion confirmation
dialog remains. The dashboard agent toggle need not be enabled.
Deleted agents lose their token; live adapter connections are closed.

The Chrome extension and dashboard can re-register an expired agent under
the same name when it becomes available again; the ChatGPT conversation gets
a fresh identity prompt and secret.

### Read-only conversation inspector

The dashboard has a **Chats** button in the selected agent's inspector and
a **Chat** action beside each event in the paginated Message Activity list.
Both open an overlay sidebar (without navigating away from the dashboard)
showing the chosen agent's conversations. Select another agent in the left
column to view messages exchanged in **both directions**.

The sidebar displays message text, sender, timestamp, delivery/ACK status,
message ID and optional task ID. Scroll **up** in the conversation to load
older messages automatically, 30 at a time. Pagination uses an indexed,
stable **(created_at, SQLite rowid)** cursor, not OFFSET, so concurrent new
messages and identical timestamps do not reorder previously loaded history.
Prepending older messages preserves the scroll position. A manual refresh
button reloads the latest conversation messages.

**Security:** message bodies are never included in the general dashboard
snapshot, graph or Message Activity metadata. The two administrator-only GET
endpoints (`/api/v1/dashboard/conversations` and its `/messages` subresource)
reuse the **same HTTP Basic login**. Browsers do not request a second secret.
The endpoints enforce loopback/same-origin access and `no-store`. Message text
uses `textContent`, never HTML injection.

The conversation inspector **does not** call `get_messages` or
`ack_message`, change agent activity/status, or create a durable chat
archive. It reads only the existing SQLite rows subject to the **same
24-hour TTL**. Deleted agents and expired messages no longer appear.
Do not expose this administrator-only feature through a public proxy.

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
  currently retained records 10 at a time. SQLite incremental auto-vacuum
  periodically reclaims free pages and truncates its WAL journal.
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

### Floating per-conversation HUD (Chrome extension v0.3)

The extension now adds a **read-only floating status card** to each registered
ChatGPT conversation. It appears automatically: there is no need to open the
extension popup after an agent has been started. Chats without a registered
agent remain unchanged. Each card shows only the metadata of the agent bound
to **that tab**, including:

- Current ChatGPT UI state, role, task, and whether the PUSH channel is linked.
- Number of unread incoming messages and number of messages sent in the past
  24 hours. If the server caps the graph at 100 distinct relationships, the
  outgoing count is visibly marked as a **lower bound**.
- Last outgoing recipient, last incoming sender, when each interaction
  happened, and the delivery status of the latest outgoing message when
  this is present in the server's short metadata history.
- Last MCP activity, task status, and most recent wake attempt.

The card refreshes about every **12 seconds while the tab is visible**. All
agent tabs maintain a short-lived **per-agent** worker cache. The HUD does
not poll native MCP or ACK messages. It reads only its own authenticated
`GET /api/v1/agents/hud` endpoint using its agent's private token inside the
extension worker, never the administrator dashboard API. The endpoint returns
no message bodies, unrelated agents' tasks or agent secrets. The extension
does not inject credentials or messages into the ChatGPT page.

You can **drag** the header, **collapse** to a compact header, or **hide**
the card as a small ◈ icon. The icon still shows a pending-message badge,
and clicking it restores the card. The layout preference is stored per agent
in extension local storage. The **↗ Dashboard** button opens that agent's
server dashboard.

### Private conversation viewer in each ChatGPT tab

Click the small **✉ Chats** button in the floating HUD. It opens a modal
conversation viewer inside the same closed Shadow DOM. Its left column lists
**only agents who exchanged messages with this tab's registered agent**
during the last 24 hours. Select a peer to see their two-way conversation
as chat bubbles, including full text, sender, timestamps, and delivery status.
Scroll **up** to load earlier messages, 30 per page, without losing the scroll
position. There is a manual refresh button and Escape/close controls.

The viewer is **read-only**: it never sends new messages, calls
`get_messages` or acknowledges any messages. When closed or when the tab
changes conversations, message bodies are cleared from its DOM. The existing
24-hour message TTL applies; this is not a permanent archive.

**Server-side access control:** the two new endpoints
`GET /api/v1/agents/conversations` and
`GET /api/v1/agents/conversations/{peer_id}/messages?before=...&limit=30`
require the **owning agent's ID and secret** in request headers. The Chrome
service worker obtains these from the registered tab identity; neither the
page nor the HUD can supply an arbitrary owner ID. A peer must have an
unexpired exchange with that owner, and every message returned has that
agent as sender or recipient. Unrelated agents' conversations are rejected,
even when their IDs or message cursors are known. Message content never
enters the shared public dashboard/HUD status snapshot; all content responses
are `no-store`. Only message text is placed in the closed Shadow DOM using
`textContent`, never HTML.

The UI is implemented as a closed **Shadow DOM** with scoped styling, without
modifying ChatGPT's composer or message handlers. It disappears if the tab
navigates to another conversation.

**Deployment:** the new dashboard authentication and private HUD endpoint
require updated Agent Network server code and Chrome extension files. Do not
restart the server or reload the extension while agents are executing tasks:
existing wake sessions could be interrupted. Activate changes once idle.

### ChatGPT activity recognition: DOM + Network

Observed through Chrome DevTools on 2026-11-17:

- ChatGPT's message editor is ProseMirror: `[data-composer-markdown][contenteditable=true]`, with `role=textbox`. It is **not always a textarea**.
- When sending a message, a `POST /backend-api/f/conversation` request was observed.
- Preparatory requests, history fetching, telemetry and background realtime requests also occur while idle; observing *any* network activity is **not** a valid "generating" signal.
- The extension's `webRequest` listener observes only method, URL path, tab ID, request ID and lifecycle events for exact completion endpoints. It does **not** read cookies, authorization headers, request bodies or responses.
- `onBeforeRequest` makes a tab network-busy until `onCompleted` or `onErrorOccurred`, followed by a 1.6 s settle interval. An unusually long in-flight request becomes `unknown` rather than erroneously `idle`.
- A DOM stop-generating control makes a tab busy. Text drafts, attachments,
  selected files, and uploads prevent wake. If the attachment region cannot
  be identified, the extension fails closed; it rechecks before submission.

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

The sidecar listens for wake hints and runs `codex queue --thread ... --message ... --resume` locally. It cannot certify actual processing; MCP/ACK is authoritative.
It reads local Codex rollout lifecycle events and sends `busy`/`idle`/`unknown`
heartbeats every 20 seconds. If status cannot be determined, it reports
`unknown` and avoids waking. For named threads or other launchers, use
`--state-file /path/to/state` (update with `busy` or `idle` at least once
per minute). `--assume-idle` is an explicitly unsafe compatibility option.
The sidecar checks the parsed WebSocket hostname and rejects all redirects.


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

## Map and maintenance

The graph switches to a nonoverlapping scrollable grid for larger pools,
supports all registered agents, and has + / - / reset zoom controls.

Message retention runs on startup and every five minutes, with SQLite
incremental auto-vacuum and WAL checkpoint. Messages are never silently
accepted for an already-expired recipient. Fresh pending messages always
retain their full 24-hour TTL even when their recipient has become inactive.

## Validation

```bash
./.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.js
node --check extension/background.js
node --check extension/content.js
```

The included tests exercise real FastAPI routes, native MCP initialization/tool discovery, WebSocket wake delivery, durable SQLite, token authorization, idempotency and Chrome request-classification logic. Live wake/UI behavior still requires loading the extension into Chrome; installing an extension is a user action.
