# Browser verification, reproducibility and safeguards

## Evidence ladder

For a webpage operation prefer the cheapest reliable observation:

1. Specific accessible node text/property from a fresh snapshot.
2. Targeted read-only `evaluate_script` (e.g. document title, selected value, visible DOM state) when accessibility output is insufficient.
3. Expected DOM text with `wait_for` or app-specific event/status.
4. Console/network result for JavaScript errors or backend persistence.
5. Screenshot for visual correctness, WebGL content or UI-specific issues.

DOM presence != element visibility; tool success != business transaction success; HTTP 200 != correct app state. Verify the dimension the task actually cares about.

## Read-only examples

`evaluate_script` can check:

```js
() => ({
  url: location.href,
  title: document.title,
  visibleText: document.body?.innerText.slice(0, 400) ?? ""
})
```

Keep result size bounded; don't capture arbitrary cookies, localStorage or session storage.

For frontend debugging, collect relevant console errors and failed requests only, then correlate them with the user's local app files through Terminal MCP. If the user asks for code changes, verify app behavior again after editing/reloading.

## Failure handling

- **Stale snapshot:** inspect a new snapshot after navigation or large DOM changes.
- **Page not listed:** confirm browser debugger availability and profile; do not silently start a separate browser.
- **Can't click element:** check visibility/overlay/disabled state via screenshot or computed CSS; avoid blind retries.
- **Dialog:** inspect dialog message, handle only the intended choice.
- **Network request fails:** inspect status/error once, keep private headers out of responses.
- **Async page:** use bounded `wait_for`; if timed out, report actual observation rather than assuming eventual success.

## Browser QA for 3D and animation

- Check GLB/network success, console warnings, animation count/names and skinning updates.
- Assess visual appearance from the user's actual camera perspective, not only exported mesh stats.
- Use runtime FPS/draw calls/triangles where exposed, otherwise measure with app-specific tooling; don't invent metrics.
- Confirm animation loop at contact poses, playback speed and interpolation; test cloned avatars where relevant.
- Distinguish failures in the **model asset** from failures in the **Three.js renderer/loader**.

## Safe completion

Use a concise summary of page, action, expected/observed result and any remaining ambiguity. Only make public changes, submit forms or delete records when user intent clearly authorizes the effect.
