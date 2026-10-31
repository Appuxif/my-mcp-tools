# Agent instructions — agent-first private MCP bridge

Goal: make `./mcp-bridge setup && ./mcp-bridge start` bring arbitrary MCPs (stdio / Streamable HTTP / SSE, including static headers) to one **private ChatGPT plugin** on Ubuntu/macOS.

## Operating rules

1. Read README.md and config/mcp.json, detect OS/architecture and existing tools first.
2. Do not import or package any legacy `cloudflare/` directory: it belongs to a separate, private setup and may contain secrets.
3. Use upstream `@ni-c/mcp-hub`, not a custom MCP protocol implementation. Keep npm package pinned. OpenAI default: `tunnel-client` runs `mcp-hub --stdio`. SSH fallback: local mcp-hub HTTP OAuth + reverse SSH via VPS.
4. Do not request or display secret keys in chat. Ask user only for required OAuth/permissions/account access. Never invent `tunnel_id`, fabricate successful ChatGPT connection, or store credentials in code. Use .env (600), ignored by git.
5. Never publish Blender/Terminal/Chrome directly or bind raw MCP traffic to the public internet. SSH reverse port must bind VPS loopback. If changing upstream mcp-hub version, verify `bind-loopback.cjs` still forces local loopback.
6. On Ubuntu **and macOS**, run `python3 -m unittest discover -s tests -v`, `./mcp-bridge doctor --smoke`; do live tests with actual Blender/Chrome only when user has those running. Report which platforms were actually tested and which were reviewed statically.
7. First test MCP `initialize`, then `tools/list`, `list_servers`, and tool schemas; don't call write/delete/terminal execution tools during unattended validation.
8. Test an end-to-end ChatGPT connector only after OpenAI tunnel permissions and runtime key are available. A green local MCP check does not mean an external plugin has been successfully connected.
9. For Linux/Russia network variance, retain `HTTPS_PROXY` support, SSH tunnel mode and offline bootstrap guidance, avoiding Cloudflare dependence.
10. Only change configs and install dependencies as necessary. Do not overwrite user's .env or existing cloudflare credentials.

## Relevant paths

- `mcp-bridge`: Python cross-platform CLI. Actions `setup`, `doctor`, `start`; flags `--mode openai|ssh`.
- `config/mcp.json`: canonical MCP definitions (add any number of upstreams).
- `.env.example`: credentials/connection template. Real `.env` ignored.
- `bind-loopback.cjs`: local-only security for SSH fallback.
- `package-lock.json`: pinned npm dependency tree.
- `.local/`: installed tunnel binary, runtime profiles, logs/state (ignored).

## Before claiming ready

- Confirm `mcp-hub` starts; parse JSONRPC initialize/tools list.
- Confirm Blender add-on connectivity (separate from hub starting), Chrome debugger, terminal.
- Verify `tunnel-client doctor --profile ...` when keys and tunnel ID exist.
- Inspect the OpenAI ChatGPT private connector discovery and make a **read-only** call. Otherwise report `pending OpenAI credentials/permissions`.
- Verify SSH fallback only if a real VPS and HTTPS domain are configured; don't silently provision public infrastructure or modify firewall rules.
