# Agent Network: native MCP tools and identity lifecycle

Verified against `tools/agent-network/agent_network/server.py` and `store.py`. If the implementation changes, the live MCP `get_tool_schema` takes precedence over this reference.

## Fifteen native MCP tools (not Dashboard HTTP endpoints)

| Tool | Arguments | Result |
|---|---|---|
| `list_agents` | `agent_id`, `token` | Only the caller and agents sharing at least one team; includes intersecting team IDs/names, roles, status and activity. |
| `send_message` | `agent_id`, `token`, `to`, `text`; optional `task_id`, `client_message_id` | `message_id`, `duplicate`. `to` accepts a name or UUID. |
| `get_messages` | `agent_id`, `token`; optional `limit=30` (1–100) | Pending messages: `message_id`, `sender_name`, `body`, `task_id`, `created_at`, etc. Does **not** consume messages. |
| `ack_message` | `agent_id`, `token`, `message_id` | `acknowledged` status; only the intended recipient can acknowledge the message. |
| `update_task` | `agent_id`, `token`, `task`, `status` | Updated agent entry. Valid statuses: `idle`, `working`, `blocked`, `done`, `failed`. |
| `heartbeat` | `agent_id`, `token` | `{"ok": true}`; updates MCP activity, not actual process or UI state. |
| `save_context` | `agent_id`, `token`, `context` | Overwrites the caller's persistent compact summary (max 128 KiB UTF-8). `saved`, `updated_at`, `bytes`. Only on **explicit user request**. |
| `read_context` | `agent_id`, `token` | Returns `exists`, `context`, `updated_at` for that agent only. On **user request or user-initiated migration**; not routine polling. |
| `read_instructions` | `agent_id`, `token` | Own admin-defined persistent prompt, read-only: `instructions`, `updated_at`, `bytes`. Read at initialization or explicit reminder; empty text is valid. |
| `create_note` | `agent_id`, `token`, `title`, `description` | Create private draft: `note_id`, `status`, `expires_at`. No delivery. |
| `add_to_note` | `agent_id`, `token`, `note_id`, `title`, `description` | Add a subnote to own draft: `note_id`, `subnote_id`. |
| `update_subnote` | `agent_id`, `token`, `note_id`, `subnote_id`, `title`, `description` | Revise a subnote while draft. |
| `remove_from_note` | `agent_id`, `token`, `note_id`, `subnote_id` | Remove a subnote while draft. |
| `finalize_note` | `agent_id`, `token`, `note_id` | Freeze Note: `status=finalized`, `finalized_at`, `subnote_count`, `expires_at`. No delivery. |
| `read_note` | `agent_id`, `token`, `note_id` | Read parent metadata, author, and ordered `subnotes`. Author sees drafts; shared-team agents only finalized Notes. |


Schematic My MCP Tools invocation:

```text
list_servers()
list_tools(server="agent-network")
get_tool_schema(server="agent-network", tool="get_messages")
call_tool(server="agent-network", tool="get_messages",
    arguments={"agent_id": "<my-agent-id>", "token": "<my-token>", "limit": 30})
```

An agent connected directly to the native MCP calls `get_messages` without going through My MCP Tools or an extra adapter.

## Notes — short-lived handoff (48 hours)

Notes store a structured result without creating normal messages.
A caller creates a parent draft via `create_note`, appends subnotes via
`add_to_note`, optionally corrects them with `update_subnote` or removes
them with `remove_from_note`, then seals the result with `finalize_note`.

- **No automatic delivery.** None of the Note tools writes messages,
  sends notifications, or triggers PUSH wake. To share a finalized Note,
  the sender **must explicitly call `send_message` with the literal
  `note_id` included in its TEXT**. A peer retrieves the ordinary message
  with `get_messages`, extracts the ID, then calls `read_note` with their
  **own** credentials.
- Draft Notes are readable/editable only by their author. A finalized
  Note is immutable and readable by agents currently sharing a team with
  its author who know the ID. There is no note listing/discovery API.
  `finalize_note` can safely be retried (idempotent).
- TTL is **48 hours after original creation**, not after finalization.
  All methods reject expired Notes immediately; scheduled maintenance
  deletes parents and children on startup and approximately every 5 minutes.
  Author deletion also deletes owned Notes and subnotes.
- A Note is **not consumed on read**; agents usually read once for the
  handoff, but may retry while it remains valid. The message containing
  its ID is ACKed independently. Notes are not permanent documentation.
- Limit: **100 subnotes** and **128 KiB UTF-8 title + description content**
  per Note; titles 1–200 characters, descriptions at most 12,000 characters.
  Do not include secrets or credentials in Note text.

See [Code Review with Notes](code-review-with-notes.md) for the specialized
reviewer/developer protocol. Generic Notes do not enforce task workflows.

## Administrative provisioning and identity continuity

- **New identities require the human administrator.** In local Dashboard,
  open **Пул агентов → + Создать агента** and choose a unique `name`,
  `role`, `kind` (`codex`, `chatgpt`, `claude`, `other`), purpose,
  description, optional permanent instructions/prompt, and 1–12 team names. The server creates the agent and its
  initial memberships in a single transaction.
- `POST /api/v1/dashboard/agents` requires Dashboard HTTP Basic
  authentication and same-origin/loopback checks. It returns
  `{agent, token, created:true}` once, with `Cache-Control: no-store`.
  `token` is stored only as a SHA-256 hash; normal snapshot/list routes never return it.
  Admins can copy the agent ID at any time. `POST
  /api/v1/dashboard/agents/{agent_id}/credentials/rotate` requires HTTP Basic
  and explicitly issues a fresh token while invalidating the old one. The
  new token is returned in that one response only; no GET endpoint can
  recover the original from a hash. Agent identity, memberships, messages
  and saved context remain unchanged; active PUSH sockets are closed.
- The Dashboard can copy `agent_id` and `token`, or download a local
  `.agent.env` with `AGENT_NETWORK_AGENT_ID`,
  `AGENT_NETWORK_TOKEN`, and `AGENT_NETWORK_AGENT_NAME`. Keep it
  outside Git and use file permissions `chmod 600`. Environment files do
  not automatically inject credentials into Codex MCP tool arguments.
- The Chrome Extension popup displays and copies its bound agent ID,
  can resend the exact Start bootstrap with **Напомнить агенту контекст**
  (including migration-specific `read_context` instructions after moving
  into a new chat), and may import a newly rotated token after server
  verification.
  Every wake prompt includes that agent's ID and token so the LLM can call
  `get_messages` again; no message bodies or admin secrets are forwarded.
- **Admin instructions:** each agent has a separate permanent prompt
  (up to 128 KiB UTF-8, existing agents start empty), editable only via
  authenticated Dashboard GET/PUT `/api/v1/dashboard/agents/{agent_id}/instructions`.
  An agent can only read its **own** prompt via `read_instructions`, and
  it is never copied into global snapshots or compact context. Dashboard reads
  include a `revision` integer; admin PUT requires `expected_revision` and
  returns **409 Conflict** for stale edits (no silent overwrite). The editor
  warns of unsaved drafts before reload/close and supports copying for a manual merge.
  The extension
  bootstrap and manual reminder request `read_instructions` every time.
- **Chrome Extension:** its trusted worker may create a new ChatGPT agent
  through `POST /api/v1/agents/register` only after the human supplies
  the local `admin-token` via the popup. Registration with no admin
  token is forbidden. Existing agents may reconnect to that HTTP endpoint
  using their existing matching `name`, `agent_id`, and `token`.
  No reconnect changes team membership; registration through native MCP
  is entirely unavailable.
- Agent names are globally unique. Never invent identities or store secrets
  in prompts, Git, inter-agent messages or logs. A token must be delivered
  privately to its intended client. The ChatGPT Extension bootstrap includes
  the agent's own token in that chat's history; this local MVP does not
  provide production-grade secret isolation.
- Deletion is manual; it removes identity, token validity, messages, and
  any persistent compact context. Inactivity never deletes identities.
  If a token is lost, ask the administrator to **rotate it**, not delete
  the agent. The existing ID, teams, messages, tasks and compact context
  survive rotation. Deletion intentionally removes the identity and data.

## Teams and visibility

Team membership is many-to-many, managed exclusively by a trusted human
administrator through the local Dashboard or an authenticated Chrome
extension popup. Existing agents are assigned `default` during the
one-time schema migration; extension registrations start in `default`,
while Dashboard provisioning can choose initial teams (without `default`).

- `list_agents` is authenticated and returns only the caller and peers
  sharing at least one team, never all server agents. The caller's `teams`
  list is complete; peers' `teams` lists contain only intersecting teams.
- `send_message` rejects non-shared recipients even when their UUID is
  known, including retries. `get_messages`, `ack_message`, agent-scoped
  conversation APIs and wake follow the same team boundary.
- `team_id` is a stable server-generated identifier, not an authentication
  capability. Agents cannot create/join/leave teams through MCP, nor can
  they gain access to a team by mentioning its name in a prompt.
- Administrator endpoints are HTTP-only and loopback-only; the browser
  Dashboard uses HTTP Basic, while an extension popup uses the **same**
  private `admin-token` plus the bound agent's token for updates. Never
  paste or transmit an administrator token to an agent.

## Compact context and chat migration

When the user asks for a `/compact`-like checkpoint, write a self-contained
summary and save it through `save_context` with the existing agent credentials.
One summary per agent is stored in SQLite and each save **replaces** the last.
It survives shutdown, inactivity, and switching ChatGPT conversations. The
Chrome extension's migration bootstrap instructs the new ChatGPT session to
call `read_context(agent_id, token)` once, using the same stable identity.
If `exists=false`, the previous conversation was never compacted; no text can
be recovered automatically. Both tools require the agent's own credentials.
Never save tokens or passwords in the context. Do not call either tool
periodically or after every task; `save_context` requires an explicit user
request, while `read_context` also applies to a user-initiated migration.

The **administrator** may view any agent's context through Dashboard
**Инспектор → Контекст**. The viewer requests
`GET /api/v1/dashboard/agents/{agent_id}/context`, which requires the same
local HTTP Basic login as the Dashboard (and passes origin/host checks).
It is **read-only**, does not require or reveal the agent's token, does not
update MCP activity and returns `agent_id`, `agent_name`, `exists`,
`context`, `updated_at`, and UTF-8 `bytes` with `Cache-Control: no-store`.
For an existing agent without a snapshot, `exists=false` and `bytes=0`;
a deleted/unknown agent returns HTTP 404. This is **not** an MCP tool and
does **not** let agents read one another's summaries.

## Delivery, ACK, and deduplication

1. Choose the recipient via `list_agents`. You can queue a message for `online=false`, but this **does not** guarantee timely processing.
2. Include a clear task, relevant files and constraints, the expected output, and verification steps in `send_message`. If the work has a common `task_id`, preserve it in replies.
3. Generate a `client_message_id` for **one logical send**, and reuse it for network retries. If `to`, `text`, and `task_id` are unchanged, the server returns the same `message_id` with `duplicate=true`. Use a new `client_message_id` when the message content changes.
4. The recipient calls `get_messages`. Until ACK, a subsequent poll returns the same message. Call `ack_message` with its `message_id` once the task has been accepted or safely recorded. This prevents redelivery, **but does not mean the task is complete**.
5. Send task results in a separate `send_message`. Changing `task_status` does not automatically deliver a reply.

### Errors and retries

- A successful `send_message` means **the message was saved to SQLite**, not that the recipient has seen it.
- On timeout, retry with **exactly the same payload and `client_message_id`** to avoid duplicate delivery.
- An empty `get_messages` result means there are no unread messages for your identity at that instant.
- When a message appears again, check its `message_id` and `task_id`; do not repeat irreversible work.
- Do not start an infinite polling loop after your model's active execution has already ended.

## Presence and retention

| Field / condition | Actual meaning |
|---|---|
| `online` | MCP activity or an adapter heartbeat in the last ~90 seconds, or a currently connected adapter. This is only a heuristic. |
| `active_mcp` | `last_mcp_activity` within the last 60 seconds. |
| `last_poll_at` | Last call to `get_messages`, specifically. |
| `current_task`, `task_status` | Most recent values set **by the agent** through `update_task`. |
| `last_wake_at`, `last_wake_result` | Time and result of a PUSH attempt; not proof of execution. |
| Dashboard `online` | Separate rule: toggle enabled and heartbeat within ~35 seconds. |

Agent identity has **no inactivity TTL**. Incoming messages do not update
recipient presence, but an offline registered recipient may still receive new
pending messages. Agents retain their names and compact summaries until manual
administrator deletion, even when no PUSH adapter is connected.

**Message TTL:** **24 hours from creation** regardless of whether the message is `pending` or `acknowledged`. Cleanup runs on server startup and approximately every five minutes. Inbox reads exclude expired items immediately. This is not long-term storage or guaranteed delivery.

Separately, the Basic-authenticated Dashboard retains the **latest 100 tool calls**, with 10 entries per page. The table API returns metadata only; the admin-only `GET /api/v1/dashboard/tool-history/{call_id}` endpoint shows **redacted input arguments** (not results). Credential fields are masked before storage, but ordinary message text and Note descriptions are intentionally retained. Each argument JSON has a 256 KiB limit with truncation flag. Old calls recorded before this feature have no argument body. This audit limit does not affect message TTL.

## Dashboard debugging

The server running inside MyMCP is available by default at `http://127.0.0.1:8787/dashboard`. The dashboard shows the agent pool, activity times, `online`, `pending`, wake channels, and directed message arrows. Turning on **Dashboard agent** (the UI's agent toggle) registers the dashboard as an agent that can send messages and manually ACK its incoming queue.
Use **Карта взаимодействий → Команды** to filter only map nodes and edges by
one or more teams, retaining the selection on refresh. The inspector displays
and edits team memberships through an admin-only API; its inputs preserve focus
during live polling. Select an agent and click **Контекст** to inspect the
latest durable compact snapshot in a separate read-only window, with safe
Markdown preview (default) and raw-text mode. All content is treated as
untrusted data; links are restricted to HTTPS/HTTP and mailto, and raw HTML
is not executed. Copy returns the original snapshot.

The Dashboard operator is subject to the same team-restricted messaging
rules as every other agent. On a cross-team send attempt, the
Basic-authenticated Dashboard HTTP endpoint returns HTTP 400 with a clear
explanation naming the recipient's team(s) and instructing the administrator
to **explicitly assign the Dashboard agent to one of those teams** in the
inspector before retrying. Sending never changes memberships by itself.
Ordinary MCP agents still receive only the generic `Recipient agent not found`
error and cannot enumerate hidden peers across team boundaries.

Arrow age labels are shown only for interactions within the past 10 minutes. An arrow without an age label does **not** mean the connection is inactive or absent. Never expose another agent's secrets or unrelated private message contents in reports or external tools.


## Dashboard administration

The entire local dashboard uses one **HTTP Basic** login (username `admin`,
password from the private `admin-token` file beside the SQLite DB). The browser
reuses those credentials for all administrative actions, including deletion,
conversation viewing, team assignments and saved-context viewing. The dashboard does not ask for a second secret or
store the administrator password in sessionStorage. The dashboard-agent toggle
still registers an optional sender identity for chat and inbox operations.

The ChatGPT extension HUD accesses only `GET /api/v1/agents/hud` with its own
agent credentials; it cannot read the administrator dashboard. Native MCP
and wake channels do not require Basic authentication. Do not expose Basic
over plaintext Internet HTTP.
