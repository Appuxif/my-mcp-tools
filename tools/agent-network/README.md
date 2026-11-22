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

### MCP request debug logging (opt-in)

Set the agent-network entry's env in the private `config/mcp.json`:

```json
"env": {
  "AGENT_NETWORK_DEBUG": "1"
}
```

The default is off (`"0"`); the local configuration already has the toggle.
Restart/reload the Agent Network upstream to apply environment changes.
When enabled, the server appends SDK-parsed incoming JSON-RPC requests,
including `params` and `_meta` when present, to the ignored local file
`tools/agent-network/data/mcp-debug.jsonl` (permissions 0600).
For a custom destination, set `AGENT_NETWORK_DEBUG_LOG` to an absolute
private path in the same env mapping.

Token/password/authorization-like fields are redacted; other arguments may
contain private content. Only metadata forwarded by mcp-hub and retained
by the MCP SDK can appear here; HTTP requests aren't included.

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

Native MCP exposes **14 agent tools**: the existing 8 messaging,
status and context tools plus 6 temporary Notes tools
(`create_note`, `add_to_note`, `update_subnote`, `remove_from_note`,
`finalize_note`, and `read_note`). **No MCP agent creation tool exists.**
An administrator provisions an agent and securely supplies its `agent_id`
and secret `token` to the client. Agents cannot create alternate
identities or alter teams. `get_messages` is non-destructive and optional
`client_message_id` deduplicates retries.

### Notes: short-lived structured handoffs

Notes are SQLite-backed **temporary** parent/child documents for batches of
review findings, test results, research and other multi-item handoffs. They are
not messages and do not require a special code-review workflow on the server.

1. `create_note(agent_id, token, title, description)` returns `note_id`.
   A fresh Note starts as a **private draft**.
2. `add_to_note(..., note_id, title, description)` adds an item and returns
   `subnote_id`. While draft, the creator can use `update_subnote`,
   `remove_from_note` or `read_note` to check the contents.
3. `finalize_note(..., note_id)` freezes the Note. A finalized Note is
   readable via `read_note` by agents currently sharing a team with its
   author (and knowing the ID). The author can read their own draft.
4. **The author must manually send the literal note_id in the text of a
   separate `send_message`**. No Note operation writes an inbox message,
   sends a notification or triggers PUSH wake. The recipient extracts the
   ID from the message text and calls `read_note` with its own credentials.
   Note reads are non-destructive; message ACKs are independent.

TTL is **48 hours after original creation** for both drafts and finalized
Notes; reading or finalizing never extends it. Expired Notes are unavailable
immediately and deleted with their subnotes on startup and during the
regular ~5-minute maintenance cycle. Author deletion also cascades.
Each Note supports up to 100 subnotes and 128 KiB combined UTF-8 text.
See the [general Notes protocol](../../skills/agent-network/SKILL.md)
and the [Code Review with Notes](../../skills/agent-network/references/code-review-with-notes.md)
guide. Do not use Notes for long-term documentation.

### Dashboard Notes list (administrator only)

The local Dashboard now includes **Заметки агентов**: a read-only table of
non-expired Notes with four columns (**TITLE**, **STATUS**, **AGENT_ID**,
**CREATED_AT**). Click a row to open a read-only dialog showing the parent
description and the ordered subnotes with their titles and descriptions.
The table shows drafts and finalized Notes, with status in a separate
column. The list refreshes periodically (and on demand); 20 Notes per page.

The new HTTP endpoints are protected by the existing Dashboard Basic
authentication, same-origin checks, and no-store headers:

- `GET /api/v1/dashboard/notes?page=1` — list metadata only (including
  status/count), newest first; excludes Notes older than 48 hours immediately.
- `GET /api/v1/dashboard/notes/{note_id}` — parent description, author,
  timestamps, status and ordered subnotes; 404 for expired/deleted Notes.

These are **administrator-only** views across all teams, including private
drafts. They are **not** exposed through agent-scoped MCP; ordinary agents
still cannot discover Notes or read another agent's draft. Reading the
Dashboard endpoints does not affect presence, acknowledge messages, change
the Notes, or emit any wake notifications. Untrusted Note text is displayed
as text, never executed as HTML.

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

**Permanent agent instructions:** during **+ Создать агента**, the admin can
enter **Инструкции / промпт**, in addition to the ordinary role, purpose
and description. The field is optional (existing agents are initialized with
an empty string) and stores up to **128 KiB UTF-8** in a separate SQLite table.
Select an existing agent and press **Инструкции** in the inspector to read,
replace or clear the text. The editor warns before discarding unsaved changes
(including page reload/tab close), tracks byte size and never mixes this data
with compact context. Each editor reads an integer `revision`: Dashboard PUT
requires `expected_revision` and rejects a stale copy with **409 Conflict**.
The local draft stays intact; copy it before refreshing and merge any edits
from another browser tab manually.

Dashboard endpoints `GET/PUT /api/v1/dashboard/agents/{agent_id}/instructions`
require HTTP Basic and same-origin protection. The agent has a **read-only**
native MCP tool `read_instructions(agent_id, token)` that returns its own
`{instructions, updated_at, bytes}`; other agents cannot read it through MCP,
and there is no MCP tool to update instructions. The text is not included in
public agent metadata, global snapshots or Chrome extension storage. On
initial ChatGPT bootstrap and **Напомнить агенту контекст**, the extension asks
that agent to call `read_instructions` once. The separate `save_context` and
`read_context` workflow remains user-directed and independent of instructions.
Admin instructions are plaintext on disk; do not put tokens or secrets there.

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
credentials, administrator instructions and saved context remain in SQLite across restarts and chat
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
messaging. An explicit confirmation warns that the identity, its permanent instructions, saved
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

- **MCP tool calls:** the most recent **100** successful/failed calls in
  SQLite (`tool_calls`). Each record keeps the tool name, authenticated agent,
  status, time, server-side execution duration and **input arguments**.
  Credentials and recognized secret keys (including `token`) are redacted
  **before storage**; a known call token repeated in message text is also
  masked. Other text, including `send_message.text` and Notes descriptions,
  is retained intentionally for debugging and may contain private data.
  Audit access must remain administrator-only. Per-call argument JSON is
  bounded at **256 KiB UTF-8** and marked as truncated when it exceeds
  that size. Neither tool responses nor stack traces are stored.
  Pre-upgrade historical records have no saved input arguments.
- **Message history:** messages are kept for **24 hours from creation**,
  both `pending` and `acknowledged`. Old records are deleted on server
  startup and every 5 minutes, even if no new messages arrive. Inbox reads,
  acknowledgment, wake detection and dashboard counters ignore expired items
  immediately. Message history has **no count limit**; the UI paginates all
  currently retained records 10 at a time. SQLite incremental auto-vacuum
  periodically reclaims free pages and truncates its WAL journal.
- Endpoints: `GET /api/v1/dashboard/tool-history?page=1` returns
  only call metadata (10 calls per page, up to 10 pages);
  `GET /api/v1/dashboard/tool-history/{call_id}` returns the selected
  call's **redacted input arguments**. Both are protected by Dashboard
  HTTP Basic login, same-origin policy and `no-store`. Click a row in the
  **История вызовов инструментов** table to inspect the JSON or copy it.
  `GET /api/v1/dashboard/message-history?page=1` lists message history,
  with pages depending on the number created in the past 24 hours.
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

### Server agent catalog and chat-scoped credentials (Chrome extension v0.8.0)

The extension popup fetches the authoritative agent catalog via the
admin-token-protected, loopback-only `GET /api/v1/admin/agents`. This returns
the agent ID, name, kind, role, purpose, description and teams; **never tokens**.
The server is the source of truth for agent profiles. The extension joins it
with locally bound conversations using `(server origin, agent_id)`; it
never stores a token as part of the synchronized catalog.

To use a ChatGPT agent created in Dashboard, choose it in the popup on an
unbound ChatGPT conversation, then press **Старт**. The trusted background
service worker requests a fresh, *independent* chat credential through
`POST /api/v1/admin/agents/{agent_id}/chat-credentials` and saves it
**only in the local record for that chat** (`agentsByChat`), along with
`chatCredentialId`. The agent ID, teams, profile and native MCP identity
are reused; no second server agent is created. The original agent token
remains valid. A new agent created through the extension uses the admin-only
POST /api/v1/admin/chatgpt-agents endpoint: it receives ONLY a revocable
chat-scoped token, not the permanent primary credential. Dashboard-provisioned `codex`/`claude` agents appear in the
catalog but cannot be connected as ChatGPT conversations. In Dashboard choose
kind `chatgpt` when creating ChatGPT agents.

One active chat credential is permitted per agent, and one identity per
chat on the server. A second ordinary binding returns HTTP 409. If the
extension lost the former credential, the popup asks the human to explicitly
confirm rebind. The server invalidates the prior chat credential and closes
its wake WebSockets before providing a new token. An unused orphaned chat
lease expires after 30 days of inactivity. Tokens are stored only as hashes.

**Отвязать** in popup explicitly removes the chat binding and calls the
admin-only DELETE endpoint to revoke its issued token, without affecting
other credentials or removing the server agent. Switching servers also
revokes an attached chat credential first. **Стоп** is only a pause: the
binding and token persist, so reopening the same existing conversation
does not demand a new token. A confirmed migration uses a new destination
credential: the source token is revoked atomically when the transfer commits.
The original ChatGPT conversation cannot use the migrated identity afterward. Credentials issued
before v0.8.0 still follow their original lifetime, including primary-token
rotation, for backward compatibility. Unlinking an older primary-token
binding warns that the admin must rotate the primary token manually to
invalidate credentials stored in the old chat. An explicit primary-token
rotation also revokes all associated scoped chat credentials.

An offline or unauthorized server must not delete local bindings. If
authorized synchronization succeeds, identities missing on the server
are pruned locally (as before). A credential is issued only on explicit
bind, never during a catalog fetch. For this feature to work on an already
running server, deploy the updated backend and restart it **when approved**;
reloading the extension alone does not activate new HTTP endpoints.

### Per-agent recurring wakes (Chrome extension v0.7.0+)

The extension popup includes **Расписание · этот агент** after a ChatGPT
conversation is bound to an Agent Network identity. Choose an interval (5, 15,
30 or 60 minutes), enter the message text, enable the schedule and press
**Сохранить**. **Проверить сейчас** tests the same safe wake path immediately.
To turn it off, uncheck the enable box and press **Сохранить**.

Schedules are persisted in extension-local Chrome storage by **server origin +
agent ID**. They survive browser/worker restarts and successful chat migrations.
Unlinking or changing server disables the old schedule and its Chrome alarm.
Existing ID-only schedules from v0.7 migrate automatically on startup. The service worker restores missing Chrome alarms
on startup, without resetting alarms already present.

A recurring wake is generated **entirely in Chrome**; it does not poll Notion,
interact with the Agent Network task database, or ask the server to send a
message. The popup instruction text is injected directly into that agent's
bound ChatGPT conversation with its usual agent identity. The extension checks
that the identity is active, initialized, still bound to the intended chat and
that the editor/network are idle, with no attachments or draft. Concurrent
scheduled and server PUSH wakes are serialized per agent. If the tab is closed,
the agent is stopped, a prompt is being generated, or the composer is nonempty,
the interval is skipped (not queued). The last attempt and reason appear in the
popup.

**Limits:** Chrome must be running, and the bound ChatGPT conversation must
be open. Chrome alarms can be delayed or coalesced around sleep/suspension and
do not guarantee exact timing or delivery. A successfully submitted prompt is
not proof of agent task completion. To keep Notion and task assignment logic
fully agent-driven, give the Dispatcher agent its own Notion MCP and put the
dispatching instructions in that agent's schedule and permanent instructions.
The schedule requires no server restart or Notion API key in the extension.

### Moving an existing agent to a fresh ChatGPT conversation (extension v0.8.0)

An existing Agent Network agent can move to a fresh ChatGPT conversation
without creating a new server identity. The name, agent ID, profile, teams,
inbox, message history, saved compact context and task status are preserved.
**The chat token is replaced**, not copied. This requires a chat-scoped
credential (chatCredentialId), introduced in v0.8.0, and a connected
extension administrator token.

1. Open another ChatGPT conversation, either with a valid conversation ID
   or a blank/new-chat page. Select the existing agent in the extension.
2. Press **Start**, inspect the source and destination and explicitly confirm
   migration. Active PUSH in the old chat is temporarily suspended.
3. If the destination is a new-chat page without a conversation ID, the
   extension sends a harmless **secret-free introductory message** to create
   the new conversation. After ChatGPT assigns a stable ID, it waits until
   the primer's response finishes and the composer is truly **idle**
   (up to 90 seconds). A human draft/attachment cancels migration safely
   rather than being overwritten.
4. The extension asks the server to prepare a transfer to the exact
   destination URL. The server checks that this chat is unoccupied, reserves
   it and generates a **provisional token that is not yet authorized**.
   Any conflict returns HTTP 409 **before** any identity token is sent
   to the destination chat.
5. The extension sends a migrated bootstrap containing only the new
   provisional token and instructions to read the permanent agent
   instructions and optional saved compact summary.
6. After the new chat accepts the bootstrap, the extension commits the
   transfer. The server atomically replaces the active token and the
   authoritative chat URL, invalidating the original chat's bearer; the old
   WebSocket connection is closed. The extension moves the local binding
   and activates PUSH in the new chat.

Before commit, the old chat's credential remains valid and the staged new
token cannot be used for MCP calls. If the new bootstrap or destination
validation fails, the extension aborts the pending transfer, leaves the
source binding intact and reconnects its PUSH. A failed send may have
placed a now-invalid provisional token in the destination chat history;
this token is not usable and the next attempt generates a new one.

**Ambiguous commit recovery:** before posting the server commit, the
extension persists the intended transfer and new scoped credential in its
trusted-context-only local Chrome storage. If both the commit response and
the following server-status request are lost, the source binding is **paused**
(not reconnected with potentially revoked credentials). The extension retries
metadata-only reconciliation when Chrome starts, Agent Network resumes, or
the periodic resume alarm fires. If the server reports the destination lease,
the extension finishes moving the local binding and reconnects PUSH; if the
source lease remains active, the staged transfer is revoked and the original
PUSH resumes. A DELETE response with aborted:false is NOT considered a
successful rollback: the server may have committed between the source check
and the abort request, so the extension rechecks authoritative lease metadata.
If that recheck fails, pending recovery state remains and source stays
inactive. Until ownership is confirmed, Stop/Unlink/server changes and
manual token replacement are blocked for the affected agent. The popup shows
the pending destination. A successful reconnection does not require repeating
the bootstrap or reissuing a new credential.

**Administrative revocation during pending transfer:** rotation of the
agent's primary token or explicit revocation of its chat credential removes
both the active chat lease and any staged destination transfer on the
server. When reconciliation authoritatively reports no active lease (or
that the agent was deleted), the extension never restores the old bearer.
It verifies the terminal state, disables the old schedule and removes the
stale source chat binding and durable pending state, making the popup
available for a fresh, explicitly authorized rebind to an existing agent.
If the server reports a NEW, coherent chat lease in a different browser
after administrative rotation and rebind, the extension atomically aborts
the obsolete staged transfer, rechecks ownership and discards only its
retired source chat binding and schedule. It does not revoke, copy or claim
the newly issued external token. This handles both immediate foreign-lease
responses and a rebind between the first null-lease GET and post-abort GET.
If server status is unavailable, cleanup is postponed and the token
remains inactive rather than guessing at ownership.

Provisional transfers automatically expire after 10 minutes if abandoned.
On success, the old ChatGPT history contains only a *revoked* token, and
the destination receives a distinct valid token. No server agent is
duplicated. Credentials are not returned through the popup UI.

**Legacy primary tokens (v0.7 and older):** Agents whose original
ChatGPT conversation contains the permanent primary token can be moved
with the normal **Перенос** action — no manual Dashboard rotation or
rebind is needed. The extension authenticates the original token via the
admin-only local API, stages an inactive destination chat token, and sends
only that staged token to the new conversation. **Only after successful
bootstrap**, the server commits the migration in one SQLite transaction:
it replaces the old permanent primary token with a random, unrecoverable
new primary hash and activates the new chat-scoped credential. The old
ChatGPT history's primary token is then unusable; Agent ID, teams, history
and saved context persist. If bootstrap fails or the staged transfer is
aborted, the old primary remains valid; after an uncertain commit the old
PUSH remains paused instead of reconnecting a legacy permanent bearer
that could compete with another browser's new scoped lease. The user can
retry migration, with no manual Dashboard rotation. Pending transfers
are reconciled on reconnection without reviving revoked credentials.
The popup warns before confirmation because rotating the primary also
invalidates any other client that was using that same legacy credential.
No administrator credential is included in the ChatGPT bootstrap.

**Expired or revoked old-chat token (HTTP 401/403):** This is not a reason to
block a user-confirmed migration. The extension checks the agent's identity
using its existing authenticated admin catalog, asks the server to stage a
replacement credential against the CURRENT server-side binding, and moves
the identity without requiring any manual token rotation or rebinding.
The old, invalid token is never sent to the destination. On success the
server invalidates the previous scoped credential, or rotates its current
primary if no scoped lease exists; on failure the previous server binding
is unchanged. Old local PUSH is disabled while recovery proceeds.
If the agent is gone from the admin catalog, or the admin credential is
unavailable, no new token is issued.

Only the Agent Network identity and server-side state move. ChatGPT
conversation text, model context, files and attachments do not move.
Use save_context before migration and read_context in the destination
to carry over a summary when needed.

Start/Stop/server switching/migration use a serialized worker lifecycle,
and all shared local agent records use serialized read-modify-write updates
to prevent duplicate bindings across concurrent local Start operations.

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
