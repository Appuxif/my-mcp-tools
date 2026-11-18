# Terminal MCP tool and process guide

The server is currently reachable as `terminal` through My MCP Tools hub. Discover current tools and schemas; their precise argument names may change.

## Tool families

| Function | Current tools |
|---|---|
| Files | `list_files`, `read_file`, `display_file`, `write_file`, `replace_file_content` |
| Finding content | `grep_search`, `match_files`, `search_files`, `glob_search` |
| Processes | `run_command`, `get_process_status`, `list_processes`, `send_process_input`, `kill_process` |
| User-connected terminal | `read_user_terminal`, `send_user_terminal_input` |

`read_file` can return image content; use it for an existing file when no OS-level UI is needed. `display_file` opens in the user's viewer; that is a user-visible desktop action, not a mere read.

## Shell execution pattern

`run_command` accepts `command`, optional `cwd`, `wait` and `tail`. It can return a command identifier or complete output. If a process is still running, call `get_process_status` using its actual schema, then read the incremental output and terminal exit code. The absence of stdout is not proof a command has succeeded.

Example request (adapt paths to the project):

```json
{
  "command": "python3 -m unittest discover -s tests -v",
  "cwd": "/path/to/authorized/project",
  "wait": 15,
  "tail": 40
}
```

For long builds, prefer an asynchronous process plus status polling, not an unbounded shell command. If the process is no longer needed, stop the **tracked process** rather than matching a broad process-name pattern.

## Multi-MCP coordination

- **Desktop MCP**: GUI focus, clicks, AT-SPI, screenshots and wait-for-change; don't use Terminal for GUI if a semantic UI controller is available.
- **Blender MCP**: live Blender scene and `bpy` work; Terminal for isolated background build/export, QA scripts and version control.
- **Chrome DevTools MCP**: live browser page/DOM/network/UI verification; Terminal for source code, logs and test server.
- **Terminal MCP**: cross-app file operations, project checks, shell scripts and process state.

Use these tools as separate evidence sources. A background Blender export or Python test saying OK does not mean the browser renders the model correctly; perform target-runtime QA when required.

## Optional PyCharm MCP (not a requirement)

My MCP may expose a `pycharm` server only when enabled in the local
configuration and when a JetBrains IDE is reachable. Discover it at runtime
and verify the correct `projectPath`. For semantic analysis (`search_symbol`,
`analyze_calls`, `get_symbol_info`) or safe renaming (`rename_refactoring`),
PyCharm can be better than textual shell searches. For deterministic
CLI tasks — Git, `rg`, tests, CI, installs, scripts, Docker and processes —
**use the independent Terminal MCP even if PyCharm is online**. Its
`execute_terminal_command` is the IDE terminal and may involve user
confirmation; it is not a replacement for `terminal.run_command`.

Refer to [PyCharm code navigation](../../pycharm-code-insight/SKILL.md)
and [PyCharm refactor/validation](../../pycharm-refactor-verify/SKILL.md).

## Common failures

- Wrong `cwd` → examine current path and rerun with explicit directory.
- Different interpreter → check `.venv/bin/python`/project manager and `python --version`.
- Truncated output → use `get_process_status` or targeted log read with minimum necessary context.
- Stale process → inspect process ID/owner before cleanup.
- Missing GUI session environment → the Terminal MCP process may not inherit `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` or session D-Bus variables. Do not blindly guess them or run apps as root.
- User terminal occupied → do not send keystrokes; use a new scoped `run_command` instead.
