# Shell safety and project hygiene

## Before writing

Inspect directory layout, existing changes, ownership and intended scope. Example minimal discovery (only in an authorized project directory):

```bash
pwd
git status --short
git diff --stat
find . -maxdepth 2 -type f | head -60
```

Read only necessary files and prefer `git diff -- <path>` for targeted review. Be careful with untracked files (a clean tracked diff does not mean the directory contains no user data).

## Safe write strategies

1. New independent file → `write_file` to explicit path; verify contents and parse/syntax.
2. Small existing change → exact `replace_file_content`; check replacement count and resulting file.
3. Large generated artifact → write to a temporary output path, validate, then rename/replace only when intended. Preserve source/backup until validation.
4. Mass-edit → use a reproducible script, display changed paths and review diff.

Avoid broad globs and shell expansion in destructive commands; use `--` when appropriate. Quote paths with spaces and non-ASCII filenames. Check symlinks and destination resolution before writes in shared directories.

## Git and secrets

- `git status --short` before and after changes; distinguish the user's pre-existing modifications from yours.
- Prefer `git add <explicit files>` rather than `git add -A` if a commit was requested.
- Don't commit `.env`, tokens, personal data, credentials, local machine-specific config, generated `.venv` or caches.
- Don't rewrite Git history, reset changes, discard stash or push without explicit instruction.
- When user requests a shareable archive, build from the intended tracked/staged snapshot and inspect archive contents to avoid secrets.

## External commands and installations

- Never pipe unreviewed network scripts to `bash` or run unknown build hooks without inspection.
- Prefer locked dependencies and project virtual environments; do not upgrade system Python or install global packages casually.
- Timebox network requests, builds and tests where appropriate, but do not guess outputs.
- Start local listeners/services only when task calls for them; bind to loopback unless external exposure is explicitly authorized.

## Acceptance tests

Choose tests matching the change: `python -m unittest`/`pytest`, `python -m py_compile`, `node --check`, config parsing, a targeted CLI smoke test, `git diff --check`, or application-level GUI/DevTools checks. A command with exit code zero does not certify runtime UX, image quality or deployment health.

When you cannot validate the actual effect, say what was inspected instead of claiming completion.
