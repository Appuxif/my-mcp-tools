"""Best-effort GNOME Wayland window control via accessibility, no Shell extension.

GNOME restricts window-management operations for ordinary processes.
AT-SPI provides enumeration and sometimes focus/resize; unsupported operations
return explicit errors rather than claiming success.
"""
from __future__ import annotations
from typing import Any
from collections import deque

import a11y
from a11y import Atspi


def _window(path: list[int]):
    obj = a11y._at(path)
    role = (a11y._safe(obj.get_role_name, "") or "").lower()
    if not any(k in role for k in ("frame", "window", "dialog")):
        raise ValueError(f"Path {path} is not a top-level window (role={role})")
    if len(path) != 2:
        raise ValueError("A window path must be [application_index, window_index]")
    return obj


def _geometry(obj):
    return a11y._rect(obj)


def _button_action(win, names: tuple[str, ...]) -> dict | None:
    """Find a native titlebar control in the accessible window hierarchy."""
    q = deque([(win, 0)])
    inspected = 0
    while q and inspected < 700:
        node, depth = q.popleft()
        inspected += 1
        name = (a11y._safe(node.get_name, "") or "").strip().casefold()
        role = (a11y._safe(node.get_role_name, "") or "").lower()
        if name in names and "button" in role:
            iface = a11y._safe(node.get_action_iface)
            if iface:
                n = a11y._safe(iface.get_n_actions, 0)
                if n:
                    idx = next((i for i in range(min(n, 12))
                                if any(t in (a11y._safe(lambda i=i:iface.get_action_name(i), "") or "").lower()
                                       for t in ("click", "press", "activate"))), 0)
                    ok = bool(a11y._safe(lambda:iface.do_action(idx), False))
                    if ok:
                        return {"button": name, "action": a11y._safe(lambda:iface.get_action_name(idx), ""),
                                "scanned": inspected}
        if depth < 32:
            for i in range(min(a11y._safe(node.get_child_count, 0), 75)):
                c = a11y._safe(lambda i=i: node.get_child_at_index(i))
                if c is not None:
                    q.append((c, depth + 1))
    return None


def control(path: list[int], operation: str,
            x: int | None = None, y: int | None = None,
            width: int | None = None, height: int | None = None) -> dict[str, Any]:
    obj = _window(path)
    before = _geometry(obj)
    comp = a11y._safe(obj.get_component_iface)
    if comp is None:
        raise RuntimeError("Window does not expose AT-SPI Component")
    info = {"window": a11y._node_info(obj, path), "before": before}
    if operation == "activate":
        worked = bool(a11y._safe(comp.grab_focus, False))
        if not worked:
            actions = a11y._safe(obj.get_action_iface)
            if actions is not None:
                count = a11y._safe(actions.get_n_actions, 0)
                for i in range(min(count, 12)):
                    name = (a11y._safe(lambda: actions.get_action_name(i), "") or "").lower()
                    if any(t in name for t in ("activate", "raise", "focus")):
                        worked = bool(a11y._safe(lambda: actions.do_action(i), False))
                        if worked:
                            break
        if not worked:
            raise RuntimeError("GNOME Wayland does not allow focusing this window via AT-SPI")
        return {**info, "requested": operation, "request_accepted": worked,
                "verified": False, "note": "AT-SPI accepted focus request; compositor activation is not independently verified"}
    if operation in ("move", "resize", "move_resize"):
        if before is None:
            raise RuntimeError("Cannot read current window geometry")
        if x is None: x=before["x"]
        if y is None: y=before["y"]
        if width is None: width=before["width"]
        if height is None: height=before["height"]
        if (not all(isinstance(v, int) for v in (x,y,width,height)) or
            abs(x)>20000 or abs(y)>20000 or width<80 or height<60 or
            width>16000 or height>16000):
            raise ValueError("Invalid window rectangle")
        rect = Atspi.Rect(x=x, y=y, width=width, height=height)
        success = bool(a11y._safe(lambda: comp.set_extents(rect, Atspi.CoordType.SCREEN), False))
        after = _geometry(obj)
        target = {"x": x, "y": y, "width": width, "height": height}
        verified = after == target
        if not success or not verified:
            raise RuntimeError(f"GNOME/app rejected window rectangle; request={success}, before={before}, after={after}")
        return {**info, "requested": operation, "request_accepted": success,
                "verified": True, "after": after}
    labels = {
        "minimize": ("minimize", "свернуть"),
        "maximize": ("maximize", "развернуть"),
        "restore": ("restore", "unmaximize", "восстановить"),
    }
    if operation in labels:
        info_action = _button_action(obj, labels[operation])
        if info_action is None:
            raise RuntimeError(
                f"No accessible titlebar button for {operation!r} in this app. "
                "GNOME Wayland exposes no generic per-window API without compositor cooperation."
            )
        return {**info, "requested": operation, "request_accepted": True,
                "verified": False, "via": "AT-SPI titlebar action", **info_action,
                "note": "Application accepted the control action; compositor state could not be verified"}
    raise ValueError("operation must be activate, move, resize, move_resize, minimize, maximize or restore")
