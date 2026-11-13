"""AT-SPI accessibility tree and semantic actions for GNOME.

GObject introspection on Ubuntu is a system package, so use the distro-provided
site-packages path in this isolated venv. No screenshot text/OCR needed.
"""
from __future__ import annotations

import sys
from typing import Any

if "/usr/lib/python3/dist-packages" not in sys.path:
    sys.path.append("/usr/lib/python3/dist-packages")

import gi  # noqa: E402
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

Atspi.set_timeout(2500, 2500)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _rect(node) -> dict | None:
    comp = _safe(node.get_component_iface)
    if comp is None:
        return None
    r = _safe(lambda: comp.get_extents(Atspi.CoordType.SCREEN))
    if r is None:
        return None
    return {"x": r.x, "y": r.y, "width": r.width, "height": r.height}


def _state(node, state) -> bool:
    st = _safe(node.get_state_set)
    return bool(_safe(lambda: st.contains(state), False)) if st is not None else False


def _node_info(node, path: list[int]) -> dict[str, Any]:
    return {
        "path": path,
        "name": _safe(node.get_name, "") or "",
        "role": _safe(node.get_role_name, "") or "",
        "description": (_safe(node.get_description, "") or "")[:240],
        "bounds": _rect(node),
        "focused": _state(node, Atspi.StateType.FOCUSED),
        "active": _state(node, Atspi.StateType.ACTIVE),
        "focusable": _state(node, Atspi.StateType.FOCUSABLE),
        "showing": _state(node, Atspi.StateType.SHOWING),
        "child_count": min(_safe(node.get_child_count, 0) or 0, 20000),
    }


def _root():
    desktop = Atspi.get_desktop(0)
    if desktop is None:
        raise RuntimeError("AT-SPI desktop not available")
    return desktop


def _at(path: list[int]):
    if not path or len(path) > 40 or any(not isinstance(i, int) or i < 0 for i in path):
        raise ValueError("path must be a non-empty list of non-negative child indices")
    node = _root()
    for pos in path:
        count = node.get_child_count()
        if pos >= count:
            raise ValueError(f"Stale AT-SPI path {path}: child {pos} outside {count}")
        node = node.get_child_at_index(pos)
        if node is None:
            raise ValueError(f"Unreachable AT-SPI element: {path}")
    return node


def tree(app_filter: str = "", name_filter: str = "", max_depth: int = 5, max_nodes: int = 250) -> dict:
    """Bounded breadth-first traversal. Paths are dynamic; do not cache them."""
    if not 1 <= max_depth <= 32 or not 1 <= max_nodes <= 1200:
        raise ValueError("max_depth 1..32; max_nodes 1..1200")
    root = _root()
    queue = []
    apps = min(_safe(root.get_child_count, 0), 200)
    for i in range(apps):
        node = _safe(lambda i=i: root.get_child_at_index(i))
        if node is None:
            continue
        name = _safe(node.get_name, "") or ""
        if app_filter and app_filter.casefold() not in name.casefold():
            continue
        queue.append((node, [i], 0))
    found = []
    processed = 0
    max_scan = min(4000, max_nodes * 8)
    while queue and len(found) < max_nodes and processed < max_scan:
        node, path, depth = queue.pop(0)
        processed += 1
        item = _node_info(node, path)
        if not name_filter or name_filter.casefold() in (item["name"] + " " + item["role"]).casefold():
            found.append(item)
        if depth >= max_depth:
            continue
        # Large web accessibility trees can have many nodes; limit branching.
        for j in range(min(item["child_count"], 100)):
            child = _safe(lambda j=j: node.get_child_at_index(j))
            if child is not None:
                queue.append((child, [*path, j], depth + 1))
    return {"nodes": found, "scanned": processed, "truncated": bool(queue), "apps": apps}


def find(name: str, app_filter: str = "", role: str = "", max_nodes: int = 1000) -> dict:
    if not name or len(name) > 300:
        raise ValueError("name must be nonempty, <= 300 characters")
    t = tree(app_filter=app_filter, name_filter=name, max_nodes=max_nodes, max_depth=30)
    nodes = t["nodes"]
    if role:
        nodes = [n for n in nodes if role.casefold() in n["role"].casefold()]
    return {"matches": nodes[:50], "count": len(nodes), "scanned": t["scanned"], "truncated": t["truncated"]}


def action(path: list[int], operation: str = "activate", value: str = "") -> dict:
    node = _at(path)
    info = _node_info(node, path)
    if operation == "activate":
        action_iface = _safe(node.get_action_iface)
        if action_iface is not None:
            n = _safe(action_iface.get_n_actions, 0)
            names = [_safe(lambda i=i: action_iface.get_action_name(i), "") for i in range(min(n, 12))]
            preferred = next((i for i, s in enumerate(names) if any(x in s.lower() for x in ("click", "press", "activate", "jump"))), None)
            chosen = preferred if preferred is not None else (0 if n else None)
            if chosen is not None:
                ok = action_iface.do_action(chosen)
                if ok:
                    return {"ok": True, "method": "AT-SPI Action", "action": names[chosen], "element": info}
        comp = _safe(node.get_component_iface)
        if comp is not None and comp.grab_focus():
            return {"ok": True, "method": "AT-SPI focus", "element": info, "note": "focus is not a click"}
        raise RuntimeError("Element does not expose a usable action/focus method")
    if operation == "focus":
        comp = _safe(node.get_component_iface)
        if comp is None or not comp.grab_focus():
            raise RuntimeError("Element cannot receive AT-SPI focus")
        return {"ok": True, "method": "AT-SPI focus", "element": info}
    if operation == "set_value":
        if len(value) > 100_000:
            raise ValueError("value exceeds 100000 characters")
        editable = _safe(node.get_editable_text_iface)
        if editable is None:
            raise RuntimeError("Element has no EditableText interface")
        if not editable.set_text_contents(value):
            raise RuntimeError("EditableText rejected the value")
        return {"ok": True, "method": "AT-SPI EditableText", "length": len(value), "element": info}
    raise ValueError("operation must be activate, focus or set_value")


def windows() -> list[dict]:
    root = _root()
    out = []
    for i in range(min(root.get_child_count(), 100)):
        app = _safe(lambda: root.get_child_at_index(i))
        if app is None:
            continue
        app_name = _safe(app.get_name, "") or ""
        for j in range(min(_safe(app.get_child_count, 0), 60)):
            win = _safe(lambda: app.get_child_at_index(j))
            if win is None:
                continue
            role = _safe(win.get_role_name, "") or ""
            if "frame" not in role.lower() and "window" not in role.lower() and "dialog" not in role.lower():
                continue
            out.append({"app": app_name, **_node_info(win, [i, j])})
    return out[:150]


def active_window() -> dict[str, Any]:
    """Find the active toplevel window using AT-SPI StateType.ACTIVE.

    Unlike focus, ACTIVE is assigned to the toplevel frame rather than a
    textbox or a GNOME shell accessibility child. Never guess if none is active.
    """
    all_windows = windows()
    candidates = [w for w in all_windows if w.get("active")]
    if not candidates:
        return {
            "found": False,
            "backend": "at-spi",
            "reason": "No AT-SPI top-level window reports ACTIVE (possibly desktop/lock screen)",
        }
    # Most sessions have exactly one ACTIVE window. If multiple are flagged,
    # use a focused frame if possible; otherwise provide all candidate names.
    chosen = next((w for w in candidates if w.get("focused")), candidates[0])
    app = chosen["app"]
    known_browsers = ("google chrome", "chromium", "brave", "mozilla firefox", "firefox", "vivaldi", "microsoft edge")
    return {
        "found": True,
        "backend": "at-spi",
        "app": app,
        "title": chosen["name"],
        "role": chosen["role"],
        "bounds": chosen["bounds"],
        "path": chosen["path"],
        "is_browser": any(n in app.casefold() for n in known_browsers),
        "is_chrome": any(n in app.casefold() for n in ("google chrome", "chromium")),
        "other_active_titles": [w["name"] for w in candidates if w is not chosen],
        "note": "AT-SPI paths are ephemeral; retrieve again before ui_action",
    }
