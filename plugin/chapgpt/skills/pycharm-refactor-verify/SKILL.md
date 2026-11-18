---
name: pycharm-refactor-verify
description: "OPTIONAL PyCharm MCP for semantic symbol renaming, IDE formatting, inspections, Run Configurations and focused project edits. Use when the correct JetBrains project and tool are available; prefer Terminal MCP for Git, CI, builds, scripts, bulk edits and unavailable IDE."
compatibility: "Optional PyCharm MCP via My MCP Tools; only when server, project and requested tool are available. Terminal MCP or another authorized code tool is the fallback."
metadata:
  version: "1.0.0"
---

# PyCharm refactoring and validation — optional IDE assistance

**PyCharm MCP is OPTIONAL, NEVER a hard dependency.** The `pycharm` server may be absent, disabled, disconnected, have the wrong project open, or not expose a needed tool. Discover through My MCP `list_servers` → `list_tools(server="pycharm")` → `get_tool_schema` (for exact tool). Supply the known `projectPath` and verify the IDE's project before modifying it. If unavailable or mismatched, **continue immediately via Terminal MCP**, not by asking the user to install/start PyCharm, altering their MCP config, or repeatedly retrying.

First read repository instructions and `git status --short`; preserve existing uncommitted changes. Do not commit or push without user authorization.

## Best reasons to use PyCharm MCP

- **Semantic rename:** `rename_refactoring(pathInProject, symbolName, newName, projectPath)` updates indexed references to the selected symbol. Prefer over blind find/replace for real class/function/variable renames. Identify the exact symbol first; inspect resulting diff for dynamic usages, reflection, string-based names, cross-project consumers or unexpected formatting.
- **IDE inspections:** `get_file_problems` (one file) and `lint_files` (batch changed files) expose IDE warnings/errors and coordinates. They complement **but never replace** real tests/type checking.
- **Run Configurations:** `get_run_configurations` discovers named IDE runs or executable code points; `execute_run_configuration` can reproduce a known interpreter, working directory and environment. Use only the actual name/returned run point and respect `supportsDynamicLaunchOverrides` before passing arguments/env overrides. Never dump environment secrets.
- **Targeted IDE formatting:** `reformat_file` applies the current IDE's style; a *mutating* action that should be scoped and reviewed with `git diff`.
- **Small project edits:** `apply_patch`, `create_new_file` can be convenient when working in the correct loaded project. No inherent benefit for bulk changes.
- **Project build:** `build_project`, when exposed, can produce IDE build errors. In a Python project it does **not replace** `pytest`, `ruff` or the project's real CI commands.

## When you should definitely use Terminal instead

1. Git inspection/staging/commit/rebase/branch/push, historical diffs and merge resolution. Prefer deterministic `git` with explicit `cwd`.
2. Full test suites, lint/typecheck, benchmarks, CI, package installation, environment checks, long-running commands, Docker, services, remote shells, process control, bulk file generation and migrations.
3. Code outside the IDE's indexed/open project, cross-project edits, stale indexes, missing run configs or unsupported refactoring capabilities.
4. Mechanical replacements and scripted multi-file modifications where a verified Terminal patch is simpler. Do **not** claim simple text replacement is equivalent to a semantic rename.
5. Database access/modification and Jupyter execution without explicit project/user need: these can **change real state**. Never treat `execute_sql_query` or `runNotebookCell` as harmless inspections.
6. Running shell commands via `pycharm.execute_terminal_command` when the standalone Terminal MCP is available: it adds another IDE-dependent UI/permission layer. The PyCharm IDE terminal generally asks for confirmation unless the user enabled Brave Mode. Never enable Brave Mode on your own.

## Standard change procedure

1. Determine scope, read relevant files and existing rules, check Git status via Terminal, and identify the exact symbol/location.
2. For genuine semantic rename, use [PyCharm Code Insight](../pycharm-code-insight/SKILL.md) to locate it first; then PyCharm `rename_refactoring`. For broad deterministic edits, use Terminal. Do not mix both tools on the same file at once without checking the intermediate content.
3. After modifications, inspect `git diff --check` and the actual diff through Terminal. Watch for accidental renames, formatting churn, deleted user work and generated files.
4. Run the project's **real** tests/lint/build via Terminal with explicit interpreter/working directory. Optionally run IDE `lint_files`/`get_file_problems` as an additional diagnostic; check `timedOut` / `notAnalyzedReason`.
5. Report files changed, checks actually executed (with exit codes) and any unverified coverage. Do not claim build success merely because PyCharm responded.

Use [refactoring and verification playbook](references/refactor-and-verification.md).

Official reference: https://www.jetbrains.com/help/pycharm/mcp-server.html
