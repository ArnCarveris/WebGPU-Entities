# WebGPU Entities

The six WebGPU-Entity demos in one page, where everything is an entity and every scenario is data:

| Feature | From | What it renders |
|---|---|---|
| **cloud** | [WebGPU-EntityCloud](https://github.com/ArnCarveris/WebGPU-EntityCloud) | volumetric clouds and a weather system: storm cells, rain and snow shafts, lightning, buildings and buses that keep the rain off |
| **water** | [WebGPU-EntityWater](https://github.com/ArnCarveris/WebGPU-EntityWater) | a GPU shallow-water river simulation with wave cascades, debris and screen-space water |
| **origin** | [WebGPU-EntityOrigin](https://github.com/ArnCarveris/WebGPU-EntityOrigin) | a floating origin with O(1) rebasing over a real-scale solar system |
| **imposter** | [WebGPU-EntityImposter](https://github.com/ArnCarveris/WebGPU-EntityImposter) | octahedral imposters with light-agnostic atlases, GPU LOD and cascaded shadows |
| **portal** | [WebGPU-EntityPortal](https://github.com/ArnCarveris/WebGPU-EntityPortal) | Portal-Room visibility (Far Cry 1 VisArea / SECTR), stencil-masked traversal, an island with a ship |
| **gui** | [WebGPU-EntityGUI](https://github.com/ArnCarveris/WebGPU-EntityGUI) | Doom 3-style world-space GUIs: an airlock terminal with CCTV, an easel, a handheld phone |

The scenario picker (top right) lists every original demo's scenario, rendered by its own engine as before, and
**compositions**: several features in one world, one camera, one picture.

| Scenario | Worlds |
|---|---|
| Storm over Riverlands | cloud (atmosphere) + water: the river map on the plains, rain over the camera turns on the river's rain |
| Imposter Valley weather | cloud (atmosphere) + imposter: the valley's forests under the plains' clouds and sun |
| Bunker on the Reservoir | cloud (atmosphere) + portal: the bunker island in a lake; indoors, the rain stays out |
| Planetfall | origin + imposter: the valley on the real-scale Earth, flown to from orbit; the valley's sun is the Sun |
| Sector 07 on the Moon | origin + gui: the GUI facility at Shackleton Base; <kbd>`</kbd> hands the camera to its player inside |
| Grand tour of the plains | cloud (atmosphere) + water + imposter + portal, with the engine's free camera and viewpoints |
| High Plains · Riverlands · Sol Transit · Imposter Valley · Bunker compound · Sector 07 | each original demo on its own |

The screen shows the worlds and nothing else (their in-world labels, toasts, a corner chip). Every option and readout is
on the **handheld**, a phone the engine holds in every scenario: <kbd>TAB</kbd> (or the chip) takes it out, <kbd>Esc</kbd>
puts it away. Its root page has a section per world (its status, its options, its controls), the scenario's pages, and
the engine's options: scenario, worlds (in a composition: show / hide each one, give one the keys, or press
<kbd>`</kbd>), view, move, sound, GPU.

Views are the engine's too: the handheld's **View** lists the scenario's `view` entities and every world's own
(`view` with `of`, `bookmark`; a world offers them through `views()`, by default its `view` entities' `pos` / `look` /
`fov`), so every scenario has some, and going to one of a world that
can't take the camera moves the camera there. A world view that follows an entity with `"each": true` is one view per
member of that entity, from data: `{ "type": "view", "of": "cloud", "name": "{label}", "follow": "bus", "each": true, "spot": "door" }`
lists every bus of the line `bus` (named by `{label}`, with what it is doing under it); `spot` is where on it (a bus's
`door` or `seat`).

Walking and flying are the engine's: <kbd>H</kbd> (or the handheld's Move) switches the camera between them, in every
scenario. The engine's own camera walks on the highest ground of every shown world (each world's `ground()`, merged in
composition space, so you walk on what you see); a world that has the camera walks its own way (cloud: its walker,
into buildings and buses; portal: its player, stairs, ladders, swimming; water, imposter: their first-person view on the
same merged ground; gui: always on foot; origin: flying only).

## Running

Open `index.html` in a WebGPU browser (Chrome / Edge 113+, or Brave with WebGPU enabled), straight from disk or served
over HTTP:

```bash
python -m http.server 8770
```

`?scenario=<id>` picks a scenario (the picker reloads the page with it); `?gpu=<id>` the GPU, as in the original demos.
Drop a scenario `.json` on the page to run it: one in the entity format below, or a native one made for any of the
original demos (its feature is recognised from its keys). Models (`.glb`, `.gltf`, `.obj`) dropped on the page go to the
focused world (the imposter baker).

Opened from disk, browsers block `fetch()`, so the page reads the embedded copy of every scenario
(`scenarios/embedded.js`). The `.json` files are the source of truth; after adding or editing one, regenerate the catalog
and the copy (the Pages workflow does this too):

```bash
node tools/embed-scenarios.mjs
```

## Everything is an entity

A scenario is one flat list of entities:

```json
{
    "name": "Riverlands",
    "group": "Entity Water",
    "entities": [
        { "type": "water", "name": "Riverlands" },
        { "type": "terrain", "size": 2048, "resolution": 512, "base": 80 },
        { "type": "mountain", "label": "Stormhorn", "pos": [-560, -820], "radius": 520, "height": 270 },
        { "type": "spring", "label": "West spring", "pos": [-470, -700], "rate": 40, "radius": 18 },
        { "type": "light", "id": "day", "sun": { "azimuth": 150, "elevation": 38 } },
        { "type": "tool", "tool": "pour", "key": "1", "rate": 40 },
        { "type": "view", "of": "water", "name": "Overview", "pos": [-820, 420, 1020], "look": [60, 40, -60] },
        { "type": "handheld.page", "id": "controls", "of": "water", "title": "Controls", "nav": { "section": "CONTROLS" },
          "sections": [{ "header": "MOVE", "cells": [{ "type": "label", "title": "Look", "value": "drag" }] }] },
        { "type": "sound.bed", "source": "white", "filters": [["bandpass", 900, 0.6]], "gain": "0.3 * clamp(water.maxSpeed / 8)" },
        { "type": "sound.cue", "on": "breach", "parts": [{ "shot": { "source": "brown", "freq": 140, "env": [[0.1, 1.2], [6, 0]] } }] }
    ]
}
```

- **A world** is a root entity whose type is a feature (`cloud`, `water`, `origin`, `imposter`, `portal`, `gui`), with an
  `id` (default: the feature's name), a `label`, and `layer` settings for compositions.
- **Everything that world is made of** is an entity of a plain type: terrain stamps, lakes, storm cells, bodies, props,
  areas and portals, materials, models, lighting presets, views, tools, config blocks (`light`, `building`, `mountain`,
  `door`...). Types are the kits', not the features': every one is listed in `js/kits/types.js` (`EntityTypes`, with
  the kit that implements it where the features share the code), and a feature takes the ones its schema names. An
  entity belongs to the world named by `of`, else to the only world of the scenario that takes its type: in a
  composition of a sky and a river, `{ "type": "lake", "of": "sky" }` (both take `lake`), but `{ "type": "clearing" }`
  (only cloud does). An included world's entities get its `of`. `camera` and `view` are the engine's unless they
  have `of`: `{ "type": "camera", "of": "imposter", "fov": 60 }` is that world's camera block.
- **The engine's own entities** are plain types: `camera`, `view`, `link`, `include`, `handheld`, `handheld.page`,
  `hud.toast`, `sound.*`.

Each feature's engine still reads its own layout (materials as a map, views as a list...). `js/engine/scenario-format.js`
holds a schema per feature that maps its entities onto that layout and back, without per-feature code:

| Feature | config blocks (one entity each) | maps (one entity per key, the key as `id`) | lists (one entity per item) | own entity classes |
|---|---|---|---|---|
| cloud | terrain render weather lighting hurricane streetLights | weatherState light building | cloudLayer view | clearing tilt hills mountain range river lake town forest village busStation bus storm supercell squall spawner |
| water | terrain sim waves waterShading lighting | light | tool view | tilt hills mountain valley basin coast dam sea lake spring drain rain debris |
| origin | start camera floatingOrigin lighting | material model | bookmark | body prop field orbiter |
| imposter | camera environment lod shadows imposterAtlas drop | light material model | | terrain prop compare scatter |
| portal | camera player minimap outdoor cctv media iptv | material model | area visPortal occluder vehicle | securityCamera prop light stairs hull helm door drone |
| gui | player facility cctv media iptv waves radar places phone | material model | | static door lamp alarmBeacon light drone securityCamera avatar terminal easel |

A block whose native key is taken by a feature's name gets another type (water's `water` block is `waterShading`,
origin's `origin` `floatingOrigin`, imposter's `imposter` `imposterAtlas`, portal's `portals` list `visPortal`); a
type the catalog does not list is an error, and so is a `<feature>.<kind>` type left from before (it says the type to
write instead). An item's own `type` field is kept under the name
of its slot (`{ "type": "tool", "tool": "pour" }`). The per-feature references (every key, every entity type, how
the engines work) are the original READMEs, in [docs/features](docs/features).

`tools/import-native.mjs` converts a scenario made for one of the original demos (a `.json`, an `index.html` with a
`<script id="scenario">`, or the GUI demo's `js/scenario.js`) and checks that it converts back to the same data.

### Engine entities

| Type | Fields | |
|---|---|---|
| `camera` | `from: "<world>"` or `["a", "b"]`, `carry` · or `controller: "fly"`, `pos`, `look`, `fov`, `speed` · `mode: "walk"` | which world's camera drives the others, or the engine's free camera (WASD, drag, wheel, Space / C); `mode` starts it walking (<kbd>H</kbd> switches) |
| `view` | `name`, `pos`, `look`, `fov` | a viewpoint in composition space, picked on the handheld's View |
| `link` | `to: "<world>.<param>"`, `value: expr` | sets a world's parameter from an expression every frame (when it changes) |
| `include` | `scenario`, `as`, `skip`, `only`, `root` | splices another scenario's entities, or a part kept in its own file (`"gui/<id>"`: a scenario's GUIs, under `scenarios/gui/`): `as` renames its world (and its name in expressions), `skip` / `only` filter by type (`"view"`, `"sound.*"`), `root` merges fields into its root |
| `handheld` | `startShown`, `title`, `fovDeg`, `pose`, `screen`, `model`, `materials`, `lighting`, `sounds` | the engine's handheld, in every scenario (<kbd>TAB</kbd> / <kbd>Esc</kbd>, or the corner chip): merged over its defaults, later entities winning |
| `handheld.page` | `id`, `of`, `title`, `nav: { section, sub, icon }`, `sections` | a page of the handheld, the scenario's HUD: cells `label` `text` `nav` `switch` `slider` `picker` `action`; `label` / `text` take `expr`, a template of the frame scope (`"{sky.rain\|pct}"`); `nav` lists it in that section of the root page, `of` ties it to a world |
| `hud.toast` | `text`, `ms`, `delay` | a message once the scenario starts |
| `sound.master` | `gain`, `muted` | |
| `sound.bed` | `source` (`white` `brown` `osc`), `wave`, `freq`, `filters` `[[type, Hz, Q]]`, `gain`, `filter: [index, Hz]`, `pitch`, `pan`, `when`, `smooth` | a looped sound whose level, filter and pitch follow expressions |
| `sound.cue` | `on` (event names) or `every: [min, max]` s, `when`, `parts` | a one-shot: `tone` `[Hz, s, wave, volume, slide Hz]`, `noise`, `shot` (filtered noise with an envelope), `thunder`; every number may be an expression of the event's fields |

**Expressions** (`js/engine/expr.js`) are parsed, never `eval`'d: literals, names (`river.flow.volume`, `sky['rain']`),
`?: || && ?? == != < <= > >= + - * / % !`, and functions (`min max abs floor ceil round sqrt pow exp log sin cos clamp
lerp mix smoothstep step sign hypot len contains rand fixed num dist pct onoff`). They read the frame's scope:
`time`, `fps`, `focus` (the world with the keys), `scenario`, and every world's stats by its id. Template formats:
a digit count, `num` (k / M / G, `num: m³` adds a unit), `dist`, `pct`, `int`, `onoff`, `yesno`, `ms`, `upper`.

**Worlds' stats, parameters and events** (what expressions read, what links set, what cues hear):

| Feature | stats | `link` parameters | events |
|---|---|---|---|
| cloud | weather light rain snow inside sheltered inBus walking wind agl busDist busSpeed riding temperature coverage cells flashes veil time fps | weather light paused quality timeScale indoors radar | thunder door busDoor step weather |
| water | volume wet maxSpeed inflow boost rain breached settling light mode tool acting height debris steps fps | rain boost paused light breach | toggle breach reset tool |
| origin | speed fromZero body altitude near rebases reason scale translate rotate scaling everyFrame instances draws density sunAt fps | paused translate rotate scale everyFrame labels | rebase jump toggle |
| imposter | loading baking bakes lod lodDistance shadows light instances meshes imposters height fps | light lod shadows sunDir | toggle relight baked |
| portal | area outdoor onShip state swimming driving culling mode draws tris shipSpeed shipDist drones fps | any of its options (culling walk map help...) | door step |
| gui | lightsOn alarm phone moving running noise gui sound fps | lights alarm phone | door step shutter chime easel delete hover miss press granted denied cctv alarm (the handheld: `handheld.shown` `handheld.tap`) |

The sounds the original demos synthesised in code are now data: the weather's beds and thunder (cloud), the GUI's
beeps and footsteps, plus new ambience for every world.

## Composition

Every world renders its finished frame with the same camera, as it would alone (its own lighting, tonemapping, MSAA),
into a layer texture; `js/engine/compositor.js` turns each world's depth buffer, whatever its convention (reversed-Z with
an infinite far plane, classic 0..1 with a far plane, multisampled, depth-stencil), into view depth in metres and takes
the nearest world per pixel. Where a world draws only sky, the others show through.

A world with `layer.role: "atmosphere"` (cloud) does not take part in the merge: the merged picture and its depth go into
its scene before its volumetrics (`Renderer.encodeInject` in `js/features/cloud/gpu/renderer.js`: depth as reversed-Z, colour back to
scene radiance through the inverse of its display transform), so its clouds, rain, haze, lightning, bloom and
tonemapping cover the other worlds too.

Where a world sits: `layer.transform: { offset: [x, y, z], yaw }` in composition space, or `{ anchor: "<world>:<entity>",
offset, yaw }` to ride on an entity of another world (a site on the Earth, a moon base). The camera passes between the
worlds as a view (position, forward, up, fov in metres) through those transforms, so a valley anchored on a real-scale
planet stays exact under the floating origin.

What makes a composition fit is more data: `clearing` (a cloud entity) levels the plains under another
world's footprint (`inset`: inside it, so the terrain meets the other world's edge at its own height); extra lighting
presets match the other worlds' suns to the sky's; links carry state across (`sky.rain > 0.05` → `river.rain`,
`!bunker.outdoor` → `sky.indoors`, `sol.sunAt['valley-site']` → `valley.sunDir`).

## Layout

```
index.html                  the page: canvas, the feature HUD root (labels, toasts), the corner chip
css/entities.css            shell, chip and toasts, what the features still draw on the screen (.fhud[data-feature])
js/engine/
    host.js                 boot, GPU device, worlds, the frame, links
    common.js               small helpers everything shares (scalars, v3 / quat / m4, frustum planes, polylines,
                            buffers and bind groups, number formats, pointer input)
    scenario-format.js      schemas, entities <-> each feature's native scenario, includes
    features.js             feature and kit registry (Features.PARTS, KITS, USES), on-demand script loading
    compositor.js           depth linearize + nearest-wins merge, the atmosphere's inject target
    camera.js               composition transforms, the engine's fly camera
    input.js                input routing between worlds
    hud.js                  the corner chip, toasts (and the pickers, when the page could not start)
    handheld.js             the engine's handheld (handheld, handheld.page): every option and readout, in every
                            scenario; worlds offer theirs through handheld()
    audio.js                sound.* entities (WebAudio synthesis)
    expr.js                 the expression language
    gpu-choice.js           GPU adapter choice
js/kits/types.js            EntityTypes: every entity type a scenario may use (types are the kits', not the
                            features'), with the kit implementing it; a plain script the scenario format reads first
js/kits/<kit>/              generic building blocks, not any one feature's (Features.kit), loaded with the first
                            feature that lists them in Features.USES (the engine's: Features.ENGINE_KITS, at boot);
                            their exports are engine.kits.<kit> (Features.kits)
    noise/                  seeded random (mulberry32, seededRandom, hashes, pcg / pcgRandom as WGSL's), value noise 2D / 3D, fbm with options,
                            ridged multifractal; NoiseWGSL: the shaders' hashes, value noise (± gradient), fbm and
                            tileable Perlin / Worley, each under the name its shader calls it (the gui kit's included)
    gpu/                    StencilLayout: a depth-stencil target's bits shared out by name. Users reserve slots
                            (`{ values: n, min }` or `{ flag: true }`), resolve() packs them (flags from the top,
                            value slots from the bottom, shrinking the ones with `min` when bits run out) and refs
                            are composed from slots, never written as literals. buildPipelines: render pipelines as
                            a table of descriptors whose stencil names slots (`{ test, op, write }`), with variants
                            (portal's stencil / plain, gui's stencil / depth). RenderExtensions: register(kind,
                            factory) adds to every renderer of that kind what it draws besides its own (stencil
                            slots, resources, pipelines, commands) without touching it: portal's renderer takes
                            them (its GUI screens pass is one: render/gui-pass.js)
    gui/                    the Doom 3-style GUI toolkit (an engine kit: the handheld uses it): math, world
                            materials, meshes and GUI surfaces, WGSL, the Renderer (views, render targets, scene
                            passes; GUI surfaces reserve its "gui.surface" stencil slot), the font atlas, GuiModel +
                            DeviceContext, EntityGUI, InteractionSystem (aiming at and using EntityGUIs, for any
                            feature: gui's facility, portal's screens), PhoneGUI + PhoneApp, the paint easel
                            (EaselGUI over a PaintCanvas), and the media systems: ViewTarget + the scene contract
                            (a world renders a view of itself: renderView(enc, target, shot)), CctvSystem (security
                            cameras), PhoneCamera + MediaLibrary (viewfinder, photos, video), IptvPlayer, their phone
                            apps (camera, photos, viewer, IPTV) and mediaApps / mediaPages for the handheld. gui's
                            facility and portal's island both implement the scene contract. An EntityGUI only needs a
                            device from its host; the kit's Renderer draws it with its own stencil value, another
                            feature's renderer its own way (portal's: a one-value "gui.surface" mask per screen)
    view/                   FirstPersonView: a first-person eye with options (turn direction, look sensitivity, pitch
                            limit, keys, boost / slow, wheel speed, ground clearance): the engine's fly camera, the
                            cloud / water / imposter cameras and the portal / gui players' views
    world/                  what every world has: the Entity base and addEntity (a scenario def -> its feature's
                            ENTITY_TYPES class, registered and spawned: every world builds its entities with it),
                            WorldHud (toasts, in-world labels, the readout), Menu and Pages (handheld options and
                            status), FeatureWorld (the host's interface)
    entities/               the entity kinds several features have, each with the union of their options, over a
                            feature's own entity base (securityCamera(Base), door(Base) mixins): security cameras
                            (pan sweep / speed / phase; portal, gui), doors (open / target / speed, auto with radius
                            and delay, locked, toggle / setOpen / status; portal, gui), LightSource (signal flicker /
                            pulse, roomLights, door dimming, alarmColor, size; portal's lights, gui's light), spinAngle
                            (prop spin in rpm or deg/s; origin, imposter), drone(Base) (a `center` + `radius` patrol
                            loop or wandering a route its feature plans, waiting at closed gates; bob, facing, pingEvery,
                            a riding `light` with ahead / drop; portal, gui). A new option goes here, not in a feature.
                            The rest of the feature entity classes, as factories over a feature's base, drawn
                            through the world's meshes (the mesh kit's interface): spaceTypes (SpaceEntity: bodies, props, fields, orbiters;
                            origin), groundProps (props, comparisons, scatters on a ground; imposter), sectorTypes
                            (SectorEntity: members, props + GUI screens, lamps, stairs, hulls, helms, doors, drones,
                            cameras; portal), fixtureTypes (FixtureEntity: models, sliding doors, swinging lamps,
                            beacons, lights, drones, cameras, avatar, terminals, easels; gui), spinQuat
    mesh/                   the common mesh interface every world offers its entities as `world.meshes` (builder,
                            add, part, bounds, split, instance, rotation, color; material references by name or
                            { color, kind, ...flags }), each feature implementing it over its own renderer, so no
                            kit's entity type needs one; MeshBuilder (the reference builder: portal's), splitMesh,
                            worldBounds, g2 (2D polygons), newell, AXES, the structures' PALETTE
    terrain/                Heightfield (grid, sampling, normals, raycast, wet() land use), floodFill, TerrainEntity
                            (every terrain world's entity base, with all their hooks), terrainTypes: the stamps
                            (tilt, hills, mountain, range, lake, clearing), channels (river, valley, basin, coast,
                            dam) and land use (town, forest) of cloud and water; meshTerrain (imposter's ground)
    hydrology/              what adds water to a water simulation: sea, springs and drains, rain, debris (water)
    weather/                storm cells, supercells (+ tornadoes), squall lines, spawners, HURRICANE / TORNADO (cloud)
    settlement/             villages and bus stations laid out on the terrain into a world's structures, and the
                            colours structures are built in (cloud)
    interior/               what every building and vehicle has by default: an Interior = Origin (its rigid local
                            frame; a vehicle's is its live pose) + VisArea (a box with door / window portals, folded
                            into at most six wall apertures for culling) + weather shelter; GridHash and InteriorIndex
                            find them in O(1) (at, sheltered) and cull them by range + portals (seen). Cloud's
                            buildings and bus cabins, portal's areas (their areaAt), the gui facility; the host
                            keeps an atmosphere world's rain off the camera inside any shown world's interior
    transit/                paths (roundPath, offsetLine, SplineRoute), TransitLine + LineVehicle: vehicles running
                            a closed route (PolylineRoute, SplineRoute) on a timetable with stops, dwell, doors,
                            braking, speed limits and headways: cloud's buses, and portal's ship when on autopilot;
                            a LineVehicle's `cabin` spec is its Interior. busTypes (Bus + BusLine, BUS dimensions,
                            liveries; cloud) and shipType (the steerable freighter carrying its areas; portal)
js/features/<feature>/      each original engine, split into parts with one responsibility each (config, shaders,
                            entities, world, renderer, HUD, app...), loaded in the order of Features.PARTS
                            (Features.part, over js/engine/common.js and its kits); only what is that feature's own
                            lives here (the bus's body and lights on a LineVehicle, the cloud's land use on the
                            Heightfield...). phone-pages.js builds the world's handheld pages, and feature.js extends
                            FeatureWorld (createApp, depth, stats, set, anchor, handheld)
scenarios/*.json            the scenarios (index.json and embedded.js are generated)
scenarios/gui/*.json        each scenario's GUIs (screens, their apps' settings, the handheld's pages), included by it ({ "type": "include", "scenario": "gui/<id>" })
tools/embed-scenarios.mjs   catalog + embedded copy
tools/import-native.mjs     import a scenario of the original demos
docs/features/*.md          the original demos' READMEs
```

Every push to `main` regenerates the catalog and deploys the page to GitHub Pages (`.github/workflows/pages.yml`; this
needs **Settings → Pages → Source: GitHub Actions** turned on once for the repository).
