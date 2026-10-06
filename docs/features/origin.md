> **In WebGPU Entities** this is the README of the original [WebGPU-EntityOrigin](https://github.com/ArnCarveris/WebGPU-EntityOrigin) demo, kept as the
> feature's technical reference. Its engine now lives in [`js/features/origin.js`](../../js/features/origin.js) (one function scope, run by the
> host in [`js/engine/host.js`](../../js/engine/host.js)), and its scenario is [`scenarios/origin-sol-transit.json`](../../scenarios/origin-sol-transit.json) as a list of
> entities: every native key below is an entity of type `origin.<key>` (see the main [README](../../README.md#everything-is-an-entity)).
> Paths and run instructions below refer to the original repository.

# Entity Origin // WebGPU

A Floating Origin in WebGPU where rebasing is **O(1)**. The origin is a full matrix (translation,
rotation and scale), and the demo spans a real-scale solar system: from walking on the Moon to a
station 4.5e12 m out at Neptune, with about 180k instances. Everything is in one static
`index.html`: the engine classes, the WGSL, and the scenario as data.

Open `index.html` in a WebGPU browser (Brave, Chrome, Edge), either from disk or over HTTP. Drop another
scenario `.json` on the page to load it.

## How it works

Every position is a `WorldPos`: an integer grid cell (`CELL` = 8192 m) plus a local offset in that
cell. The origin is:

```
Origin = { pos: WorldPos (T), q: quaternion (R), scale: metres per unit (s) }
p_origin = R^T (p - T) / s
```

- **Rebase = one 80-byte uniform write.** Instances sit in a static storage buffer as
  `(cell, local, axes, tint)` and are never rewritten on a rebase. The vertex shader computes
  `(cell - originCell) * CELL + (local - originLocal)`. The integer subtraction is exact, so geometry
  near the origin keeps full f32 precision at any distance from world 0. The cost doesn't depend on
  the instance count: press `O` to rebase every frame, or `[ ]` to change the density, and the cost
  stays at 80 B.
- **T (translation):** the origin snaps to the camera once the camera is `origin.distance` units away.
- **R (rotation):** near a body, origin +Y follows the local vertical (shortest-arc turn, so no
  twist). The camera controls work in the origin frame (yaw about +Y, Space/C along it, horizon
  leveling), so the same controller works on any side of any planet.
- **S (scale):** a power of two that follows the distance to the nearest thing, so camera speed and
  the near plane (both in origin units) cover 1 m to 1 AU.
- **Bodies** (stars, planets) are exact per-pixel ray/sphere impostors. Their origin-relative centre
  and the camera's altitude are computed in doubles on the CPU each frame (a few bodies, so O(bodies)).
  The stable root `t = c / (-b + sqrt(b² - c))` with `c = alt·(alt + 2R)` keeps the ground exact at
  1.7 m eye height on a 1.7e6 m Moon.
- Reversed-Z with an infinite far plane (`depth32float`) plus 4× MSAA.

Turn **T** off to see the classic problem: the origin is pinned to world 0, and at Neptune the f32
step is about 524 km (shown in the HUD), so the outpost collapses.

## Controls

| Key | Action |
|---|---|
| drag / WASD / Space, C / Q, E | look / move / up, down along origin +Y / roll |
| Shift, Ctrl, wheel | ×10, ×0.1, speed |
| 1–7 | bookmarks from the scenario |
| T R G | translation / rotation / scale rebasing on or off |
| O | rebase every frame |
| [ ] | halve / double field density (rebuilds instances) |
| L, P, H | labels, pause, help |

## Scenario (`<script id="scenario">`)

| Key | Contents |
|---|---|
| `camera`, `origin`, `lighting` | fov, `minAltitude`; rebase `distance` / `angle` / `scaleBase` / `frameRange`; exposure, sun |
| `materials` | `albedo`, `pattern` (`flat`, `panels`, `rock`, `blink`, `windows`, `solar`, `hazard`, `regolith`), `scale`, `spec`, `shin`, `emissive` [r, g, b, strength], `rate` |
| `models` | parts: `box` [x,y,z, sx,sy,sz], `cyl` [x,y,z, r,h] (+`r2`, `axis`, `seg`), `sphere` [x,y,z, r], `torus` [x,y,z, R,r], `rock` [x,y,z, r] (+`detail`) |
| `entities` | `{ type, id, label, ...placement }`, where `type` maps to a class in `ENTITY_TYPES`: `body`, `prop` (+`spin`), `field` (`sphere` / `ring` / `disc` shapes, `count`, `size`, `seed`), `orbiter` (`orbit.period`) |
| placement | `pos` [m] · `parent` + `offset` · `orbit` { parent, radius or altitude, angle, incl, node } · `surface` { parent, lat, lon, alt, heading }; then `rot` [yaw, pitch, roll], `scale` |
| `bookmarks` | `{ key, name, at: placement, look: entity id }` |

### Adding a new kind of entity

1. Subclass `Entity`. Resolve its frame in `spawn()` (`super.spawn()`) and add GPU instances with
   `world.addInstance(model, pos, q, scale)`.
2. If it moves, call `world.addDynamic(this)`. In `update(dt, t)`, re-`place()` its instances and call
   `world.store.touch(inst)`. That rewrites only its own 96-byte slots.
3. Register it in `ENTITY_TYPES` and add it to the scenario's `entities`.
