# One World, one Renderer, one App: every scenario on a single instance (plan)

Status: Phases 0-5 done on branch `claude/single-world-177086` (2026-10-22): the harness and baselines, Composite with
many extensions, one encoder and submit, frame conventions, the scenario format with sites, and the single-site
scenarios on one World, Renderer and App (the compositions on js/engine/legacy-host.js). Next: Phase 6, which needs Q1
(MSAA), Q2 (sky ranking), Q3 (links) and Q4 (origin scale) answered. Written 2026-10-21 against `main` at 756d5ee (soft
shadows), with `docs/sdf-kit-plan.md` uncommitted beside it.

The goal, in the user's words: the worlds (cloud, portal, water, gui, origin, imposter) "are from separate
repos/projects, I trying to merge into one engine, but turn exclusive those project features into own kits that can be
shared and using in any scenario, concept of cross-world should be gone forever".

So at the end:

- a scenario runs on exactly **one** `World`, **one** `Renderer` and **one** `App` instance, made once by the host;
- there are no world types. What each former world brought is a kit (or kits and features) whose extensions compose onto
  those three instances, loaded only when a scenario uses them;
- nothing in the engine refers to "another world", "composition space", "the world holding the camera" or a
  per-world anything. The words, the code paths and the data fields that need them are gone (§4, Phase 7 adds a guard).

`docs/sdf-kit-plan.md` already assumes this end state (its §1.2a), and its Phase 0 makes two of the same changes as
Phase 1 here (`compose` skipping a key that is already there, `extensionsOf` taking lists). Whichever lands first does
them; the other drops them.

---

## 0. What the code does today

### 0.1 How many instances a scenario has

`Host.createWorlds` (js/engine/host.js) makes one *instance* per root entity (`ScenarioFormat.roots`). Each instance is
`module.create(ctx)`, a `FeatureWorld` (js/kits/world/feature-world.js) whose `spec.app(fx)` makes a `new App(...)`,
which then makes its own `new Renderer(...)` and `new World(...)`:

| World type | App | Renderer made at | World made at |
|---|---|---|---|
| cloud (atmosphere kit) | js/kits/atmosphere/app/feature.js:16 | atmosphere/app/app.js:35 | atmosphere/worlds/cloud/world-type.js:16 |
| water (hydrology) | hydrology/worlds/water/feature.js:34 | water/app.js:30 | water/app.js:48 |
| portal (interior) | interior/worlds/portal/feature.js:21 | portal/game/game.js:38 | portal/game/game.js:66 |
| gui | gui/worlds/gui/feature.js:24 | gui/game/game.js:55 | gui/game/game.js:71 |
| origin (entities) | entities/worlds/origin/feature.js:33 | origin/game/app.js:16 | origin/game/app.js:34 |
| imposter | imposter/worlds/imposter/feature.js:36 | imposter/game/game.js:24 | imposter/game/game.js:75 (`this.next`: a second World on a scene reload) |

On top of that, the handheld makes its own `new Renderer(RendererExtension, ...)` (js/engine/handheld.js:154). So
`compose-every-kit` runs 6 Apps, 6 Worlds and 7 Renderers, and even a single-world scenario has 2 Renderers.

### 0.2 Why a host can only be one world type: `Composite`

`Common.Composite` (js/engine/common.js) wraps a host in a Proxy. `mount(host, base)` sets the host's single `base` and
throws on a second one. Whatever the host lacks, the base answers. A world type's extension *is* that base
(`this.world = world.mount(this)`), and features add `host.ext[key]` beside it. The one-base rule is what ties each
World / Renderer / App instance to one world type. Removing it is Phase 1.

### 0.3 The cross-world mechanisms

| Mechanism | Where | What it does |
|---|---|---|
| per-instance loop | `Host.frameWorlds` | the camera owner's `frame(..., { render: false })` first, then every scene world renders into its layer, then the atmospheres |
| frames | `Host.frameOf`, `LayerFrame`, `layer.transform` (`offset`, `anchor: "<world>:<entity>"`) | each world in composition space; every hook call converts through two frames |
| merge | js/engine/compositor.js | `linearize` (each world's depth, any convention, to view metres), `merge` (nearest wins over up to 6 layers, sky from the `sky` world inside the outdoors rect, else the holder's background) |
| inject / `behindTex` | atmosphere/renderer.js `encodeInject`, `encodeSpace`, `behindView` | the merged rgba8 colour + r32f depth put back into the atmosphere's HDR scene through an inverse ACES; `behindTex` in the world bind group for `terrain.outside: "none"`; above `airTop`, the merged picture blended over the frame |
| layer roles | `layer.role` (`scene` / `atmosphere`), `layer.sky`, `layer.focus`, `layer.sun`, `byRole` | who merges, who gets the inject, whose sky fills the gaps, who has the keys, init order (scene worlds before atmospheres) |
| implicit worlds | `ScenarioFormat.complete`, manifest `worlds.<t>.implicit` | entities no root takes bring in a root (a storm in the bunker → a cloud world with `layer.role: atmosphere` on a sea-level plain) |
| suns | `configureSuns`, `lights`, `set('sunDir')`, `sunAlong`, `Lighting.follow` | each world's sun direction taken from another world's `sunDir(p)` through two frames |
| inside / holder | `inside()`, `sheltered(p)`, `outdoors(p)`, `fx.outdoors`, `set('indoors')`, `ui.region()` | the world whose interior holds the camera; the others see the outdoors only in its portal rect; atmospheres stop their rain |
| veil | `veilOf`, `FeatureWorld.veil`, `ui.veil` | the atmosphere's daytime sky hides what is in space; other worlds' labels fade with it |
| footprints | `footprintsIn`, `fx.footprints` | scene worlds' ground rectangles as inset clearings in the atmosphere's terrain |
| floors | `floorAt`, `floorIn`, `fx.floor`, `walkerAt` | the highest ground over every world, through frames |
| cameras | `camera.from`, `owners`, `cameraOwner`, `cameraLocked`, `handTo`, `lender`, `savedView`, `setView` per instance | several camera worlds, borrowed walkers, the camera handed between worlds |
| HUDs / input | `#world-huds .fhud[data-world]`, `unfocused`, `router.scope(id)`, `focusCamera` | one HUD root and one input scope per world |
| views / stats / links | `viewList` per instance, `buildScope` (`s[inst.id]`), `link.to: "<world>.<param>"` | per-world views, expression scope and parameter routing |
| `composed` flags | `fx.composed`, water renderer `depthC` | extra work only in a composition |

### 0.4 The renderers' frame structures

| Renderer | Colour | Depth / stencil | Convention | MSAA | Encoder | Passes |
|---|---|---|---|---|---|---|
| atmosphere | `rgba16float` HDR, final to target | `depth32float-stencil8` (else `depth32float`) | reversed, clear 0, `greater` | 1 | caller's `enc` | weather, ground, features' `encode` → scene (sky, terrain, `outdoor`/`indoor`/`late`, scissored to `outdoors`) → inject → froxel → march / resolve → bloom → final (composite, precip, features' `final`, bolts, lines) |
| water | `rgba16float` HDR | `depth32float` | reversed, clear 0, `greater` | 1 | caller's `enc` | scene (sky, terrain) → surface (composite, water, features' `surface`) → (composed only) depth copy + water depth |
| portal | canvas format | `depth24plus-stencil8` | standard, clear 1, `less` | 4 | own encoder + submit | extensions' `prepare` → one pass running FrameBuilder's command list (draw, sky, mark A/B/C, water, glass, veil, extension ops) → lines |
| imposter | canvas format | `depth32float` | reversed (infinite far), clear 0 | 4 | own encoder + submit | cull (compute), shadows (feature), one main pass |
| origin | canvas format | `depth32float` | reversed, clear 0, `scale` | 4 | own encoder + submit | one pass (bodies, instances, glow) |
| gui | canvas format | `depth24plus-stencil8` | standard, clear 1 | 1 | `beginFrame` / `endFrame` own encoder + submit | GUI atlas and targets, view targets, scene pass; the handheld's instance draws over the frame with `load` |

The display transform also differs. The atmosphere and water tonemap in their composite pass. The portal, gui, imposter
and origin shaders write display values straight to the canvas format.

### 0.5 Shader libraries and bind groups

Each renderer has its own `WgslLibrary` (`atmosphereWgsl`, `portalWgsl`, `waterWgsl`, the gui kit's, the imposter's
`shaders/library`, the origin's shaders) and its own group convention:

- **atmosphere**: group 0 is `WORLD_BINDINGS` (js/kits/atmosphere/bindings.js: 21 entries, **12 sampled textures**
  counting `behindTex`, 5 of 8 read-only storage buffers). Group 1 is the screen (4 textures) or the object frame.
  Group 2 is the object frame in `layoutGlass`. The final pass, the window glass and the march each sit at **16/16**
  sampled textures (sdf-kit-plan's finding). `layoutGlass` already uses 3 bind groups.
- **portal**: group 0 is globals + areas + materials (storage), group 1 the draw slot (dynamic offset).
- **water**: group 0 has 11 entries (7 sampled textures: terrain, surf, flow, 4 wave arrays), group 1 the screen
  (HDR + depth).
- **gui**: per-view uniform + instances + sampler + material texture + material buffer.
- **imposter**: 13 pipeline layouts, at most 5 sampled textures, 4 storage and 4 uniform buffers per stage, and **4 of 4
  bind groups** (the main pass). **origin**: one layout, 3 read-only storage buffers and 2 uniforms. **gui** (the kit's,
  also the handheld's): 3-9 layouts, 1 sampled texture, 1 storage and 1 uniform buffer, 2 groups; the phone camera and
  the paint canvas build theirs with `layout: 'auto'` (not counted). Measured in Phase 2 (`pixel-harness.mjs check
  --bindings`; see §2.4).

Chunk names collide between libraries (`COMMON`, `SCENE`...). That doesn't matter while each library has its own
renderer, and does matter once there is one (§2.1).

---

## 1. The end state

### 1.1 Words

- **kit**: as today (js/kits/manifest.js). Kits have no `worlds:` any more.
- **extension**: a class composed onto the one World, Renderer or App, by key (`world.ext.water`,
  `renderer.ext.atmosphere`). A kit's extensions are its only entry points ([[webgpu-entities-one-host]]).
- **feature**: as today, a part of a kit turned on by the data's `when`, contributing extensions.
- **site**: a named place in the one World, with a frame (position, orientation, optionally riding on an entity) and the
  entities placed in it. It replaces the root entity and `layer.transform`. A site is a parent transform with
  membership, like a scene-graph node. Every site shares the world's one camera, sun, depth buffer, HUD and rules. It is
  not a world, and nothing is ever "per site" except where its entities stand.

### 1.2 Composite with many extensions

`Common.Composite` changes from "one base plus features" to "many extensions, none of them special":

- Each extension class has `static key` (its kit's, or its feature's) and `static exposes = ['terrain', 'field', ...]`:
  the members it answers *on the host*. A Proxy lookup goes to the extension that exposes the member. Two extensions
  exposing the same name throw at compose time and name both. A member nobody exposes is `undefined` (the Proxy no
  longer falls through silently to a base).
- Hooks are lists: `host.each('update', dt)`, `host.first('sheltered', p)`, `host.most('veil', ...)`,
  `host.all('views')`. They run in compose order, which is the manifest's kit order and then the features' order, so it
  is deterministic.
- `mount` goes. An extension's constructor gets the host and keeps it (`this.world = world`). The rule
  "pass the host, not `this`" stays.
- `compose` skips a class whose key is already composed (from the sdf plan), so two features can both bring a shared
  extension.

### 1.3 One loop

```
Host.frame(now)
  app.frame(now, dt)
    app.each('input')                     the one input scope (and the handheld's)
    app.camera.update(dt)                 the one camera, its active controller (§1.8)
    world.each('update', dt, view)        every WorldExtension in order: sims, storms, drones, vehicles, origin rebase
    renderer.frame(view)                  one encoder, the stages of §2.2, one submit
  links, sound, handheld read world.stats()
```

The camera moves first by construction, so "update the owner first, then render the others" disappears.

### 1.4 The kit manifest

`worlds:` is removed. What a world type declared moves to its kit:

```js
hydrology: {
  uses, parts,
  extends: { world: 'WaterWorld', renderer: 'WaterRenderer', app: 'WaterApp' },  // exports of its parts
  bases: ['terrain'],            // the entity bases its WorldExtension offers (was worlds.water.bases)
  provides: ['water'],           // what entity types may need of it (was worlds.water.provides)
  sites: 'many',                 // 'none' | 'one' | 'many': whether its data is placed in sites, and how many
  schema: { config, maps, lists, rename },    // one site's native layout (was worlds.water.schema)
  defaults: [ ... ],             // entities it has unless the scenario gives some of that type (was implicit.entities)
  features: { waves, debris },   // the former world's own features become the kit's
  types, data,
}
```

A kit's extensions are composed onto the host when the kit loads. A kit loads when the scenario uses it, as today
(`kitsOf`), extended by one rule: an entity type's `base` and `needs` load the kits that offer that base and provide
those needs. Today the root decides that; afterwards the type does.

Mapping of the former world types:

| Former world | Becomes | World ext | Renderer ext | App ext | `sites` |
|---|---|---|---|---|---|
| cloud | atmosphere kit (the `cloud` world's `entities`, `storms`, `clouds`, `world-type` parts move into the kit) | `atmosphere` (weather, storms, the terrain it draws until Phase 8) | `atmosphere` | `atmosphere` (cloud picker, menus, readout) | `one` |
| water | hydrology kit | `water` (one `FlowSim` per site) | `water` | `water` (tools) | `many` |
| portal | interior kit | `interior` (areas, portals, power, collision, per site) | `interior` (portal traversal, its command list) | `interior` (map, vehicles' helm) | `many` |
| gui | gui kit | `gui` (fixtures, facility state, per site) | `gui` (already the kit's; shared by the handheld) | `gui` (terminals, interaction) | `many` |
| origin | new **origin** kit (floating origin, §3) + entities kit (`space` base: bodies, orbiters) | `origin`, `space` | `space` | `origin` (the space flight controller) | `space`: `one` |
| imposter | imposter kit | `imposter` (archetypes, per site; reload in place, not `this.next = new World`) | `imposter` (cull, draw; `shadows` feature) | `imposter` (drop, control panel on the handheld) | `many` |

The players and cameras of the former worlds (portal/gui `game/player.js`, imposter `game/camera.js`, origin
`game/camera.js`) become camera controllers (§1.8). They are no longer per-world cameras.

### 1.5 Entity bases, `needs` / `provides` on one World

- The World's bases are the union of what the composed extensions offer (`space`, `ground`, `terrain`, `sector`,
  `fixture`). `world.types` is built lazily per base, as `kits.world.entityTypes` does today.
- A type with one implementation takes it. A type implemented over several bases (`prop`: space, ground, sector;
  `light`, `door`, `drone`, `securityCamera`: sector and fixture) takes the base of the site it is placed in (its `of`).
  Without `of`, it takes the only loaded kit whose base it has. With several candidates it is an error asking for `of`.
  That is today's `worldOf` rule with sites in place of roots.
- `needs` are checked against what the loaded kits provide. `bus` needs `structures`, which the atmosphere kit provides,
  so a bus loads it.

### 1.6 A scenario without roots

```json
{ "type": "site", "id": "bunker", "label": "Portal · Bunker", "at": { "pos": [-11000, 221.2, 15000], "on": "plains-pad" } },
{ "type": "area", "of": "bunker", ... }
```

- `site` is an engine type: `id`, `label`, `at: { pos, yaw | q, on }`. `on` names any entity that answers
  `world.anchor(id)` (an origin prop, a body). A scenario with no site has one implicit site (the world's own frame).
  So a single-world scenario loses its root entity and nothing else.
- `of` names a site. Entities of a `sites: 'many'` kit go into that kit's native for that site:
  `ScenarioFormat.toNative(scenario, kit, site)`. Entities of a `sites: 'one'` kit with `of` set the frame of that
  kit's one site (the atmosphere's terrain in `compose-every-kit` sits 1300 m under `plains-pad`).
- The old root's fields map like this: `label` / `name` → the site's; `layer.transform` → `at`; `layer.role`, `sky`,
  `sun`, `focus` → **gone** (§1.7 gives the rules that replace them); `features` → one engine entity
  `{ "type": "features", ... }` for the whole world.
- `include { as }` keeps working. The included scenario's root becomes a site with id `as`, and its children keep
  `of: <as>`, which `resolveIncludes` already writes.
- Compatibility for one release (until Phase 7): a root entity of a former world type is read as
  `{ type: "site", id, kit: <its kit> }`, with a console note. `tools/migrate-single-world.mjs` rewrites the files and
  runs `embed-scenarios.mjs`.
- `link.to: "<site>.<param>"` goes to the extension that owns that site's parameter (`world.set(site, param, v)`), so
  `river.rain` still works. `"<kit>.<param>"` addresses a kit-wide one.
- Expression scope: `s[site]` holds the stats of what is in that site. `s[kitKey]` holds a kit's own. Site ids are kept
  from the old world ids, so existing expressions (`sky.rain`, `sol.sunAt['valley-pad']`) still resolve.

### 1.7 What replaces each cross-world mechanism

| Today | Replaced by |
|---|---|
| per-instance loop, `frameWorlds`, `{ render: false }` / `{ update: false }` | the one loop (§1.3) |
| `frameOf`, `LayerFrame`, `layer.transform.anchor`, `composition space` | site frames: the world kit's `Sites` WorldExtension resolves each site's frame once per frame (anchors through `world.first('anchor', id)`), in f64 in JS. A kit draws a site's content with that site's camera-relative transform (§3). There is one space, the World's |
| Compositor `linearize` / `merge`, layer textures, nearest-wins | one HDR target and one depth-stencil, shared by every extension in one frame; the depth test does the merging. compositor.js is deleted |
| `fx.inject`, `encodeInject`, `behindTex`, `behindView` / `bindBehind`, `encodeSpace` | gone. Whatever the inject brought in is now drawn in the same scene pass before the volumetrics, so the clouds, haze, rain and tonemap cover it as before. `behindTex` leaves `WORLD_BINDINGS` (12 → 11 sampled textures). `terrain.outside: "none"` with `edge` fades the terrain over whatever is drawn under it: space and bodies are drawn first (stage `background`) and the terrain's edge band blends or dithers. The "beyond the air" test (`airOut` in the inject shader) moves into the atmosphere's composite. Above `airTop` the sky's opacity fades by `airAt`, revealing the `background` stage |
| `layer.role`, `byRole`, `layer.sky`, init order | the stages of §2.2: each RendererExtension says which stages it draws in. The sky: exactly one `sky` contribution per frame, picked by manifest rank (atmosphere > space > a kit's own) or `render.sky` in the data. Init order: kits init in manifest order; the terrain reads site footprints after every site is built (a `world.each('built')` hook) |
| `layer.focus`, `router.scope(id)`, `focusCamera`, `unfocused` | one input scope for the App (and the handheld's). There is no world to focus |
| implicit worlds (`complete`, `implicit.root`) | kit loading by type (§1.5) plus the kit's `defaults`. A storm in the bunker loads the atmosphere kit, and its default sea-level terrain is added because the world has no `terrain` entity. That is the same picture as today, without a second world |
| suns: `configureSuns`, `lights`, `layer.sun`, `set('sunDir')`, `sunAlong`, `Lighting.follow` across worlds | one sun on the World: `world.sun` (exposed by the extension that owns the sky: the atmosphere's time of day, else the space kit's star seen from the site, else the lighting preset). Every kit reads `world.sun.dir(p)` and `world.sun.color`. The light-preset links of the compositions (`valley.light`, `river.light`) are deleted |
| `inside()`, `holder`, `region`, `fx.outdoors`, `set('indoors')`, `ui.region()` | World hooks: `world.first('sheltered', p)` and that kit's `outdoors(p)`, computed once per frame into `world.shelter = { by, outdoors: { seen, rect } }`. The Renderer scissors every `outdoor`-stage draw to it, as the atmosphere does now for its own features; the atmosphere reads `world.shelter` for its rain; the one LabelLayer clips by it |
| `veilOf`, `FeatureWorld.veil`, `ui.veil` | `world.most('veil', eye, dir, d)`; in practice the atmosphere's `airHides`. Labels read it |
| `footprintsIn`, `fx.footprints` | kept as an idea: `world.all('footprint')` returns each site's ground rectangle in world space, and the terrain makes its inset clearings from it. No world-to-world frame maths |
| `floorAt`, `floorIn`, `fx.floor`, `walkerAt`, `ground(p)` | `world.floor(p)`: the highest of `world.all('ground', p)`, each kit converting into its sites itself |
| `camera.from`, owners, `cameraOwner`, `cameraLocked`, `handTo`, `lender`, `savedView`, per-instance `view` / `setView` | one camera on the App (§1.8) |
| per-world HUD roots (`#world-huds .fhud[data-world]`), `hudHtml`, `FeatureWorld.HUD` | one HUD root. Kits ask for its elements by name (`labels`, `toast`, `crosshair`) in their AppExtension. There is one LabelLayer, to which every kit adds labels |
| `viewList` per instance | `world.all('views')` per kit and site, plus the `view` entities, grouped by site label on the handheld |
| `buildScope` per instance | §1.6 scope |
| the handheld's own `Renderer` | a `handheld` RendererExtension on the one Renderer drawing in the `overlay` stage, sharing `renderer.ext.gui` |
| `fx` per world (`device`, `format`, `size`, `target`, `composed`, `emit`, `toast`...) | the hosts: `renderer.device`, `renderer.size`, `renderer.target`, `app.emit`, `app.toast` |
| `fx.composed`, water `depthC` | deleted (the shared depth already holds the water surface: §2.2 `translucent` writes depth where it must) |

### 1.8 One camera

The App has one camera, the view kit's `FirstPersonView` (pos, fwd, up, fov; a `WorldPos` when the origin kit is
loaded). It is driven by one **controller** at a time:

- `fly` and `walk` are the engine's (walk stands on `world.floor` and collides through `world.first('collide', ...)`,
  which the interior and gui kits answer from their collision code);
- kits offer more as AppExtension `controllers`: the origin kit's `space` flight (floating origin, bookmarks), vehicle
  helms (interior: the freighter), bus driving (atmosphere `buses` feature).

The handheld's Walk switch and `camera.mode` pick between them. `camera.controller` / `camera.start` in the data pick the
first one. `keyHelp` comes from the active controller (only the mandatory keys: [[webgpu-entities-no-hotkeys]]).
`camera.from` and `carry` are removed. A view entity with `of` is in that site's frame.

---

## 2. One Renderer, one frame

### 2.1 What the Renderer itself owns

The gpu kit's `Renderer` is the core every RendererExtension adds to. It owns:

- the frame encoder: one per frame, one `queue.submit`. Every extension's `encode` / draw hook gets it, and no kit calls
  `createCommandEncoder` or `submit` for the frame (portal `render`, imposter, origin and gui `beginFrame` / `endFrame`
  change);
- the frame targets: the canvas view; the scene colour (canvas format, or `rgba16float` HDR: §2.3); the depth-stencil
  (`depth32float-stencil8`, else `depth32float`); MSAA colour and depth when the frame samples > 1; a scene-colour copy
  on request (`needs: ['sceneCopy']`, for the water's refraction);
- one `StencilLayout` per depth-stencil target, which every extension reserves into;
- the stage list (§2.2), the extensions' contributions sorted into it;
- one `GpuProfiler`, its pass names gathered from the extensions (`profile`), as the sdf plan's Phase 0 does;
- one `LineLayer` (debug frames, vis inspector);
- one `WgslLibrary`. Chunks are namespaced by kit (`water/SCENE`, `atmosphere/SKY`), and the engine's shared chunks
  have plain names: the full-screen vertex, reversed-Z helpers, the display transform, `curve*` (§3), the origin
  rebase. Until Phase 5 each kit keeps its own library instance under its own namespace, which has the same effect.

### 2.2 Stages and pass order

| # | Stage | Pass | Contributions (today's code) |
|---|---|---|---|
| 1 | `compute` | the extensions' own compute / render-to-texture passes | gui atlas and GUI targets, paint stamps, water sim + wave cascades + debris, weather and ground passes, imposter culling, imposter shadow cascades, sdf bake (later) |
| 2 | `views` | other cameras into their targets | media's CCTV / phone camera / IPTV views and the portal's view targets: `renderer.renderView(camera, target, stages)` runs stages 3–4 for that camera |
| 3 | `background` | **scene pass** (scene colour + depth-stencil, cleared once) | space: stars, bodies, orbits (space kit) |
| 3 | `sky` | ″ | exactly one: atmosphere `pSky`, else the space sky, else a kit's own sky (portal `sky` op, water `pSky`, imposter / gui clear colours) |
| 3 | `outdoor` | ″, scissored to `world.shelter.outdoors` | atmosphere terrain and its features' `outdoor` (structures, vegetation, buses); water terrain; imposter valley; origin near bodies; portal exterior |
| 3 | `indoor` | ″, full screen | portal command list (stencil traversal), gui facility, atmosphere features' `indoor` |
| 3 | `late` | ″, scissored | atmosphere features' `late` |
| 4 | `translucent` | same pass (or a second one that loads it, after `sceneCopy`) | water surface (+ water depth), portal glass / veil / water polys |
| 5 | `volumetric` | atmosphere froxel, march, resolve | reads the shared depth and scene colour, exactly as now through `depthSampleView` / `hdrView` |
| 6 | `post` | bloom, then the **final pass** into the canvas | the atmosphere's `fsComposite` when loaded; else the water's composite, or a pass-through (§2.3) |
| 7 | `final` | ″ (final pass) | precipitation, bolts, features' `final`, GUI overlays, the LineLayer |
| 8 | `overlay` | after the final pass | the handheld |

The atmosphere's `outdoor` / `indoor` / `late` hooks are already this contract inside one renderer. The plan promotes
them to the Renderer core and makes every kit use them.

**The portal's command list** runs as one `indoor` contribution in the shared pass. It sets its own pipelines,
scissors and stencil references, then hands back a pass state the next contribution can rely on: the full scissor and
its own stencil reference cleared. Its `sky` op becomes "draw the frame's sky contribution here", which is the
outdoors seen through a portal. Its `prepare` hooks move to `compute`.

**writeBuffer before one submit.** Today some renderers write a uniform buffer and submit once per call. With one
submit per frame, every `queue.writeBuffer` lands before all of the frame's commands. A buffer written twice per frame
would then hold only the last value for both uses. Known cases: the portal's `globalBuf` / `areaBuf` / `drawBuf`, which
`render(f, target)` writes once per view target (CCTV); and any per-view uniform reused across `renderView` calls. They
get one slice per call (a ring with dynamic offsets), sized by the views per frame. Phase 2 audits every
`writeBuffer` in a render path for this.

### 2.3 Conventions

- **Depth**: reversed-Z with an infinite far plane, clear 0, `greater`; view depth in metres. The portal and gui flip
  (projection, compare, clear) behind a `depthConvention` chunk and pipeline-table entry. Near plane: one per frame,
  the smallest the loaded kits ask for (gui 0.02, portal 0.05, imposter 0.1, water / origin `NEAR`), or `camera.near`.
  Reversed-Z float keeps the precision.
- **Origin scale**: `origin.scale` must not reach the depth. It goes into the model matrices, or is dropped where f32
  vertex precision allows it (Q4).
- **Stencil**: one layout. `portal.regions` (min 15 values = 4 bits) + `portal.mark` (1 bit) + `gui.surface` + the
  structures' GUI slot fit 8 bits through the existing `min` shrinking. Without stencil (`depth32float` only) the
  portal runs its `plain` (scissor) variant and the GUIs fall back to targets, as both already can.
- **Samples**: a frame property from the data, `render.samples`. Its default is what the loaded kits prefer (portal,
  imposter, origin: 4; atmosphere, water, gui: 1). With the atmosphere loaded the default is 1, because its march reads
  single-sample depth (Q1). Every pipeline is built for the frame's sample count.
- **Display or radiance**: the scene colour is the canvas format (display values, today's portal / gui / imposter /
  origin path) when no loaded kit needs radiance. It is `rgba16float` radiance when one does (atmosphere, water).
  In a radiance frame, display-output kits pass their colour through a `toRadiance` chunk: the inverse of the post's
  display transform, the same maths `encodeInject` does today. So they look as they do in a composition now, but
  without the rgba8 round trip. Native radiance per kit is Phase 8.

So a single-world scenario's frame keeps its own target format, depth convention, samples and display path, and stays
pixel-identical. Only frames that mix kits take the shared choices.

### 2.4 Bind groups and the sampled-texture budget

- Every kit keeps its own bind groups and pipeline layouts. No kit's resource enters another kit's group. There is no
  engine-wide group 0: `layoutGlass` already uses 3 of the default 4 bind groups.
- What every kit shares per frame (camera, sun, time, screen, origin cell, shelter rect) is written by the Renderer core
  into each kit's **own** frame uniform. `FrameBlock` and the other kits' frame layouts take an engine field list.
  That costs no binding.
- Cross-kit reads go through the World on the CPU (floor, shelter, sun, veil, wetness) or through the shared frame
  targets, passed in the reading kit's own screen group (the atmosphere's screen group already holds HDR + depth). No
  kit samples another kit's textures.
- Budget after the change: atmosphere world group 11 sampled textures (without `behindTex`); final 15/16, glass 15/16,
  march 15/16; read-only storage 5/8; water 7 + 2. Phase 2 adds a check that prints every pipeline layout's sampled
  textures and storage buffers per stage and fails at > 16 / > 8, and fills in the imposter, origin and gui figures.
  Measured (Phase 2, `pixel-harness.mjs check --bindings`, every scenario, nothing over a limit): atmosphere 16/16
  sampled (fragment and compute), 5-7/8 storage buffers (the vegetation pass 7), **4/4 storage textures**, 3 groups;
  water 9 sampled, 2 storage, 3 storage textures; imposter 5 sampled, 4 storage, **4/4 groups**; portal (interior) 1
  sampled, 2 storage, 3 groups; origin 3 storage; gui 1 sampled, 1 storage; the compositor's merge 12 sampled (6 layers
  x colour + depth). The imposter's main pass has no group to spare, and the atmosphere no storage texture.
  A kit that needs more uses the sdf plan's per-module binding sets (its Phase 0), not a shared texture.

---

## 3. Floating origin and curvature as kits on the one World

**origin kit** (new, split from `entities/worlds/origin/core`: `WorldPos`, `Origin`, `FloatingOrigin`, and
`game/floating.js`):

- `world.ext.origin` exposes `world.origin`: the current origin (integer cell + f32 local, rotation, scale) and the
  rebase rule from the `floatingOrigin` data (distance, angle). The App's camera position becomes a `WorldPos` while the
  kit is loaded. Without it, positions stay plain f32 at no cost, which keeps the scenarios without it pixel-identical.
- Each site's frame is a `WorldPos` plus a rotation. Once per frame, the `Sites` extension turns it into a
  camera-relative transform: an exact integer cell difference, then f64 → f32. A kit draws its site content with it and
  never sees coordinates beyond its site. The atmosphere's 64 km terrain stays in its own f32 frame as now.
- A rebase calls `world.each('rebase', delta)` for state kept in absolute coordinates (the sdf clipmap's toroidal
  offset, a weather map that follows the eye). Today only the origin world itself has any.
- `space` (entities kit) keeps bodies, orbiters, fields and props on bodies (`surface: { parent, lat, lon }`), and
  answers `anchor(id)`. A site with `at.on: "plains-pad"` rides on Earth's surface through it.
- The `space` controller (§1.8) is the origin's current camera + floating code.

**curvature kit** (exists: `kits.curvature`, data `curvature`):

- becomes `world.ext.curvature` (radius, on, reference). When the site the eye is in rides on a body, the space
  kit gives the body's radius, so the plains on Earth bend with Earth.
- The `curve*` WGSL stubs move from the atmosphere library into the shared library. The atmosphere's curvature feature
  replaces them as now. Water, imposter and portal exteriors may call them; the stub is flat, so a kit is unchanged
  until it opts in.

---

## 4. Migration: phases that each ship alone

Every phase ends with every scenario in `scenarios/` running. The single-world scenarios are pixel-identical to the
previous phase. The compositions are pixel-identical through Phase 5, then re-baselined once, deliberately, in Phase 6
(§6.2).

### Phase 0: harness and baselines (no engine change)

- `tools/pixel-harness.mjs` (Node 22, CDP, isolated Brave; §6.1). It captures every scenario × every `view` entity and
  start view at a fixed size after N stepped frames, and writes `baselines/<scenario>/<view>.png` plus `manifest.json`
  (known noise per scenario).
- `tools/format-golden.mjs`: for every scenario, `ScenarioFormat.toNative` per root, written as JSON goldens.
- Counters in the harness: `World` / `Renderer` / `App` constructions, `queue.submit` calls per frame, loaded kits.
  These record today's numbers (§0.1) as the starting point.

### Phase 1: `Composite` with many extensions

- §1.2: keys, `exposes`, hook lists, duplicate keys skipped, `mount` removed, `extensionsOf` taking lists.
- Each world type's extension declares what it exposes. Nothing else changes, and the instances are still one per root.
- Gate: everything pixel-identical; the instance counts unchanged.

### Phase 2: one encoder, one submit, stages

- The Renderer core (§2.1, without the shared targets yet) and the stage contract (§2.2). Each type's renderer is
  reorganised into stages in its current order. Portal, imposter, origin and gui stop creating encoders and submitting.
- The host still has instances. Each instance's Renderer encodes into the host's frame encoder, and the Compositor
  (still there) encodes its linearize / merge into the same encoder at the point where it submits today.
- The `writeBuffer` audit and the uniform rings (§2.2).
- The binding-budget check (§2.4).
- Gate: everything pixel-identical; one `queue.submit` per frame (plus the handheld's until Phase 5, if it can't join
  yet).

### Phase 3: shared conventions, chosen by data

- Frame properties: target format / display-or-radiance, depth convention, samples, near (§2.3); one StencilLayout per
  target; one LineLayer.
- Portal and gui get the reversed-Z variant (chunk + pipeline entries) without using it yet. Their frames still choose
  standard depth while only they are loaded.
- Gate: everything pixel-identical. The reversed variants are exercised by a harness mode that forces them on the
  single portal / gui scenarios and diffs against the baseline. A difference is reported, not gated, because 24-bit
  standard and 32-bit reversed depth may break coplanar ties differently.

### Phase 4: scenario format with sites

- `site` entity, `of` = site, `features` entity, `ScenarioFormat.toNative(scenario, kit, site)`, `kitsOf(scenario)`
  for the whole scenario, type-driven kit loading (§1.5), the compatibility reading of roots (§1.6).
- `tools/migrate-single-world.mjs` rewrites `scenarios/*.json` (§5) and re-embeds.
- Internally the host still makes one instance per site of a `sites` kit, the same instances as before.
- Gate: format goldens equal (each site's native equal to the old root's, key for key); everything pixel-identical.

### Phase 5: kits instead of world types; single-world scenarios on one instance

- Manifest: `worlds:` → each kit's `extends` / `bases` / `provides` / `sites` / `schema` / `defaults` / features (§1.4).
  The former worlds' parts move under their kits (`js/kits/<kit>/worlds/<type>/` → `js/kits/<kit>/...`).
- `FeatureWorld` is deleted. Its hooks become the extensions' (`ground`, `sheltered`, `outdoors`, `footprint`, `views`,
  `stats`, `set`, `anchor`, `drop`, `veil`, `sun`). Its defaults move to the App's camera and the World's `Sites`.
- `Host.boot` makes the one World, Renderer and App. Each loaded kit composes its extensions. The handheld becomes a
  RendererExtension and an AppExtension. The imposter's reload rebuilds its site in place.
- Scenarios with one site (§5, the nine single-world ones) run on this path. Scenarios with more than one site still
  run on the legacy per-root path, which stays untouched in `js/engine/legacy-host.js`: the old `Host` code with the
  old `FeatureWorld` adapters kept beside it, so the compositions don't break before Phase 6.
- Gate: single-world pixel-identical; for them exactly 1 World, 1 Renderer, 1 App and 1 submit; kits loaded unchanged.
  Compositions identical on the legacy path.

### Phase 6: compositions on one instance

The shared frame: shared targets, the radiance path, one sky, one sun, `world.shelter`, site frames through `Sites` and
the origin kit, `world.floor`, one camera with controllers, one HUD, one input scope. One composition moves at a time,
from the legacy path to the one host, simplest first. Each step ships:

| Step | Scenario | What it proves |
|---|---|---|
| 6a | `compose-storm-riverlands` | atmosphere + water in one frame: water terrain and surface under the clouds, `translucent` + `sceneCopy`, `river.rain` link, one sun (the `river.light` link deleted) |
| 6b | `compose-valley-weather` | atmosphere + imposter: the MSAA question settled (Q1), imposter lighting from `world.sun` (`valley.light` deleted) |
| 6c | `compose-bunker-reservoir` | atmosphere + interior: `world.shelter`, the portal command list in `indoor`, the portal sky op as the frame's sky through apertures, stencil sharing, the island footprint |
| 6d | `compose-planetfall` | space + imposter: site on a body (`at.on`), the floating origin with one depth buffer, the sun from the star (`valley.light` deleted) |
| 6e | `compose-moonbase-sector07` | space + gui: controllers `space` → `walk` in the sector (`camera.from` / `carry: false` gone) |
| 6f | `compose-grand-tour` | four kits, the `fly` camera from the data |
| 6g | `compose-every-kit` | everything: the atmosphere's site under `plains-pad`, `terrain.outside: "none"` + `edge` over Earth (`background` stage), `airTop` over space, curvature from Earth's radius |

After 6g: delete `js/engine/compositor.js`, the legacy host, `encodeInject` / `encodeSpace` / `behindTex`,
`layer.*`, `complete` / `implicit`, `configureSuns` / `lights`, `inside` / `holder` / `veilOf` / `skyOf` / `byRole`,
`frameOf` / `LayerFrame` (its maths goes into `Sites`), `camera.from` / `handTo` / `lender` / `walkerAt`, per-world
HUD roots and `router.scope(id)`.

Gate per step: §6.2 G2. Single-world scenarios stay pixel-identical throughout.

### Phase 7: remove the compatibility, guard the result

- Roots are no longer read as sites. `of` means a site only. Manifest and `scenario-format.js` header comments are
  rewritten without "world type", "composition", "root".
- `tools/check-single-world.mjs`, run by the harness and before commits, fails on: more than one
  `new World|Renderer|App(` in `js/`; the identifiers `instances`, `frameOf`, `composed`, `Compositor`, `inject`,
  `behindTex`, `byRole`, `cameraOwner`, `sunFrom`, `holder`, `layer.role`; a manifest `worlds:` key; any scenario
  field `layer`.
- Docs: `docs/sdf-kit-plan.md` §1.2a refers to this plan. The memory notes [[webgpu-entities-no-world-toggles]] and
  [[webgpu-entities-single-world]] are updated: the composition rules they describe are superseded by §1.7.

### Phase 8 (after, optional): one ground and native radiance

These aren't needed for "one instance", but they finish the merge:

- The terrain kit draws the one terrain (CDLOD out of the atmosphere renderer). The water's sim heightfield, the
  imposter valley and the portal island become terrain sources or stamps on it, not grounds of their own.
- Portal, gui, imposter and origin shaders output radiance natively. `toRadiance` goes away, and so do the
  per-scenario display paths.
- Each changes pixels on purpose and gets its own re-baseline.

---

## 5. Every scenario in `scenarios/`

The single-world scenarios: after Phase 4 their root entity is gone (or read as the implicit site until Phase 7). From
Phase 5 on they run on one World, one Renderer and one App. They are pixel-identical in every phase.

| Scenario | Today's root | After |
|---|---|---|
| `cloud-high-plains` | `cloud` | no site; atmosphere kit (+ structures, vegetation, buses, curvature features as its data asks) |
| `cloud-oahu` | `cloud` | no site; atmosphere + geo kits |
| `water-riverlands` | `water` | no site; hydrology kit (waves, debris) |
| `origin-sol-transit` | `origin` | no site; origin + entities (space) kits; camera controller `space` |
| `imposter-valley` | `imposter` | no site; imposter kit (shadows) |
| `portal-bunker-compound` | `portal` | no site; interior kit (screens, media, vehicles, lightTransport, drones) |
| `gui-sector-07` | `gui` | no site; gui kit (paint, radar, media) |
| `gui-stress` | `gui` | no site; gui kit |
| `gui-swarm` | `gui` | no site; gui kit (`tools/gui-swarm.mjs` writes it: updated to write no root) |

The compositions keep their file names and ids (URLs and `localStorage` remember them: Q6). Their includes stay; each
`include.root.layer` becomes `include.site.at`.

| Scenario | Today | After Phase 6 |
|---|---|---|
| `compose-storm-riverlands` | `sky` (cloud, atmosphere) + `river` (water, offset); `camera.from: river`; links `river.rain`, `river.light` | sites `sky` (atmosphere's one site), `river` at its offset; camera starts at the river's start view; `river.rain` kept; `river.light` deleted |
| `compose-valley-weather` | `sky` + `valley` (imposter); `camera.from: valley`; link `valley.light` | sites `sky`, `valley`; `valley.light` deleted |
| `compose-bunker-reservoir` | `sky` + `bunker` (portal, offset, focus); `camera.from: bunker` | sites `sky`, `bunker`; the atmosphere's outdoors through the bunker's portals via `world.shelter` |
| `compose-planetfall` | `sol` (origin, sky) + `valley` anchored `sol:valley-pad`; link `valley.light` | no `sol` site (space is the world's own); site `valley` `on: "valley-pad"`; sun from the star; link deleted |
| `compose-moonbase-sector07` | `sol` + `sector` (gui) anchored `sol:sector07-pad`; `camera.from: [sol, sector]`, `carry: false` | site `sector` `on: "sector07-pad"`; controllers `space` and `walk` |
| `compose-grand-tour` | `sky` + `river` + `valley` + `bunker`; `fly` camera; `river.rain` | four sites; `fly`; link kept |
| `compose-every-kit` | all six, everything anchored on `sol:plains-pad`; `camera.from: [sol, sector]`; `river.rain` | sites `sky` (on `plains-pad`, −1300 m), `river`, `valley`, `bunker`, `sector`; space as the world's own; controllers `space` / `walk`; link kept |

`scenarios/gui/*.json` (handheld pages) and `scenarios/plans/*` are unchanged; page entries that name a world id keep
working because site ids are the old world ids. `scenarios/sounds/*` entries addressed as `<world>.<event>` go through
`app.emit(site, name)` with the same names.

---

## 6. Testing

### 6.1 The deterministic Brave pixel harness

From [[brave-webgpu-testing]], as in `docs/sdf-kit-plan.md` §6.2:

- an isolated Brave instance (`--user-data-dir` in the scratchpad, `--remote-debugging-port`, the anti-backgrounding
  and occlusion flags), never the user's own session;
- a fake clock (`performance.now`, `Date.now`), seeded `Math.random`, stepped `requestAnimationFrame` (stubbed; frames
  stepped by calling `entities.frame(t)` at 1/60 s);
- `timestamp-query` hidden by patching `GPUSupportedFeatures.prototype.has` (else the atmosphere's dynamic resolution
  follows GPU timings);
- the weather blend made tiny (`transition`), so early frames aren't mid-blend;
- `#engine-bar`, `#engine-side` and the toasts hidden, a fixed canvas size and `devicePixelRatio` 1;
- cache disabled in the same CDP session as `Page.reload({ ignoreCache: true })`, and the edit verified live;
- `Page.bringToFront` before each capture;
- fail on any `uncapturederror` (GPU validation) or console error.

### 6.2 Gates

| Gate | When | Check |
|---|---|---|
| G1 | every phase | the nine single-world scenarios, every view: pixel-identical to the previous phase (exact; `gui-sector-07` / `gui-swarm` within their recorded noise, about 0.04 %) |
| G2 | Phases 1–5: identical. Phase 6: re-baseline | compositions on the legacy path: identical. Moved in Phase 6: a diff report against the Phase 0 baseline per view (changed pixels, max / mean ΔE, a heat map), reviewed with the user from screenshots, then frozen as the new baseline. Expected changes: no rgba8 round trip through the inject, the light-preset links replaced by one sun, the shared near plane |
| G3 | Phase 4 on | format goldens: each site's native equal to the old root's |
| G4 | every phase | kits loaded per scenario unchanged (`Object.keys(Features.kits)`); after Phase 5, nothing of an unused kit is loaded or composed |
| G5 | Phase 5 (single), Phase 6 (all) | exactly 1 `World`, 1 `Renderer`, 1 `App` constructed, 1 `queue.submit` per frame |
| G6 | every phase | key smoke run: WASD, E, F, Tab (handheld), the Walk switch, click to look, Esc; no errors, the view moves |
| G7 | Phases 2, 5, 6 | GPU time per pass with `timestamp-query` on, A/B alternated on one frozen frame (the 3050 Ti throttles ±40 % between runs). Compositions should get cheaper: no layer targets, linearize or merge |
| G8 | Phase 7 on | `tools/check-single-world.mjs` clean |

---

## 7. Phase summary

| Phase | Ships | Removes | Pixels | Main risk |
|---|---|---|---|---|
| 0 | harness, baselines, format goldens, counters | — | — | harness determinism in the noisy gui scenarios |
| 1 | `Composite` with many extensions, `exposes`, hook lists | `mount`, the single base | identical | name clashes between extensions surfacing late |
| 2 | one encoder / submit, stages, uniform rings, binding-budget check | per-kit encoders and submits | identical | a missed buffer written twice per frame |
| 3 | frame conventions by data, one StencilLayout, one LineLayer, reversed-Z variants for portal / gui | per-renderer stencil layouts | identical (reversed variants reported) | coplanar ties under reversed-Z |
| 4 | `site`, `of` = site, type-driven kit loading, migration tool | roots in the data (compat kept) | identical | `prop` / `light` / `door` ambiguity across bases |
| 5 | kits instead of world types, one World / Renderer / App for single-world scenarios, handheld as extension | `worlds:`, `FeatureWorld`, the handheld's Renderer, `this.next` | identical | hidden reliance on base forwarding |
| 6a–g | compositions on one instance, one per step | Compositor, inject, `behindTex`, layer roles, implicit worlds, suns, holder, veil, frames, camera hand-over, per-world HUDs, the legacy host | compositions re-baselined, single-world identical | MSAA vs the atmosphere, terrain edge over Earth, origin scale in one depth |
| 7 | guard, compatibility removed, docs | root compatibility | identical | — |
| 8 | one ground, native radiance (optional) | per-kit grounds, `toRadiance` | re-baselined on purpose | terrain sources from four kits |

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6a…6g → 7. Phase 3 and Phase 4 don't depend on each other and can swap. The sdf plan's
phases can run in parallel from Phase 1 on: its Phase 0 shares Phase 1's two Composite changes.

---

## 8. Open questions

1. **MSAA in mixed frames.** With the atmosphere loaded, the frame is single-sample (its march reads single-sample
   depth), so imposter, portal and origin content under the clouds loses its 4× MSAA. Accept that? Add FXAA / TAA in
   `post`? Or run the scene pass at 4× and resolve depth (nearest) for the volumetrics, which builds every atmosphere
   pipeline at 4× and changes the cloud scenarios' pixels?
2. **Which sky wins** when several kits offer one and the data says nothing: the manifest ranking proposed in §1.7
   (atmosphere > space > a kit's own), or must a mixed scenario always say `render.sky`?
3. **Kit-wide parameters vs site parameters in links.** `river.rain` addresses a site. Should `rain` be a property of
   the world's one weather instead (water reads the atmosphere's rain where its site is) and the link be deleted too?
   This is like the light links, which §1.7 already deletes.
4. **Origin `scale`.** Fold it into the model matrices, or drop it, given reversed-Z f32 depth and camera-relative
   rendering? This needs a precision check at Sol's distances.
5. **Terrain edge over Earth** (`compose-every-kit`, `outside: "none"`, `edge: 8000`): blend the edge band (the terrain
   pipeline gets a blend state; space and bodies draw first) or dither / alpha-to-coverage? Blending is closest to
   today's `behindTex` look but conflicts with depth writes in the band.
6. **Names.** Keep the `compose-*` ids and the "Compositions" group in `scenarios/index.json` (URLs and `localStorage`
   remember the ids), or rename the group (for example "Tours") so the word "composition" leaves the UI too?
7. **`site` as the name** of the new engine type. `place` is taken by the geo kit and `area` by the interior kit.
   **Answered (2026-10-22): `site` stays; the props a site rides on are renamed `*-site` → `*-pad`** (`plains-pad`,
   `valley-pad`, `sector07-pad`; done in Phase 4).
8. **Higher limits.** Request `maxSampledTexturesPerShaderStage` above 16 when the adapter offers it, or keep 16 as the
   design limit everywhere (proposed: keep 16, as the sdf plan does)?
9. **Phase 8.** In this plan, or a separate one once Phase 7 is in?
