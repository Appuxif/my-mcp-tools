# Armatures, skinning and game animation

## Rig architecture

- Prefer a single **deform armature** for the exported character. An animator control rig or IK controllers may exist in the source but should not automatically export unless the runtime requires them.
- Bone names and hierarchy must reflect the project's actual runtime contract. Use a sensible naming scheme for a new character; don't silently rename existing bones.
- Set correct rest pose, joint centers and bone rolls; apply transform conventions consistently. If a weapon is rigid, attach it to the designated hand bone or give it a single-bone weight.
- Normalize vertex weights, resolve unweighted regions, and target at most four meaningful influences per vertex where mobile/glTF constraints matter. Confirm modifier targets.
- Check deformation at extremes: arm raised overhead, elbow folded, wrist rotated, thigh/knee bend, planted foot, finger grip; inspect garment penetration.

## Animation method

Choose key poses before inserting lots of intermediate keys. Use logical spacing and timing for a natural motion; animate the pelvis, chest and arms rather than only rotating lower legs.

**Walk cycle (one full stride, repeating):**

| Phase | At 24 frames | Important checks |
|---|---:|---|
| Contact A | 1 | Leading heel touches, trailing toe near lift |
| Down A | 4 | Pelvis lowers, leading leg bears weight |
| Passing A | 7 | Swing leg passes stance leg, weight over support |
| Up A | 10 | Pelvis rises before next contact |
| Contact B | 13 | Opposite heel strike; mirrored arms |
| Down B | 16 | Controlled weight absorption |
| Passing B | 19 | Opposite leg swings through |
| Up B | 22 | Preparing to return to Contact A |
| Loop boundary | 25 | Match pose at frame 1; use 1–24 for sampled loop |

This is a **starting example**, not an immutable timing chart. Cycle length, frame rate, stride and root movement depend on the character/game. Test at intermediate frames and accelerated playback speeds.

**Run cycle:** stronger forward lean, clear airborne phase where appropriate, faster cadence, arms driving opposite legs; verify landing/weight shift and absence of skating.

**Idle:** relaxed natural posture, mild breath and subtle weight shift; loop endpoints match without snapping or distracting robotic oscillation.

**Action/attack:** anticipation → action/contact → follow-through → recovery. Equipment-to-hand transform remains stable throughout the attack.

## Root motion vs in-place

Establish whether movement is extracted from an animated root bone or driven by the engine controller. For a root-motion walk/run clip, horizontal displacement may accumulate while local body pose loops; do **not** force root translation to return to the starting position when the engine needs displacement. For an in-place clip, keep root XY motion consistent with its runtime semantics.

## Blender version differences

On newer Blender versions, actions may use slots and layered strips. Prefer `bpy` keyframe insertion and inspect actual Action data; don't assume `action.fcurves` exists. When exporting, verify intended action slots/clips are visible to glTF exporter. Bake drivers, IK and constraints onto the deform rig where required. Never rely on F-curve cycles modifiers being preserved by glTF.

## Animation QA

Check frames at 0/25/50/75/100% and the **two frames around the loop seam**. Watch world-space foot contact, arm rhythm, shoulder/wrist deformation, knee popping and hip stability. Test playback speed expected in the target runtime. Inspect the exported GLB animation, not only Blender keyframes.
