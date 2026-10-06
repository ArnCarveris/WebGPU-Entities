> **In WebGPU Entities** this is the README of the original [WebGPU-EntityPortal](https://github.com/ArnCarveris/WebGPU-EntityPortal) demo, kept as the
> feature's technical reference. Its engine now lives in [`js/features/portal.js`](../../js/features/portal.js) (one function scope, run by the
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
| `entities` | `{ type, ... }`, where `type` maps to a class in `ENTITY_TYPES` (`js/world/entities.js`): `prop` (`solid`, `climbable`, `area`), `light`, `stairs`, `hull`, `helm`, `door`, `drone` |

### Adding a new kind of entity

1. Subclass `Entity` (static geometry or controllers) or `Member` (a dynamic chunk drawn with its own
   matrix) in `js/world/entities.js`.
2. Build its geometry in `spawn()` with `world.addStatic` / `world.pool.add`, and call
   `world.addDynamic(this)` if it needs `update(dt, t, actors)`. Resolve references to vehicles or
   other entities in `link()`.
3. Register it in `ENTITY_TYPES` and place it in the scenario's `entities`.

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

1. Where stencil == parent ref and depth passes, set bit 7.
2. Write the child's ref.
3. Clear bit 7.

The child's objects and sky then draw with stencil EQUAL, masked to the aperture exactly. There are
127 refs per frame.

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
