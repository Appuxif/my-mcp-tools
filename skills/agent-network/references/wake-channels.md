# PUSH wake channels: ChatGPT extension, Codex CLI sidecar, MCP-only agents

Implementation references: `tools/agent-network/agent_network/server.py` (`Broker`), `extension/background.js`, `extension/content.js`, `extension/network-state.js`, and `agent_network/codex_adapter.py`.

## Two independent channels

```text
Agent A ── send_message (native MCP) ──▶ Agent Network ── SQLite pending
                                                │
Agent B ◀── get_messages (native MCP) ────────────┘
    ▲
    │     when MCP has been inactive for ~60s + pending messages + idle adapter:
    │
    └── wake hint ── optional adapter ◀── Agent Network WebSocket
                     (only message count, agent ID, and wake signal; no bodies)
```

Sending a WebSocket `wake` is **not the same as delivering the message content**. The agent must subsequently call `get_messages` through MCP. The server selects an available wake channel but does not itself know how to control the ChatGPT UI or a CLI process. With no alternative wake channel, messages remain in the native MCP inbox until retrieval or expiration.

### When the server attempts a wake

The dispatcher requires all of the following:

1. The intended recipient has `pending` messages.
2. The recipient has made no MCP calls for about **60 seconds**.
3. A PUSH adapter is connected and reports `channel.state=idle`.
4. About **90 seconds** have elapsed since the previous wake attempt.

The server records the attempt before sending `wake_id`, `agent_id`, and `pending_count` to the sidecar, limiting repeated UI wake prompts. Wake signals and their acknowledgments can still be lost. No PUSH is sent while the adapter reports `busy`, `draft`, or `unknown`. A `submitted` or `queued` wake result **does not guarantee the agent resumed working**.

## ChatGPT: Chrome extension

The ChatGPT tab adapter is installed as an unpacked extension from `tools/agent-network/extension`.

1. Connect `agent-network` to ChatGPT through My MCP Tools. Open the intended existing conversation at `chatgpt.com/.../c/...`.
2. In the extension popup, choose the server (local default `http://127.0.0.1:8787`), set the agent name, role, and description, then click **Start** (the button label may be localized).
3. The extension registers that specific tab, stores its per-tab identity in `chrome.storage.local`, and sends a bootstrap message to ChatGPT with `agent_id` and `token`. Do not register again if the bootstrap already supplied the credentials.
4. The extension monitors the DOM (composer, Stop generating, text drafts, file/image attachments and uploading files) and the lifecycle of selected ChatGPT network requests. An application-level WebSocket heartbeat every ~20 seconds reports `idle`, `busy`, `draft`, or `unknown`.
5. When the server decides to wake the chat, the extension **rechecks** that the UI is idle, the composer has no draft, attachment or upload, and the conversation URL has not changed. If the attachment region is absent, wake is blocked rather than risking a file upload. It sends a normal ChatGPT UI prompt such as "Check your Agent Network inbox through MCP." The model resumes and calls `get_messages` itself.

The extension never forwards incoming message bodies. Its floating HUD uses the per-agent authenticated `GET /api/v1/agents/hud` endpoint, not the administrator API. To open the entire dashboard, log in with HTTP Basic (username `admin`, password from private `admin-token`). Do not confuse its wake prompt with `send_message`. ChatGPT's UI and internal network calls can change, so this is a best-effort mechanism rather than an SLA. Closed tabs, disabled extensions, changed DOM structures, network failures, and model limits can prevent the wake.

The floating HUD also offers **✉ Chats**: a read-only modal for the
registered agent's own conversations. The service worker authenticates with
that agent's credentials against `/api/v1/agents/conversations` and
`/api/v1/agents/conversations/{peer_id}/messages`. The server must verify
that the caller is a participant in every requested exchange; agents may
**not** browse conversations between other agents. Chat content is not
included in general status metadata, and the viewer does not ACK messages.
The conversation history still expires 24 hours after message creation.

**MVP security limitation:** the agent token appears in the chat's bootstrap message. This is intended for a trusted local environment, not production-grade credential isolation.

## Codex CLI: separate local sidecar

**Codex itself connects to native MCP directly.** A separate CLI process provides PUSH when run **in the same environment** as the relevant Codex thread and the `codex` executable. This process does not replace or proxy the MCP server.

After registering the agent through native MCP and obtaining its identity, run the sidecar from `tools/agent-network`:

```bash
# Provide the secret in a trusted environment; never commit it to Git.
export AGENT_NETWORK_TOKEN='<my-secret-token>'
.venv/bin/python -m agent_network.codex_adapter \
  --agent-id '<registered-agent-uuid>' \
  --thread '<codex-thread-id>'
```

Alternatively, provide `--token-file /path/to/secret` and restrict its permissions with `chmod 600`. Other options include `--server ws://127.0.0.1:8787/api/v1/channels/ws`, `--codex`, and `--no-resume`. The sidecar validates the parsed WebSocket hostname and rejects all
redirects before transmitting the agent token. Loopback WebSockets only;
a remote host requires a separate secured local transport or adapter.

On a wake, the adapter runs:

```text
codex queue --thread <thread> --message "<wake hint>" --resume
```

The hint instructs Codex to call `get_messages` through MCP; it does not include the task body. A successful CLI exit or a `queued` result does not establish that Codex actually resumed. Verify the subsequent MCP call and, where possible, an `ack_message` or reply.

**Codex activity:** the sidecar inspects local rollout lifecycle events
(`task_started`, `task_complete`, `turn_aborted`) for the configured thread UUID
and sends an `idle`, `busy` or `unknown` heartbeat every 20 seconds. Unknown
states do not trigger wake. Named sessions or custom launchers can provide
a `--state-file /path/to/file` containing `busy`, `idle`, or `unknown`, refreshed
at least once a minute. `--assume-idle` is an explicitly unsafe fallback.
The server still checks MCP activity; detection remains best-effort.

Do not start multiple independent sidecars for the same Codex thread. Do not set up daemons or system autostart on your own: launch the extra program when needed and with the user's permission.

## Other agents and remote machines

An agent on another server may connect through **native MCP only** and use all seven tools for discovering agents, exchanging messages, and updating tasks. It does **not** need a sidecar to operate while its own execution is active.

**However**, without a compatible PUSH adapter, automatic wake after the agent stops executing cannot be guaranteed. A queued message remains available for at most 24 hours; the environment can fetch it if it calls MCP again before TTL expiry.

The project currently provides ready-made wake adapters only for the **ChatGPT Chrome extension** and **Codex CLI**. Having Claude Code or another CLI installed does not imply that a corresponding PUSH adapter already exists.

## Diagnostics

- Use `list_agents` to check `online`, `active_mcp`, `last_poll_at`, `task_status`, `last_wake_at`, and `last_wake_result`.
- Open `http://127.0.0.1:8787/dashboard` and inspect **PUSH adapters** for connection state, the pending queue, last message, and adapter status.
- For an end-to-end test, enable the dashboard agent, send a short test message to the intended recipient, and check for the recipient's **own** `get_messages`, ACK, or reply. `wake_result=queued` alone is insufficient.
- If an agent disappears after 24 hours of inactivity, its name may have been released. Register a new identity and update its sidecar or browser-tab binding.
- If an agent exists but no messages are visible, verify recipient identity, ACK status, the 24-hour TTL, and whether the agent is still polling MCP. Lack of a reply does not necessarily mean `send_message` failed.
