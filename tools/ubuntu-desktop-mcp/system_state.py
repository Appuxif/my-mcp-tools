"""Lightweight local system snapshot for GNOME Desktop MCP."""
from __future__ import annotations

import os
import platform
import sys
import time
from datetime import datetime
from pathlib import Path

if "/usr/lib/python3/dist-packages" not in sys.path:
    sys.path.append("/usr/lib/python3/dist-packages")

from gi.repository import Gio

import a11y
from idle import idle_guard


def _cpu_ticks() -> tuple[int, int]:
    """Read aggregate Linux CPU ticks (total, idle including iowait)."""
    line = next(line for line in Path("/proc/stat").read_text().splitlines()
                if line.startswith("cpu "))
    ticks = [int(s) for s in line.split()[1:]]
    return sum(ticks), ticks[3] + (ticks[4] if len(ticks) > 4 else 0)


def _cpu_info() -> dict:
    before_total, before_idle = _cpu_ticks()
    time.sleep(0.10)
    after_total, after_idle = _cpu_ticks()
    total = after_total - before_total
    idle = after_idle - before_idle
    percent = round(max(0, min(100, 100 * (total - idle) / total)), 1) if total else None
    return {
        "usage_percent": percent,
        "logical_cores": os.cpu_count(),
        "load_average_1m_5m_15m": [round(x, 2) for x in os.getloadavg()],
    }


def _memory_info() -> dict:
    stats = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        if ":" in line:
            k, value = line.split(":", 1)
            try:
                stats[k] = int(value.strip().split()[0]) * 1024
            except (IndexError, ValueError):
                continue
    total = stats.get("MemTotal", 0)
    available = stats.get("MemAvailable", 0)
    used = max(0, total - available)
    to_gib = lambda n: round(n / (1024 ** 3), 2)
    return {
        "total_gib": to_gib(total),
        "used_gib": to_gib(used),
        "available_gib": to_gib(available),
        "used_percent": round(used / total * 100, 1) if total else None,
    }


def _keyboard_layout() -> dict:
    """GNOME's MRU input-source order is useful, but not guaranteed live state."""
    try:
        settings = Gio.Settings.new("org.gnome.desktop.input-sources")
        configured = settings.get_value("sources").unpack()
        mru = settings.get_value("mru-sources").unpack()
        current = int(settings.get_uint("current"))
        default_source = configured[current] if 0 <= current < len(configured) else None
        best_guess = mru[0] if mru else default_source
        return {
            "selected_source_guess": {
                "type": best_guess[0],
                "id": best_guess[1],
            } if best_guess else None,
            "selected_verified": False,
            "selected_guess_method": "GNOME mru-sources (most recently used)",
            "configured_sources": [{"type": s[0], "id": s[1]} for s in configured],
            "configured_current_index": current,
            "configured_current_source": {"type": default_source[0], "id": default_source[1]} if default_source else None,
            "note": "GNOME does not expose a reliable global currently active layout via this settings key. "
                    "The last-used source may differ from the currently active one.",
        }
    except Exception as exc:
        return {"selected_source_guess": None, "selected_verified": False, "error": str(exc)}


def snapshot() -> dict:
    now = datetime.now().astimezone()
    try:
        uptime = round(float(Path("/proc/uptime").read_text().split()[0]))
    except (OSError, IndexError, ValueError):
        uptime = None
    return {
        "local_time": now.isoformat(timespec="seconds"),
        "timezone": str(now.tzinfo),
        "os": platform.system(),
        "kernel": platform.release(),
        "session_type": os.environ.get("XDG_SESSION_TYPE"),
        "uptime_seconds": uptime,
        "keyboard": _keyboard_layout(),
        "cpu": _cpu_info(),
        "memory": _memory_info(),
        "active_window": a11y.active_window(),
        "idle_protection": idle_guard.status(),
    }
