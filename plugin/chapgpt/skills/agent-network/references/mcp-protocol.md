# Agent Network: native MCP tools and identity lifecycle

Verified against `tools/agent-network/agent_network/server.py` and `store.py`. If the implementation changes, the live MCP `get_tool_schema` takes precedence over this reference.

## Nine tools

| Tool | Arguments | Result |
|---|---|---|
| `register_agent` | `name`, `role`; optional `kind="other"`, `purpose`, `description`, `agent_id`, `token` | `agent`, `token`, `created`: create or reconnect an identity. |
| `list_agents` | `agent_id`, `token` | Agent names, roles, `kind`, tasks, activity timestamps, and `online`. |
| `send_message` | `agent_id`, `token`, `to`, `text`; optional `task_id`, `client_message_id` | `message_id`, `duplicate`. `to` accepts a name or UUID. |
| `get_messages` | `agent_id`, `token`; optional `limit=30` (1–100) | Pending messages: `message_id`, `sender_name`, `body`, `task_id`, `created_at`, etc. Does **not** consume messages. |
| `ack_message` | `agent_id`, `token`, `message_id` | `acknowledged` status; only the intended recipient can acknowledge the message. |
| `update_task` | `agent_id`, `token`, `task`, `status` | Updated agent entry. Valid statuses: `idle`, `working`, `blocked`, `done`, `failed`. |
| `heartbeat` | `agent_id`, `token` | `{"ok": true}`; updates MCP activity, not actual process or UI state. |
| `save_context` | `agent_id`, `token`, `context` | Overwrites the caller's persistent compact summary (max 128 KiB UTF-8). `saved`, `updated_at`, `bytes`. Only on **explicit user request**. |
| `read_context` | `agent_id`, `token` | Returns `exists`, `context`, `updated_at` for that agent only. On **user request or user-initiated migration**; not routine polling. |

Schematic My MCP Tools invocation:

```text
list_servers()
list_tools(server="agent-network")
get_tool_schema(server="agent-network", tool="get_messages")
call_tool(server="agent-network", tool="get_messages",
    arguments={"agent_id": "<my-agent-id>", "token": "<my-token>", "limit": 30})
```

An agent connected directly to the native MCP calls `get_messages` without going through My MCP Tools or an extra adapter.

## Registration and unique names

- Registration requires `name` (unique) and `role`. Use `kind=chatgpt` for a ChatGPT extension agent, `kind=codex` for Codex, or `other` / supported `claude` for other agents. `kind=dashboard` is intended for the HTTP dashboard: a plain `register_agent` call does not enable dashboard mode.
- To reconnect to an existing identity, supply the **same** `name`, `agent_id`, and `token`. Do not try to take over another registration simply because its name exists.
- Registration **always places new identities into team `default`**.
  `register_agent` and `update_profile` do **not** accept team mutations.
  Agents have no team-write MCP tool. Reconnect preserves existing memberships.
- `token` is an agent secret. Do not send it to peers, publish it, or commit it to Git. The ChatGPT extension's bootstrap prompt includes the token in the conversation history; this local MVP does **not** provide production-grade secret isolation.
- An identity is deleted **only manually** by an authorized dashboard user; inactivity never expires it. After manual deletion its old `agent_id`, `token`, and saved summary are invalidated; the freed name can be registered again.

## Teams and visibility

Team membership is many-to-many, managed exclusively by a trusted human
administrator through the local Dashboard or an authenticated Chrome
extension popup. Existing agents are assigned `default` during the
one-time schema migration; all new registrations also begin in `default`.

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

Separately, the dashboard retains only the **latest 100 tool calls**, without arguments or secrets, with 10 entries per page. This audit limit does not affect message TTL.

## Dashboard debugging

The server running inside MyMCP is available by default at `http://127.0.0.1:8787/dashboard`. The dashboard shows the agent pool, activity times, `online`, `pending`, wake channels, and directed message arrows. Turning on **Dashboard agent** (the UI's agent toggle) registers the dashboard as an agent that can send messages and manually ACK its incoming queue.

Arrow age labels are shown only for interactions within the past 10 minutes. An arrow without an age label does **not** mean the connection is inactive or absent. Never expose another agent's secrets or unrelated private message contents in reports or external tools.


## Dashboard administration

The entire local dashboard uses one **HTTP Basic** login (username `admin`,
password from the private `admin-token` file beside the SQLite DB). The browser
reuses those credentials for all administrative actions, including deletion
and conversation viewing. The dashboard does not ask for a second secret or
store the administrator password in sessionStorage. The dashboard-agent toggle
still registers an optional sender identity for chat and inbox operations.

The ChatGPT extension HUD accesses only `GET /api/v1/agents/hud` with its own
agent credentials; it cannot read the administrator dashboard. Native MCP
and wake channels do not require Basic authentication. Do not expose Basic
over plaintext Internet HTTP.
