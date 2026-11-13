#!/usr/bin/env python3
"""Minimal stdio MCP server for GNOME Wayland. No root, no network listener."""

import asyncio
import base64
import json
import io
import inspect
import math
import threading
import os
import shutil
import stat
import struct
import subprocess
import time
import uuid
from functools import wraps
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from dbus_next import BusType, Message, MessageType, Variant
from dbus_next.aio import MessageBus
from evdev import AbsInfo, UInput, ecodes
from PIL import Image as PILImage
import a11y
import windows
import system_state
import ui_watch
import visual_watch
from idle import idle_guard
from mcp.server.fastmcp import FastMCP, Image
from mcp.types import CallToolResult, ImageContent, TextContent

class ActivityFastMCP(FastMCP):
    """Automatically renew a short-lived GNOME idle inhibitor for every tool call."""

    def tool(self, *args, **kwargs):
        register = super().tool(*args, **kwargs)

        def wrapped_decorator(fn):
            if inspect.iscoroutinefunction(fn):
                @wraps(fn)
                async def with_activity(*fn_args, **fn_kwargs):
                    idle_guard.touch()
                    try:
                        return await fn(*fn_args, **fn_kwargs)
                    finally:
                        idle_guard.touch()
            else:
                @wraps(fn)
                def with_activity(*fn_args, **fn_kwargs):
                    idle_guard.touch()
                    try:
                        return fn(*fn_args, **fn_kwargs)
                    finally:
                        idle_guard.touch()
            return register(with_activity)

        return wrapped_decorator


mcp = ActivityFastMCP("ubuntu-desktop-mcp")
MAX_PNG_BYTES = 64 * 1024 * 1024
AXIS_MAX = 65535
_screenshot_size: tuple[int, int] | None = None
_pointer: UInput | None = None
_keyboard: UInput | None = None
_input_lock = threading.RLock()
_mouse_held: set[int] = set()
_keys_held: set[int] = set()
_last_pointer: dict[str, Any] | None = None


def _check_env() -> None:
    if os.environ.get("XDG_SESSION_TYPE") != "wayland":
        raise RuntimeError("XDG_SESSION_TYPE must be wayland; configure the MCP process environment")
    if not os.environ.get("XDG_RUNTIME_DIR"):
        raise RuntimeError("XDG_RUNTIME_DIR is missing")


def _read_portal_png(uri: str) -> bytes:
    parsed = urlparse(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise RuntimeError("Screenshot portal returned an unexpected URI")
    path = Path(unquote(parsed.path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("Screenshot is not a regular user-owned file")
        if info.st_size > MAX_PNG_BYTES:
            raise RuntimeError("Screenshot exceeds the 64 MiB limit")
        data = b""
        while len(data) <= MAX_PNG_BYTES:
            block = os.read(fd, min(1024 * 1024, MAX_PNG_BYTES + 1 - len(data)))
            if not block:
                break
            data += block
        if not data.startswith(bytes((137, 80, 78, 71, 13, 10, 26, 10))) or len(data) < 24:
            raise RuntimeError("Screenshot portal did not return PNG data")
        # The portal saves every capture under ~/Pictures. Avoid accumulating files.
        try:
            path.unlink()
        except OSError:
            pass
        return data
    finally:
        os.close(fd)


async def _portal_screenshot() -> bytes:
    _check_env()
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    token = "uds_" + uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()

    def on_message(message: Message) -> bool:
        if (
            message.message_type == MessageType.SIGNAL
            and message.interface == "org.freedesktop.portal.Request"
            and message.member == "Response"
            and (message.path or "").endswith("/" + token)
        ):
            if not future.done():
                future.set_result(message.body)
        return False

    bus.add_message_handler(on_message)
    rule = "type='signal',interface='org.freedesktop.portal.Request',member='Response'"
    try:
        result = await bus.call(
            Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="AddMatch",
                signature="s",
                body=[rule],
            )
        )
        if result.message_type == MessageType.ERROR:
            raise RuntimeError("Cannot subscribe to screenshot portal responses: " + str(result.body))
        reply = await bus.call(
            Message(
                destination="org.freedesktop.portal.Desktop",
                path="/org/freedesktop/portal/desktop",
                interface="org.freedesktop.portal.Screenshot",
                member="Screenshot",
                signature="sa{sv}",
                body=["", {"handle_token": Variant("s", token), "interactive": Variant("b", False)}],
            )
        )
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError("Screenshot portal request failed: " + str(reply.body))
        code, values = await asyncio.wait_for(future, timeout=30.0)
        if code != 0:
            raise RuntimeError(f"Screenshot denied or cancelled (portal response {code})")
        uri = values.get("uri")
        if uri is None:
            raise RuntimeError("Screenshot portal returned no URI")
        return _read_portal_png(uri.value)
    finally:
        bus.disconnect()


def _size_from_png(png: bytes) -> tuple[int, int]:
    return struct.unpack(">II", png[16:24])


def _devices() -> tuple[UInput, UInput]:
    global _pointer, _keyboard
    if _pointer is None:
        if not os.access("/dev/uinput", os.W_OK):
            raise RuntimeError("User cannot write to /dev/uinput; check the existing uaccess ACL")
        _pointer = UInput(
            {
                ecodes.EV_KEY: [ecodes.BTN_LEFT, ecodes.BTN_RIGHT, ecodes.BTN_MIDDLE],
                ecodes.EV_ABS: [
                    (ecodes.ABS_X, AbsInfo(0, 0, AXIS_MAX, 0, 0, 0)),
                    (ecodes.ABS_Y, AbsInfo(0, 0, AXIS_MAX, 0, 0, 0)),
                ],
                ecodes.EV_REL: [ecodes.REL_WHEEL, ecodes.REL_HWHEEL],
            },
            name="ubuntu-desktop-mcp pointer",
        )
    if _keyboard is None:
        _keyboard = UInput(
            {ecodes.EV_KEY: list(range(1, 256))},
            name="ubuntu-desktop-mcp keyboard",
        )
    return _pointer, _keyboard


def _position(x: float, y: float, normalized: bool) -> tuple[int, int]:
    if _screenshot_size is None:
        raise RuntimeError("Call screenshot first, to establish the real screen dimensions")
    w, h = _screenshot_size
    if normalized:
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError("normalized x and y must be between 0 and 1")
        x, y = x * (w - 1), y * (h - 1)
    elif not (0 <= x < w and 0 <= y < h):
        raise ValueError(f"Pixel coordinates must be inside {w}x{h}")
    return round(x * AXIS_MAX / (w - 1)), round(y * AXIS_MAX / (h - 1))


def _move_raw(x: float, y: float, normalized: bool) -> None:
    global _last_pointer
    ax, ay = _position(x, y, normalized)
    pointer, _ = _devices()
    pointer.write(ecodes.EV_ABS, ecodes.ABS_X, ax)
    pointer.write(ecodes.EV_ABS, ecodes.ABS_Y, ay)
    pointer.syn()
    w, h = _screenshot_size
    px = x * (w - 1) if normalized else x
    py = y * (h - 1) if normalized else y
    _last_pointer = {"x": round(px), "y": round(py), "source": "last_command", "verified": False}


def _move(x: float, y: float, normalized: bool) -> None:
    _move_raw(x, y, normalized)
    time.sleep(0.07)  # Let Mutter process the move before the click.


def _key_press(combo: str) -> None:
    _, keyboard = _devices()
    modifier_keys = {
        "ctrl": "KEY_LEFTCTRL", "control": "KEY_LEFTCTRL",
        "alt": "KEY_LEFTALT", "shift": "KEY_LEFTSHIFT",
        "super": "KEY_LEFTMETA", "meta": "KEY_LEFTMETA",
    }
    specials = {
        "enter": "KEY_ENTER", "return": "KEY_ENTER", "esc": "KEY_ESC",
        "escape": "KEY_ESC", "space": "KEY_SPACE", "tab": "KEY_TAB",
        "backspace": "KEY_BACKSPACE", "delete": "KEY_DELETE",
        "up": "KEY_UP", "down": "KEY_DOWN",
        "left": "KEY_LEFT", "right": "KEY_RIGHT",
        "home": "KEY_HOME", "end": "KEY_END",
        "pageup": "KEY_PAGEUP", "pagedown": "KEY_PAGEDOWN",
        "page_up": "KEY_PAGEUP", "page_down": "KEY_PAGEDOWN",
    }
    keys = []
    for raw in combo.split("+"):
        name = raw.strip().lower().replace("-", "_")
        if not name:
            raise ValueError("Empty key in combo")
        keyname = modifier_keys.get(name) or specials.get(name)
        if keyname is None:
            keyname = "KEY_" + name.upper()
        keycode = getattr(ecodes, keyname, None)
        if not isinstance(keycode, int):
            raise ValueError(f"Unsupported key: {raw}")
        keys.append(keycode)
    try:
        for keycode in keys:
            keyboard.write(ecodes.EV_KEY, keycode, 1)
            keyboard.syn()
            time.sleep(0.015)
        time.sleep(0.075)
    finally:
        for keycode in reversed(keys):
            keyboard.write(ecodes.EV_KEY, keycode, 0)
            keyboard.syn()
            time.sleep(0.015)


@mcp.tool()
async def screenshot() -> Image:
    """Capture the REAL GNOME Wayland desktop as PNG (XDG Screenshot Portal). Returns original-resolution image. Call before coordinate operations."""
    global _screenshot_size
    png = await _portal_screenshot()
    _screenshot_size = _size_from_png(png)
    return Image(data=png, format="png")


@mcp.tool()
def get_active_window() -> dict:
    """Detect the currently active GNOME Wayland window using AT-SPI ACTIVE state. Returns application, title, bounds and a browser hint."""
    return a11y.active_window()


@mcp.tool()
def get_system_state() -> dict:
    """Local time, CPU %, memory, GNOME keyboard layout (best-effort), active window and auto-expiring idle inhibitor status."""
    return system_state.snapshot()


@mcp.tool()
def screen_info() -> dict:
    """Return the most recent screenshot dimensions and input availability. Screenshot must be called first for coordinates."""
    return {
        "last_screenshot_size": _screenshot_size,
        "uinput_writable": os.access("/dev/uinput", os.W_OK),
        "wayland_socket": os.environ.get("WAYLAND_DISPLAY"),
        "coordinate_tips": "Prefer normalized=true with x,y in 0..1 to avoid scaled-preview mistakes",
    }


@mcp.tool()
def move(x: float, y: float, normalized: bool = False) -> str:
    """Move the real pointer. x,y are original PNG pixels; if normalized=true use fractions 0..1 instead."""
    with _input_lock:
        _move(x, y, normalized)
    return "moved"


@mcp.tool()
def click(x: float, y: float, normalized: bool = False, button: str = "left") -> str:
    """Move and click the real desktop. normalized=true uses 0..1 fractions (recommended for resized previews)."""
    _button_code(button)
    with _input_lock:
        keep_mouse, keep_keys = set(_mouse_held), set(_keys_held)
        if _button_code(button) in keep_mouse:
            raise ValueError(f"Mouse button {button} already held")
        try:
            _move(x, y, normalized)
            _mouse_button(button, True)
            time.sleep(0.09)
        finally:
            _cleanup_held(keep_mouse, keep_keys)
    return f"clicked {button} at ({x}, {y}), normalized={normalized}"


@mcp.tool()
def hotkey(combo: str) -> str:
    """Press a real desktop shortcut such as 'super+PageDown', 'ctrl+a', 'alt+F4' or 'Return'."""
    with _input_lock:
        _key_press(combo)
    return f"pressed {combo}"


@mcp.tool()
def type_text(text: str) -> str:
    """Paste Unicode text into the currently focused app using Wayland clipboard + Ctrl+V (works regardless of keyboard layout). Replaces clipboard contents."""
    _check_env()
    if not shutil.which("wl-copy"):
        raise RuntimeError("wl-copy not found; install wl-clipboard")
    if len(text) > 100_000:
        raise ValueError("Text too long (max 100000 characters)")
    result = subprocess.run(
        ["wl-copy", "--type", "text/plain;charset=utf-8"],
        input=text, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8,
    )
    if result.returncode:
        raise RuntimeError("wl-copy failed")
    time.sleep(0.10)
    _key_press("ctrl+v")
    return f"pasted {len(text)} characters"


@mcp.tool()
def scroll(x: float, y: float, steps: int, normalized: bool = False) -> str:
    """Scroll at a desktop point. Positive steps scroll down; negative steps scroll up."""
    if not (-40 <= steps <= 40):
        raise ValueError("steps must be within -40..40")
    _move(x, y, normalized)
    pointer, _ = _devices()
    for _ in range(abs(steps)):
        pointer.write(ecodes.EV_REL, ecodes.REL_WHEEL, -1 if steps > 0 else 1)
        pointer.syn()
        time.sleep(0.02)
    return f"scrolled {steps} steps"



# ---- Additional desktop tools ----

_BUTTONS = {"left": ecodes.BTN_LEFT, "right": ecodes.BTN_RIGHT, "middle": ecodes.BTN_MIDDLE}
_MODIFIERS = {"ctrl": "KEY_LEFTCTRL", "control": "KEY_LEFTCTRL", "shift": "KEY_LEFTSHIFT",
              "alt": "KEY_LEFTALT", "super": "KEY_LEFTMETA", "meta": "KEY_LEFTMETA"}
_SPECIALS = {"enter": "KEY_ENTER", "return": "KEY_ENTER", "esc": "KEY_ESC",
             "escape": "KEY_ESC", "tab": "KEY_TAB", "space": "KEY_SPACE",
             "backspace": "KEY_BACKSPACE", "delete": "KEY_DELETE", "up": "KEY_UP",
             "down": "KEY_DOWN", "left": "KEY_LEFT", "right": "KEY_RIGHT",
             "home": "KEY_HOME", "end": "KEY_END", "pageup": "KEY_PAGEUP",
             "pagedown": "KEY_PAGEDOWN", "page_up": "KEY_PAGEUP", "page_down": "KEY_PAGEDOWN"}


def _keycodes(combo: str) -> list[int]:
    if not combo or len(combo) > 120:
        raise ValueError("Invalid key combination")
    result = []
    for part in combo.split("+"):
        name = part.strip().lower().replace("-", "_")
        if not name:
            raise ValueError("Empty key in combo")
        code = getattr(ecodes, _MODIFIERS.get(name, _SPECIALS.get(name, "KEY_" + name.upper())), None)
        if not isinstance(code, int):
            raise ValueError(f"Unsupported key {part!r}")
        result.append(code)
    if len(result) > 5:
        raise ValueError("Maximum 5 keys in one chord")
    return result


def _key_down(combo: str) -> None:
    _, keyboard = _devices()
    for code in _keycodes(combo):
        if code in _keys_held:
            raise ValueError("Key already held; release before pressing it again")
        keyboard.write(ecodes.EV_KEY, code, 1)
        keyboard.syn()
        _keys_held.add(code)
        time.sleep(0.012)


def _key_up(combo: str) -> None:
    _, keyboard = _devices()
    for code in reversed(_keycodes(combo)):
        if code not in _keys_held:
            raise ValueError("Key is not held")
        keyboard.write(ecodes.EV_KEY, code, 0)
        keyboard.syn()
        _keys_held.discard(code)
        time.sleep(0.012)


def _button_code(button: str) -> int:
    code = _BUTTONS.get(button)
    if code is None:
        raise ValueError("button must be left, right or middle")
    return code


def _mouse_button(button: str, pressed: bool) -> None:
    pointer, _ = _devices()
    code = _button_code(button)
    if pressed and code in _mouse_held:
        raise ValueError(f"Mouse button {button} is already down")
    if not pressed and code not in _mouse_held:
        raise ValueError(f"Mouse button {button} is not down")
    pointer.write(ecodes.EV_KEY, code, 1 if pressed else 0)
    pointer.syn()
    if pressed:
        _mouse_held.add(code)
    else:
        _mouse_held.discard(code)


def _cleanup_held(keep_mouse: set[int], keep_keys: set[int]) -> None:
    """Release only buttons/keys newly held during a sequence, even on exceptions."""
    pointer, keyboard = _devices()
    for code in list(_mouse_held - keep_mouse):
        pointer.write(ecodes.EV_KEY, code, 0)
        pointer.syn()
        _mouse_held.discard(code)
    for code in list(_keys_held - keep_keys):
        keyboard.write(ecodes.EV_KEY, code, 0)
        keyboard.syn()
        _keys_held.discard(code)


@mcp.tool()
def get_cursor() -> dict:
    """Return last REQUESTED synthetic pointer position. GNOME Wayland prevents querying the ACTUAL global cursor without trusted compositor integration."""
    return {"actual_position": None, "actual_available": False,
            "last_commanded_position": _last_pointer,
            "reason": "GNOME Wayland does not provide a public global-pointer query for unprivileged processes"}


@mcp.tool()
def mouse_down(button: str = "left", x: float | None = None, y: float | None = None,
               normalized: bool = False) -> str:
    """Press and hold a mouse button; optional x/y first positions cursor. Must follow with mouse_up."""
    with _input_lock:
        if (x is None) != (y is None):
            raise ValueError("Pass both x and y, or neither")
        if x is not None:
            _move(x, y, normalized)
        _mouse_button(button, True)
        return f"{button} down"


@mcp.tool()
def mouse_up(button: str = "left", x: float | None = None, y: float | None = None,
             normalized: bool = False) -> str:
    """Release a held mouse button, optionally moving first."""
    with _input_lock:
        if (x is None) != (y is None):
            raise ValueError("Pass both x and y, or neither")
        if x is not None:
            _move(x, y, normalized)
        _mouse_button(button, False)
        return f"{button} up"


@mcp.tool()
def double_click(x: float, y: float, normalized: bool = False, button: str = "left",
                 interval_ms: int = 130) -> str:
    """Two discrete clicks with configurable interval (50..350ms), for files/desktop items."""
    if not (50 <= interval_ms <= 350):
        raise ValueError("interval_ms must be 50..350")
    with _input_lock:
        keep_mouse, keep_keys = set(_mouse_held), set(_keys_held)
        try:
            _move(x, y, normalized)
            for n in range(2):
                _mouse_button(button, True)
                time.sleep(0.065)
                _mouse_button(button, False)
                if n == 0:
                    time.sleep(interval_ms / 1000)
        finally:
            _cleanup_held(keep_mouse, keep_keys)
    return f"double_clicked {button} at {x},{y}"


@mcp.tool()
def drag(x1: float, y1: float, x2: float, y2: float,
         duration_ms: int = 500, steps: int = 20,
         button: str = "left", normalized: bool = False) -> str:
    """Smooth mouse press/move/release drag. Coordinates are original screenshot pixels or 0..1 normalized. Releases mouse on exceptions."""
    if not (100 <= duration_ms <= 6000) or not (2 <= steps <= 120):
        raise ValueError("duration_ms must be 100..6000; steps 2..120")
    with _input_lock:
        keep = set(_mouse_held)
        if _button_code(button) in keep:
            raise ValueError("Requested drag button is already down")
        try:
            _move(x1, y1, normalized)
            _mouse_button(button, True)
            time.sleep(0.04)
            delay = duration_ms / steps / 1000.0
            for i in range(1, steps + 1):
                t = i / steps
                _move_raw(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, normalized)
                time.sleep(delay)
            time.sleep(0.055)
        finally:
            _cleanup_held(keep, set(_keys_held))
    return f"dragged {button}: ({x1},{y1}) -> ({x2},{y2})"


@mcp.tool()
def key_down(combo: str) -> str:
    """Hold one or more keys (e.g. shift or ctrl). Follow with key_up."""
    with _input_lock:
        keep = set(_keys_held)
        try:
            _key_down(combo)
        except BaseException:
            _cleanup_held(set(_mouse_held), keep)
            raise
    return f"keys down {combo}"


@mcp.tool()
def key_up(combo: str) -> str:
    """Release keys previously held by key_down."""
    with _input_lock:
        _key_up(combo)
    return f"keys up {combo}"


@mcp.tool()
def key_sequence(events: list[dict[str, Any]]) -> list[str]:
    """Bounded keyboard event script: [{type:'press'|'down'|'up'|'text'|'wait',combo:'ctrl+a',ms:100,text:'...'}]. Held keys from script are released at end."""
    if not 1 <= len(events) <= 40:
        raise ValueError("1..40 key events required")
    with _input_lock:
        keep_mouse, keep_keys = set(_mouse_held), set(_keys_held)
        output = []
        total_wait = 0
        try:
            for event in events:
                if not isinstance(event, dict):
                    raise ValueError("Each event must be an object")
                kind = event.get("type")
                if kind == "wait":
                    ms = int(event.get("ms", 100))
                    if not 0 <= ms <= 3000:
                        raise ValueError("wait ms must be 0..3000")
                    total_wait += ms
                    if total_wait > 12000:
                        raise ValueError("key_sequence wait budget exceeded")
                    time.sleep(ms / 1000)
                elif kind == "press":
                    _key_press(str(event.get("combo", "")))
                elif kind == "down":
                    _key_down(str(event.get("combo", "")))
                elif kind == "up":
                    _key_up(str(event.get("combo", "")))
                elif kind == "text":
                    type_text(str(event.get("text", "")))
                else:
                    raise ValueError(f"Unknown keyboard event {kind!r}")
                output.append(str(kind))
        finally:
            _cleanup_held(keep_mouse, keep_keys)
        return output


def _pil_capture(png: bytes, region: tuple[int,int,int,int] | None = None,
                 scale: float = 1) -> Image:
    global _screenshot_size
    if not (0.1 <= scale <= 1.0) or not math.isfinite(scale):
        raise ValueError("scale must be 0.1..1")
    src = PILImage.open(io.BytesIO(png))
    _screenshot_size = src.size  # Always full physical dimensions, not cropped.
    if region is not None:
        x, y, w, h = region
        if w < 1 or h < 1 or x < 0 or y < 0 or x + w > src.width or y + h > src.height:
            raise ValueError(f"Crop {region} is outside {src.width}x{src.height}")
        src = src.crop((x, y, x + w, y + h))
    if scale != 1:
        size = (max(1, round(src.width * scale)), max(1, round(src.height * scale)))
        src = src.resize(size, resample=PILImage.Resampling.LANCZOS)
    data = io.BytesIO()
    src.save(data, format="PNG", optimize=True)
    return Image(data=data.getvalue(), format="png")


@mcp.tool()
async def screenshot_region(x: int, y: int, width: int, height: int,
                            scale: float = 1.0) -> Image:
    """Screenshot a crop in PHYSICAL screen pixels; optional downscale 0.1..1. Returned crop coords are NOT screen coords; add x,y."""
    return _pil_capture(await _portal_screenshot(), (x, y, width, height), scale)


@mcp.tool()
async def screenshot_scaled(scale: float = 0.5) -> Image:
    """Screenshot full desktop downscaled by 0.1..1. Mouse coordinates remain in full original physical pixels."""
    return _pil_capture(await _portal_screenshot(), scale=scale)


@mcp.tool()
def ui_tree(app_filter: str = "", name_filter: str = "",
            max_depth: int = 22, max_nodes: int = 250) -> dict:
    """AT-SPI accessibility elements (name, role, bounds, temporary path). Filter by application or name."""
    return a11y.tree(app_filter, name_filter, max_depth, max_nodes)


@mcp.tool()
def ui_find(name: str, app_filter: str = "", role: str = "",
            max_nodes: int = 750) -> dict:
    """Find accessible buttons, text fields etc by name and optional app/role; provides temporary path for ui_action."""
    return a11y.find(name, app_filter, role, max_nodes)


@mcp.tool()
def ui_action(path: list[int], operation: str = "activate", value: str = "") -> dict:
    """Semantically activate, focus or set_value on a fresh AT-SPI path. Paths can become stale after UI changes."""
    return a11y.action(path, operation, value)


@mcp.tool()
def list_windows() -> dict:
    """List user-visible AT-SPI top-level windows, including name, role, screen bounds and temporary path (GNOME Wayland)."""
    return {"windows": a11y.windows(), "backend": "at-spi", "note": "Some apps expose no AT-SPI window"}


@mcp.tool()
def control_window(path: list[int], operation: str,
                   x: int | None = None, y: int | None = None,
                   width: int | None = None, height: int | None = None) -> dict:
    """Best-effort window activation/geometry/titlebar actions via AT-SPI. Minimize/maximize only work where the app exposes accessible titlebar buttons."""
    return windows.control(path, operation, x, y, width, height)


async def _dispatch(action: dict[str, Any]) -> str:
    if not isinstance(action, dict):
        raise ValueError("Each batch action must be an object")
    kind = action.get("type")
    norm = bool(action.get("normalized", False))
    if kind == "wait":
        ms = int(action.get("ms", 100))
        if not 0 <= ms <= 3000:
            raise ValueError("wait 0..3000ms")
        time.sleep(ms / 1000)
    elif kind == "click":
        click(float(action["x"]), float(action["y"]), norm, str(action.get("button", "left")))
    elif kind == "move":
        move(float(action["x"]), float(action["y"]), norm)
    elif kind == "double_click":
        double_click(float(action["x"]), float(action["y"]), norm, str(action.get("button", "left")))
    elif kind == "drag":
        drag(float(action["x1"]), float(action["y1"]), float(action["x2"]), float(action["y2"]),
             int(action.get("duration_ms", 500)), int(action.get("steps", 20)), str(action.get("button", "left")), norm)
    elif kind == "mouse_down":
        mouse_down(str(action.get("button", "left")), action.get("x"), action.get("y"), norm)
    elif kind == "mouse_up":
        mouse_up(str(action.get("button", "left")), action.get("x"), action.get("y"), norm)
    elif kind == "hotkey":
        hotkey(str(action["combo"]))
    elif kind == "key_down":
        _key_down(str(action["combo"]))
    elif kind == "key_up":
        _key_up(str(action["combo"]))
    elif kind == "type_text":
        type_text(str(action["text"]))
    elif kind == "scroll":
        scroll(float(action["x"]), float(action["y"]), int(action["steps"]), norm)
    elif kind == "ui_action":
        ui_action(action["path"], str(action.get("operation", "activate")), str(action.get("value", "")))
    else:
        raise ValueError(f"Unknown batch action: {kind!r}")
    return str(kind)


@mcp.tool()
async def run_actions(actions: list[dict[str, Any]], screenshot_after: bool = False) -> Any:
    """Run up to 40 bounded desktop actions serially in ONE MCP call. Optionally include final screenshot in response. Releases new held keys/buttons on failures."""
    if not 1 <= len(actions) <= 40:
        raise ValueError("1..40 actions required")
    total_wait = sum(int(a.get("ms", 0)) for a in actions if isinstance(a,dict) and a.get("type")=="wait")
    total_drag = sum(int(a.get("duration_ms", 500)) for a in actions if isinstance(a,dict) and a.get("type")=="drag")
    if total_wait + total_drag > 12000:
        raise ValueError("Maximum combined wait/drag duration is 12s")
    results: list[str] = []
    with _input_lock:
        prev_mouse, prev_keys = set(_mouse_held), set(_keys_held)
        try:
            for idx, action in enumerate(actions):
                try:
                    results.append(await _dispatch(action))
                except Exception as exc:
                    raise RuntimeError(f"Action {idx} failed: {exc}") from exc
        finally:
            _cleanup_held(prev_mouse, prev_keys)
    report = {"completed": len(results), "actions": results}
    content = [TextContent(type="text", text=json.dumps(report, ensure_ascii=False))]
    if screenshot_after:
        png = await _portal_screenshot()
        global _screenshot_size
        _screenshot_size = _size_from_png(png)
        content.append(ImageContent(type="image", data=base64.b64encode(png).decode("ascii"), mimeType="image/png"))
    return CallToolResult(content=content)




async def _wait_actions(actions: list[dict[str, Any]] | None) -> list[str]:
    """Execute a small script with held-input cleanup, before awaiting a UI change."""
    if actions is None:
        return []
    if not 1 <= len(actions) <= 30:
        raise ValueError("actions must contain 1..30 steps")
    total_wait = sum(int(a.get("ms", 0)) for a in actions
                     if isinstance(a, dict) and a.get("type") == "wait")
    total_drag = sum(int(a.get("duration_ms", 500)) for a in actions
                     if isinstance(a, dict) and a.get("type") == "drag")
    if total_wait + total_drag > 10000:
        raise ValueError("Combined action delays must be at most 10 seconds")
    completed = []
    with _input_lock:
        old_mouse, old_keys = set(_mouse_held), set(_keys_held)
        try:
            for index, action in enumerate(actions):
                try:
                    completed.append(await _dispatch(action))
                except Exception as exc:
                    raise RuntimeError(f"Pre-wait action {index} failed: {exc}") from exc
        finally:
            _cleanup_held(old_mouse, old_keys)
    return completed


@mcp.tool()
async def wait_for_change(
    mode: str = "accessibility",
    timeout_seconds: float = 15,
    app_filter: str = "active",
    event_contains: str = "",
    element_contains: str = "",
    actions: list[dict[str, Any]] | None = None,
    screenshot_after: bool = False,
    region: list[int] | None = None,
    interval_ms: int = 800,
    pixel_threshold: int = 25,
    change_fraction: float = 0.01,
    stable_checks: int = 2,
) -> Any:
    """Wait for UI change in one MCP call. accessibility: event-driven AT-SPI (no screenshots until optional final image); visual: local screenshot comparison for Blender/canvas. Optional actions run AFTER watching starts. On timeout returns changed=false; no image unless a change is detected."""
    if mode not in ("accessibility", "visual"):
        raise ValueError("mode must be accessibility or visual")
    if not (0.5 <= timeout_seconds <= 45) or not math.isfinite(timeout_seconds):
        raise ValueError("timeout_seconds must be between 0.5 and 45")
    if not (400 <= interval_ms <= 3000):
        raise ValueError("interval_ms must be 400..3000")
    if not (0 <= pixel_threshold <= 255):
        raise ValueError("pixel_threshold must be 0..255")
    if not (0 < change_fraction <= 1) or not math.isfinite(change_fraction):
        raise ValueError("change_fraction must be in (0, 1]")
    if not (1 <= stable_checks <= 5):
        raise ValueError("stable_checks must be 1..5")
    if region is not None and (len(region) != 4 or
                               any(not isinstance(n, int) for n in region)):
        raise ValueError("region must be [x,y,width,height] integer screen pixels")
    if len(app_filter) > 150 or len(event_contains) > 200 or len(element_contains) > 200:
        raise ValueError("filters must be 200 characters or shorter")

    started = time.monotonic()
    result = {
        "changed": False, "mode": mode, "timeout": False,
        "elapsed_ms": 0, "actions_completed": [],
    }
    changed_png: bytes | None = None
    if mode == "accessibility":
        if app_filter == "active":
            active = a11y.active_window()
            resolved_app = active.get("app", "") if active.get("found") else ""
            if not resolved_app:
                raise RuntimeError("No active AT-SPI window; provide app_filter or use visual mode")
        else:
            resolved_app = app_filter
        watcher = ui_watch.AccessibilityWatcher(
            app_filter=resolved_app,
            event_contains=event_contains,
            element_contains=element_contains,
        )
        watcher.start()
        try:
            result["actions_completed"] = await _wait_actions(actions)
            remaining = max(0, timeout_seconds - (time.monotonic() - started))
            event = await asyncio.to_thread(watcher.wait, remaining)
            if event is not None:
                result["changed"] = True
                result["event"] = event
        finally:
            watcher.close()
        result["watched_app"] = resolved_app
        result["screenshots_compared"] = 0
    else:
        # Image polling is opt-in for graphical content lacking AT-SPI events.
        # Captures stay local and only one final image is returned if requested.
        roi = tuple(region) if region is not None else None
        baseline_png = await _portal_screenshot()
        global _screenshot_size
        _screenshot_size = _size_from_png(baseline_png)
        baseline = visual_watch.prepare(baseline_png, roi)
        result["screenshots_compared"] = 0
        result["actions_completed"] = await _wait_actions(actions)
        streak = 0
        last = None
        deadline = started + timeout_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(min(interval_ms / 1000, max(0, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                break
            png = await _portal_screenshot()
            _screenshot_size = _size_from_png(png)
            current = visual_watch.prepare(png, roi)
            last = visual_watch.compare(baseline, current, pixel_threshold)
            result["screenshots_compared"] += 1
            is_different = last["resolution_changed"] or last["changed_fraction"] >= change_fraction
            streak = streak + 1 if is_different else 0
            if streak >= stable_checks:
                result["changed"] = True
                changed_png = png
                result["visual_difference"] = last
                result["region"] = region
                break
        if last is not None and "visual_difference" not in result:
            result["visual_difference"] = last

    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    result["timeout"] = not result["changed"]
    content = [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]
    if screenshot_after and result["changed"]:
        if changed_png is None:
            changed_png = await _portal_screenshot()
            _screenshot_size = _size_from_png(changed_png)
        content.append(ImageContent(
            type="image", data=base64.b64encode(changed_png).decode("ascii"),
            mimeType="image/png",
        ))
    return CallToolResult(content=content)

if __name__ == "__main__":
    mcp.run(transport="stdio")
