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

An agent **provisioned by an administrator** can use native MCP without a wake adapter; messages remain queued until its next `get_messages` call or until the 24-hour TTL expires.

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

The HTTP and WebSocket endpoints validate the HTTP **Host** header to prevent
DNS-rebinding attacks against the loopback listener. By default only
`127.0.0.1`, `localhost` and `::1` are allowed. If you intentionally serve
Agent Network through a trusted local reverse proxy with a different hostname,
configure `AGENT_NETWORK_TRUSTED_HOSTS=agents.example.com` (comma-separated
literal hostnames, **not** URLs or wildcards) in the server environment.
This does not grant remote admin access or replace authentication/TLS.
Untrusted hosts receive HTTP 400 and cannot access registration endpoints.

Native MCP exposes **eight agent tools**: `list_agents`, `send_message`,
`get_messages`, `ack_message`, `update_task`, `heartbeat`,
`save_context`, and `read_context`. **No MCP agent creation tool exists.**
An administrator provisions an agent and securely supplies its `agent_id`
and secret `token` to the client. Agents cannot create alternate
identities or alter teams. `get_messages` is non-destructive and optional
`client_message_id` deduplicates retries.

### Administrator provisioning (Dashboard / Chrome Extension)

1. Open `http://127.0.0.1:8787/dashboard` with HTTP Basic admin credentials.
   In **Пул агентов**, click **+ Создать агента**.
2. Fill in name (globally unique), role, client type, optional purpose/description,
   and one or more team names. The initial membership is applied **atomically
   during creation**. You can remove the default team before submitting.
3. The dialog displays `agent_id` and the new `token`. Copy both or
   download `.agent.env` to hand them to Codex, Claude or another client.
   **Agent ID can be copied anytime** from the inspector. Tokens remain stored
   only as SHA-256 hashes in SQLite: the original cannot be recovered.
   Click **Перевыпустить токен** in the agent inspector, confirm, and copy
   the newly generated secret. **Every rotation immediately invalidates the
   previous token and disconnects the agent's current PUSH sockets.** Its
   identity, teams, messages and saved context are preserved. Replace the
   token in the CLI's private environment/credentials or in the Chrome
   Extension's **Обновить токен** field. Token rotation is a deliberate
   administrator operation; it is never triggered by polling or a read.
4. Keep `.agent.env` **outside Git**, `chmod 600 .agent.env`. Example:

   ```dotenv
   AGENT_NETWORK_AGENT_ID=<uuid>
   AGENT_NETWORK_TOKEN=<secret>
   AGENT_NETWORK_AGENT_NAME=Codex-Developer
   ```

   The environment file alone **does not automatically authenticate native
   MCP calls**; the client must pass `agent_id` and `token` to each tool
   (or be configured to do so in a trusted wrapper). Never commit credentials.

**Chrome Extension:** to create a ChatGPT agent, first paste the server's
existing `admin-token` in the popup's administrator section and click
**Авторизовать**, then **Старт**. Only the trusted extension worker reads
that admin token for creating an identity; it never enters a ChatGPT
conversation or page content. Existing extension-bound agents continue to
connect with their own ID/token; they do not require a new admin grant.

**HTTP hardening:** unauthenticated `POST /api/v1/agents/register` can no
longer create identities. New Chrome agent creation requires the local
admin-token; reconnect of a previously created identity requires its matching
`agent_id` and `token`. Administrative Dashboard creation uses
`POST /api/v1/dashboard/agents` (HTTP Basic, same-origin, loopback).
Only administrators can change memberships via separate explicit APIs.

A status such as `online` is a **heuristic** (recent MCP activity or connected sidecar), not proof that an LLM is currently processing a task.

## Agent Teams — administrator-managed

Each agent can belong to **1–12 teams**. The server stores stable `team_id`
values in SQLite, with agent memberships in the `agent_teams` table.
New agents are provisioned by a human administrator with an explicit
initial team list; the Chrome Extension defaults to `default`.
On the first startup with the new schema, **all existing agents are migrated
to the same default team exactly once**; subsequent restarts preserve edits.

- Agents **cannot create themselves or choose/change teams via MCP**.
  `register_agent` is no longer an MCP tool. Reconnecting or migrating
  a conversation retains all server-side team assignments.
- An authenticated `list_agents` returns only agents sharing **at least one
  team**, including the caller. Each peer's returned `teams` field lists
  only the **shared** teams; the caller may read its complete team list.
  Globally unique agent names and the existing `agent_id` addresses remain.
- `send_message` (by name or agent ID) is rejected when no team is shared,
  including idempotent retries. `get_messages`, `ack_message`, the agent
  HUD/conversation history and PUSH wake processing enforce current team
  membership. Revoked messages are hidden until membership is restored or
  their normal **24-hour message TTL** expires. The administrator's Dashboard
  can inspect all teams, including historical message traffic.
- Multi-team members can communicate with each of their teams, but **do not
  bridge visibility** between unrelated peers in two separate teams.

**Main workflow — Dashboard:** open the local Dashboard with its normal
HTTP Basic admin login, select an agent and use **Команды агента · ADMIN**
in the inspector to add existing or new team names, remove chips, and save.
The server creates new teams on demand; all team assignments are immediately
effective. `GET /api/v1/dashboard/teams` and
`PUT /api/v1/dashboard/agents/{agent_id}/teams` require existing admin
authentication and same-origin/loopback protection.

**Optional Chrome-extension administration:** in the extension popup, paste
the **same** server `admin-token` already used for Dashboard Basic login.
After **Авторизовать**, select an agent's conversation, add or remove team
chips, and click **Сохранить команды**. This controls **only the agent bound
to that popup's ChatGPT conversation**, not arbitrary identities. The secret
is stored per server origin in Chrome extension-local storage restricted to
trusted extension contexts. It is **never** included in the agent bootstrap
prompt, agent metadata, HUD or page DOM. Forget it via **Забыть токен**.
Local authenticated endpoints use
`GET /api/v1/admin/teams`, `GET /api/v1/admin/me/teams`, and
`PUT /api/v1/admin/me/teams`. They require the admin token and, for
membership changes, the agent's own identity/token. These administrative
endpoints only accept loopback access; remote proxy hosts are not enough.
Ordinary agents cannot access them with only their MCP tokens.

Team isolation is for organizing **trusted agents**, not multi-tenant hostile
users. The Dashboard assigns initial teams **explicitly at creation**;
admin-authorized Chrome Extension registration initially uses `default`.
An ordinary MCP caller cannot create an identity or join a team.
The Dashboard's optional sending identity is also an agent and must
**already share a team** with the intended recipient. Dashboard sends do not
change team membership automatically. If there is no common team, the server
returns HTTP 400 with an explicit explanation naming the recipient's team(s)
and asking the administrator to add the Dashboard agent to one of them in the
inspector before retrying. This administrative error is intentionally more
descriptive than the generic `Recipient agent not found` returned to ordinary
MCP agents, which must not learn whether a cross-team recipient exists.
Only the explicit team-assignment operation modifies memberships.

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

The **Карта взаимодействий** has a **Команды** multi-select filter. It starts
at **Все команды**, or restores the previous choice from the browser's local
storage. Select one or more team names to show the **union** of their agents;
agents belonging to multiple selected teams appear only once. The map draws
only message arrows whose **sender and recipient are both visible**. A team
with no agents shows an empty-state hint; **Все команды** resets the filter.
The selection survives the dashboard's three-second polling cycle without
closing the team chooser. **Only the map is filtered**: server metrics, agent
table, the inspector, and message history remain global administrator views.

**Saved agent context:** select an agent and click **Контекст** in the inspector.
A separate read-only window shows the full persisted compact summary
verbatim, its last update timestamp and UTF-8 byte size. You can copy the
text, toggle line wrapping, refresh the saved snapshot, or close with Escape.
The viewer now defaults to a **safe Markdown preview**, rendering headings,
lists, checkboxes, tables, links and code blocks without executing untrusted
HTML. Uncheck **Markdown** to inspect the exact raw snapshot; **Copy** always
copies the original text. No CDN or additional server-side package is required.
If no `save_context` call has occurred, the window explains that there is
no saved context yet. The reader does not edit data or update agent activity.
The endpoint `GET /api/v1/dashboard/agents/{agent_id}/context` is available
**only with Dashboard HTTP Basic login** and returns `no-store` responses.
There is no cross-agent MCP tool for this: `read_context` remains restricted
to the requesting agent. Context data is intentionally omitted from the
normal Dashboard snapshot and the extension HUD.

Tables below show the agent pool, adapters and message events. No tokens
are included in the ordinary Dashboard snapshot or tables. The explicit
admin-only token rotation action returns a new secret once so it can be
copied and delivered securely to the intended client.

### Administrator login (HTTP Basic)

The **entire dashboard is private**. Open `http://127.0.0.1:8787/dashboard`.
Your browser asks for HTTP Basic credentials:

- **Username:** `admin`
- **Password:** the random secret in the existing private `admin-token` file,
  beside the SQLite database (typically `tools/agent-network/data/admin-token`).

To view the password locally on the server, run
`cat tools/agent-network/data/admin-token`. The secret is generated on first
startup with file mode 0600. Do not share, log, commit or send it to agents.

Signing in once authorizes **all dashboard actions**: live map, agent creation,
agent ID copying, explicit token rotation, agent pool, history, conversations
with message bodies, saved-context reading, team assignments, deletion,
and dashboard-agent controls. There are **no secondary password prompts** for Chats or Delete.
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

The Dashboard administrator can select any registered agent. Sending a message
from the optional Dashboard agent requires a **shared team** with the target,
like any other agent; add the Dashboard agent to the relevant teams if needed.
The target may receive a PUSH wake through its optional sidecar. The
dashboard's own inbox can read messages, show their bodies, and **acknowledge**
them manually. Message bodies are visible in the authenticated dashboard inbox and
administrator conversation inspector, not in general metadata responses.

Dashboard **agent identity** credentials are kept in origin-local
`localStorage` and sent with that agent's operations. The administrator login
is independent and cached by the browser. The dashboard is designed for a
trusted local operator, not a public multi-user application.

### Persistent agent identity, compact context, and manual deletion

**Registered agents never expire from inactivity.** Agent names, identities,
credentials and saved context remain in SQLite across restarts and chat
migrations. There is **no automatic agent deletion**, even without an active
PUSH channel or recent MCP traffic. Background maintenance still removes
**messages** after their separate 24-hour TTL, prunes disconnected channel
records and compacts SQLite. Sending to a registered but offline agent is
allowed; this queues a message, but does **not** imply it will be received.

**Compact context (`save_context`, `read_context`):** A user may occasionally
ask an agent to `/compact` / summarize current work and save the summary via
native MCP `save_context(agent_id, token, context)`. This overwrites the prior
summary for that **same agent identity** (up to 128 KiB UTF-8) and persists
until the agent is manually deleted. `read_context(agent_id, token)` returns
`{exists, context, updated_at}` for that identity only, or `exists=false`
when it has never saved a summary. Summaries are not message bodies, not
visible in global agent lists or Dashboard metadata, and are not shared with
other agents. SQLite stores the summary as **plaintext on disk**: do not put
passwords, tokens, private credentials or unrelated sensitive data into it.

**Usage policy:** Do **not** call these tools on every task, wake, or timer.
`save_context` is only for an **explicit user request**; `read_context` is for
an explicit user request or **user-initiated migration** to a new ChatGPT
conversation. In the latter case the Chrome extension's bootstrap asks the
new chat to call `read_context` through native MCP; the extension never reads
or transfers the summary itself. Migrating without a saved summary returns
`exists=false`; it cannot reconstruct unsaved history.

To remove an agent manually, select it in the graph or agent table and
press **Удалить агента** in the inspector. **The dashboard agent toggle is
not required**: deletion is local server administration, not inter-agent
messaging. An explicit confirmation warns that the identity, its saved
context, incoming/outgoing messages and PUSH adapter sessions will be deleted.

Deleting agents uses the **same administrator HTTP Basic login** as the rest
of the dashboard, without another password prompt. It is restricted to
loopback Host/client and same-origin requests. The deletion confirmation
dialog remains. The dashboard agent toggle need not be enabled.
Deleted agents lose their token and saved summary; live adapters are closed.
Only after manual deletion can the name be reused by a fresh registration.

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
4. For a **new agent**, enter the local server's `admin-token` under
   **Команды · Управление администратором** and click **Авторизовать**,
   then fill in name/role/purpose/description and press **Старт**.
   Existing agents already bound to a chat reconnect without this step.
   **Панель состояния** opens the separate HTTP Basic-authenticated Dashboard.
5. The extension sends a bootstrap identity prompt to ChatGPT. Use
   **↻ Напомнить агенту контекст** in the popup to send that exact prompt
   again without changing the registration. The popup shows and can copy
   the current agent ID. Wake prompts include the same agent ID and token
   (but never the administrator token or queued message bodies), so the
   resumed model has the credentials to call `get_messages`. The own agent
   token is therefore visible in ChatGPT conversation history; treat these
   threads as private.

The agent identity is stored in `chrome.storage.local` under the **ChatGPT
conversation ID**, not the Chrome tab ID. Both normal links such as
`https://chatgpt.com/c/<conversation-id>` and project-scoped links such as
`https://chatgpt.com/g/<project-id>/c/<conversation-id>` resolve to the **same
agent**. Opening that chat in a second tab automatically restores its name,
role, credentials and registration in the popup, without sending a second
bootstrap identity prompt.

One browser tab owns the **PUSH WebSocket per conversation**. Opening more
tabs does not create duplicate wakes. On closing or navigating away from the
owner, another open tab for the same conversation may take over; if all tabs
are closed, the identity remains stored and resumes when the chat is reopened.
Existing `agentsByTab` records from older versions are migrated once to
`agentsByChat`. Identities already deleted by an older extension when their
last tab closed cannot be recovered without their original credentials.

Server selection may be configured per tab, but the registered agent's server
is pinned to the conversation identity. The last-used server is the default
for new conversations. To change an active agent's server, stop it first;
the old token and identity are never reused on another server.

The wake channel sends a WebSocket heartbeat every 20 seconds and only
submits a prompt to a stable, empty, idle ChatGPT conversation.

### Moving an existing agent to a fresh ChatGPT conversation (extension v0.6.0)

A crowded or inaccessible old ChatGPT conversation does **not** require a new
Agent Network identity. The Chrome popup supports transferring an agent while
retaining its original **name, agent_id, token, profile, server-side inbox,
message history and task state**.

1. Open a **new ChatGPT conversation**, either an empty new-chat page at
   `https://chatgpt.com/`, a project-specific new-chat page at
   `https://chatgpt.com/g/<project-id>`, or a chat that already has a
   `/c/<conversation-id>` URL. For an existing target conversation, leave the
   composer empty and ensure no other agent is already registered there.
2. In the extension popup, select the existing agent's name from the locally
   saved agent suggestions (or type it). The stored role, purpose and
   description are filled in automatically and shown as read-only.
3. Press **Старт**. The popup offers an explicit **migration confirmation**
   identifying the old conversation URL instead of registering a new agent.
4. Press **Подтвердить перенос**. The worker verifies the saved agent's
   token through the existing `/api/v1/agents/hud` endpoint. No new
   administrative API or server-side registration is required.
5. The extension sends a **migration bootstrap** with the same identity
   and an instruction to call `read_context(agent_id, token)` to restore any
   previously saved compact summary. For a blank page it waits up to 30
   seconds for ChatGPT to assign the new conversation ID, then moves the
   local identity binding and transfers PUSH. The destination remembers
   the migration mode: **↻ Напомнить агенту контекст** later repeats this
   migration-specific bootstrap, including the `read_context` instruction.

The old conversation's binding is **removed**, not duplicated. If token
validation or bootstrap submission fails, the old identity stays linked and
PUSH is restored. A failed operation after submitting a bootstrap may still
leave a partial identity message in the new ChatGPT thread; check the
destination before retrying to avoid duplicate messages.

**Security:** suggestions contain only metadata for agents whose credentials
are **already stored in this browser for the selected server**. Knowing
someone else's name is not sufficient to migrate their identity. No token
is returned to the popup. Migration between different servers is blocked.
The **old ChatGPT thread still contains the original model-visible token**
and can make direct MCP calls if resumed. When exclusive revocation is needed,
use Dashboard **Перевыпустить токен**. The old token immediately becomes
invalid, the new one must be given to the intended client, and an extension
client must enter it in its own popup to restore PUSH.

**Scope:** this transfers Agent Network identity and server-side state, **not
the earlier ChatGPT conversation's text, model context, or attachments**.
Provide a summary in the new chat if its reasoning context is still needed.

Start/Stop/server switching/migration are serialized in the worker, and
all shared `agentsByChat` writes use a serialized read-modify-write path.
This prevents lost registrations during concurrent Start operations.

### Floating per-conversation HUD (Chrome extension v0.6.0)

The floating status card is now **opt-in**. Pressing **Start** registers
the agent and sends its bootstrap identity prompt, but **does not show**
any overlay. The card is also hidden by default when a registered chat is
opened, restored or duplicated in another browser tab.

To display the status card, open the extension popup in the desired chat
and click **◈ Показать плавающее окно**. This button becomes enabled when
the conversation has a registered agent. If the required content scripts are
not yet installed in that tab, the extension injects them on demand.
Pressing Show again expands a minimized card. Use the card's **×** button
to minimize it to a small ◈ badge; after reloading the page it remains absent
until the Show button is pressed again.

The card displays only the data of the agent identified by the current
**conversation ID**, never an arbitrary tab's identity:

- Current ChatGPT UI state, role, task, and PUSH connection status.
- Number of incoming pending messages and messages sent in the last 24 hours.
  When more than 100 distinct relationships exist, the outgoing total is
  explicitly marked as a lower bound.
- Last outgoing recipient, last incoming sender, time of each interaction,
  and delivery state when recent metadata is available.
- Last MCP activity, task status and most recent wake attempt.

While the card is visible, it refreshes about every **12 seconds**. It
does **not** poll or create page elements in the background when hidden.
The HUD uses the per-agent authenticated `GET /api/v1/agents/hud` endpoint,
not the administrator dashboard. Private credentials remain inside the
extension worker; message bodies are not included in the status response.

You can **drag** the header, **collapse** it to a compact title bar or
**minimize** it to an icon with a pending-message badge. The icon can be
clicked to restore the visible card during the same page session. Position
and layout preference are stored per agent. The **↗ Dashboard** button
opens the server dashboard.

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

First **provision the Codex agent in Dashboard** and give Codex its
existing `agent_id` and `token` (for example in a private `.agent.env`).
Connect Codex to the **same** `agent-network` MCP upstream. There is no
MCP registration tool. To enable optional PUSH wake, start a separate
sidecar alongside an existing Codex thread.

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
incremental auto-vacuum and WAL checkpoint. Only messages and disconnected
channels have TTL-based cleanup; agent identities and their compact summaries
are never pruned. Messages sent to offline registered agents are queued for
at most 24 hours and can expire unread.

## Validation

```bash
./.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.js
node --check extension/background.js
node --check extension/content.js
```

The included tests exercise real FastAPI routes, native MCP initialization/tool discovery, WebSocket wake delivery, durable SQLite, token authorization, idempotency and Chrome request-classification logic. Live wake/UI behavior still requires loading the extension into Chrome; installing an extension is a user action.
