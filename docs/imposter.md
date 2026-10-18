# Imposters (the imposter kit)

Octahedral imposters for any renderer: bake a mesh once into a G-buffer atlas of N x N views around it, then draw
its far instances as camera-facing quads that rebuild the surface from the three nearest views. The atlas holds no
lighting, so any lighting works without a rebake. [`js/kits/imposter/`](../js/kits/imposter/) (`engine.kits.imposter`;
list `imposter` in a feature's `USES` or a kit's `uses`) is the pipeline the imposter feature
([docs/features/imposter.md](features/imposter.md), how it works in depth) runs on:

| Part | What |
|---|---|
| `octahedral` | `Oct` (encode / decode / frameDir / right / select: directions <-> the atlas square, JS), `WGSL_OCT` (the same in WGSL), `orthoFrame` (one frame's orthographic camera) |
| `atlas` | the layers and their formats, `atlasLayers`, `atlasMipLevels`, `ImposterAtlas` |
| `shaders` | `WGSL_BAKE_FRAME` (what a source's bake shader writes into), `WGSL_BAKE` (the standard mesh's), `WGSL_AO`, `WGSL_MIP`, `imposterWGSL` (drawing) |
| `gpu` | `ImposterGpu`: per device, the samplers, bind group layouts and pipelines |
| `baker` | `ImposterBaker`, `meshSource` (the standard mesh as a source), `bakeVertexAO` |
| `lists` | `LodLists` + `lodListsWGSL` (GPU culling into mesh / imposter lists feeding indirect draws), `drawImposters` |

Everything is per device: `ImposterGpu.of(device)` makes it once (the kit's parts call it themselves).

## Baking an atlas

```js
const { ImposterBaker } = engine.kits.imposter;
const baker = new ImposterBaker(device);
const atlas = await baker.bake(source, { grid: 12, res: 128, full: false });
```

`options`: `grid` frames per side, `res` px per frame (halved until the atlas fits the device's largest texture),
`full` the whole sphere (objects seen from below, or rotated freely), else the upper hemisphere (ground objects).

A **source** is anything a renderer can draw:

| Field | |
|---|---|
| `center`, `radius` | its bounding sphere, in its own space (the bake adds 2%) |
| `emissive` | bake the emission layer too |
| `draw(pass)` | record one frame's draws. Group 0 (the frame) is bound; it sets its pipelines, vertex buffers and its own groups 1.. |

Its pipelines come from `ImposterGpu.bakePipeline({ key, module, vertex, fragment, buffers, layouts, cullMode,
emissive })`: the atlas's targets (4x MSAA, `depth24plus`), group 0 the frame, `layouts` its groups after that,
cached by `key`. Its shader is `WGSL_BAKE_FRAME` + its own code; the fragment stage returns
`bakeOut(albedo, normal, point, surface, emission)`:

```wgsl
// WGSL_BAKE_FRAME: bake (the frame: viewProj, dir + 1 / radius, centre), bakeSampler (repeat, anisotropic)
@fragment fn fs(v: VOut) -> BakeOut {
    // albedo (linear), unit normal and point in the source's space, surface (AO, specular, gloss 0..1,
    // translucency / wrap), emission (linear)
    return bakeOut(v.color, normalize(v.n), v.p, vec4f(v.ao, 0.1, 0.3, 0.0), vec3f(0.0));
}
```

Leaves and other cutouts `discard` below their alpha cutoff; the MSAA resolve premultiplies every layer by coverage,
so filtering and mips never bleed the background into the edges.

**The standard mesh** needs no shader of its own: `meshSource(device, mesh)` is the source for

| Field | |
|---|---|
| `vertices` | `MESH_VF` (11) floats a vertex: position, normal, uv, colour (`MESH_BUFFERS` is the vertex layout) |
| `ao` | one f32 a vertex: ambient occlusion (fill with 1, or bake it with `bakeVertexAO`) |
| `indices` | uint32 |
| `count` | vertices (`bakeVertexAO`) |
| `submeshes` | `[{ first, count, doubleSided, material }]`: index ranges; `material` a bind group in `ImposterGpu.materialLayout`: the `Mat` uniform of `WGSL_BAKE` (colour + alpha; alpha cutoff, wrap, uv scale, flip back faces; specular, gloss; emission) and one texture |
| `center`, `radius`, `emissive` | as above |

`bakeVertexAO(device, mesh, strength)` writes that mesh's per-vertex ambient occlusion into `ao` (48 depth views
around it, one compute pass; `vertices` and `ao` need `STORAGE`). It is geometry only, so meshes and their atlases
darken the same creases.

## The atlas

`ImposterAtlas`: `grid`, `res`, `full`, `levels`, `center`, `radius` (with the 2%), `bytes`, `bakeMs`, `tex`
(`albedo`, `normal`, `surface`, `emissive`?), `views` (the four layers, a 1 x 1 black stand-in without emission),
`bg` (all of it in `ImposterGpu.atlasLayout`), `destroy()`.

| Layer | Format | Channels |
|---|---|---|
| albedo | `rgba8unorm-srgb` | albedo, coverage |
| normal | `rgba8unorm` | normal (the source's space), depth along the frame direction |
| surface | `rgba8unorm` | ambient occlusion, specular, gloss, translucency (wrap) |
| emissive | `rgba8unorm-srgb` | emission / `EMISSIVE_RANGE` (8); only for sources with emission |

## Drawing instances as imposters

The renderer keeps its own instance format, lighting and passes; the kit gives it the atlas side as WGSL functions.
`imposterWGSL({ group })` declares the atlas at `@group(group)` (`impAtlas`, the four layers, `impSampler`) and:

| Function | Stage | |
|---|---|---|
| `IMP_QUAD[vertex_index]` | vertex | the quad's corner (an imposter draw is `IMPOSTER_VERTICES` = 6 vertices an instance) |
| `impCorner(c, R, eye, dir, q)` → `{ wp, toView }` | vertex | the corner of a quad over the sphere (centre `c`, radius `R`, world space) facing the view: `eye.w` 1 perspective from `eye.xyz` (sized to the sphere's silhouette), else orthographic along `dir` (shadow maps) |
| `impFrames(v, blend)` → `ImpFrames { cellsA, cell2, w }` | vertex | the three frames around the view direction `v` (toward the viewer, in the instance's own space) and their weights; `blend` false: the nearest frame. Pass them on `@interpolate(flat)` |
| `impReconstruct(ro, rd, frames, parallax, full)` → `ImpSample` | fragment | the pixel's view ray (the instance's space, in units of the radius, about the centre) against each frame, with depth parallax, blended; premultiplied by coverage (`albedo.a`). `full` false: albedo, normal and hit only (shadow casters) |
| `impResolve(sample)` → `ImpSurface { albedo, n, surface, emissive, hit }` | fragment | divided by coverage: the surface to light, `hit` the point (radius units) for the depth and shadows |
| `impSharpen(a)` | fragment | coverage sharpened to about a pixel, for alpha to coverage |
| `impCoverage(ro, rd, cell)` | fragment | one frame's coverage alone (cheap far shadow casters) |

A minimal imposter shader over instances `x, y, z, scale / yaw, ...` that a compute scatter wrote:

```wgsl
// + imposterWGSL({ group: 1 }); the renderer's own camera uniform U at group 0, instances at group 2
@vertex fn vsImp(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VImp {
    let I = insts[ii];
    let c = I.a.xyz + yawRotate(impAtlas.bound.xyz * I.a.w, I.b.x);
    let K = impCorner(c, impAtlas.bound.w * I.a.w, vec4f(U.eye, 1.0), U.fwd, IMP_QUAD[vi]);
    let F = impFrames(yawRotate(K.toView, -I.b.x), true);
    ...     // pass K.wp, F (flat), c, the radius, the yaw on; ray in the instance's space in the fragment stage
}
```

From JS: `drawImposters(pass, atlas, instances, args, offset, { atlasGroup, instanceGroup })` binds the atlas and the
instance list (a bind group in `ImposterGpu.instanceLayout`, or the renderer's own) and draws indirect: `args` at
`offset` hold `[IMPOSTER_VERTICES, instanceCount, 0, 0]`, the count written by the GPU. Pipelines: the renderer's own
targets, `ImposterGpu.atlasLayout` at the atlas's group.

## LOD lists

For a renderer that culls its instances on the GPU (the imposter feature does: camera + 4 shadow cascades):
`new LodLists(device, { count, instanceBytes, submeshes: [{ first, count }], lists })` holds the instances (`src`,
`srcBG`), `lists` culled lists of meshes and of imposters (`meshBG[list]`, `impBG[list]`) and their indirect args,
`setStride` bytes a list: the imposter draw (`impArgs(list)`), then a `drawIndexedIndirect` per submesh
(`meshArgs(list, i)`). Each frame: `writeParams({ hasImposter, radius, lodScale, center, casts })` when the model
changes, `reset()` (the args from a template: no clears), the cull dispatch (`cullBG`), the draws. `counted(u, base,
list, mesh)` reads a list's count from args copied back.

The cull shader is the renderer's (its frustum, its LOD distance, its instance struct) over
`lodListsWGSL({ group, inst })`: `lodP` (the params), `lodSrc` (the instances), `lodPush(list, mesh, instance)`
(append, counting into the args: the first submesh counts, the others follow with `atomicMax`) and
`lodFade(mode, d, start, band)` (0 auto: the mesh's share fading from 1 at `start` to 0 at `start * (1 + band)`;
1 mesh, 2 imposter). Instances inside the band go to both lists, which dither complementary pixels by it.
