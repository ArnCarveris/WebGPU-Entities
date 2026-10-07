> **In WebGPU Entities** this is the README of the original [WebGPU-EntityPortal](https://github.com/ArnCarveris/WebGPU-EntityPortal) demo, kept as the
> feature's technical reference. Its engine now lives in [`js/features/portal/`](../../js/features/portal/) (one part per responsibility, run by the
> host in [`js/engine/host.js`](../../js/engine/host.js)), and its scenario is [`scenarios/portal-bunker-compound.json`](../../scenarios/portal-bunker-compound.json) as a list of
> entities: every native key below is an entity of type `portal.<key>` (see the main [README](../../README.md#everything-is-an-entity)).
> Paths and run instructions below refer to the original repository.

# Entity Portal // WebGPU

A Portal-Room visibility system in WebGPU, modelled on the Far Cry 1 (CryEngine 1) VisArea/Portal
system and SECTR (Sector/Portal/Occluder). The engine is a set of classes in `js/`, and the whole
world is built from a scenario `.json` file in `scenarios/`.

Open `index.html` in a WebGPU browser (Brave, Chrome, Edge), straight from disk or served over HTTP.
It loads `scenarios/bunker-compound.json` by default. To load another scenario from disk, click
**Load scenario…** (bottom right), press `L`, or drop a `.json` onto the page. Served over HTTP,
`?scenario=<url>` picks the scenario to start with.

Browsers block `fetch()` on pages opened from disk, so there the default scenario comes from
`scenarios/bunker-compound.js`, a script copy of the `.json`. The `.json` is the source of truth:
after editing it, regenerate the copy (the Pages deploy does this too):

```bash
node tools/embed-scenarios.mjs
```

Served over HTTP, the page always fetches the `.json` itself:

```bash
python -m http.server 8766
```

Every push to `main` regenerates the script copies and deploys the page, `js/` and `scenarios/` to GitHub Pages
(`.github/workflows/pages.yml`). This needs **Settings → Pages → Source: GitHub Actions** turned on
once for the repository.

## Layout

```
js/core/            config (limits, buffer layouts), math, 2D polygons, frustum / clipping
js/render/          MeshBuilder + GeometryPool, MaterialTable, WGSL shaders, Renderer,
                    FrameBuilder (visibility -> command list), DebugLines
js/vis/             QuadTree / BVHTree object trees, PortalVis (portal traversal)
js/world/           Area + PointLight, Portal + Occluder, Architecture (generated walls / roofs / frames),
                    Outdoors + Water, CollisionSet, NavGraph, Vehicle + Route, entity classes, World
js/game/            Camera + PlayerController, InputSystem, Hud, Minimap, Game (frame loop)
js/scenario-loader.js  fetch / embedded copy / pick / drop scenario files
js/main.js          entry point
scenarios/          scenario data (bunker-compound.json) + generated script copies (.js)
tools/              embed-scenarios.mjs: regenerate the script copies
```

## Scenario file

| Key | Contents |
|---|---|
| `name`, `camera` | title; start `pos`, `yaw`, `pitch` (degrees) and `fov` |
| `player` | walker tuning: `eyeHeight`, `radius`, `walkSpeed`, `runSpeed`, `stepHeight`, `jumpSpeed`, `gravity`, `climbSpeed`, `swim`, `fly`, `turnSpeed`, `mouseSensitivity`, `helm` rates. All optional |
| `minimap` | `near` / `far` spans in metres (key `N`) |
| `materials` | `albedo`, `pattern` (`flat`, `tiles`, `panels`, `noise`, `grass`, `hazard`, `planks`, `bricks`, `screen`, `rust`), `scale`, `spec`, `emissive` [r, g, b, strength] |
| `models` | lists of `box` [x, y, z, sx, sy, sz], `cyl` / `cone` [x, y, z, r, h] parts with `mat` and `seg` |
| `outdoor` | the implicit outdoor area: lighting, sky, `terrain`, `water`, `scatter` |
| `areas` | `shape`, `y`, `height`, `ambient`, `sun`, `fog`, `hub`, `materials`, `shellFrom`, `terrain`, `nav` |
| `portals` | `center`, `size`, `normal`, `kind`, flags, `glass`, optional `front` / `back` |
| `occluders` | `center`, `size`, `normal`, `autoOrient` |
| `vehicles` | `hull`, `pivot`, `route`, `waves`, handling |
| `entities` | `{ type, ... }`, where `type` maps to a class in `ENTITY_TYPES` (`js/world/entities.js`): `prop` (`solid`, `climbable`, `area`), `light`, `stairs`, `hull`, `helm`, `door`, `drone` (the shared kits.entities drone: wanders the nav graph from `pos` at `speed`, `seed`, `light` { color, intensity, radius, drop, ahead }, `bob`, `pingEvery`; a `center` + `radius` patrols a loop instead) |

### Adding a new kind of entity

1. Subclass `Entity` (static geometry or controllers) or `Member` (a dynamic chunk drawn with its own
   matrix) in `js/world/entities.js`.
2. Build its geometry in `spawn()` with `world.addStatic` / `world.pool.add`, and call
   `world.addDynamic(this)` if it needs `update(dt, t, actors)`. Resolve references to vehicles or
   other entities in `link()`.
3. Register it in `ENTITY_TYPES` and place it in the scenario's `entities`.

### GUI screens (WebGPU Entities)

The consoles, generators and bridge desks carry world-space EntityGUIs (Doom 3 style, the gui kit: [`js/kits/gui/`](../../js/kits/gui/)),
drawn in the portal renderer's own pass: a prop with `screen: { gui, ... }` puts one on its model's display face (the box part
with `face`: `+x | -x | +z | -z`, optionally `tilt`ed). The screen is a dynamic SECTR Member (riding the ship when its prop does);
FrameBuilder draws its GUI quads right after its portal entry's objects, depth-tested just in front of the glass and masked by
the entry's stencil ref, fogged through portals like the walls. Aim with the crosshair (or the free mouse) within 3 m and click.
Kinds ([`js/features/portal/gui/screens.js`](../../js/features/portal/gui/screens.js)): `facility` (map of both levels: you, the
drone, doors, power), `doors` (lock / unlock, lockdown; the drone reroutes), `harbour` (the freighter's route and departure),
`power` (a breaker per area; unpowered areas keep their emergency beacons), `generator` (`unit`: rpm, load, coolant, fuel,
start / stop), and aboard: `engine`, `navigation` (chart, waypoints, ETA), `helm` (rudder, telegraph, heel and trim).
The island's power is [`world/power.js`](../../js/features/portal/world/power.js).

The screens are drawn by a render extension of the portal renderer ([`render/gui-pass.js`](../../js/features/portal/render/gui-pass.js);
`RenderExtensions` in [`js/kits/gpu/extensions.js`](../../js/kits/gpu/extensions.js)): the renderer core only draws the world,
sky, marks, water, glass and lines. Anything else that draws in its pass registers for `'portal'` the same way, from any
kit or part, with its stencil slots (reserved next to `portal.regions` and `portal.mark`, which shrink to make room),
its resources and pipelines, an `overlay(o)` command per visible object, its draw-slot `info(o)` and its `commands`.

A screen's quads are masked to its glass with the stencil layout's `gui.surface` slot (one value: the glass, drawn again,
sets it where it is seen in its entry's region, the quads draw with depth ALWAYS inside it, and the glass clears it).
When the layout has no bit left for it (other extensions took them), the pass falls back to render targets: before the
frame's pass, each screen the frame draws renders its GUI model into a texture of its own (only when the model changed,
so once however many views draw it), and its glass is drawn again showing that texture, from the world shader's own
vertex stage, so at exactly the glass's depth: no stencil, no offset, nothing to z-fight. Every view (the main one,
CCTV, the phone's camera) rebuilds the screens it sees, once per frame.

**CCTV, the phone's camera, IPTV** (the gui kit's media systems, [`game/media.js`](../../js/features/portal/game/media.js)):
`securityCamera` entities (`pos`, `target`, `sweep`, `speed`, `phase`, `label`, `name`, `loc`, `offline`; no geometry, their housings are props) feed
the `cctv` screen kind (camera list + the selected feed). `portal.cctv`, `portal.media` and `portal.iptv` tune them, and
the handheld gets Camera, Photos and IPTV pages. Every picture is a view of the island rendered by the island
(`Game.renderView`: its own portal traversal and frame into a view target, submitted before the main frame).

## Concepts

| Here | Far Cry 1 | SECTR |
|---|---|---|
| **Area**: extruded 2D shape (`shape`, `y`, `height`) with `ambient`, `sun`, `fog`; may be underground | `CVisArea` (shape points + height, ambient color, AffectedBySun) | `SECTR_Sector` |
| **Outdoors**: implicit area 0, holds every portal that has only one area on it | outdoors + exit portals | – |
| **Portal**: planar convex hull; front/back found by probing both sides | portal VisArea, connections by overlap | `SECTR_Portal` |
| portal flags `closed`, `locked`, `passThrough`, `doubleSide`, `skyOnly`; `glass` pane | `m_bDoubleSide`, `m_bSkyOnly` | `PortalFlags.Closed/Locked/PassThrough` |
| **Traversal** from the camera's area only; clip the hull by the frustum, recurse with a narrower one | `DrawVolume` / `UpdatePortalCameraPlanes` | `SECTR_CullingCamera` |
| **Occluders**: convex hulls, optional `autoOrient: "y"` | `m_lstOcclAreas` | `SECTR_Occluder` |
| **Door** (`auto` opens for nearby actors) drives its portal's Closed flag | – | `SECTR_Door` |
| **Members**: objects belong to every area their AABB overlaps | – | `SECTR_Member` |
| **Drone** routes between areas over open portals and waits at auto doors | – | `SECTR_Graph` |

## Per-frame visibility

### 1. Portal traversal

The walk starts in the camera's area. Other rooms and the outdoors are reached only through open
portals, so a closed room never touches anything outside itself. Each visited (area, frustum) pair
is an entry in a tree.

### 2. Object trees

Each entry queries only its own area's tree:

- **Outdoors** uses a loose quadtree: terrain chunks, trees, rocks and building shells.
- **Each indoor area** has its own BVH of static members, plus a per-frame list of dynamic members
  (doors, drone).

Queries carry a plane mask, so a node fully inside a plane stops testing it.

### 3. Stencil masking

The portal tree is drawn depth-first. Each child's clipped portal polygon is written into the
stencil in three steps:

1. Where the stencil holds the parent's region and depth passes, set the mark.
2. Where the mark is, write the child's region.
3. Clear the mark.

The child's objects and sky then draw with stencil EQUAL, masked to the aperture exactly.

*In WebGPU Entities* the regions and the mark are slots of the renderer's stencil layout
([`js/kits/gpu/stencil.js`](../../js/kits/gpu/stencil.js); `STENCIL` in `core/config.js`): `portal.regions`
(`{ values: 127, min: 15 }`) and `portal.mark` (a flag). Alone they resolve to the original bits 0..6 and bit 7, but no
value is written in the code: the pipelines name the slots they test and write, so if another user of the target
reserves bits, the regions shrink (down to 15 per frame; deeper entries share their parent's region) instead of
colliding.

Fog through portals: every draw carries the chain of portals it is seen through (up to 4), each with
its plane and the fog of the area in front of it. The scene shader splits the view ray at those
planes and fogs each stretch with the air it crosses, the last one with the surface's own area. This
happens in linear colour before tone mapping, like the fog on walls, so distant windows, doorways and
the cargo hold under an open hatch fade into the fog exactly like the walls around them. Glass panes
are then fogged only for their own distance. The scissor and none modes draw objects once for all
entries, so there a fog veil over each open portal (and the glass pane) approximates it.

Key `3` cycles the masking mode: stencil, scissor rects, or none.

## Architecture from data

Walls, floors, ceilings, the exterior shell and roofs are generated from the area shapes:

- Edges shared with a neighbouring area get no exterior face.
- Underground parts get no shell.
- Portal apertures are cut out (convex polygon subtraction).
- Frames are generated for portals.
- Geometry that crosses a portal is cut along the portal plane (`splitMesh`): door and window frames,
  hatch rims, props and the door panels. Each half belongs to, and is lit by, the area on its side,
  so it draws only inside that area's stencil region. Door panels are split in local space, and each
  half keeps the area its face looks into, so a sliding hatch cover still looks closed from below.
- `stairs` entities build step blocks.

### Sea, docks and the freighter

- **Coast:** `outdoor.terrain.coast` sinks the land below a shore line into a seabed. `flatten`
  rects level the ground (the quay), and `beachMat` paints sand near the water line.
- **Water:** `outdoor.water` is an animated plane with fresnel sky reflection and sun glints. It is
  drawn last in every outdoor visibility entry, masked by that entry's stencil ref. Each hull cuts
  its waterline cross-section out of the water mesh, so the sea never draws inside a ship. The hold
  floor is below sea level, and the water would otherwise cover it wherever the outdoor view reaches
  the hold. That happens when the camera crosses the hatch, and in the scissor/none modes.
- **Hull:** a `hull` entity extrudes a ship from its deck outline. The sides taper to the keel, with
  an antifouling band below the paint line and a bulwark with gaps. The deck is the outline minus
  the roofs of the interior areas under it.
- **Ship interiors:** these are ordinary areas with `shellFrom` (no outer walls below the deck),
  `terrain: false` and `nav: false`: an Engine Room and Cargo Hold below deck, and a Crew Deck and
  Bridge in the superstructure. They connect through `style: "ship"` automatic doors and hatches.
  The large cargo hatch cover uses `slide` and `lift`.
- **Gangway:** `stairs` with `open` treads and `rails`, tagged `vehicle` and `dockedOnly`, so it is only
  there while the ship is at the quay.

### The freighter voyage (`vehicles`)

A vehicle is a moving group of areas, portals, objects and lights. Everything inside the hull
outline (or tagged with `vehicle`) is authored at the docked pose, and that pose is the vehicle's
local space.

Each frame one transform carries the vehicle along a closed Catmull-Rom `route`, evaluated on the
spline itself. The hull yaws toward the tangent through a critically damped spring (`yawResponse`),
so turns start and end without jolts. The ship accelerates, cruises, brakes to rest exactly on the
dock mark and waits there. On top of that come heel from steering (the ship leans out of the turn)
and pitch, roll and heave from the waves. The waves ease down to calm while docked.

The vehicle's areas keep their BVHs in vehicle space. Visibility queries transform the frustum
planes into that space instead of moving trees. Portals, lights, doors and the waterline hole in
the sea are placed in world space every frame. The island falls off into the sea at the terrain
extent (`terrain.island`).

### Taking the helm (`helm` entity)

Press `F` at the ship's wheel on the bridge to take control. `W`/`S` move the throttle lever from
half astern to full ahead, `A`/`D` turn the wheel (the rudder self-centres), `X` stops the engines,
`Space` centres the rudder and `F` leaves.

- **Handling:** the rudder only bites with water flowing past it, so turn rate scales with speed and
  reverses astern. The ship heels out of turns.
- **Collisions:** the hull is checked against the seabed along its keel line and against structures
  below deck height (the quay) along its deck line. A turn that would swing the stern into the quay
  goes straight instead; a collision ahead bumps the ship to a stop.
- **Helm animation:** the spoked wheel turns with the rudder and the lever follows the throttle.
  Both are dynamic members riding the ship, and they also move on autopilot.
- **Camera:** while you drive, it is locked to the helm stand and follows the hull's full rotation,
  so you roll and pitch with the ship.
- **Autopilot:** when you let go, it steers back onto the route by pure pursuit, backing off if it
  bumps into something. Once back on the line it resumes the cruise and docking cycle.

### Walking (default, `V` toggles fly)

- **Collision:** built from the scene triangles. Floors (upward-facing triangles) and walls (XZ
  segments with a height range) are hashed on a 2 m grid, and each vehicle has its own set in
  vehicle space.
- **Movement:** a 0.3 m walker with gravity, jumping, 0.55 m steps (sampled under the walker's whole
  footprint, so short treads work) and wall sliding.
- **Doors, ladders, water:** closed doors block, and closed hatch covers can be stood on. Ladders
  climb with `W`/`S`. You can swim in the sea and climb out onto the quay.
- **Riding:** standing on or inside a vehicle stores your position in vehicle space, so you ride
  with it, turning when it turns. Walk up the gangway while it's docked, then explore the deck,
  crew deck, bridge, engine room and hold at sea.

Lighting is per area: a low ambient, a sun factor, fog and up to 12 point lights with
`flicker`/`pulse` signals.

## Controls

Click for mouse look. `WASD` move, `Space` jump, `Shift` run, `W/S` on ladders. `V` switches to fly
mode, where `E/Q` move up and down. `F` shows door status (all doors are automatic), `R` resets.
The minimap is centred on you. Click it to teleport; clicking the ship lands you on its deck. `F` at
the ship's wheel takes the helm.

| Key | Toggle |
|---|---|
| `1` | portal culling |
| `2` | freeze visibility (fly out and inspect the frustums) |
| `3` | masking mode: stencil / scissor / none |
| `4` | portal lines |
| `5` | area volumes |
| `6` | occluders |
| `M` | minimap |
| `N` | minimap span: near (110 m) / island (420 m), always centred on you |
| `L` | load a scenario `.json` from disk |
| `H` | help |

`window.portalDemo` exposes `world`, `vis`, `cam` and `opts` for debugging.
