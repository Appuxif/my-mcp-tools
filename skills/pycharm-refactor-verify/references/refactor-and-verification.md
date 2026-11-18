# PyCharm refactor / verify — decision guide

**PyCharm is an optional tool**, not a prerequisite for editing or testing code.
Discovery: My MCP `list_servers` → if `pycharm` connected, `list_tools` + `get_tool_schema`; verify exact `projectPath`. Missing server/tool/project ⇒ Terminal MCP fallback.

| Work | PyCharm MCP when worthwhile | Terminal MCP preferred / fallback |
|---|---|---|
| Rename one symbol across indexed sources | `rename_refactoring` after `search_symbol` and exact symbol verification | Scoped patch + `rg` + type checking/tests if IDE unavailable; not an identical semantic rename |
| Analyze callers before refactor | `analyze_calls` (FQN, incoming/outgoing) | `rg` with manual inspection; dynamic references require care |
| IDE diagnostics on affected code | `lint_files`, `get_file_problems` | Project linter/type checker/test runner; **authoritative for CI** |
| Run a specific existing IDE-configured target | `get_run_configurations` then `execute_run_configuration` | Explicit shell command and environment via Terminal |
| Reformat a file in IDE style | `reformat_file` after confirming scope | `ruff format`, `black`, `gofmt`, `prettier` only if project uses them |
| Targeted patch/creation in loaded project | `apply_patch`, `create_new_file` | Terminal for bulk edits, generators, multiple repos, scripts |
| Staging/committing/pushing | **Not an IDE MCP workflow** | `git status`, `git add`, `git commit`, `git push` with user authorization |
| Docker, processes, package installs | **Not an IDE MCP workflow** | Terminal MCP and process lifecycle tools |

## Semantic rename checklist

- Resolve exact definition and project root first; overloaded/identically named symbols must not be guessed.
- Use `rename_refactoring(pathInProject=..., symbolName=..., newName=..., projectPath=...)` only for intended source files.
- Check `git diff` and all references, especially dynamic strings, reflection, plugins, serialized keys and external callers.
- Run tests and configured type checking. IDE success is not proof no regressions.
- If rename fails once due to indexing/unsupported language/missing project, fall back to Terminal. Do not repeatedly issue IDE commands or enable extra plugins without user request.

## Run Configuration checklist

- Find real configuration names with `get_run_configurations`. With a `filePath`, inspect returned run points before passing a `filePath` + `line` to `execute_run_configuration`.
- Do not provide `configurationName` and `filePath`/`line` together.
- Override `programArguments`, `envs`, `workingDirectory` only when `supportsDynamicLaunchOverrides=true` for the selected configuration. Omit optional overrides when unnecessary.
- Existing configurations may start servers, connect to real databases or modify data. Confirm scope/side effects rather than blindly running them.
- For PyCharm terminal commands, use standalone Terminal MCP when possible; IDE terminal may require confirmation unless the user configured Brave Mode.

## Validation and boundaries

- Project indexes may be incomplete or stale; some file types and dialects lack semantic support.
- IDE inspection may return per-file `timedOut` or `notAnalyzedReason`. Handle these explicitly, rather than saying there are no warnings.
- Builds/tests from PyCharm use IDE-selected run configuration, not necessarily CI settings. Run reproducible commands via Terminal.
- Database MCP tools and notebook execution are potentially destructive; do not touch live/production data without an explicit authorized task.
- Do not expose environment secrets, database credentials, tokens, private source beyond requested scope or unrelated opened editor contents.

Source: https://www.jetbrains.com/help/pycharm/mcp-server.html
