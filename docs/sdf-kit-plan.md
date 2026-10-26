# The `sdf` kit: mesh distance fields and a global distance field (plan)

Status: a plan, not built. Written 2026-10-21 against `main` = `soft-shadows` (756d5ee). That commit added finer near
cloud shadow maps, Catmull-Rom shadow lookups, and closed-form soft shadows and sky occlusion for the structure boxes
(`blockerSoft`, `SHADE_SOFT`, `SKY_CONE`, `SKY_REACH`). In the dense village view at 1280x800 those cost about +0.5 ms in
the scene pass and +0.15 ms in the froxels.

What it is: UE5-style signed distance fields for WebGPU-Entities.
- **Mesh fields**: one narrow-band field per mesh, baked once on the GPU (or offline), stored as 8³ bricks in one atlas.
- **A global field**: a camera-following clipmap made from the mesh fields.
- **WGSL functions** over both: distance, sphere trace, soft shadow, cone occlusion and "sheltered".

Its consumers are the atmosphere's, imposter's and portal's shading.

**One instance.** The engine is heading to exactly one `World`, one `Renderer` and one `App` *instance* per scenario
([[webgpu-entities-single-world]]). The world types (cloud, portal, water, gui, origin, imposter) came from separate
projects, and their exclusive features are becoming kits that any scenario can use. Compositions of several worlds and
everything across them are going away. This plan assumes that end state:
- one field for the whole scenario, on the one host;
- no per-world fields, no frames between worlds, no sharing across hosts.

Until the unification lands, the atmosphere, imposter and portal renderers still have separate shader libraries and
bind-group conventions, so §1.3 says how each binds the kit today. After it they are one renderer, and that section
collapses to one table.

The plan follows the repo's rules ([[webgpu-entities-kits]], [[webgpu-entities-one-host]], no world toggles, no extra
hotkeys):
- It is data-driven: an `sdf` block in the scenario turns it on, in the same way as `curvature`.
- It loads only when something names it in `uses`.
- It is composed: features replace neutral WGSL stubs, and extensions mount on the one `Renderer` / `World`. There are
  no flags in the cores.
- Scenarios without it stay pixel-identical.

---

## 0. What the code says today (constraints the plan is built on)

| Fact | Where | Consequence |
|---|---|---|
| Kits, features and worlds are listed only in `Kits.KITS`. A feature's `uses` loads its kits first, and `when` / `requires` turn it on. | `js/kits/manifest.js`, `js/engine/features.js` | The `sdf` kit is one manifest entry. Its consumers are features of the kits that already own the shading (atmosphere, imposter world, portal world). |
| `WgslLibrary.define` / `replace` / `code(...names)`. A chunk is emitted once, after the chunks it `needs`. A replaced chunk keeps its `needs` unless new ones are given. | `js/kits/gpu/wgsl-library.js` | The sdf chunks are defined by the kit. A consumer feature `replace`s the core's stubs, or another feature's chunk (for example `BLOCKERS`). Features apply in manifest order, so a feature that replaces `structures`' chunks must come after it and `requires` it. |
| Atmosphere `RendererExtension` hooks: `frame`, `wgsl(lib, modules)`, `pipelines(ctx)`, `init()`, `frames(world)`, `setWorld(world)`, `bindings(res)`, `prepare(enc)`, `encode(enc, prof)`, `outdoor`, `indoor`, `late`, `final`. | `js/kits/atmosphere/renderer.js` top | The bake and global-field updates go in `encode` (compute, before the scene pass). Resources go in `setWorld` + `bindings`. The frame fields are not needed (the kit has its own uniform, see §1.4). |
| The world bind group is the fixed table `WORLD_BINDINGS` (20 rows). `bindings(res)` can only fill rows that already exist. One `BindingSet` with all rows is used by every module. | `js/kits/atmosphere/bindings.js`, `renderer.js:init` | **A feature cannot add a binding today.** Phase 0 makes the table composable, as `FrameBlock` already is. |
| Sampled textures in the world group: `shapeTex, detailTex, weatherTex, shadowTex, heightTex, landTex, canopyTex, smoothTex, anvilTex, layerTex, styleTex, behindTex` = **12**. | `bindings.js` | Final pass (`layoutB` + screen group `tex, tex, depth, tex`): **16 of 16**. Window glass (`layoutGlass`: world + screen + object): **16**. March (`marchOut`: `depth, tex3d, tex:uint, tex3d`): **16**. Resolve: 15. Froxel: 13. Scene (`layoutA`): 12. The default `maxSampledTexturesPerShaderStage` is 16, and the limit counts the whole pipeline layout, used or not. That is why `shadowTex` had to become texture-array layers. |
| Read-only storage buffers in the world group: `cells, ground, bolts, occ, buildings` = 5 (the default limit is 8 per stage). | `bindings.js` | The kit can afford **one** storage buffer, with all its records packed into it (§1.3). |
| Device features requested: `timestamp-query`, `float32-filterable`, `depth32float-stencil8` (when the adapter has them). | `js/engine/host.js:initGpu` | `texture-formats-tier1` is not requested. Core WebGPU cannot write `r8snorm` / `r16float` storage textures. |
| Structures are **one world-space triangle soup** (`Structures.v`, and `iv` for the interiors). Its triangles "face either way: the shader turns it to the eye". Real places add `bulk` (`TiledMesh`, 2048 m tiles). | `js/kits/settlement/structures/structures.js` | Winding is **not consistent**, so a winding-number inside test is wrong for this geometry. Use a ray-parity vote (§2.1). The soup has no ranges per entity, so the static geometry is baked per world tile, not per object. |
| Shelter boxes: up to `MAX_BLOCKERS = 128` analytic boxes near the eye, a `BLOCK_GRID` 32² cell list, flags `ao, slope, dyn, enclosed`/building id. | `shelter-boxes.js`, structures `shaders.js` | These are what the field replaces for sun, sky and rain. The `bldPass` windows-and-doors logic in `lightSeen` stays (§5.1). |
| The curvature kit keeps the world flat. Only what the eye sees is bent (`curveToWorld` for a view ray's samples). | `js/kits/curvature/curvature.js` | Fields live in flat world space (§4). |
| Floating origin: `WorldPos` = integer cell (`CELL = 8192` m, a power of two) + local offset. The origin uniform is the only thing that changes on a rebase. | `js/kits/entities/worlds/origin/core/` | Clipmap addressing works on integer voxel indices, so it can be derived exactly from `cell * CELL / voxel` (§3.2). |
| The occupancy grid notes that "a bound on the shape noise as well was measured to skip little more and cost as much as it saved". | `js/kits/atmosphere/shaders/occupancy.js` | No distance field for clouds (§4). |

---

## 1. Architecture in the kit model

### 1.1 Manifest

```js
sdf: {
    about: 'signed distance fields: narrow-band mesh fields baked on the GPU into one brick atlas, a camera-following global field (clipmap) built from them, and WGSL to trace both',
    uses: ['gpu', 'mesh'],
    parts: ['limits', 'formats', 'atlas', 'baker', 'fields', 'global', 'cpu', 'wgsl', 'extension'],
    data: { sdf: 'distance fields (quality: voxel sizes, levels, budgets; on); the outdoors and models traced by them, the world itself unchanged' },
},
```

Consumers are features of the kits that own the shading. Each has `uses: ['sdf']` and `when: { data: ['sdf'] }`, plus
`requires` where it replaces another feature's chunk:

| Feature | Kit / world | `requires` | Replaces |
|---|---|---|---|
| `fieldStructures` | atmosphere | `structures` | `BLOCKERS`, `SHELTERED_RAY` (§5.1) |
| `fieldShelter` | atmosphere | `fieldStructures` | new core stub `SHELTER_FIELD` in the froxels (§4.3) |
| `fieldParticles` | atmosphere | `fieldStructures` | `rainBlocked` / `structureTop` inside `BLOCKERS`, and the splash spawn (§5.4) |
| `farShadows` | imposter / imposter | `shadows` | its `SHADOW` chunk's past-the-last-cascade branch (§5.2) |
| `fieldLight` | interior / portal | `lightTransport` | `THROUGH` (§5.3) |
| `fieldDrones` | interior / portal | `drones` | the CPU steering hook (§5.5) |
| `fieldFlow` | hydrology / water | | new flow-sim stub `OBSTACLE` (§5.6) |

So the kit loads only where a scenario has an `sdf` block **and** a feature that uses it is on.
- A world without the block never loads the kit.
- A world with the block but no consumer feature loads nothing either: the kit has no `when` of its own.
- There are no handheld switches for showing or hiding it. The handheld gets a read-only **Field** page (bricks used,
  atlas fill, bake ms, per-pass ms) and a quality selector (voxel size presets) under the existing render options.
  There are no hotkeys.

`sdf` data block (all optional):

```js
"sdf": {
  "voxel": 0.25,              // mesh-field voxel (m) for meshes without their own (structures, models)
  "band": 4,                  // narrow band, voxels either side of the surface
  "levels": [0.5, 2, 8, 32],  // global clipmap voxel sizes (m), finest first
  "res": 128,                 // clipmap voxels per side per level (64 for low quality)
  "budget": { "bakeMs": 2, "slabsPerFrame": 2 },
  "hulls": true               // building envelopes for "sheltered" (§4.3)
}
```

### 1.2 Parts

| Part | What it does |
|---|---|
| `limits.js` | `BRICK = 8` (7 interior cells + 1 shared border, so trilinear never crosses bricks), `ATLAS_BRICKS = [32, 32, z]`, band, `MAX_INSTANCES`, `MAX_DYNAMIC`, clipmap defaults. |
| `formats.js` | `SdfFormats.pick(device)`. If the device has `texture-formats-tier1`, the bake writes `r8snorm` storage directly. Otherwise it writes `array<u32>` (`pack4x8snorm`, 4 voxels along x per word) and then `copyBufferToTexture` into an `r8snorm` 3D texture. `r8snorm` is filterable in core, and a buffer-to-texture copy needs only byte compatibility; it has no storage-format rule. Rows are padded to `bytesPerRow % 256 == 0`: an atlas row of 256 voxels is exactly 256 B. Fallback when neither works: `r32float` storage texture (core-writable) with manual trilinear via `textureLoad`. It is filterable only with `float32-filterable`, which the host already requests. |
| `atlas.js` | `BrickAtlas`: one `r8snorm` 3D texture (start 256×256×128 voxels = 8 MiB = 16 384 bricks; it grows in z by copy up to `maxTextureDimension3D` = 2048, about 128 MiB in total). Also a free list of slots and a CPU mirror of each slot's owner. |
| `baker.js` | `MeshBaker`: GPU compute bake of a triangle list into bricks (§2.1). One job queue, a time budget per frame (`budget.bakeMs`), results streamed into the atlas. |
| `fields.js` | `MeshField` (bounds, voxel, brick grid with atlas slots or EMPTY_IN / EMPTY_OUT + coarse distance, CPU copy optional) and `FieldSet` (meshes, static instances, dynamic instances, building hulls). It packs everything into one storage buffer `sdfData` (§1.3). |
| `global.js` | `GlobalField`: the clipmap texture, toroidal updates, dirty-region tracking, and the instance-per-chunk lists it composites from (§3). |
| `cpu.js` | `CpuField`: the same lookups on the CPU over the bricks read back once after bake (or the offline file's), for drones, walkers and tests (§5.5). |
| `wgsl.js` | The WGSL chunks (§1.4). |
| `extension.js` | The kit's three extensions (§1.2a): `SdfRenderer`, `SdfWorld`, `SdfApp`. They are its only entry points. |

The other parts (`atlas`, `baker`, `fields`, `global`, `cpu`, `wgsl`) are not systems of their own. They are the code
and resources the extensions own, made in their constructors and hooks and kept on them (`renderer.ext.sdf.atlas`...).
None of them makes a device, a frame loop, a scene or a camera, and none is reachable except through the host.

### 1.2a Extensions of the one World, Renderer and App, nothing else

There is exactly one `World`, one `Renderer` and one `App` ([[webgpu-entities-one-host]]). A kit never has its own
world, renderer, app, game, loop or registry; all it can do is extend those three. So the sdf kit is three extension
classes, each with `static key = 'sdf'`, composed onto the host with `host.compose(...)` like every feature's. That holds
for every scenario, however many sites it has: `docs/single-world-plan.md` (done through Phase 7) puts each site on the
one World, Renderer and App through `Composite.scope`, and its §1.7 says what replaced the cross-world mechanisms, so
the field sees every site's entities in one frame and there is nothing to inject between worlds.

| Extension | Mounted on | What it does | Hooks it answers |
|---|---|---|---|
| `SdfRenderer` | the one `Renderer` (`renderer.ext.sdf`) | owns the atlas, baker, global field and `sdfData`; adds the WGSL chunks; encodes the bake and clipmap updates | `wgsl`, `bindings` (rows + resources), `pipelines`, `init`, `setWorld`, `encode`, `profile` (pass names) |
| `SdfWorld` | the one `World` (`world.ext.sdf`) | collects the sources from the world's entities (structure tiles, models, doors, buses, lifts, hulls); holds the CPU mirror; answers the world's point queries | `distance(p)`, `sheltered(p)` (beside `ground` / `sheltered` / `outdoors`), `frame(dt)` (dynamic instances) |
| `SdfApp` | the one `App` (`app.ext.sdf`) | the handheld's Field page and quality options | `pages` |

A consumer feature brings them with its own extensions. `fieldStructures`, for example, exports
`extensions: { renderer: [SdfRenderer, FieldStructuresRenderer], world: [SdfWorld], app: [SdfApp] }`. Two features that
both bring `SdfRenderer` must still compose it **once**. That needs two small engine changes (Phase 0):

- `extensionsOf` accepts a list per role and flattens it.
- `Composite.compose` skips a class whose `key` is already in `host.ext`.

Then a consumer reaches the field as `this.renderer.ext.sdf` / `this.world.ext.sdf`, in its own hooks. It never makes
one. The sources are the one World's entities, whichever kits they come from.

### 1.3 GPU resources and binding cost

Everything the kit binds:

| Binding | Kind | Counts against |
|---|---|---|
| `sdfU` | uniform: levels' origin voxel (`vec4i` × 4), voxel sizes, res, band, counts, eye origin (cell + local) for `origin` worlds | uniforms (12 default) |
| `sdfData` | read-only storage `array<vec4u>`: [meshes][instance BVH-lite grid][static instances][dynamic instances][hulls][brick tables], offsets in `sdfU` | storage buffers: 5 → **6** of 8 |
| `sdfAtlas` | `texture_3d<f32>` (`r8snorm`) | sampled textures: +1 |
| `sdfGlobal` | `texture_3d<f32>` (`r8snorm`), levels stacked in z (128×128×512) | sampled textures: +1 |
| sampler | the core's `clampSamp` (clamp-to-edge, linear) | none |

That adds **+2 sampled textures** to any module that binds them. At 16 of 16 that breaks the final pass, the glass and
the march. **Phase 0** removes the problem by binding by need:

1. `WORLD_BINDINGS` becomes composable, like `FRAME_LAYOUT`: a RendererExtension may export `bindings` rows
   (`[name, kind, decl]`), which are appended after the core's. The existing `bindings(res)` hook keeps filling them by
   name.
2. A WGSL chunk declares the bindings it reads: `define(name, code, { needs, binds: ['heightTex', ...] })`.
   `WgslLibrary.code(...)` returns `{ code, binds }`. `shaderSource` declares only those bindings, and each module gets a
   `BindingSet` of exactly them, so its layout holds what it uses. This also implements the library's own promise ("a
   module holds only the code of what the world has") for bindings.
3. Each pipeline then builds its world group from its own `BindingSet`. Groups are cached per set, which means about 6
   distinct sets instead of 1. `setWorld` builds them all.

**Check before committing to it:** that the final module does not use most of `shapeTex, detailTex, anvilTex, layerTex,
styleTex, canopyTex` (it composites; the volumetrics already ran). If it does, the final pass stays near 16. The
fallback is a **storage-buffer field** for the final and march modules only: the same data as `array<u32>` (packed
r8) with manual trilinear (8 loads, about 3× a filtered fetch). Their uses (rain per drop, `rainReaches` per march
sample under roofs) are point queries, not traces, so the slower lookup is affordable. Measure both in Phase 3.

The **imposter world** binds its globals through `globals()` (group 0, as the shadows feature does: bindings 3–5), and
it has plenty of headroom. The **portal world** has its own renderer and layouts. The kit therefore exports
`SdfBindings.rows` and `SdfBindings.wgsl(group, first)`, and each consumer places them where its renderer's convention
says.

### 1.4 WGSL chunks

The kit's chunks never reference the atmosphere's `F`; they read `sdfU`, so the same chunks work in all three
renderers.

| Chunk | Functions | needs |
|---|---|---|
| `SDF_COMMON` | `sdfU` struct, decode (`r8snorm × band × voxel`), `sdfVoxelOf(p, level) -> vec3i` (toroidal), `sdfLocal(p)` (origin-relative for `origin` worlds) | |
| `SDF_ATLAS` | `meshDist(inst, p) -> f32` (instance transform → brick table → atlas sample, or the coarse distance of an empty brick; conservative scale for non-uniform transforms) | `SDF_COMMON` |
| `SDF_GLOBAL` | `globalDist(p) -> vec2f` (distance, level used; finest level that holds p with a 1-voxel margin; saturated → step `band × voxel` of that level) | `SDF_COMMON` |
| `SDF_DYNAMIC` | `dynamicDist(p) -> f32` (min over the frame's ≤ `MAX_DYNAMIC` moving instances, bounding-sphere culled) | `SDF_ATLAS` |
| `SDF_TERRAIN` | `terrainDist(p)` = `(p.y - h) / sqrt(1 + \|∇h\|²)`. It takes the consumer's height lookup as a stub (`fn sdfHeight(xz) -> vec3f` : h, ∂h/∂x, ∂h/∂z). The atmosphere replaces it with `heightTex`; the imposter world with its terrain; others leave the stub (`-1e9`: no ground). | |
| `SDF_SCENE` | `sceneDist(p) = min(globalDist, dynamicDist, terrainDist)` | the three above |
| `SDF_TRACE` | `sdfTrace(o, d, tMax) -> vec2f` (hit t, min ratio), `sdfShadow(o, d, cone, tMax) -> f32` (UE-style soft shadow: `min(k · d(t) / t)` with a cone tan, the same convention as `SHADE_SOFT`), `sdfOcclusion(p, n, cone, reach) -> f32` (5-direction cone AO, the `SKY_CONE`/`SKY_REACH` meaning), `sdfVisible(a, b, size) -> f32` (point to point, for lamps) | `SDF_SCENE` |
| `SDF_HULL` | `hullDist(p) -> f32` (building envelopes, §4.3), `sheltered(p) -> f32` (1 deep inside an envelope, 0 outdoors) | `SDF_COMMON` |

Each consumer adds the chunks to the modules that trace (for example `modules.scene.push('SDF_TRACE')`), and `replace`s
its renderer's stubs with code that calls them.

### 1.5 Frame flow (atmosphere example)

```
renderer.setWorld(world)          -> renderer.ext.sdf.setWorld(world)
  sources = world.ext.sdf.sources()   Structures tiles (v, iv, bulk) + models of fixtures/props + hulls
  fields.plan(sources)            -> MeshFields (brick counts after pass A), atlas sized once
  baker.queue(all)                -> baked in encode() under budget.bakeMs; global marks their boxes dirty
world.frame(dt)                   -> world.ext.sdf.frame(dt): buses, doors, lifts this frame (dynamic instances)
renderer.encode(enc, prof)        -> renderer.ext.sdf.encode (before the scene pass; 'sdfBake', 'sdfGlobal')
  baker.step(enc)                 a few bricks' jobs
  global.update(enc, eye)         scroll: new slabs per level (toroidal), dirty boxes, ≤ slabsPerFrame
  write dynamic instances         -> sdfData tail
scene / froxel / march            the consumers' chunks trace through sdfGlobal + atlas
```

The renderer runs `renderer.ext.sdf`'s hooks before the consumers' because the feature lists it first. Profiler names
come from the extensions' `profile` lists: the `GpuProfiler` list is fixed in `init()` today, so Phase 0 lets
extensions contribute names.

---

## 2. Per-mesh fields

### 2.1 GPU bake at load (compute)

The inputs are triangles in the mesh's frame: a mesh kit geometry, a building-kit model, or a world tile of
`Structures.v`/`bulk`. The building kit's meshes are low-poly (hundreds to a few thousand triangles per building, and a
village tile of 64 m holds about 5–20k), so brute force over triangles per voxel is fine, tiled through workgroup
memory.

**Pass A, classify bricks.** One thread per brick cell of the mesh's grid (brick = 7 voxels of cell). A brick is
*near* when any triangle is within `band × voxel + brick half-diagonal` of its centre. The test is a triangle–sphere
distance, 64 triangles per shared-memory tile. Near bricks get an atlas slot through an atomic counter. Far bricks keep
a coarse signed distance (its centre's), which the empty-space steps use.

**Pass B, distance.** One workgroup per near brick: 8×8×4 threads, 2 voxels each, because 8³ = 512 exceeds the default
`maxComputeInvocationsPerWorkgroup` of 256. Each voxel takes the min unsigned distance over triangles (Ericson's
closest point on a triangle), streamed through shared memory.

**Pass C, sign: inside/outside that survives non-watertight, inconsistently wound meshes.** The structures' soup faces
"either way", so a generalized winding number (which needs consistent orientation) and a back-face-ratio test (UE's,
which needs orientation) are both wrong here. Use a **3-axis scanline parity vote** (Nooruddin & Turk):
- For every column of voxels along x, intersect the column's line with every triangle once and sort the crossings
  (≤ 32 kept in registers, with a fallback to unsigned). The parity of crossings before each voxel gives that voxel's
  side along x. Do the same along y and z.
- **Majority of 3.** A hole (an open door, a missing face) flips one axis's parity for a band of voxels. The other two
  outvote it.
- Cost: O(N² · T) per axis instead of O(N³ · R · T). It runs over the mesh's whole voxel grid at brick resolution, so
  empty bricks get their sign too.
- Crossings closer than 1e-4 voxel are merged, because coplanar duplicate faces (two prisms sharing a wall) otherwise
  cancel.

**Thin walls.** Walls of 0.2 m are thinner than a 0.25 m voxel. Store `d - minThickness/2` with
`minThickness = 0.5 voxel` (UE does the same), so every wall reads at least half a voxel negative and traces cannot step
through it. Glass and pane materials (`panes`, `glass`) are left out of the bake: light passes windows (§5.1).

**Validation, at bake time in a debug build or in the tests.** Bake the reference meshes on the GPU and in `cpu.js` (the
same algorithm in JS), and compare voxel by voxel to within 1/127 band. The reference meshes are: a box, an open box
(one face missing), two prisms sharing a wall, a torus, randomly flipped triangles, and a village tile.

### 2.2 Offline bake: `tools/sdf-bake.mjs`

For bigger assets, follow the pattern of `tools/geo-import.mjs` (no dependencies; deflated base64 inside a classic
script calling `ScenarioData.put`, so pages opened from disk work):

```
node tools/sdf-bake.mjs <scenario | region> [--voxel 0.5] [--out scenarios/data/<id>/sdf.js]
```

- It bakes Oʻahu's `bulk` tiles (tens of thousands of footprint buildings), imported models (glTF from the imposter
  world's `drop`, kept as the dropper's own bake), and anything over a triangle budget (default 50k).
- The algorithm is the same as `cpu.js` (shared source: the module exports it for node, `module.exports` like
  `manifest.js`), with worker threads.
- Output: per tile, the brick table + brick payload (r8) + hull records. At load, `ScenarioData` inflates it and the
  atlas uploads it with `writeTexture`. No GPU bake runs for those tiles.
- A footprint building is an extruded polygon, so the tool can write its field **exactly** (2D polygon distance ×
  height span) instead of from triangles. That is faster and has no sign problems. The data's `meta` notes the method
  and the source.

### 2.3 Storage: a narrow band in 8³ bricks, one atlas

- Brick = 8³ `r8snorm` voxels, 512 B. The value is `clamp(d / (band · voxel), -1, 1)`, which gives 1/127 of ±4 voxels
  ≈ 0.03 voxel resolution.
- Per mesh, a brick table: `u32` per brick cell. Either an atlas slot (17 bits of brick index), or `EMPTY` with an
  8-bit coarse distance and a sign bit. It lives in `sdfData`.
- Atlas growth: allocated once per `setWorld` from pass A's counts plus 25 % for late bakes (dropped models). Beyond
  that it grows by `copyTextureToTexture` into a taller texture, up to z = 2048. Past that, the bake falls back to a
  coarser voxel for the remaining meshes and reports it on the Field page.
- Budget estimate: a village (the settlement kit's dense view) at 0.25 m is about 4–8k bricks = 2–4 MiB. Oʻahu's bulk
  at 0.5 m is about 60–120k bricks: too many for one atlas at that voxel. Bake bulk at 1 m (buildings ≥ 3 m) and let
  only the tiles near the eye refine (an open question, §8).

### 2.4 WebGPU limits checklist

- **Storage formats:** core cannot write `r8snorm`/`r16float` storage textures. Write `u32` words into a buffer and
  `copyBufferToTexture`, or write directly with `texture-formats-tier1`. The host requests it only when the adapter
  offers it, and adding it to `initGpu`'s list changes nothing for existing modules (pixel harness check).
- **`maxTextureDimension3D` = 2048** caps the atlas and the stacked global field (4 × 128 = 512 z, fine; 4 × 256 would
  be 1024, still fine).
- **Sampled textures per stage ≤ 16:** see §1.3 and Phase 0.
- **Storage buffers per stage ≤ 8:** the kit uses 1.
- **Workgroup ≤ 256 invocations, 16 KiB shared:** a tile of 64 triangles × 36 B = 2.3 KiB. Fine.
- **`bytesPerRow` multiple of 256** for buffer↔texture copies: atlas rows are 256 voxels and clipmap slabs 128, so slab
  copies pad rows to 256 B in the staging buffer.

---

## 3. Global field

### 3.1 Levels and refresh

- 4 nested levels, each `res³` voxels (128 default, 64 low), voxel sizes `levels` (default 0.5, 2, 8, 32 m). That
  reaches 64 m, 256 m, 1 km and 4 km on a side about the eye.
- Memory: 4 × 2 MiB `r8snorm` stacked in z in one 3D texture (one sampled-texture slot).
- Each level is centred on the eye snapped to its chunk (8 voxels). When the eye crosses a chunk boundary, only the
  newly exposed slab of chunks is recomputed. Coarse levels move rarely.
- **Composite pass**, compute, one thread per voxel of a dirty chunk:
  `d = min over static instances listed for that chunk of meshDist(inst, p)`, clamped to the level's band.
- The per-chunk instance lists are built on the CPU from the instances' bounds (a `GridHash`, as `ShelterBoxes` does)
  and uploaded as part of `sdfData`.
- Chunks with no instance within reach are written `+1` (far) without sampling.
- Budget: `slabsPerFrame` chunks-slabs per frame, finest level first. A teleport (bookmark, bus boarding) rebuilds over
  several frames, finest first. Until a level is valid, its `sdfU` flag sends queries to the next coarser level.
- **Dirty boxes:** a static instance added or removed (a dropped model, a structure built later) marks its bounds dirty
  in every level that holds them.

### 3.2 Toroidal addressing that survives a floating-origin rebase

Each level stores voxel `v` (an integer world voxel index) at texel `v mod res` (positive modulo).
- The CPU keeps, per level, the **integer** voxel index of the window's min corner.
- For `origin` worlds that index comes from `WorldPos`: `cell · (CELL / voxel) + floor(local / voxel)`. That is exact
  because `CELL = 8192` and the voxel sizes are powers of two.
- The shader gets, per level, the window's corner index (`vec4i`) and the eye's sub-voxel position. It computes
  `vi = cornerIdx + vec3i(floor((p_local - cornerLocal) / voxel))`, where `p_local` is relative to the current origin.
  A rebase changes the origin uniform and `cornerLocal`, and nothing in the texture moves.
- The flat worlds (atmosphere, imposter) use world metres directly: the cell is 0 and the local part is f32. At Oʻahu's
  ±60 km, f32 resolution is about 4 mm ≪ 0.5 m.
- **Test:** rebase every frame while the camera is still. The clipmap texture must not change (read back, byte-equal),
  and a fresh rebuild at the new origin must be byte-equal to the scrolled one.

### 3.3 Terrain stays out of it

The heightfield is already an exact, cheap lookup (`heightTex`, with gradients from neighbouring texels). Baking it
would waste clipmap precision near the ground and go stale with `stamps`/`channels`. It is combined in the shader:

```wgsl
fn terrainDist(p: vec3f) -> f32 { let h = sdfHeight(p.xz); return (p.y - h.x) / sqrt(1.0 + dot(h.yz, h.yz)); }
fn sceneDist(p: vec3f) -> f32 { return min(min(globalDist(p).x, dynamicDist(p)), terrainDist(p)); }
```

This is a lower bound of the true distance on slopes (exact on planes), so it is safe for sphere tracing. Its error
only shortens steps.

### 3.4 Moving and deforming entities

These are not merged into the global field, because they would dirty it every frame:
- buses (`BusLine`, already `dyn` shelter boxes),
- doors (`Doors`, `SlidingDoor`, the building kit's `InteriorDoors`),
- lift cars (`Lifts`),
- drones,
- vegetation sway.

Each is an instance of its own (rigid) mesh field, with its transform written per frame into `sdfData`'s dynamic tail
(≤ `MAX_DYNAMIC` = 64 nearest the eye, as `ShelterBoxes.write` ranks boxes). Traces take
`min(global, dynamic, terrain)`.
- **Doors:** the leaf is its own mesh, and the doorway in the static shell is open, so a closed door shadows through its
  instance and an open one does not.
- **Lift cars** move in shafts that are static; the car is the instance.
- **Vegetation:** sway is a small deformation. Use each species' rigid field (§5 vegetation note) with its bound grown
  by the sway amplitude. The sway itself is ignored in the field. Plants are not in the global field in the first
  phases (an open question, §8).
- **Buses:** the `dyn` box flag already means "no dry patch" for rain. That rule moves to the dynamic instances
  (`flags.noRainShadow`).

---

## 4. Curvature and clouds

### 4.1 Flat world space, bent only for eye rays

The curvature kit keeps the world flat and bends only what the eye sees, so fields live in flat world space.
- Every trace that starts at a world point (surface shading, froxel samples converted by `curveToWorld`, lamp
  visibility, rain back-traces, particle collision) is a straight line in that space, and needs no curvature math at
  all.
- Only a trace that **starts from the eye** along a view direction (picking, a future SDF reflection, or a debug view
  of the field) needs `curveToWorld` on each step's position.
- That distortion within the field's reach is tiny: the drop is `ρ²/2R`, which is 0.3 mm at 64 m, 5 mm at 256 m, 8 cm at
  1 km and 1.3 m at 4 km. In every level that is below 4 % of its voxel (0.5, 2, 8, 32 m). So a trace may
  `curveToWorld` once per level entered instead of per step.

### 4.2 No field for the clouds

The occupancy grid already skips empty air per column and height cell. Its notes record that a tighter bound on the
shape noise skipped little and cost as much as it saved, and a cloud SDF would be that tighter bound, changing every
frame with the weather. So none is built. The kit is for solid geometry.

### 4.3 Fields in the froxels and shafts, fog and "sheltered"

- **`lightSeen(k, p)`** (froxel halos and beams, `lampsAt` in `shelter.js`) becomes `sdfVisible(p, lamp, size)`: a soft
  point-to-point trace. This replaces the box spans and the `lightMask` per-light box bits, except for the building
  shell that `bldPass` handles (§5.1).
- **`structuresOnRay(ro, dir, t0, t1)`** (the march's "is any roof near this view ray" gate) becomes "does the ray's
  segment pass within `band` of anything", from `globalDist` at a few points, or simply the hull grid's bounds as now.
  It stays a cheap gate; the per-sample `rainReaches` behind it becomes the field query.
- **Fog density around buildings:** in the froxel integration, `density *= mix(interior, 1, smoothstep(-r, r,
  hullDist(p)))`.
  - The air inside a building's envelope holds the interior haze, not the street's fog.
  - Near walls, the shafts stop where `sceneDist < 0`, so they do not shine through walls.
- **"Sheltered" needs envelopes, not solid fields.** A room is *outside* the solid wall in SDF terms (the wall's two
  faces bound it), so `sceneDist < 0` only means "inside a wall".
  - So the kit keeps **hulls**: per building, its closed envelope.
  - Building-kit buildings: footprint and storey span from the plan; ShelterBoxes' `enclosed` boxes are exactly these
    today.
  - Geo buildings: footprint polygon × height.
  - Stored as a 2D footprint distance (exact polygon SDF on a small per-building grid, or analytic for rectangles) plus
    a y span.
  - `sheltered(p) = smoothstep(r, -r, hullDist(p))` replaces `blockerRain`'s `enclosed` case. It then serves as the
    general "indoors" test: fog, rain particles, wind, and later the sound kit's reverb, all from data.

---

## 5. Consumers, in phases

Each phase ships on its own. A phase is done when its scenarios without `sdf` are pixel-identical to the previous HEAD,
and its own scenario shows the effect within its budget (§6).

### Phase 0: groundwork (no visible change)

- `WORLD_BINDINGS` is composable, chunks declare `binds`, and each module gets its own `BindingSet` (§1.3). The profiler
  takes names from extensions.
- The host requests `texture-formats-tier1` when the adapter offers it.
- Extensions compose once by key: `extensionsOf` flattens a list per role, and `Composite.compose` skips a key already
  in `host.ext` (§1.2a).
- `World` gets optional point queries `distance(p)` / `sheltered(p)` answered by its extensions, as `ground` is today.
  A world without an answering extension returns nothing, and the host skips it as `floorAt` skips worlds without
  `ground`.
- `manifest.js`: the `sdf` kit and its `sdf` data type (no consumer features yet).
- **Verify:** every scenario in `scenarios/` is pixel-identical to HEAD with the deterministic harness (§6.2). The
  sampled-texture count per pipeline is logged once (dev console) and the final pass and march drop below 16.
  - If they do not, record the storage-buffer fallback decision here.

### Phase 1: baker, atlas, CPU mirror, offline tool

- `formats`, `atlas`, `baker`, `fields`, `cpu`; `tools/sdf-bake.mjs`; the Field handheld page (slice view of a mesh
  field as a heatmap on the phone screen: a page, not a world toggle).
- **Verify:**
  - GPU and CPU bake agree on the reference meshes (§2.1) to 1/127 band.
  - The parity vote classifies the open box and the flipped-triangle soup correctly (> 99.5 % voxels).
  - Bake time for the dense village is below 1.5 s in total, spread under `bakeMs` per frame. The fps never dips below
    the scenario's baseline by more than `bakeMs`.

### Phase 2: global field

- `global.js`, `SDF_GLOBAL`/`SDF_TERRAIN`/`SDF_SCENE`/`SDF_TRACE`.
- **Verify:**
  - The toroidal scroll equals a fresh rebuild (byte-equal), and a rebase leaves the texture unchanged (§3.2), both in
    `origin-sol-transit` (with an `sdf` block added in a test copy) and in the cloud world.
  - `sceneDist` against brute-force `meshDist` over all instances at random points: ≤ 1 voxel of the level used.
  - `sdfGlobal` update ≤ 0.15 ms/frame walking, ≤ 0.6 ms on a teleport frame.

### Phase 3: atmosphere structures (`fieldStructures`)

What it replaces in `js/kits/atmosphere/features/structures/shaders.js`, as a `replace('BLOCKERS', …)` after
`structures`:

| Today (analytic boxes) | With the field |
|---|---|
| `structureLight(p, sun, rain).x` = `blockerSoft` per box from the `blockCell` list | `sdfShadow(p + n·ε, sunDir, SHADE_SOFT, SHADOW_REACH)` over `sceneDist` (terrain self-shadowing stays the existing terrain shadow: the trace uses `min(global, dynamic)` only, so the terrain is not shadowed twice) |
| `.z` sky occlusion (`SKY_CONE` cone up to `SKY_REACH`) | `sdfOcclusion(p, n, SKY_CONE, SKY_REACH)`: 5 cone samples around the normal's upper hemisphere, so walls darken by their facing and the roof leaves `ao` dark under it |
| `.y` / `rainReaches(p)` (`blockerRain` back along `rainBack`) | a hard trace along `rainBack(p.y)` up to the highest structure top (`F.blocks.z`), `sdfTrace(...).x < tMax`; or `sheltered(p) > 0.5` inside an envelope |
| `lightSeen(k, p)` (box spans + `bldPass` through windows) | `sdfVisible(p, lamp, size)` for everything **except** the building shell between p and the lamp, which keeps `bldPass` where the shell is an unbroken wall with formula windows. Where the mesh has real openings, the baked field lets light through them (§8, question 2) |
| `structureTop(p)`, `rainBlocked(p, back)` | a downward trace (`sdfTrace(top, -y)`), and the `rainReaches` trace |
| `structuresOnRay` | unchanged gate (§4.3) |

The shelter boxes themselves stay in the settlement kit; the walkers' collisions and the drip edges use them. The frame
fields `blocks`/`blockGrid` are still written for drips, and the field replaces only the shading uses.

- **Verify:**
  - On a box-only village, the field and the analytic boxes should agree. Compare images (A/B on the same frozen frame):
    mean |Δ| below 1 % and the shadow edges within one voxel.
  - Then a scenario that gains from the field (gable roofs, the bus station canopy, bridge arches, geo hipped roofs on
    `cloud-oahu`): visually check the shadows follow the real roofs.
  - Rain: the dry patches under roofs and the dry interiors match today's boxes in the valley-weather scenario (wet mask
    readback, ≥ 98 % texels equal).
  - Budget: scene pass ≤ the soft-box cost (+0.5 ms) + 0.3 ms; froxels ≤ +0.15 ms + 0.1 ms.

### Phase 4: fog and shelter in the froxels (`fieldShelter`)

- `SHELTER_FIELD` stub in the froxel integration (core: `fn shelterFog(p) -> f32 { return 1.0; }`), replaced by the
  hull fade (§4.3). Shafts stop inside walls.
- **Verify:** no fog inside the buildings of the dense village (froxel readback inside an envelope ≤ interior density),
  no light shafts through walls (a lamp behind a wall, beam radiance on the far side ≈ 0). Pixel-identical without
  `sdf`. Froxels ≤ +0.1 ms.

### Phase 5: imposter world far shadows (`farShadows`)

- Past `SH.splits[3]` (`shadowAt` fades to lit today), the shadow becomes `sdfShadow` over the global field's coarse
  levels plus the terrain, with a cone matching the last cascade's texel blur.
- The casters are the world's models baked once each (`assets/models`, and the `drop`ped ones baked when dropped) and
  instanced like the meshes. The imposters' instances use their mesh's field, since an imposter stands for a mesh.
- **Verify:** `imposter-valley`: no seam at the last split (band compare across `splits[3]` ± 5 %), distant valley
  sides shadowed. Cost ≤ 0.3 ms at 1280x800. With `shadows` off, `farShadows` is off too (`requires`).

### Phase 6: interior portal world (`fieldLight`)

- `lightTransport` lets a light through a portal reach a point only along a ray through every aperture (`THROUGH`'s
  `aperture`/`throughLight`). Inside an area, nothing between the aperture and the point shadows: furniture, pillars,
  the freighter's hull.
- With fields of the area meshes and props:
  - **Contact shadowing:** `sdfOcclusion` with a short reach (1 m) for every lamp's diffuse term.
  - **Sun inside:** the sun patch through a window is shadowed by what stands in the room, via `sdfShadow` from the
    point towards the sun after the aperture test passes.
  - **Lamps in the area:** `sdfVisible` to the lamp.
- The portal world's renderer binds `SdfBindings` in its own group. Its areas are local frames (`interior` origins), so
  the instances carry the area's frame.
- **Verify:** `portal-bunker-compound`: furniture shadows under the skylights, crates occluding lamps. The portal
  stencil traversal is unchanged (stencil readback equal). Scene cost ≤ +0.4 ms.

### Phase 7: particles (`fieldParticles`)

- **Rain:** the drops in `vsPrecip` already call `rainBlocked`, and the splashes spawn on `structureTop`. Both become
  field queries: the downward trace, and drops killed where `sceneDist < 0`.
- **Snow:** settles where the trace hits; its splash particle becomes a resting flake for its lifetime.
- **Debris:** the hydrology debris logs and any compute particle system collide by `sceneDist`, with the normal from a
  tetrahedral gradient (4 lookups) and reflection with restitution.
- **Verify:** drops never visible inside envelopes (screen readback in the bus station), splashes on the real roof
  shapes. The final pass grows ≤ 0.15 ms, or the fallback buffer field is measured here if Phase 0 kept the final pass
  at 16.

### Phase 8: drones (`fieldDrones`)

- Drones move on the CPU (`js/kits/entities/drone.js`, the portal world's `drones` nav graph).
- Avoidance asks the one World: `world.distance(p)`, answered by `world.ext.sdf` from its CPU mirror: static bricks read back once after the bake (or the offline file's), plus the
  dynamic instances' CPU transforms. Each tick: `d = world.distance(at)`, `∇d` by central differences. When
  `d < clearance`, the steering adds `∇d · k (clearance − d)`, and a look-ahead probe along `fwd` slows the drone before
  a wall.
- The nav graph still plans the route, and the field only keeps the drone off walls and props between waypoints.
- **Verify:** a drone wanders 10 min in `portal-bunker-compound` (stepped harness) with no frame where
  `world.distance(at) < 0.5 × clearance`. CPU cost ≤ 0.05 ms per drone per tick.

### Phase 9: water (`fieldFlow`)

- The hydrology water world is a shallow-water grid over its terrain, with no structures of its own today.
- Obstacles come from what stands in the water in that scenario:
  - debris logs (dynamic instances),
  - dams and piers (if added as models),
  - any structures the scenario's other kits build in the water (settlement, geo), all entities of the one World.
- Each sim step reads a 2D **obstacle slice**: `sceneDist` at the water surface height over the sim grid, written by a
  compute pass when the global field changes there. A new `OBSTACLE` stub in the flow shader (default: no obstacle) is
  replaced to block flow in cells inside obstacles. Near obstacles it adds drag `∝ 1/(1 + d)`, and it raises foam where
  `|∇d|`-weighted velocity converges.
- **Verify:** `water-riverlands` with a pier model: a wake and foam downstream, mass conserved (the sim's stats buffer:
  total volume drift unchanged vs no obstacle ± 0.1 %). Sim cost ≤ +0.1 ms.

### Phase 10 (optional, later): probe-based bounced light

- Lumen-lite: a sparse grid of irradiance probes (octahedral, 8×8) in the finest clipmap levels, around the eye.
- Each probe traces ~64 rays through `sceneDist` per update, round-robin a few hundred probes per frame. Each hit is
  shaded from a cheap surface cache: the albedo by material id from the mesh field's brick table (one material per
  brick), lit by the sun shadow (`sdfShadow`) and the sky.
- Only after Phases 3–6 are solid. Open questions: the surface cache, the leaking through thin walls (the half-voxel
  thickening helps), and the cost on a 3050 Ti.

---

## 6. Budgets and testing

### 6.1 GPU time per pass

- Measure on the RTX 3050 Ti (the WebGPU adapter Brave always picks here, [[webgpu-adapter-selection]]) with the base
  renderer's profiler: `renderer.base.profiler.ms` (`weather, ground, vegetation, scene, froxel, tiles, march, resolve,
  bloom, final`, plus the kit's `sdfBake`, `sdfGlobal`).
- The laptop throttles (±40 % between runs, [[brave-webgpu-testing]]), so compare **alternating A/B on the same frozen
  frame**:
  - Two pages in the measuring instance (port 9334), one with the scenario's `sdf` block and one without.
  - Frames stepped with the fake clock, 120 frames each, 5 rounds alternating, median per pass.
- There is no in-page toggle (no world toggles): the variants are two scenario files, or the harness overriding the root
  entity's `features: { fieldStructures: false }`.

| Pass | Budget (dense village, 1280x800) |
|---|---|
| `sdfBake` | ≤ `budget.bakeMs` (2 ms) on load frames, 0 after |
| `sdfGlobal` | ≤ 0.15 ms walking, ≤ 0.6 ms teleport frames |
| scene | Phase 3: ≤ +0.3 ms over the soft-box version |
| froxel | Phases 3+4: ≤ +0.2 ms over the soft-box version |
| march | ≤ +0.1 ms (rain gate only) |
| final | Phase 7: ≤ +0.15 ms |
| memory | atlas ≤ 32 MiB in the shipped scenarios, global 8 MiB |

### 6.2 The deterministic pixel harness

From [[brave-webgpu-testing]]:
- an isolated Brave instance with CDP (`--user-data-dir` in the scratchpad, `--remote-debugging-port`, the
  anti-backgrounding flags);
- a fake clock, seeded `Math.random`, stepped `requestAnimationFrame` (call `entities.frame(t)` directly);
- `timestamp-query` hidden by patching `GPUSupportedFeatures.prototype.has`, so dynamic resolution does not follow GPU
  timings;
- `#engine-bar`, `#engine-side` and the toasts hidden;
- cache disabled in the same CDP session as the reload, and the edit verified live.

Gates:
1. **Without the kit, pixel-identical:** every scenario in `scenarios/` against the previous HEAD (known noise only in
   `gui-sector-07` / `gui-swarm`, about 0.04 %). Required after every phase.
2. **Kit not loaded:** for each scenario without `sdf`, `Object.keys(Features.kits)` does not contain `sdf`.
3. **With the kit, reproducible:** two runs of the same `sdf` scenario are pixel-identical. The bake order and the
   per-frame slab budget must not depend on timing, so `budget.bakeMs` is a brick count in the harness.
4. **Per phase:** the image compares and readbacks listed in §5.

### 6.3 Phase order and independence

- 0 → 1 → 2 is the spine.
- After 2, phases 3, 5, 6, 8 and 9 each depend only on 2 and can ship in any order. 4 and 7 need 3 (they replace chunks
  that `fieldStructures` defines). 10 needs 3 and 6.
- Every phase leaves the scenarios without `sdf` untouched, and is a feature with its own `when`, so a phase can be
  backed out by deleting its feature.

---

## 7. Summary

| Phase | Ships | Replaces | Main risk |
|---|---|---|---|
| 0 | composable world bindings, bindings by need, profiler names, `texture-formats-tier1` | one all-bindings layout | final/march may still sit at 16 → storage-buffer fallback |
| 1 | GPU baker (scanline parity vote), atlas, CPU mirror, `tools/sdf-bake.mjs`, Field page | — | bake time on big tiles; coplanar duplicate faces |
| 2 | global clipmap, toroidal, terrain combined in shader | — | teleport rebuild cost |
| 3 | atmosphere structures through the field | `blockerSoft`, sky cone, `rainReaches`, `lightSeen` boxes, `structureTop`, `rainBlocked` | windows: baked holes vs `bldPass` formulas |
| 4 | fog fade, shafts stop at walls, `sheltered` from hulls | `enclosed` boxes | envelopes for geo buildings |
| 5 | imposter shadows past the last cascade | lit beyond `splits[3]` | seam at the split |
| 6 | portal contact shadows, sun and lamps occluded in rooms | aperture-only `lightTransport` | areas' local frames |
| 7 | rain, snow, debris colliding | `rainBlocked`/`structureTop` per drop | final pass binding headroom |
| 8 | drones avoid walls (CPU mirror) | waypoints only | CPU mirror memory |
| 9 | water obstacles: drag, wakes, foam | none | where the obstacles come from in the water world |
| 10 | probe bounced light (optional) | ambient only | surface cache, cost |

## 8. Open questions

1. **Bindings:** does Phase 0's binding by need bring the final pass and the march below 16 sampled textures, or do
   they take the storage-buffer field? (This decides the shape of `SDF_ATLAS` for those modules.)
2. **Windows:** bake the shells with their openings cut (the field lets light through), or keep `bldPass` formulas for
   the street lamps and room light through windows? This depends on whether the building kit's exterior mesh has real
   holes. The interiors' `iv` soup is baked separately and only for the portal world's use.
3. **Structures' soup:** bake per world tile (proposed: no per-entity ranges needed), or add per-entity ranges to
   `Structures` so buildings can be re-baked one at a time when edited?
4. **Oʻahu scale:** tens of thousands of bulk buildings. Use an exact prism field from footprints (offline), at 1 m, with
   refinement near the eye? And is the atlas cap enough without streaming?
5. **Vegetation:** do the plants go in the global field (thousands of instances, coarse species fields), stay dynamic
   near the eye only, or stay out (their shadows are the vegetation feature's own)?
6. **Dynamic instance cap:** is 64 enough in the bus station at rush hour with buses, doors and lifts?
7. **Quality presets on the handheld:** which voxel and level sets, and do they rebake live or on the next load?
8. **Water obstacles:** which entities count as obstacles in the water world (a new `pier`/`obstacle` type, or only
   composed structures)?
9. **Lumen-lite:** worth it at all on a 3050 Ti, or is the sky occlusion from Phase 3 enough?
