# Agent MCP Bridge

Private, **agent-first** MCP aggregation for ChatGPT on **Ubuntu and macOS**.
Powered by [mcp-hub](https://github.com/ni-c/mcp-hub) (version pinned in `package-lock.json`), not a custom MCP implementation.

## Architecture

**Default (OpenAI private tunnel):** ChatGPT → OpenAI Secure MCP Tunnel → `tunnel-client` → `mcp-hub --stdio` → only the MCP servers defined in `config/mcp.json`.

- One local MCP configuration, one private ChatGPT connection.
- No Cloudflare, domain, publicly exposed port, OAuth gateway, or VPS.
- OAuth / plugin access is **managed by OpenAI** in this mode. `mcp-hub`'s own OAuth is not running in `--stdio` mode.
- Agent controls setup; private OpenAI authorization requires an operator to supply a runtime key and tunnel ID with suitable permissions.

**Fallback (SSH):** ChatGPT → HTTPS on VPS (Caddy) → one SSH reverse-forward → `mcp-hub` HTTP + built-in OAuth → same MCP config.

- SSH fallback requires a VPS, DNS hostname, TLS, and a one-time reverse proxy config, but **no Cloudflare account**.
- The localhost Node binding shim protects the hub HTTP listener. Never expose the raw local port to the Internet; only the VPS reverse proxy is public.

## Quick start (on Ubuntu or macOS)

Core prerequisites: Python 3.9+, Node.js 22+ and npm (Ubuntu or macOS). **No Blender, Chrome, or uv dependency unless you actually configure an MCP that requires it.** The agent should install/check only the prerequisites of the selected upstream MCPs.

```bash
cd path/to/my-mcp-tools
./mcp-bridge setup
./mcp-bridge doctor --smoke
```

`setup` installs pinned `@ni-c/mcp-hub` and an official versioned `tunnel-client` release matching Linux/macOS amd64/arm64, creates private `.env` and an **empty local** `config/mcp.json` when absent. It never overwrites an existing MCP config or `.env`. The local config is Git-ignored. To use your own preinstalled binary, set `TUNNEL_CLIENT=/absolute/path`.

Create or select a private tunnel at:

- **Tunnel management:** https://platform.openai.com/settings/organization/tunnels
- **Runtime API keys:** https://platform.openai.com/settings/organization/api-keys

The runtime key principal needs **Tunnels Read + Use** permission. Use a separate admin key only if your agent is authorized to create/manage tunnel resources; do not leave admin keys in the runtime env.

Put `CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` into `.env`, or export as environment variables. Keys are **never required in `config/mcp.json`**.

```bash
./mcp-bridge doctor --smoke
./mcp-bridge doctor --live
./mcp-bridge start
```

During operation, the OpenAI runtime exposes a local health UI on an ephemeral loopback port (it writes the URL to `.local/health.url`). Browse the health URL plus `/ui` or `/healthz` to verify its state.

**ChatGPT connection:** While runtime is healthy, visit https://chatgpt.com/#settings/Connectors and create/verify the private tunnel connector. A functioning local runtime is **not proof** the ChatGPT connector was provisioned; check connector discovery and an actual MCP call in ChatGPT.

To stop, press Ctrl+C. The process terminates its managed child. Do not background it with `nohup` as a substitute for supervision; production persistence can use OpenAI's documented `runtimes connect`, or a platform-specific service manager.

> **Availability and pricing:** OpenAI account/organization entitlements, regional availability, and any tunnel charges must be verified in the Platform UI. No universal free-cost guarantee. The default connection requires an outbound connection to `api.openai.com:443`; VPN routes work transparently and HTTP(S) proxies are supported via `HTTPS_PROXY` or the tunnel client's proxy settings.

## MCP configuration: the project is server-agnostic

**The bridge has no built-in MCPs.** Only `config/mcp.json` (a Git-ignored local file, using the standard `mcpServers` map) decides which upstreams run. `setup` creates an empty config when missing and never overwrites a current one. `config/mcp.example.json` contains three **optional examples**, not automatic defaults. Every stdio, Streamable HTTP or SSE MCP is optional; the core never installs or starts an MCP unless it appears in the local config.

Example: **only Blender + Terminal**:

```json
{
  "mcpServers": {
    "blender": { "command": "uvx", "args": ["mcp-for-blender"] },
    "terminal": {
      "command": "uvx",
      "args": ["-q", "--from", "open-terminal[mcp]==0.14.7", "python", "-c", "from open_terminal.mcp_server import mcp; mcp.run(transport='stdio')"],
      "env": { "OPEN_TERMINAL_API_KEY": "${OPEN_TERMINAL_API_KEY}" }
    }
  }
}
```

To configure from examples: `cp config/mcp.example.json config/mcp.json`, then **remove every server you do not want**. Or leave the empty file created by `setup` and copy in only the entries you need. Do not edit the example for personal settings. Example package installation and GUI setup are up to the agent based on selected commands, **not** hardcoded in the bridge.

For Open Terminal in this example, set `OPEN_TERMINAL_API_KEY` in local `.env` (e.g. generate a random key with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`). The bridge never guesses credentials for arbitrary MCPs. For Chrome autoConnect, enable remote debugging in Chrome and grant its permission; Blender needs its add-on running.

Later, to enable Chrome DevTools, add this entry to the same `mcpServers` map:

```json
"chrome-devtools": {
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"]
}
```

**Hot reload:** mcp-hub watches `config/mcp.json`, so adding or removing entries updates the running hub automatically. A newly configured server is launched on demand. You do **not** need a new tunnel, additional ChatGPT connector, or another domain. Make sure the file remains valid JSON during editing (prefer atomic saves). The existing ChatGPT connection still exposes the same six mcp-hub meta-tools; server discovery via `list_servers` reflects current config.

Example remote HTTP MCP with a header:

```json
"remote-mcp": {
  "type": "http",
  "url": "https://example.org/mcp",
  "headers": { "Authorization": "Bearer ${UPSTREAM_MCP_TOKEN}" }
}
```

Set `UPSTREAM_MCP_TOKEN` in local `.env` or the process environment. Upstream OAuth and SSE are supported by mcp-hub too. See [mcp-hub configuration](https://mcp-hub.ni-c.de/guide/configuration).

**Note:** Variables from `.env` are loaded at **bridge startup**. Changes to the JSON config hot-reload; adding a *new* environment variable to `.env` requires restarting the bridge so the new variable enters its process environment. `mcp-bridge doctor --smoke` checks tool discovery, using only configured MCPs.

The aggregate exposes **six meta-tools**, so the model chooses server and tool via `list_servers` → `list_tools` → `call_tool`. It is not a direct list of every upstream tool in the connector.

### macOS notes

- `setup` detects `Darwin arm64` (Apple Silicon) or `Darwin x86_64` (Intel) and downloads the matching official tunnel-client binary.
- Install core prerequisites using Homebrew, e.g. `brew install node python`, if missing; install `uv` only if one of the selected MCPs needs it.
- macOS may prompt for permissions to allow Blender, Chrome, or Terminal access.
- If Chrome DevTools is **configured**, `--autoConnect` needs supported Chrome and remote debugging. Otherwise Chrome is not required at all.
- Avoid absolute Linux paths in MCP definitions; `uvx`, `npx`, and config path resolve via environment.

## SSH/VPS fallback

Use SSH if OpenAI's control plane cannot be reached even through the user's approved VPN/proxy (or if the private tunnel feature is unavailable).

1. Set in `.env`:
   - `EXTERNAL_URL=https://mcp.your-domain.com`
   - `SSH_TARGET=user@your-vps` (must authenticate with SSH key)
   - `SSH_REMOTE_PORT=17690` (VPS loopback port)
   - `MCP_PORT=7690`
   - `PASSWORD_HASH` = bcrypt hash produced by `htpasswd -bnBC 10 "" 'long-unique-password' | tr -d ':\\n'` (use a password manager, never paste it into a committed file).
2. Configure DNS to VPS, Caddy HTTPS/TLS on VPS, and reverse proxy to `127.0.0.1:17690`:
   ```caddyfile
   mcp.your-domain.com {
       reverse_proxy 127.0.0.1:17690 {
           flush_interval -1
       }
   }
   ```
3. VPS sshd must permit `AllowTcpForwarding remote`. Keep `GatewayPorts no` (default) so the reverse port stays on VPS loopback. Do not open port 17690 in the firewall; only public 443/80 for Caddy.
4. Launch on the local machine:
   ```bash
   ./mcp-bridge setup --mode ssh
   ./mcp-bridge doctor --mode ssh --live
   ./mcp-bridge start --mode ssh
   ```
5. Register **one private ChatGPT custom connector** at `https://mcp.your-domain.com/hub`. mcp-hub handles OAuth login itself using `PASSWORD_HASH`. All OAuth discovery paths, redirects and /hub must reach the *same* local hub through the same reverse tunnel.

Unlike OpenAI Secure MCP Tunnel, SSH fallback publishes one authenticated HTTPS gateway through your VPS; it is not an OpenAI-hosted private tunnel. This fallback necessarily needs a public HTTPS hostname that ChatGPT can resolve.

## Network / VPN considerations

- `tunnel-client` talks to OpenAI using outbound HTTPS. For transparent VPNs, no special config is needed. For HTTP proxies, set `HTTPS_PROXY` or configure the tunnel client's outbound proxy. HTTP proxy authentication/security depends on your proxy.
- SSH is a different egress path: use a reachable VPS and `~/.ssh/config` (e.g. `ProxyCommand` or `ProxyJump`) if the SSH route needs a proxy/VPN.
- `uvx` and `npx` may require registry downloads at setup/start. Pre-install and pin packages when offline/regional blocking is a concern.
- Neither transport guarantees operation under all censorship/VPN conditions; test both paths from the user's network.

## Safety

**Treat configured local MCP servers (especially Terminal, Blender or browser debugging) as potentially having full local-machine privileges.** An agent connected through these tools can modify or delete files, execute shell commands, or read browser content.

- Private ChatGPT connector does not mean safe commands: use explicit human approval for destructive actions.
- Avoid untrusted third-party MCP packages; review and pin each version. Version-pin third-party MCP packages after verifying compatibility with the target OS.
- `mcp-hub --stdio` runs local subprocesses as the signed-in user. No sandbox.
- Never commit `.env`, OAuth client state, keys or tunnel profiles. `.gitignore` excludes those.
- Legacy Cloudflare configuration is **not part of the portable project** and must not be shared. If migrating from a prior setup with embedded tokens, rotate those credentials.

## Documentation

- [OpenAI tunnel onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
- [mcp-hub](https://github.com/ni-c/mcp-hub)
- [mcp-hub config and transports](https://mcp-hub.ni-c.de/guide/configuration)
- [mcp-hub security model](https://github.com/ni-c/mcp-hub/blob/main/SECURITY.md)
