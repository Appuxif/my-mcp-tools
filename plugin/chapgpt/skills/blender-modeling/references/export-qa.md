# Export and game-engine QA

## Prepare source and candidate

- Inspect current scene, source file path, transform units, armature, mesh names, animations, materials and user edits.
- Save an editable `.blend` milestone. Export a **candidate** (not the production GLB) and reimport it into an isolated scene before replacing any runtime asset.
- Select only the exported asset's armature and dependent meshes; exclude test cameras, lights, sculpt-source meshes, controllers and render stage unless intentionally requested.
- If materials contain complex procedural nodes, bake to supported textures/parameters for glTF.

## Structural checks

Verify (with `bpy`, glTF loader or suitable GLB inspector):

- File format is glTF 2.0 / GLB as requested and can be parsed.
- Correct mesh count/triangle count, material/texture count and size in bytes.
- Armature and skin are present for a rigged asset; all intended skinned meshes reference the correct skeleton.
- Bone names, hierarchy and clips match the current runtime contract; no accidental duplicate clip names.
- Animation channel tracks are bound to relevant deform bones/root, not unwanted independently animated scene objects.
- Root motion exists when the runtime needs it and matches locomotion axis convention.
- Forward direction and ground contact are correct after import (Blender and engine axes may differ).
- Bone parenting / weapon grip survives export.
- Reimported materials and normal shading look plausible.

## Runtime check (Three.js or other engine)

Load candidate GLB **in a separate preview** without changing the live production asset. Check loader warnings, animations, skinning, blending and loop transitions. Run representative Idle/Walk/Run/attack at the actual game playback speed. If multiplayer clones use `SkeletonUtils.clone`, test at least one clone as well.

Only after visual review + structured QA should the candidate replace a production asset, and only when explicitly requested.

## Structural validation tooling

Use a GLB/glTF validation utility suited to the target runtime, or inspect exported JSON/binary accessors and animation channels directly. Structural checks can find missing skins, malformed buffers and unwanted tracks, but **cannot certify** artistic quality, deformation, tool grip, materials or runtime playback.

## Completion criteria

Provide absolute/relative paths to source and candidate, object/bone/clip summaries, verified triangle/material counts, visual review performed, compatibility result and remaining risks. If no render/runtime inspection was possible, disclose that explicitly.
