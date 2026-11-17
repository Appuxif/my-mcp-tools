# Agent Network: native MCP tools and identity lifecycle

Verified against `tools/agent-network/agent_network/server.py` and `store.py`. If the implementation changes, the live MCP `get_tool_schema` takes precedence over this reference.

## Seven tools

| Tool | Arguments | Result |
|---|---|---|
| `register_agent` | `name`, `role`; optional `kind="other"`, `purpose`, `description`, `agent_id`, `token` | `agent`, `token`, `created`: create or reconnect an identity. |
| `list_agents` | `agent_id`, `token` | Agent names, roles, `kind`, tasks, activity timestamps, and `online`. |
| `send_message` | `agent_id`, `token`, `to`, `text`; optional `task_id`, `client_message_id` | `message_id`, `duplicate`. `to` accepts a name or UUID. |
| `get_messages` | `agent_id`, `token`; optional `limit=30` (1–100) | Pending messages: `message_id`, `sender_name`, `body`, `task_id`, `created_at`, etc. Does **not** consume messages. |
| `ack_message` | `agent_id`, `token`, `message_id` | `acknowledged` status; only the intended recipient can acknowledge the message. |
| `update_task` | `agent_id`, `token`, `task`, `status` | Updated agent entry. Valid statuses: `idle`, `working`, `blocked`, `done`, `failed`. |
| `heartbeat` | `agent_id`, `token` | `{"ok": true}`; updates MCP activity, not actual process or UI state. |

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
- `token` is an agent secret. Do not send it to peers, publish it, or commit it to Git. The ChatGPT extension's bootstrap prompt includes the token in the conversation history; this local MVP does **not** provide production-grade secret isolation.
- If an identity was manually removed or expired after 24 hours of inactivity, the old `agent_id` and `token` no longer work. Registration under an available name creates a new UUID and token.

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

Inbound messages do not update the recipient's activity; reconnecting with
valid credentials does. Expired recipients reject new sends. If a recipient
has pending unexpired messages, deletion is deferred until those messages
have enjoyed their entire 24-hour TTL, even if the recipient remains idle.
A connected PUSH adapter also protects a registered identity from cleanup.

**Message TTL:** **24 hours from creation** regardless of whether the message is `pending` or `acknowledged`. Cleanup runs on server startup and approximately every five minutes. Inbox reads exclude expired items immediately. This is not long-term storage or guaranteed delivery.

Separately, the dashboard retains only the **latest 100 tool calls**, without arguments or secrets, with 10 entries per page. This audit limit does not affect message TTL.

## Dashboard debugging

The server running inside MyMCP is available by default at `http://127.0.0.1:8787/dashboard`. The dashboard shows the agent pool, activity times, `online`, `pending`, wake channels, and directed message arrows. Turning on **Dashboard agent** (the UI's agent toggle) registers the dashboard as an agent that can send messages and manually ACK its incoming queue.

Arrow age labels are shown only for interactions within the past 10 minutes. An arrow without an age label does **not** mean the connection is inactive or absent. Never expose another agent's secrets or unrelated private message contents in reports or external tools.


## Dashboard administration

Administrative deletion requires a separate local administrator token stored
beside the SQLite DB in `admin-token` (mode 0600). It does **not** require
registering a dashboard agent; the browser requests the token separately
and stores it in per-tab `sessionStorage`. The local dashboard is not a
public multiuser administration interface. Do not share the token.
