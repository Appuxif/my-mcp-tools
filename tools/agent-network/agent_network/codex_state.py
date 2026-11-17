"""Conservative Codex thread activity detection from local rollout lifecycle events.

Never assume idle when a thread or its lifecycle cannot be inspected.
External integrations may override this with a recently written state file.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path


THREAD_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,40}$")
COMPLETED_EVENTS = {"task_complete", "turn_aborted", "task_failed", "turn_failed"}
BUSY_EVENTS = {"task_started"}
MAX_TAIL_BYTES = 1024 * 1024


def rollout_state(path: Path) -> str:
    """Infer busy/idle from the last complete lifecycle event in a JSONL file."""
    try:
        with path.open("rb") as fp:
            fp.seek(0, 2)
            size = fp.tell()
            offset = max(0, size - MAX_TAIL_BYTES)
            fp.seek(offset)
            raw = fp.read()
        if offset:
            raw = raw.partition(b"\n")[2]  # discard a partial JSONL record
        lifecycle = None
        for line in raw.splitlines():
            try:
                item = json.loads(line)
                if item.get("type") != "event_msg":
                    continue
                event = (item.get("payload") or {}).get("type")
                if event in BUSY_EVENTS:
                    lifecycle = "busy"
                elif event in COMPLETED_EVENTS:
                    lifecycle = "idle"
            except (ValueError, TypeError):
                continue
        return lifecycle or "unknown"
    except (OSError, UnicodeError):
        return "unknown"


def detect_state(thread: str, *, codex_home: Path | None = None,
                 state_file: Path | None = None, assume_idle: bool = False,
                 current_time: float | None = None) -> str:
    """A stale/unknown state is never reported as idle by default."""
    clock = time.time() if current_time is None else current_time
    if state_file:
        try:
            if clock - state_file.stat().st_mtime > 60:
                return "unknown"
            state = state_file.read_text().strip().lower()
            return state if state in ("idle", "busy", "unknown") else "unknown"
        except OSError:
            return "unknown"
    root = codex_home or (Path.home() / ".codex")
    if THREAD_UUID.fullmatch(thread):
        try:
            files = list((root / "sessions").rglob(f"*{thread}*.jsonl"))
            if files:
                latest = max(files, key=lambda x: x.stat().st_mtime)
                return rollout_state(latest)
        except OSError:
            pass
    return "idle" if assume_idle else "unknown"
