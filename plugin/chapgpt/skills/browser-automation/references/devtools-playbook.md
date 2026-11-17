# Chrome DevTools MCP: current tool inventory and how to use it

The MCP is currently connected through the My MCP Tools hub. Tool names shown below were inspected from its live `list_tools`; always call `get_tool_schema` for the actual arguments before use.

## Browser navigation and page selection

- `list_pages`: enumerate opened pages.
- `select_page`: select a page in DevTools tool context; **not necessarily** the foreground Chrome tab.
- `navigate_page`: URL/back/forward/reload on intended page.
- `new_page` and `close_page`: alter tab inventory; do this only when explicitly appropriate.
- `resize_page`, `emulate`: deliberate viewport/device/network emulation; restore conditions when done.

## Accessible DOM interactions

- `take_snapshot`: the primary low-cost view of names, roles and actionable nodes.
- `click`, `hover`, `drag`, `press_key`: interactivity.
- `fill`, `fill_form`, `type_text`: form inputs; use `fill_form` when several controls can be filled in one call.
- `wait_for`: wait until expected text appears; check its visibility semantics and timeout.
- `upload_file`: requires a real user-authorized file and intended input.
- `handle_dialog`: alert/confirm/prompt; never automatically accept a destructive browser prompt.

## Code and page inspection

- `evaluate_script`: execute JS in the selected page. Prefer read-only inspection for debugging; don't bypass the UI to make hidden state changes unless the user is explicitly debugging their own app and this approach is warranted.
- `get_css_styles`: style computation and cascade questions.
- `list_console_messages`, `get_console_message`: runtime errors/warnings, failed imports or CSP problems.
- `list_network_requests`, `get_network_request`: request URL/status and diagnostic details; avoid logging auth headers and secrets.
- `take_screenshot`: visual proof for CSS/layout, WebGL output, regressions.
- `lighthouse_audit`: accessibility, performance, SEO and best-practice audit.
- `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`: intentional performance investigations; collect trace only when necessary.
- `take_heapsnapshot`, `screencast_start`, `screencast_stop`, `set_logpoints`: heavyweight/specialized debugging; check impact, time and artifact sensitivity.

## Practical task patterns

**Fill existing form:** `list_pages` → correct page → `take_snapshot` → `fill_form` → `wait_for` expected validation → fresh `take_snapshot`. Submission requires scope/authorization.

**Debug blank WebGL canvas:** correct page → `list_console_messages` → `list_network_requests` for scripts/textures/GLB → `evaluate_script` read-only renderer/scene counters (when app exposes them) → `take_screenshot` → isolate root cause in app or Blender asset.

**Verify layout:** `take_snapshot` for semantic content → `resize_page` only when responsive view is requested → `take_screenshot` → `get_css_styles` on exact element → restore original viewport when done.

**Wait after action:** prefer `wait_for` expected DOM text, network response or a targeted read-only DOM query. Don't poll full screenshots by default.

## Chrome ↔ Desktop boundary

DevTools can connect to a browser debugging endpoint but cannot automatically inspect every native Chrome popup, extension dialog or OS file chooser. Use `ubuntu-desktop` for such surfaces. Use `get_active_window` to disambiguate which app is active; do not assume the DevTools-selected page is the currently focused tab.
