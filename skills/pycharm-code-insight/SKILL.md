---
name: pycharm-code-insight
description: "OPTIONAL PyCharm MCP for semantic source browsing: indexed symbol search, call hierarchy, Quick Documentation, IDE inspections and targeted reads. Use only when available with the correct project open; immediately fall back to Terminal for missing tools or unavailable IDE."
compatibility: "Optional JetBrains IDE MCP upstream through My MCP Tools. The PyCharm MCP server, IDE, project and individual tools may all be unavailable; Terminal MCP is the primary fallback."
metadata:
  version: "1.0.0"
---

# PyCharm Code Insight — optional IDE-aware navigation

**PyCharm MCP is an OPTIONAL tool, never a required dependency.**
It might not be installed, enabled, connected or running; the right project might not be open; a needed tool might not be exposed. Do NOT block an otherwise executable task, install/enable the IDE, modify MCP config or ask the user to start it just because PyCharm would be convenient. **Fall back to Terminal MCP** (or another already-authorized source tool).

## Availability and scope: mandatory gate

1. Discover My MCP servers using `list_servers`. If `pycharm` is absent, disconnected or unusable, skip PyCharm entirely and work through [Terminal workflows](../terminal-workflows/SKILL.md).
2. If present, call `list_tools(server="pycharm")`, then `get_tool_schema` for each *actually listed* tool before `call_tool`. Do not invent tool names or parameter schemas; JetBrains versions and per-user Exposed Tools / router-only settings vary.
3. Resolve the target project's path. Supply `projectPath` whenever known. Verify correct IDE project with a cheap read-only call (`get_repositories`, `search_file`, or `get_all_open_file_paths`). If IDE has the wrong project, prefer Terminal immediately; do not use unscoped IDE edits on another project.
4. Observe project instructions and uncommitted changes; keep this navigation workflow read-only.

## What PyCharm is especially good at

IDE indexes know **symbols and resolved code**, not just matching text. Prefer semantic tools when ambiguity or dependencies matter:

| Goal | Tool, *if exposed* | Advantage over grep |
|---|---|---|
| Locate a class, function or field definition | `search_symbol` | Filters to program symbols |
| See who calls a function / what it calls | `search_symbol` then `analyze_calls` | IDE Call Hierarchy instead of text guessing |
| Understand type, signature or resolved reference | `get_symbol_info` | Quick Documentation at exact location |
| Find IDE errors/warnings in changed file(s) | `get_file_problems`, `lint_files` | Indexed inspections and locations |
| Read a small code region | `read_file` | Numbered lines, scoped reads |
| Explore loaded project/modules and libraries | `get_project_modules`, `get_project_dependencies` | IDE project structure |
| Locate files/strings in open project | `search_file`, `search_text`, `search_regex` | Convenient scoped IDE searches |

For call graphs, first locate an actual fully-qualified symbol using `search_symbol`, then `analyze_calls(symbolFqn=..., analysisKind="INCOMING_CALLS"|"OUTGOING_CALLS", projectPath=...)`. Bound `depth`, `maxNodes`, `maxChildren`. IDE call graphs are static and may miss dynamic Python/JS, reflection, monkey-patching or dependency-injection paths. Cross-check important results with source code.

## When to definitely prefer Terminal

- **Git** (diff/history/stage/commit/rebase), shell pipelines, `rg`, large searches, bulk file operations, generating files or multi-repo changes.
- **Python tests, lint/type-check, CI, installs, build scripts, package managers, Docker, services, logs, running processes, remote hosts and system inspection**. Use explicit working directory and interpreter.
- Files not loaded/indexed by PyCharm, excluded/generated content, headless projects, wrong open project, or tool errors/timeouts. PyCharm index results may be stale or incomplete.
- Simple exact text lookup where `rg -n` / `git grep` is faster. Do not route shell commands through `pycharm.execute_terminal_command` by default: it adds IDE dependency and may require user confirmation.
- Actions affecting UI/editor when the user didn't ask to open or change editor state.

**Terminal text search is not equivalent to semantic analysis.** If falling back, distinguish symbol relationships inferred from grep from facts confirmed by IDE call hierarchy. Do not interpret an empty IDE inspection as proof that unit tests pass.

## Completion routine

Select precise, bounded queries; validate important findings in file context; if a PyCharm request fails or is unsupported, try at most one appropriate correction then switch to Terminal. Describe paths and evidence and whether you really used PyCharm. For modifications follow [PyCharm Refactor & Verify](../pycharm-refactor-verify/SKILL.md).

See [semantic navigation and fallback recipes](references/semantic-navigation-and-fallbacks.md).
Official source: https://www.jetbrains.com/help/pycharm/mcp-server.html
