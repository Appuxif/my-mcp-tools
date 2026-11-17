# Ubuntu Desktop MCP field guide

The MCP is reached **through My MCP Tools hub**, not necessarily as direct tools. Discover the server name (currently `ubuntu-desktop`) and check each tool's current input schema before use.

## Observability

| Tool | Use |
|---|---|
| `get_active_window` | AT-SPI ACTIVE top-level window: app name, title, bounds and Chrome hint; may report no active app |
| `get_system_state` | Local time, CPU/memory, keyboard layout **guess**, GNOME idle-lease status |
| `list_windows`, `control_window` | AT-SPI-enumerated windows; focus/resize/minimize are best-effort and app-dependent |
| `ui_tree`, `ui_find`, `ui_action` | Accessibility names/roles; activate/focus/set_value using fresh paths |
| `screen_info` | Last *full-resolution* capture size |
| `screenshot`, `screenshot_scaled`, `screenshot_region` | Whole screen, reduced screen or crop |
| `get_cursor` | Last **requested synthetic** position; **not** actual cursor measurement |

Use accessible semantic targets when possible. Blender's 3D viewport, games and custom canvases usually need pixels.

## Input and chaining

| Tool | Use |
|---|---|
| `click`, `double_click`, `move`, `scroll` | Target position / scrolling |
| `drag`, `mouse_down`, `mouse_up` | Drag & drop and held mouse input |
| `hotkey`, `key_down`, `key_up`, `key_sequence` | Keyboard shortcuts or held keys |
| `type_text` | Paste arbitrary Unicode via Wayland clipboard + Ctrl+V; **overwrites clipboard** |
| `run_actions` | One call for deterministic multi-step mouse/keyboard actions plus optional final screenshot |
| `wait_for_change` | One call to start observation, optionally perform actions, then wait for a UI event/visual diff |

### Example: click, pause, type and submit

```json
{
  "actions": [
    {"type": "click", "x": 0.48, "y": 0.82, "normalized": true},
    {"type": "wait", "ms": 250},
    {"type": "type_text", "text": "Hello! 👋 Unicode works!"},
    {"type": "wait", "ms": 200},
    {"type": "hotkey", "combo": "Return"}
  ],
  "screenshot_after": true
}
```

Send the text/submit only if this is the user's requested action. Use `wait` for brief known delays, not as a substitute for checking readiness.

### Example: event-driven change detection

```json
{
  "mode": "accessibility",
  "app_filter": "active",
  "actions": [{"type": "hotkey", "combo": "ctrl+n"}],
  "timeout_seconds": 8,
  "screenshot_after": false
}
```

Accessibility mode listens for AT-SPI events (children, name, text, state and window events) and sends **zero intermediate screenshots**. It may react to unrelated accessible changes: narrow `app_filter`, `event_contains`, `element_contains` as useful, and verify final state. When no accessible changes are emitted, use visual mode.

```json
{
  "mode": "visual",
  "region": [300, 160, 1150, 720],
  "timeout_seconds": 8,
  "interval_ms": 800,
  "pixel_threshold": 25,
  "change_fraction": 0.015,
  "stable_checks": 2,
  "screenshot_after": true
}
```

Visual mode captures locally and compares reduced grayscale images; it does **not** stream screenshots to the model. A blinking caret/clock/animated viewport can cause false positives; choose a tight region and adjust thresholds. `changed=true` is not proof the desired operation completed.

## Coordinates and display

The pointer's target space is original *screen pixels*, not browser CSS pixels, preview pixels or cropped/scaled image pixels. Use `normalized=true` when clicking a percent position in full-screen screenshots.

For crop region `(rx,ry,w,h)` and scale `s`, a point `(cx,cy)` in the returned image maps to original screen pixels:
`x = rx + cx/s; y = ry + cy/s`.

Call `screenshot` once to establish screen size before coordinate operations. Multi-monitor support, compositor scaling and window decorations require verification instead of assumed offsets.

## Failure patterns

- No focus: call `get_active_window`, focus the intended target and reobserve.
- Stale `ui_action` path: call `ui_find` again.
- Long workflow: split into batches around observable UI state changes.
- `wait_for_change` timeout: inspect active window, target tree/region and the tool's returned metrics.
- Window-management failure: use application-provided AT-SPI button, keyboard shortcut or the terminal/application API; do not claim generic compositor control.
