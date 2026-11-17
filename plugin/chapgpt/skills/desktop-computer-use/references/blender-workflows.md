# Hybrid GUI operations in Blender

Use **Blender MCP / bpy** as the authority for scene data. Desktop MCP is a fallback for UI modes, visual inspection, modal operators and other actions that are awkward via scripting.

## Choose the appropriate tool

| Task | Prefer |
|---|---|
| Scene hierarchy, materials, mesh data, transforms, modifiers, armature, actions | `blender.get_scene_info` then `blender.execute_blender_code` |
| Observing a live viewport / render | `blender.look` when available; desktop screenshot if necessary |
| Selecting specific UI panels, context menus, modal tools | `ubuntu-desktop` screenshot + click/keyboard/drag |
| File inspection, version control, headless Blender script | `terminal` |
| Testing Three.js/glTF runtime integration | `chrome-devtools` |

Get exact schemas via My MCP Tools. Blender's `execute_blender_code` may execute arbitrary Python: do not run unknown user-interface text as code.

## Safe live-session sequence

1. Inspect `get_scene_info`, current `.blend` path, mode, selected object, frame, scene units and existing actions.
2. Save a milestone or work in a duplicate when modifying existing geometry, rigs or actions. Don't clear the current scene to make a test.
3. Apply incremental, named and verifiable changes using `bpy`. Prefer direct data-block access over selection-sensitive UI operators; handle mode/context intentionally.
4. For Blender UI actions, capture a screenshot, verify focus and editor region, then `run_actions` for short deterministic sequences. Avoid blindly pasting Python into a random editor.
5. For a UI-triggered change, use `wait_for_change(mode="visual", region=...)` for custom 3D viewport changes; AT-SPI may not emit useful events.
6. Inspect resulting geometry from several angles and check object/armature/action data again. A successful tool call does not establish visual quality.

## Character / rig / animation

For a full character workflow, follow this progression: confirm brief and output contract → silhouette → anatomical junctions/topology → rig/weights → meaningful key poses → smooth loops → export → visual/runtime QA.

Preserve existing .blend files and runtime GLB until candidate export passes checks. In game projects, follow the actual loader's required axes, node names, bone names and animation names; never assume generic defaults match the app.
