# Character modeling and sculpture pipeline

Apply artistic and QA principles according to the current project's design goals and runtime constraints.

## Define the visible goal

Write down the intended character class/mood, camera distance, posture, clothing, key accessories and important silhouette features. Use rough head-to-body ratios as a **design decision**, not a universal law; stylized adult humans might target ~6–7.5 heads, exaggerated/cartoon designs deliberately differ.

Capture references if available. Identify anatomical landmarks: skull-jaw-neck, brow/eyes/nose, deltoid and arm junction, elbow bend, forearm taper, wrist, rib cage, pelvis, knee, calf, ankle and foot. Clothes wrap the body and overlap logically.

## Practical modeling order

1. **Blockout:** pelvis, chest, head, limbs, major outfit volumes. Evaluate proportion from orthographic front and side. Save this checkpoint.
2. **Organic continuity:** refine torso/neck, shoulders and limb transitions using purposeful mesh topology. Don't leave impossible hard seams between organic surfaces just because the primitives intersect.
3. **Face and hands:** simple readable facial planes, ears and nose. Deliberate thumb and fingers when the character needs tools or gestures. Check grip on equipment from side and front.
4. **Clothing and gear:** sleeves/cuffs, torso garment, belts, footwear, hair, bag, armor or tools. Each layer must attach and clear adjacent geometry in expected poses.
5. **Surface quality:** smoothing normals, bevels, sculpted planes, shade transitions, intentional asymmetry. Avoid excessive subdivision with no visible silhouette benefit.
6. **Game mesh:** retopologize a sculpt or directly construct clean low-poly surfaces; keep edge flow around joints and simplify flat areas. UV/texture only where beneficial.

## Visual rejection checklist

- Visible cube/cylinder joints or an unfinished assemblage of primitives.
- Shoulder and upper arm disconnected; neck merges like a pipe.
- Missing/fused fingers, tool intersects palm, weapon edge faces wrong direction.
- Floating ornaments, clothing clip-through, oversized detached feet.
- Inverted normals, shading seams, z-fighting, long degenerate polygons.
- Silhouette disappears from game camera or face/weapon too small to read.

## Minimum visual proof

Solid + material views: front, side, back, 3/4. Also close-ups of face, wrists/hands/tool and any unusual silhouette. Test at roughly gameplay thumbnail size (e.g. ~160 px character height). Data-only checks cannot certify artistic quality.

## Reproducible Blender automation

Prefer named objects/collections and short `bpy` functions. Set units and coordinate contract intentionally. For procedural geometry, fix random seeds, preserve parameters and retain an editable `.blend` file. A deterministic build script can help, but verify the rendered result after each modeling stage.
