# Semantic navigation and CLI fallback recipes

**PyCharm MCP is OPTIONAL.** At each task start: My MCP `list_servers` → if `pycharm` is usable, `list_tools` → `get_tool_schema` for exact tool → verify `projectPath`. If any step fails, use Terminal MCP; never assume JetBrains is active or configured.

| Need | IDE-aware path | Terminal alternative |
|---|---|---|
| Find definition of `UserService` | `search_symbol(q="UserService")` | `rg -n 'class UserService\b' .` |
| Who calls `save_user`? | `search_symbol` → `analyze_calls(INCOMING_CALLS)` | `rg -n '\bsave_user\('` plus manual tracing; **not semantic proof** |
| What does imported `X` refer to? | `get_symbol_info(filePath,line,column)` | Inspect imports/definitions, optionally interpreter introspection |
| Inspections on changed Python files | `lint_files(files=[...])` | Configured `ruff check`, `mypy`, `pyright`, tests |
| Exact substring across huge repo | `search_text` on loaded project | `rg -n -F 'literal'` or `git grep -n -F` (**usually faster**) |
| File/project layout | `search_file`, `list_directory_tree`, `get_repositories` | `rg --files`, `find`, `git rev-parse` |
| Git changes/branch/history | `git_status` for IDE overview | **Terminal** `git status --short`, `git diff`, `git log` |

## Limits of IDE semantics

- Tool availability varies by JetBrains IDE version, installed/enabled plugin, server status, "Exposed Tools" settings and per-project indexing.
- Dynamic calls, runtime patches, JavaScript reflection and Python's dynamic dispatch are often invisible to static call hierarchy.
- `search_symbol` may index dependencies differently; try `include_external` only when the schema supports it and project lookup fails.
- `get_file_problems`/`lint_files` may skip files or time out; inspect return details. Clean inspections do not replace test execution.
- Read bounded source spans; the current linked `read_file` uses `file_path`, 1-based `offset` and `limit`, but **discover the schema** in new sessions.
- `get_all_open_file_paths` lists open editor tabs, **not** a repository inventory.
- When an IDE tool says it cannot resolve a symbol, report that limitation, don't manufacture signatures.

Source: https://www.jetbrains.com/help/pycharm/mcp-server.html
