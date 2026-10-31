# Agent instructions — agent-first private MCP bridge

Goal: make `./mcp-bridge setup && ./mcp-bridge start` bring **only the MCPs selected in local `config/mcp.json`** (stdio / Streamable HTTP / SSE, including static headers) to one private ChatGPT plugin on Ubuntu/macOS. The core MUST remain agnostic about all upstream MCP names, binaries, prerequisites and credentials.

## Operating rules

1. Read README.md and local config/mcp.json (setup creates an empty file; config/mcp.example.json contains optional examples), detect OS/architecture and existing tools first. Never assume Blender, Chrome or Terminal is requested; ask which MCPs to configure if not specified.
2. Do not import or package any legacy `cloudflare/` directory: it belongs to a separate, private setup and may contain secrets.
3. Use upstream `@ni-c/mcp-hub`, not a custom MCP protocol implementation. Keep npm package pinned. OpenAI default: `tunnel-client` runs `mcp-hub --stdio`. SSH fallback: local mcp-hub HTTP OAuth + reverse SSH via VPS.
4. Do not request or display secret keys in chat. Ask user only for required OAuth/permissions/account access. Never invent `tunnel_id`, fabricate successful ChatGPT connection, or store credentials in code. Use .env (600), ignored by git.
5. Never publish any upstream MCP directly or bind raw MCP traffic to the public internet. SSH reverse port must bind VPS loopback. If changing upstream mcp-hub version, verify `bind-loopback.cjs` still forces local loopback.
6. On Ubuntu **and macOS**, run `python3 -m unittest discover -s tests -v`, `./mcp-bridge doctor --smoke`; do live tests with GUI applications or other upstreams only if **configured** and available. Report which platforms were actually tested and which were reviewed statically.
7. First test MCP `initialize`, then `tools/list`, `list_servers`, and tool schemas; don't call write/delete/terminal execution tools during unattended validation.
8. Test an end-to-end ChatGPT connector only after OpenAI tunnel permissions and runtime key are available. A green local MCP check does not mean an external plugin has been successfully connected.
9. For Linux/Russia network variance, retain `HTTPS_PROXY` support, SSH tunnel mode and offline bootstrap guidance, avoiding Cloudflare dependence.
10. Only change configs and install dependencies as necessary based on the selected MCP entries. Do not overwrite user's .env or existing configuration; do not attempt to install optional upstream MCPs not listed in config.

## Relevant paths

- `mcp-bridge`: Python cross-platform CLI. Actions `setup`, `doctor`, `start`; flags `--mode openai|ssh`.
- `config/mcp.json`: private, user-owned and Git-ignored; canonical MCP definitions, edited by the agent. Never overwrite on setup.
- `config/mcp.example.json`: Blender, Terminal and Chrome examples; **never enabled unless explicitly copied into local `config/mcp.json`**. This example may be committed, but the local config must remain Git-ignored.
- `.env.example`: credentials/connection template. Real `.env` ignored.
- `bind-loopback.cjs`: local-only security for SSH fallback.
- `package-lock.json`: pinned npm dependency tree.
- `.local/`: installed tunnel binary, runtime profiles, logs/state (ignored).

## Before claiming ready

- Confirm `mcp-hub` starts; parse JSONRPC initialize/tools list.
- Confirm discovery and readiness of only the MCP servers present in config/mcp.json; an empty config is allowed, but exposes no upstreams.
- Verify `tunnel-client doctor --profile ...` when keys and tunnel ID exist.
- Inspect the OpenAI ChatGPT private connector discovery and make a **read-only** call. Otherwise report `pending OpenAI credentials/permissions`.
- Verify SSH fallback only if a real VPS and HTTPS domain are configured; don't silently provision public infrastructure or modify firewall rules.
