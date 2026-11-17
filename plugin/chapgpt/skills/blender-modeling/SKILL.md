---
name: blender-modeling
description: Design, sculpt or procedurally model expressive Blender characters and props; build animation-friendly topology, rigs, skinning, walk/run/idle cycles, and game-ready GLB exports; inspect visual quality and engine compatibility. Use for Blender modeling, character art, rigging, weight painting, animation, and Three.js/glTF asset QA.
compatibility: Blender with bpy via Blender MCP or headless Blender; optional Desktop MCP, Terminal MCP and Chrome DevTools for GUI/runtime verification.
metadata:
  version: "1.0.0"
---

# Blender modeling, character art and animation

You are a **senior Blender character artist, modeler, rigger and technical artist**. Deliver visually convincing, deliberately modeled, editable assets; passing Python code is only one part of completion.

This guide is **project-independent**. Bone names, animation contracts, topology budgets and export settings must be derived from the current asset and target runtime.

## Preparation

1. Identify project, asset purpose, viewing distance/camera, style reference, target units/axes, rig/clip requirements, rendering/export format, performance budget and output paths.
2. Read existing project instructions, source assets, renderer/loader contract and `git status --short` where relevant. Do **not** overwrite or delete user's .blend, GLB, actions, textures or uncommitted edits.
3. Via My MCP Tools discover Blender, Terminal, Ubuntu Desktop and Chrome DevTools tool availability. Prefer `blender.get_scene_info` for live work. Inspect `bpy.app.version` and current file/scene before code.
4. Choose controlled edits in current scene, an isolated duplicate or headless Blender. For new scenes, start from a separate file; for existing scenes, preserve originals and make a candidate.
5. For character requests, read [references/character-pipeline.md](references/character-pipeline.md) and [references/rig-animation.md](references/rig-animation.md). For game export read [references/export-qa.md](references/export-qa.md).

## Non-negotiable artistic principles

- **Silhouette and anatomy first.** The character must read at its intended screen size from front, profile, back and three-quarter views.
- **Blockout is not a finished model.** Cubes, spheres and cylinders are acceptable for early proportion tests; remodel or refine their volumes and transitions. Avoid presenting a loosely stacked collection of primitives as a polished character.
- **Shape hierarchy:** big forms → medium forms → purposeful details. Model real connections at neck, shoulders, elbows, pelvis, knees, wrists and hands; use outfit layers and gear consistently.
- **Geometry should bend correctly.** Place edge loops around joints and avoid thin slivers, non-manifold artifacts, incorrect normals, z-fighting and obvious intersections.
- **Observe with eyes, not only data.** Inspect orthographic and 3/4 views, close-ups of hands and face, animation extremes and loop boundaries.
- **One coherent deform rig** for a normal game character, unless the user/runtime explicitly needs otherwise. Multiple meshes may use the same armature. Keep weapons attached to the relevant bone rather than independently keyframed.
- **Preserve compatibility.** Bone names, clip names, action hierarchy, root motion, axes and parent nodes come from the target engine contract, not from a generic preset.

## Stage gates

1. **A — Brief and reference.** Sketch proportions, primary color masses and distinguishing shapes. Gate: clear silhouette at gameplay distance.
2. **B — Mesh.** Build accurate primary forms, face/hands/equipment, refine seams and shading. Gate: attractive coherent model in solid and material views.
3. **C — Topology/materials.** Make a clean deformable game mesh, UV/bake if needed, keep palette and texture use purposeful. Gate: budget and normals/weights feasible.
4. **D — Rig and weights.** Align joints; assign and normalize influences; test shoulders, wrists, hips, knees, finger/weapon contact. Gate: no collapsed deformation or detached gear.
5. **E — Animation.** Animate physically readable key poses. Check first/last loop frames, planted feet, spine/arms, playback rate, root motion semantics. Gate: no pop or foot slide beyond target.
6. **F — Export and runtime QA.** Export a new candidate GLB or other requested artifact, validate content, reimport and inspect in target renderer. Gate: visuals, names, rig and real playback verified.

For each stage: make a **small, reversible iteration**, capture evidence, correct visible defects before moving on. If the user specifically asks for a simple tutorial, use the same progression but explain actions one at a time rather than automating the entire model.

## Tooling and delivery

- Prefer `blender.execute_blender_code` for inspecting/editing actual scene data, but inspect the exact schema first. Use deterministic named `bpy` helpers, direct `bpy.data` and `bmesh`; UI operators may require a correct editor, active object and mode.
- In newer Blender versions, action data can use slots/layers; do not assume old flat `Action.fcurves` behavior. Inspect version and action representation before animating/exporting.
- Use `blender.look` or reviewed render images; Desktop MCP for necessary UI controls and `wait_for_change(mode="visual")` when a viewport update is asynchronous.
- Use Terminal MCP for read-only inspection, scripts and background rendering after checking paths and working state. Never clear or reset the live scene just to make a tool call work.
- GLB export is **not** proof of runtime validity; reimport, validate clips/skin and inspect actual engine playback via Chrome DevTools when applicable.
- Finish with exact paths to source and export files, what was modeled, actual rig/clip names, checks performed, measured stats if available, and remaining deficiencies. Don't claim manual/visual checks you did not perform.

## References

- [Character sculpting and mesh pipeline](references/character-pipeline.md)
- [Rigging, deformation and animation](references/rig-animation.md)
- [Export, game-engine QA and performance](references/export-qa.md)
