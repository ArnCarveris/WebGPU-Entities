# Building plans

Buildings are data. A building's floor plans, core, lifts, shafts, ladders, rooms and furniture are entities in
**plan scenarios** (`scenarios/plans/*.json`), composed with `include` like any scenario, and built by the generic
**building kit** (`js/kits/building/`) into whatever world includes them:

| World | How it builds a plan |
|---|---|
| cloud (structure meshes) | `kits.building.PlannedBuilding`: each section a shell of the world's (`Buildings.add`), the storeys meshed once per kind and drawn instanced, areas made near the eye, lift cars, ladders |
| portal (sectors) | `kits.building.withStructures`: areas, portals, doors, stairs, lights and furniture props in the world's native format |

A world takes plans by including the plan scenarios (`{"type": "include", "scenario": "plans/spire"}`) and placing
them: `skyscraper` / `structure` entities with `plan`, or archetypes whose `plan` names one (the cloud town's
`block` and `terminal`).

## Plan entities

| Type | What it is |
|---|---|
| `building` | an archetype: storey height, walls, slabs, windows, doors, colours, curtain wall, lamps; `plan` (a `buildingPlan`) makes buildings of it planned (`plans/archetypes.json`) |
| `buildingPlan` | `{ archetype, core, ground (label of storey 0), sections, lifts, crown }` |
| `storeyPlan` | `{ layout: rooms \| hall, ring, corridor, door, rooms { depth [min, max], module, outer {kind: weight}, inner {kind: weight} }, hall, lit, stairs }` (`plans/storeys.json`) |
| `corePlan` | `{ stairs { lane, landing }, lobby, banks [{ shafts, shaft { width, depth, tech }, car { width, depth, height }, door { width, height } }], pit, overrun, machine, ladder }` (`plans/cores.json`) |
| `roomType` | `{ label, furniture { wall, free, row, grid }, lit, floor }` |
| `furniture` | `{ w, d, parts: [[u0, u1, v0, v1, y0, y1, colour, finish]] }` |
| `furnishing` | an unplanned archetype's furniture per storey |

### Sections and storeys

`sections` stack bottom up, each `{ width, depth, storeyHeight, window, doors, roof, storeys }`; a section narrower
than the one below stands on its terrace. `storeys` is a list of `{ plan, repeat, tags, label, zone }` or
`{ repeat, of: [...] }`; `repeat: "*"` fills to the storeys the placement asks for. `zone: true` starts a new lift zone
there; labels take `{zone}`, `{sky}` (zone - 1) and `{g}` (the storey number).

The spire (`plans/spire.json`): a 6 m lobby in a 62 m podium, then five setback sections of six 40-storey zones each:
a sky lobby, 38 office storeys, a plant storey (the local lifts' machine rooms over their overrun, the next zone's
pits), the observation deck on top — 1200 storeys.

### Floor plans

A `rooms` storey: a corridor ring round the core; from each façade in to the ring a strip of room bands,
double-loaded on corridors (as many bands as keep rooms within `rooms.depth`), cut into rooms `module` m wide. The
façade band's rooms are of the `outer` kinds, the others of the `inner` ones; a passage joins each strip's corridor to
the ring opposite the lift lobby. Every room has a doorway (onto a corridor, or through its neighbour). A spire office
storey has about 105 rooms. A `hall` storey is one open room round the core.

### Core, lifts, shafts

The core lies along local x: `[stairwell | bank 0 | lift lobby | bank 1]`. Each shaft holds the car's run and, beside
it, its technical space: the counterweight at the back and the emergency ladder by the landing doors. Guide rails run
the car's sides. Each car's range has a pit `pit` m below its lowest landing and, over its highest, the overrun
(`overrun` m over the car's roof) and the machine room (`machine` m; reached through a service opening from a storey
level with it).

`lifts`: `{ bank, kind, group, name, stops: [tags], zoned, speed, accel, door, dwell }`. A group puts a car in every
shaft of its bank; a `zoned` one a car per zone in the same shafts, one zone above the next. The spire: two express
shuttles (lobby, sky lobbies, deck) and a pair of locals per zone.

## Using lifts (cloud)

- Each landing door has its own **call panel** (the car's floor and direction, CALL). `E` at a landing door calls its
  car; **holding** `E` releases the door (emergency): every car of that shaft halts until it shuts again.
- In the car, the **keypad**: the destination as digits — tap a digit, pick its value on the keypad that opens, then
  GO. A storey the car does not serve says `NO STOP`.
- The car is an area of its own aboard it (the walker rides in its frame; the vis traversal from inside reaches only
  the car while its doors are shut; its own lamp; no weather or haze inside: the frame's cabin is the car).
- In a shaft (through a released door, on a car's roof, in the pit), `E` takes hold of the **emergency ladder**; `W`
  / `S` climb, `E` at a landing steps out through its door. Anyone in a shaft keeps its cars halted.
