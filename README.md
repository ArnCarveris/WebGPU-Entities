# WebGPU Entities

The six WebGPU-Entity demos in one page, where everything is an entity and every scenario is data:

| World | From | What it renders |
|---|---|---|
| **cloud** | [WebGPU-EntityCloud](https://github.com/ArnCarveris/WebGPU-EntityCloud) | volumetric clouds and a weather system: storm cells, rain and snow shafts, lightning, buildings and buses that keep the rain off |
| **water** | [WebGPU-EntityWater](https://github.com/ArnCarveris/WebGPU-EntityWater) | a GPU shallow-water river simulation with wave cascades, debris and screen-space water |
| **origin** | [WebGPU-EntityOrigin](https://github.com/ArnCarveris/WebGPU-EntityOrigin) | a floating origin with O(1) rebasing over a real-scale solar system |
| **imposter** | [WebGPU-EntityImposter](https://github.com/ArnCarveris/WebGPU-EntityImposter) | octahedral imposters with light-agnostic atlases, GPU LOD and cascaded shadows |
| **portal** | [WebGPU-EntityPortal](https://github.com/ArnCarveris/WebGPU-EntityPortal) | Portal-Room visibility (Far Cry 1 VisArea / SECTR), stencil-masked traversal, an island with a ship |
| **gui** | [WebGPU-EntityGUI](https://github.com/ArnCarveris/WebGPU-EntityGUI) | Doom 3-style world-space GUIs: an airlock terminal with CCTV, an easel, a handheld phone |

The scenario picker (top right) lists every original demo's scenario, rendered by its own engine as before, and
**compositions**: several worlds, one camera, one picture.

| Scenario | Worlds |
|---|---|
| Storm over Riverlands | cloud (atmosphere) + water: the river map on the plains, rain over the camera turns on the river's rain |
| Imposter Valley weather | cloud (atmosphere) + imposter: the valley's forests under the plains' clouds and sun |
| Bunker on the Reservoir | cloud (atmosphere) + portal: the bunker island in a lake; indoors, the rain stays out |
| Planetfall | origin + imposter: the valley on the real-scale Earth, flown to from orbit; the valley's sun is the Sun |
| Sector 07 on the Moon | origin + gui: the GUI facility at Shackleton Base; <kbd>`</kbd> hands the camera to its player inside |
| Grand tour of the plains | cloud (atmosphere) + water + imposter + portal, with the engine's free camera and viewpoints |
| High Plains · Riverlands · Sol Transit · Imposter Valley · Bunker compound · Sector 07 | each original demo on its own |
| Oʻahu | cloud: the real island at 1:1, its heights, mapped roads and buildings ([real places](docs/geo.md)) |

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
original demos (its world is recognised from its keys). Models (`.glb`, `.gltf`, `.obj`) dropped on the page go to the
focused world (the imposter baker).

Opened from disk, browsers block `fetch()`, so the page reads the embedded copy of every scenario
(`scenarios/embedded.js`). The `.json` files are the source of truth; after adding or editing one, regenerate the catalog
and the copy (the Pages workflow does this too):

```bash
node tools/embed-scenarios.mjs
```

A scenario of a real place (Oʻahu) reads its heights, roads and buildings from data under `scenarios/data/`, made by
`node tools/geo-import.mjs <region>` from public elevation tiles and an OpenStreetMap extract: see
[docs/geo.md](docs/geo.md).

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

- **A world** is a root entity of a world type (`cloud`, `water`, `origin`, `imposter`, `portal`, `gui`: the kits'
  worlds), with an `id` (default: its type), a `label`, `layer` settings for compositions and `features` (below).
- **Everything that world is made of** is an entity of a plain type: terrain stamps, lakes, storm cells, bodies, props,
  areas and portals, materials, models, lighting presets, views, tools, config blocks (`light`, `building`, `mountain`,
  `door`...). Types are the kits', not the worlds': every one is listed in the kit manifest (`js/kits/manifest.js`)
  under the kit that implements it (an entity type) or reads it (a data type). A world takes the entity types whose
  implementation stands on an entity base it has and needs nothing it lacks (cloud: `terrain` entities that may need
  `structures` or `weather`; water: `terrain` ones that may need `water`; portal: `sector`; gui: `fixture`...), and
  the data types of its schema. An entity belongs to the world named by `of`, else to the only world of the scenario
  that takes its type: in a composition of a sky and a river, `{ "type": "lake", "of": "sky" }` (both take `lake`). An
  included world's entities get its `of`. `camera` and `view` are the engine's unless they have `of`:
  `{ "type": "camera", "of": "imposter", "fov": 60 }` is that world's camera block.
- **Any kit's entity works in any scenario.** An entity no world of the scenario takes brings in a world that does,
  composed with the others as the manifest says it joins (`implicit`): a `storm` in the bunker scenario puts a cloud
  sky over it (as its atmosphere, on a plain at sea level), a list of `hills` and `spring`s with no root at all is a
  water world.
- **The engine's own entities** are plain types: `camera`, `view`, `link`, `include`, `handheld`, `handheld.page`,
  `hud.toast`, `sound.*`.

Each world still reads its own layout (materials as a map, views as a list...). Its schema (the manifest's
`worlds.<type>.schema`) maps its entities onto that layout and back, without per-world code
(`js/engine/scenario-format.js`):

| World | config blocks (one entity each) | maps (one entity per key, the key as `id`) | lists (one entity per item) | entity bases (its entity types) |
|---|---|---|---|---|
| cloud | terrain render weather lighting hurricane streetLights curvature | weatherState light building + plans | cloudLayer view | terrain + structures, weather: clearing tilt hills mountain range river lake valley basin coast dam town forest village busStation skyscraper structure bus storm supercell squall spawner geo* place |
| water | terrain sim waves waterShading lighting | light | tool view | terrain + water: tilt hills mountain range river lake valley basin coast dam town forest clearing sea spring drain rain debris |
| origin | start camera floatingOrigin lighting | material model | bookmark | space: body prop field orbiter |
| imposter | camera environment lod shadows imposterAtlas drop | light material model | view | ground: terrain prop compare scatter |
| portal | camera player minimap outdoor cctv media iptv | material model building + plans | area visPortal occluder vehicle view structure | sector: securityCamera prop light stairs hull helm door drone |
| gui | player facility cctv media iptv waves radar places phone | material model | view | fixture: static door lamp alarmBeacon light drone securityCamera avatar terminal easel |

A block whose native key is taken by a world's name gets another type (water's `water` block is `waterShading`,
origin's `origin` `floatingOrigin`, imposter's `imposter` `imposterAtlas`, portal's `portals` list `visPortal`); a
type the manifest does not list is an error, and so is a `<world>.<kind>` type left from before (it says the type to
write instead). An item's own `type` field is kept under the name
of its slot (`{ "type": "tool", "tool": "pour" }`). The per-world references (every key, every entity type, how
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

| World | stats | `link` parameters | events |
|---|---|---|---|
| cloud | weather light rain snow inside sheltered inBus walking wind agl busDist busSpeed riding temperature coverage cells flashes veil time fps | weather light paused quality timeScale indoors radar | thunder door busDoor step weather |
| water | volume wet maxSpeed inflow boost rain breached settling light mode tool acting height debris steps fps | rain boost paused light breach | toggle breach reset tool |
| origin | speed fromZero body altitude near rebases reason scale translate rotate scaling everyFrame instances draws density sunAt fps | paused translate rotate scale everyFrame labels | rebase jump toggle |
| imposter | loading baking bakes lod lodDistance shadows light instances meshes imposters height fps | light lod shadows sunDir | toggle relight baked |
| portal | area outdoor onShip state swimming driving culling mode draws tris shipSpeed shipDist drones fps | any of its options (culling walk map help...) | door step |
| gui | lightsOn alarm phone moving running noise gui sound fps | lights alarm phone | door step shutter chime easel delete hover miss press granted denied cctv alarm (the handheld: `handheld.shown` `handheld.tap`) |

The sounds the original demos synthesised in code are now data: the weather's beds and thunder (cloud), the GUI's
beeps and footsteps, plus new ambience for every world.

## Kits, worlds and features

Nothing about a world is hardcoded in the engine: the kit manifest (`js/kits/manifest.js`, one plain script) is the
only list of kits, entity types, data types and worlds, and everything else is loaded from it on demand.

- **A kit** (`js/kits/<kit>/`) is a folder of parts with one responsibility each, the kits it builds on (`uses`), the
  entity types it implements (factories over a world's entity base: `terrainTypes(Base)` makes tilt, hills...) and
  the data types it reads. A kit loads only when something in the scenario needs it: a world built on it, an entity
  of one of its types, a data type it reads (`cctv` loads the media kit), or an entity type that names it (an
  `easel`: the paint kit). The engine's own (noise, view, gpu, gui) load at boot for the handheld.
- **A world** is offered by a kit (`worlds`), parts under `js/kits/<kit>/worlds/<type>/`: the water world is the
  hydrology kit's, the portal the interior kit's, the gui world the gui kit's, origin the entities kit's, imposter the
  imposter kit's, cloud the atmosphere kit's. Its entity classes are made from the manifest when first used
  (`kits.world.entityTypes`), over its bases: no world lists its types. It is composed, not derived: a world part
  returns `{ create: fx => new FeatureWorld(fx, spec) }`, the spec its HUD, its app and whichever of the host's hooks it
  has (depth, stats, views, ground, sheltered, set...) over the defaults.
- **A feature** is what a world is made of beyond its core, built only when the world's data asks for it (`when`: an
  entity of a type, an entity whose implementation needs something, a data path, through a list in any of its items
  (`entities.screen`), another feature; `requires`), its
  parts under `features/<name>/` of its kit (or of its world, over the world's own exports). The root entity's
  `features: { <name>: true | false }` turns one on or off whatever the data says. A feature plugs into the world's
  parts as extensions (its World, App and Renderer: hooks they call in the features' order):

  | World | Feature | On with |
  |---|---|---|
  | cloud | `curvature` | a `curvature` entity: the outdoors drawn on a round planet (else flat) |
  | | `structures` | an entity that builds (village, station, skyscraper, structure, a real place's roads and buildings, a bus line), `building` archetypes, plans or street lights: buildings with interiors, lifts and doors, roads, lamps, distant lights, sun and rain shadows, world-space GUIs (settlement and building kits) |
  | | `vegetation` | `terrain.vegetation`: plants, meshes near, octahedral imposters further, the canopy carpet (imposter kit) |
  | | `buses` | a `bus` entity: drawn, boarded, ridden and driven, their lights and sounds (requires structures; transit kit) |
  | water | `waves` | the scenario's `waves`: wave cascades following the camera, with foam |
  | | `debris` | `debris` entities: floating logs on the GPU |
  | portal | `screens` | a prop with a `screen`: world-space GUIs on consoles, generators and the bridge, their pass in the portal renderer, the cursor on them |
  | | `media` | a `securityCamera`, or the scenario's `cctv`, `media` or `iptv`: CCTV, the phone camera, IPTV (requires screens; media kit) |
  | | `vehicles` | the scenario's `vehicles`: the freighter on its route, boarded and steered, its route on the map |
  | | `lightTransport` | the scenario's `portals`: lamps of neighbouring areas and the sun shining in through doors, windows and hatches |
  | | `drones` | a `drone` entity: the navigation graph over areas and portals they fly, the drones on the map |
  | gui | `paint` | an `easel` entity: paint canvases stamped on the GPU before the frame (paint kit) |
  | | `radar` | the scenario's `waves` or `radar`: the waves of footsteps, doors, drones and the alarm, the phone's radar app |
  | | `media` | a `securityCamera`, or the scenario's `cctv`, `media` or `iptv`: CCTV, the phone camera and gallery, IPTV (media kit) |
  | imposter | `shadows` | the scenario's `shadows`: four cascades of sun shadows, meshes and imposters drawn into a depth array, PCF |

  A cloud world of terrain and weather alone loads 9 kits; with Oʻahu's buildings, roads, buses and plants, 16.
- **Shaders are composed too.** A renderer builds every module from a library of named WGSL chunks (the gpu kit's
  `WgslLibrary`): its core defines its own and, for what a feature brings, a neutral stub of the functions the core
  calls (`structureLight`, `lightSeen`, `rainReaches`, `curveToRender`, `waves`, the portal's `throughLight`, the
  imposter's `shadowAt` and `castShadows`...); a feature on in the world
  replaces the stubs with its code and adds the chunks that draw it, so a world compiles only the code of what it has.
  The atmosphere's frame uniform is composed the same way (a feature's fields after the core's). A GUI renderer's
  shadings come from the kits that use them (`GuiShadings`: the media kit's CCTV and video), built when a material of
  theirs first registers there, the handheld's included.

## Composition

Every world renders its finished frame with the same camera, as it would alone (its own lighting, tonemapping, MSAA),
into a layer texture; `js/engine/compositor.js` turns each world's depth buffer, whatever its convention (reversed-Z with
an infinite far plane, classic 0..1 with a far plane, multisampled, depth-stencil), into view depth in metres and takes
the nearest world per pixel. Where a world draws only sky, the others show through.

A world with `layer.role: "atmosphere"` (cloud) does not take part in the merge: the merged picture and its depth go into
its scene before its volumetrics (`Renderer.encodeInject` in `js/kits/atmosphere/renderer.js`: depth as reversed-Z, colour back to
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
index.html                  the page: canvas, the worlds' HUD root (labels, toasts), the corner chip
css/entities.css            shell, chip and toasts, what the worlds still draw on the screen (.fhud[data-world])
js/engine/
    host.js                 boot, GPU device, worlds (each with the kits and features its data asks for), the frame,
                            links
    common.js               small helpers everything shares (scalars, v3 / quat / m4, frustum planes, polylines,
                            buffers and bind groups, number formats, pointer input)
    scenario-format.js      the worlds' schemas (from the manifest), entities <-> each world's native scenario,
                            routing (worldOf), implicit worlds (complete), the kits and features a world needs
                            (kitsOf, featuresOf), includes
    scenario-data.js        ScenarioData: binary data an entity names (`data`), loaded as scripts before the worlds
    features.js             the loader: kits (Features.kit), worlds (Features.world), features (Features.feature) as
                            the manifest describes them, on demand, as <script>s
    compositor.js           depth linearize + nearest-wins merge, the atmosphere's inject target
    camera.js               composition transforms, the engine's fly camera
    input.js                input routing between worlds
    hud.js                  the corner chip, toasts (and the pickers, when the page could not start)
    handheld.js             the engine's handheld (handheld, handheld.page): every option and readout, in every
                            scenario; worlds offer theirs through handheld()
    audio.js                sound.* entities (WebAudio synthesis)
    expr.js                 the expression language
    gpu-choice.js           GPU adapter choice
js/kits/manifest.js         Kits: every kit (its parts, uses, entity types by factory, data types, worlds with their
                            schemas, features), engine types; implsIn / kitsFor / featuresOf / featureOf. A plain
                            script the scenario format reads first (and node tools)
js/kits/<kit>/              a kit's parts (Features.kit); its exports are engine.kits.<kit> (Features.kits).
    <kit>/worlds/<type>/    a world it offers (Features.world): its parts over the kit's exports; the last,
                            feature.js, returns { create }. phone-pages.js builds its handheld pages
    <kit>/features/<name>/  a feature of its worlds (Features.feature('<kit>/<name>')); a world's own under
                            worlds/<type>/features/<name>/
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
                            slots, resources, pipelines, commands) without touching it, and for(kind, features) adds
                            those of the features on in a world (extensionsOf: a feature's extensions[role]):
                            portal's renderer takes them (its GUI screens pass is one: the screens feature's gui-pass.js).
                            WgslLibrary: shaders as named chunks with their needs, a feature's over the core's stubs.
                            Half floats (toHalf / fromHalf) and GpuProfiler (GPU time per pass from timestamp queries)
    imposter/               octahedral imposters for any renderer: ImposterBaker bakes a source (any mesh it can
                            draw; meshSource for the standard mesh, bakeVertexAO) into a light-agnostic G-buffer
                            ImposterAtlas; imposterWGSL (billboard, frame selection, reconstruction with parallax)
                            and drawImposters draw instances from it; LodLists + lodListsWGSL cull instances into
                            mesh / imposter lists feeding indirect draws (docs/imposter.md). worlds/imposter: the
                            imposter valley
    gui/                    the Doom 3-style GUI toolkit (an engine kit: the handheld uses it): math, world
                            materials, meshes and GUI surfaces, WGSL, the Renderer (views, render targets, scene
                            passes; GUI surfaces reserve its "gui.surface" stencil slot), the font atlas, GuiModel +
                            DeviceContext, EntityGUI, InteractionSystem (aiming at and using EntityGUIs, for any
                            world: gui's facility, portal's screens), WorldGuiPass and GuiTargets (world-space GUIs
                            in another renderer, or their render-target fallback), PhoneGUI + PhoneApp. An EntityGUI
                            only needs a device from its host; the kit's Renderer draws it with its own stencil
                            value, another world's renderer its own way (portal's: a one-value "gui.surface" mask
                            per screen). worlds/gui: the facility (Sector 07)
    media/                  a world's media, loaded where its data or a security camera asks: ViewTarget + the scene
                            contract (a world renders a view of itself: renderView(enc, target, shot)), CctvSystem
                            (security cameras), PhoneCamera + MediaLibrary (viewfinder, photos, video), IptvPlayer,
                            their phone apps (camera, photos, viewer, IPTV) and mediaApps / mediaPages for the
                            handheld. gui's facility and portal's island both implement the scene contract
    paint/                  paint canvases (stamped on the GPU) and the easel GUI over them, loaded with an easel
    view/                   FirstPersonView: a first-person eye with options (turn direction, look sensitivity, pitch
                            limit, keys, boost / slow, wheel speed, ground clearance): the engine's fly camera, the
                            cloud / water / imposter cameras and the portal / gui players' views
    world/                  what every world has: the Entity base, entityTypes (a world's classes from the manifest,
                            made on first use) and addEntity (a scenario def -> its class, registered and spawned:
                            every world builds its entities with it), WorldHud (toasts, in-world labels, the
                            readout), Menu and Pages (handheld options and status), FeatureWorld (the host's
                            interface: defaults composed with a world's spec)
    entities/               the entity kinds several worlds have, each with the union of their options, over a
                            world's own entity base (securityCamera(Base), door(Base) mixins): security cameras
                            (pan sweep / speed / phase; portal, gui), doors (open / target / speed, auto with radius
                            and delay, locked, toggle / setOpen / status; portal, gui), LightSource (signal flicker /
                            pulse, roomLights, door dimming, alarmColor, size; portal's lights, gui's light), spinAngle
                            (prop spin in rpm or deg/s; origin, imposter), drone(Base) (a `center` + `radius` patrol
                            loop or wandering a route its world plans, waiting at closed gates; bob, facing, pingEvery,
                            a riding `light` with ahead / drop; portal, gui). A new option goes here, not in a world.
                            The rest of the worlds' entity classes, as factories over a world's base, drawn
                            through the world's meshes (the mesh kit's interface): spaceTypes (SpaceEntity: bodies, props, fields, orbiters;
                            origin), groundProps (props, comparisons, scatters on a ground; imposter), sectorTypes
                            (SectorEntity: members, props + GUI screens, lamps, stairs, hulls, helms, doors, drones,
                            cameras; portal), fixtureTypes (FixtureEntity: models, sliding doors, swinging lamps,
                            beacons, lights, drones, cameras, avatar, terminals, easels; gui), spinQuat.
                            worlds/origin: Sol Transit, the floating-origin solar system
    mesh/                   the common mesh interface every world offers its entities as `world.meshes` (builder,
                            add, part, bounds, split, instance, rotation, color; material references by name or
                            { color, kind, ...flags }), each world implementing it over its own renderer, so no
                            kit's entity type needs one; MeshBuilder (the reference builder: portal's), splitMesh,
                            worldBounds, g2 (2D polygons), newell, AXES, the structures' PALETTE; TiledMesh (big
                            static geometry as compact indexed tiles, drawn by the tiles in view: Structures.bulk)
    geo/                    a real place from data (tools/geo-import.mjs): geoTerrain (heights, land cover),
                            geoRoads (ribbons with rounded curves, bridges on piers, markings), geoBuildings
                            (footprints stood up, flat or hipped roofs, walls as Solids), geoPlaces (place labels)
    terrain/                Heightfield (grid, sampling, normals, raycast, wet() land use), floodFill, TerrainEntity
                            (every terrain world's entity base, with all their hooks), terrainTypes: the stamps
                            (tilt, hills, mountain, range, lake, clearing), channels (river, valley, basin, coast,
                            dam) and land use (town, forest); meshTerrain (imposter's ground); LandField (a
                            Heightfield with a land-use map and the surface as its mesh draws it; cloud)
    hydrology/              what adds water to a water simulation: sea, springs and drains, rain, debris.
                            worlds/water: Riverlands, the shallow-water simulation (features: waves, debris)
    weather/                storm cells, supercells (+ tornadoes), squall lines, spawners, HURRICANE / TORNADO; the
                            weather state (WeatherSystem: named states blending, RainZones, CloudLayers, Sky: sun,
                            moon and sky colours), Lightning (flashes and bolts), the defaults and limits (cloud)
    settlement/             villages and bus stations laid out on the terrain into a world's structures, and the
                            structures themselves (structures/: Structures and its parts: Solids a walker collides
                            with, ShelterBoxes keeping rain off, Doors, Buildings (plain and planned, with interiors,
                            lifts and ladders), Fixtures (lamps, LAMPS), their GPU record sizes and flags; cloud)
    interior/               what every building and vehicle has by default: an Interior = Origin (its rigid local
                            frame; a vehicle's is its live pose) + VisArea (a box with door / window portals, folded
                            into at most six wall apertures for culling) + weather shelter; GridHash and InteriorIndex
                            find them in O(1) (at, sheltered) and cull them by range + portals (seen). Cloud's
                            buildings and bus cabins, portal's areas (their areaAt), the gui facility; the host
                            keeps an atmosphere world's rain off the camera inside any shown world's interior.
                            worlds/portal: the bunker compound (portal-room visibility, stencil-masked traversal)
    transit/                paths (roundPath, offsetLine, SplineRoute), TransitLine + LineVehicle: vehicles running
                            a closed route (PolylineRoute, SplineRoute) on a timetable with stops, dwell, doors,
                            braking, speed limits and headways: cloud's buses, and portal's ship when on autopilot;
                            a LineVehicle's `cabin` spec is its Interior. busTypes (Bus + BusLine, BUS dimensions,
                            liveries; cloud), shipType (the steerable freighter carrying its areas; portal), lifts,
                            DriveControl (at the wheel of a bus)
    atmosphere/             the volumetric atmosphere over a terrain: its core (limits, quality presets, bindings, the
                            WGSL library, the weather map, cloud shadow, ground state, froxels, the ray march, scene,
                            final composite; the passes, the Renderer, World, App, the walker, lights, frame
                            uniform) with the hooks its features plug into; features/ curvature, structures,
                            vegetation, buses; worlds/cloud: the cloud world (its entity types over its
                            TerrainEntity base, Storms, Clouds, atmosphereWorld(cloud))
scenarios/*.json            the scenarios (index.json and embedded.js are generated)
scenarios/gui/*.json        each scenario's GUIs (screens, their apps' settings, the handheld's pages), included by it ({ "type": "include", "scenario": "gui/<id>" })
scenarios/data/<region>/    a real place's data (generated by tools/geo-import.mjs; ScenarioData)
tools/embed-scenarios.mjs   catalog + embedded copy
tools/geo-import.mjs        import a real place (tools/geo-regions.json): heights, land cover, roads, buildings, places
tools/import-native.mjs     import a scenario of the original demos
docs/features/*.md          the original demos' READMEs
```

Every push to `main` regenerates the catalog and deploys the page to GitHub Pages (`.github/workflows/pages.yml`; this
needs **Settings → Pages → Source: GitHub Actions** turned on once for the repository).
