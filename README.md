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
<kbd>`</kbd>), viewpoint, sound, GPU.

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
        { "type": "water.terrain", "size": 2048, "resolution": 512, "base": 80 },
        { "type": "water.mountain", "label": "Stormhorn", "pos": [-560, -820], "radius": 520, "height": 270 },
        { "type": "water.spring", "label": "West spring", "pos": [-470, -700], "rate": 40, "radius": 18 },
        { "type": "water.light", "id": "day", "sun": { "azimuth": 150, "elevation": 38 } },
        { "type": "water.tool", "tool": "pour", "key": "1", "rate": 40 },
        { "type": "water.view", "name": "Overview", "pos": [-820, 420, 1020], "look": [60, 40, -60] },
        { "type": "handheld.page", "id": "controls", "of": "water", "title": "Controls", "nav": { "section": "CONTROLS" },
          "sections": [{ "header": "MOVE", "cells": [{ "type": "label", "title": "Look", "value": "drag" }] }] },
        { "type": "sound.bed", "source": "white", "filters": [["bandpass", 900, 0.6]], "gain": "0.3 * clamp(water.maxSpeed / 8)" },
        { "type": "sound.cue", "on": "breach", "parts": [{ "shot": { "source": "brown", "freq": 140, "env": [[0.1, 1.2], [6, 0]] } }] }
    ]
}
```

- **A world** is a root entity whose type is a feature (`cloud`, `water`, `origin`, `imposter`, `portal`, `gui`), with an
  `id` (default: the feature's name), a `label`, and `layer` settings for compositions.
- **Everything that world is made of** is an entity of type `<feature>.<kind>`: terrain stamps, lakes, storm cells,
  bodies, props, areas and portals, materials, models, lighting presets, views, tools, config blocks. With several
  worlds of one feature in a scenario, `of` names the world an entity belongs to.
- **The engine's own entities** are plain types: `camera`, `view`, `link`, `include`, `handheld`, `handheld.page`,
  `hud.toast`, `sound.*`.

Each feature's engine still reads its own layout (materials as a map, views as a list...). `js/engine/scenario-format.js`
holds a schema per feature that maps its entities onto that layout and back, without per-feature code:

| Feature | config blocks (one entity each) | maps (one entity per key, the key as `id`) | lists (one entity per item) |
|---|---|---|---|
| cloud | terrain render weather lighting hurricane streetLights | weatherState light building | cloudLayer view |
| water | terrain sim waves water lighting | light | tool view |
| origin | start camera origin lighting | material model | bookmark |
| imposter | camera environment lod shadows imposter drop | light material model | |
| portal | camera player minimap outdoor | material model | area portal occluder vehicle |
| gui | player facility cctv media iptv waves radar places phone | material model | |

Every other `<feature>.<kind>` is one of that feature's own entity types (`cloud.supercell`, `water.dam`,
`origin.orbiter`, `imposter.scatter`, `portal.door`, `gui.terminal`...). An item's own `type` field is kept under the name
of its slot (`{ "type": "water.tool", "tool": "pour" }`). The per-feature references (every key, every entity type, how
the engines work) are the original READMEs, in [docs/features](docs/features).

`tools/import-native.mjs` converts a scenario made for one of the original demos (a `.json`, an `index.html` with a
`<script id="scenario">`, or the GUI demo's `js/scenario.js`) and checks that it converts back to the same data.

### Engine entities

| Type | Fields | |
|---|---|---|
| `camera` | `from: "<world>"` or `["a", "b"]`, `carry` · or `controller: "fly"`, `pos`, `look`, `fov`, `speed` | which world's camera drives the others, or the engine's free camera (WASD, drag, wheel, Space / C) |
| `view` | `name`, `pos`, `look`, `fov` | a viewpoint in composition space, picked on the handheld |
| `link` | `to: "<world>.<param>"`, `value: expr` | sets a world's parameter from an expression every frame (when it changes) |
| `include` | `scenario`, `as`, `skip`, `only`, `root` | splices another scenario's entities: `as` renames its world (and its name in expressions), `skip` / `only` filter by type (`"cloud.view"`, `"sound.*"`), `root` merges fields into its root |
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

What makes a composition fit is more data: `cloud.clearing` (a new cloud entity) levels the plains under another
world's footprint (`inset`: inside it, so the terrain meets the other world's edge at its own height); extra lighting
presets match the other worlds' suns to the sky's; links carry state across (`sky.rain > 0.05` → `river.rain`,
`!bunker.outdoor` → `sky.indoors`, `sol.sunAt['valley-site']` → `valley.sunDir`).

## Layout

```
index.html                  the page: canvas, the feature HUD root (labels, toasts), the corner chip
css/entities.css            shell, chip and toasts, what the features still draw on the screen (.fhud[data-feature])
js/engine/
    host.js                 boot, GPU device, worlds, the frame, links
    common.js               helpers the features share (scalars, v3 / m4, noise, polylines, buffers, toasts, labels)
    scenario-format.js      schemas, entities <-> each feature's native scenario, includes
    features.js             feature registry and on-demand script loading
    compositor.js           depth linearize + nearest-wins merge, the atmosphere's inject target
    camera.js               composition transforms, the engine's fly camera
    input.js                input routing between worlds
    hud.js                  the corner chip, toasts (and the pickers, when the page could not start)
    handheld.js             the engine's handheld (handheld, handheld.page): every option and readout, in every
                            scenario; worlds offer theirs through handheld()
    gui-kit.js              the Doom 3-style GUI toolkit (renderer, font atlas, DeviceContext, EntityGUI, PhoneGUI)
    audio.js                sound.* entities (WebAudio synthesis)
    expr.js                 the expression language
    gpu-choice.js           GPU adapter choice
js/features/<feature>/      each original engine, split into parts with one responsibility each (config, shaders,
                            entities, world, renderer, HUD, app...), loaded in the order of Features.PARTS
                            (Features.part, sharing js/engine/common.js); phone-pages.js builds the world's handheld
                            pages, and feature.js is its FeatureWorld, the host's interface (init, frame, depth,
                            view, stats, set, anchor, handheld)
scenarios/*.json            the scenarios (index.json and embedded.js are generated)
tools/embed-scenarios.mjs   catalog + embedded copy
tools/import-native.mjs     import a scenario of the original demos
docs/features/*.md          the original demos' READMEs
```

Every push to `main` regenerates the catalog and deploys the page to GitHub Pages (`.github/workflows/pages.yml`; this
needs **Settings → Pages → Source: GitHub Actions** turned on once for the repository).
