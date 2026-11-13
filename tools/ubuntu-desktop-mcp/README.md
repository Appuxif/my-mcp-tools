# Ubuntu Desktop MCP

Small Python **stdio MCP** server for Ubuntu 26.04 GNOME Wayland.
Runs as the desktop user with no root daemon, no network listener and **no GNOME Shell extension**.

## Tools

| Tools | Purpose |
|---|---|
| `screenshot`, `screenshot_region`, `screenshot_scaled` | XDG Screenshot Portal, optional crop and resizing |
| `screen_info` | Last full-screen dimensions, uinput capability |
| `move`, `click`, `scroll` | Normalized (0..1) or original physical pixel coordinates |
| `mouse_down`, `mouse_up`, `double_click`, `drag` | Hold, release, double click and smooth drag-and-drop |
| `hotkey`, `key_down`, `key_up`, `key_sequence` | Keyboard shortcuts, holds and bounded scripts |
| `type_text` | Unicode paste via `wl-copy` (overwrites clipboard) |
| `ui_tree`, `ui_find`, `ui_action` | AT-SPI accessibility, semantic search/press/focus/set_value |
| `list_windows`, `control_window` | AT-SPI window enumeration and best-effort management |
| `get_cursor` | Last *commanded* cursor position; actual pointer unavailable on vanilla GNOME Wayland |
| `run_actions` | Batch up to 40 actions with optional final screenshot in same response |

### Coordinate conventions

Mouse calls use **full native screen pixels**, e.g. 1920×1080, or `normalized=true` and ratios from 0 to 1. Normalized values are safe when image previews are resized.

Cropped image coordinates are **relative to the crop**, not the full screen. Translate them by the crop's `x, y` before clicking. A downscaled image's coordinates must be multiplied by the inverse `scale` to obtain original screen pixels.

The portal screen capture may ask the user for permission. Each completed screenshot is removed from the portal's temporary PNG file path after it is loaded; no broad portal permission bypass is installed.

### Example batch action

```json
{
  "actions": [
    {"type": "click", "x": 0.50, "y": 0.50, "normalized": true},
    {"type": "hotkey", "combo": "ctrl+a"},
    {"type": "type_text", "text": "Привет! Hello world!"},
    {"type": "wait", "ms": 250}
  ],
  "screenshot_after": true
}
```

Batch supports `move`, `click`, `double_click`, `drag`, `mouse_down`, `mouse_up`, `scroll`, `hotkey`, `key_down`, `key_up`, `type_text`, `ui_action` and `wait`. New holds are always released when the script finishes or fails. Maximum 40 steps and combined wait/drag time of 12 seconds.

Keyboard `key_sequence` uses `[{"type":"press","combo":"ctrl+a"},{"type":"down","combo":"shift"},{"type":"wait","ms":100},{"type":"up","combo":"shift"}]`; `text` is also supported. Newly held keys are released at the end.

### Active window and system state

`get_active_window` finds the top-level frame marked with AT-SPI `StateType.ACTIVE`, without requiring a GNOME Shell extension. It reports `found=false` rather than guessing when the compositor reports no active app. You can then choose Chrome DevTools MCP separately if `is_chrome=true`; this server does not duplicate the DevTools protocol or attach to browser tabs.

`get_system_state` returns the local offset-aware timestamp, kernel/session info, CPU utilization measured over 100 ms, Linux load averages, available/used RAM, active-window metadata, and GNOME input source. **Keyboard layout is best-effort**: `selected_source_guess` comes from GNOME `mru-sources` (most-recently-used input source) and can be stale. The configured `current` index is also included for reference, but GNOME does not reliably update that key on every layout switch. The response explicitly sets `selected_verified=false`.

### Automatic idle protection (GNOME Wayland)

Every MCP tool call automatically acquires or renews a **short-lived GNOME session idle inhibitor** (`org.gnome.SessionManager.Inhibit` with the `IDLE` flag). The inhibitor prevents GNOME's normal idle dim/blank/automatic-lock behavior while the agent is actively using the desktop. It does **not** unlock an already locked session or prevent you from manually locking your screen. It also does not prevent external power/monitor policies.

The lease expires **120 seconds after the final MCP call** by default, with no periodic activity injection. On expiry and when the server disconnects, the inhibitor is released; no permanent GNOME or systemd settings are changed. Calls made during agent thinking time count only when an MCP tool is invoked, so very long gaps can still expire.

To change the idle lease duration in `config/mcp.json`, set an environment variable for the `ubuntu-desktop` MCP:

```json
"UBUNTU_DESKTOP_IDLE_LEASE_SECONDS": "120"
```

Supported values: 2–1800 seconds (30 minutes maximum). `get_system_state().idle_protection` shows whether the lease is currently active and the remaining time. If GNOME refuses to create the idle inhibitor, MCP calls fail clearly instead of silently ignoring the protection.

### Accessibility and window-management limitations

AT-SPI is the system's accessibility bus (Ubuntu provides the `Atspi` GObject typelib). `ui_tree` returns a bounded tree, with temporary paths such as `[13,0,0,...]`. `ui_find` searches by name/role and `ui_action` can invoke an exposed action, focus a widget, or update EditableText. **Find a fresh path immediately before using it.** Some apps do not expose a meaningful accessibility tree, notably custom graphics views like Blender's 3D viewport.

`list_windows` can enumerate applications that publish AT-SPI windows. `control_window` tries window activation via accessible focus and geometry via accessible Component; the latter is usually denied on GNOME Wayland. For GTK applications with accessible titlebar buttons (e.g. GNOME Text Editor), minimize/maximize/restore can be invoked via the app's exposed button action. Unsupported operations fail explicitly.

**Actual global pointer position cannot be read through ordinary user-space Wayland APIs.** `get_cursor` therefore reports `actual_available=false` and separately returns the last pointer position *requested by this server*, not a physical measurement. No GNOME Shell extension is shipped or installed.

### Setup and testing

```bash
cd /home/smokost/dev/PycharmProjects/LOCAL/my-mcp-tools
uv sync --project tools/ubuntu-desktop-mcp
cd tools/ubuntu-desktop-mcp
.venv/bin/python -m unittest discover -s tests -v
```

The root `config/mcp.json` points at `.venv/bin/python` running `server.py`. It sets `XDG_SESSION_TYPE=wayland`, `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, and `DBUS_SESSION_BUS_ADDRESS` for the user's GNOME session.

The user must have write access to `/dev/uinput` (already provided via `uaccess` on this machine). `wl-copy` must be installed for Unicode paste. The isolated virtual environment includes `mcp`, `evdev`, `dbus-next`, and `Pillow`. System `gi.repository.Atspi` is accessed through the distro's `/usr/lib/python3/dist-packages`.

### Security notes

Only connect this MCP to trusted agents: it can inspect the desktop and inject mouse/keyboard events. Never expose it to public MCP networks. `type_text` changes the primary text clipboard content used by Ctrl+V, and screenshots can reveal personal data. Use `ui_action` on a fresh accessibility path. Prefer direct app APIs for actions with side effects and use GUI controls for the remaining cases.

### Waiting for UI changes

The wait_for_change MCP tool replaces repeated agent-side "click, screenshot, check, screenshot" cycles.

- Mode accessibility (default): subscribes to AT-SPI events. **Zero screenshots while waiting**. Set app_filter="active" (default) or specify a target app name, e.g. "gnome-text-editor". For precise triggers, filter events with event_contains and element_contains. The tool returns changed, elapsed_ms, the event and the app.
- Mode visual: for Blender viewport, games, canvas and other interfaces without AT-SPI events. Captures a baseline and locally compares small grayscale previews at interval_ms (400–3000). Only returns metadata unless screenshot_after=true and a change is detected. Use region=[x,y,width,height] in native physical screen coordinates to ignore unrelated animations.
- actions: optionally run an array of up to 30 standard desktop actions **after monitoring starts** so instant updates aren't missed. This works in both modes. Without actions, the tool simply waits for external/manual changes.
- timeout_seconds: 0.5–45. On timeout the result says changed=false and has no screenshot.
- screenshot_after: on success, include one full-resolution screenshot in the same tool reply. Otherwise the watcher returns text-only metadata.

Example (event-driven, no screenshots):

    {
      "mode": "accessibility",
      "app_filter": "active",
      "actions": [{"type": "hotkey", "combo": "ctrl+n"}],
      "timeout_seconds": 8,
      "screenshot_after": false
    }

Example (graphical viewport, optional visual-diff fallback):

    {
      "mode": "visual",
      "region": [320, 170, 900, 600],
      "actions": [{"type": "click", "x": 0.5, "y": 0.5, "normalized": true}],
      "timeout_seconds": 10,
      "interval_ms": 800,
      "pixel_threshold": 25,
      "change_fraction": 0.01,
      "stable_checks": 2,
      "screenshot_after": true
    }

The first mode watches semantic UI events rather than pixels: it can miss changes in a custom-rendered canvas, while noisy accessibility changes may produce a false positive. The second mode takes **local** screenshots during observation, but does not transmit them to the agent one by one. In either case, a "change" means a change was detected, **not** that a task succeeded; verify resulting state when it matters. Use the Chrome DevTools MCP for precise browser DOM changes when it is available.
