'use strict';
// Walking, and how buildings are drawn. What buildings are (their archetypes, floor plans, cores, lifts, furniture) is
// data: the scenario's `building` entities and the floor-plan scenarios it includes (scenarios/plans/), built by the
// building kit.

Features.part('cloud', (engine, feature) => {
// walking (Walker): body radius, highest step, eye height (m), speeds (m/s), climbing a ladder (m/s)
const WALK = { radius: 0.2, step: 0.5, head: 1.75, eye: 1.62, speed: 1.5, run: 4.5, climb: 0.9, climbFast: 1.8 };

const INTERIOR_DRAW = 160;   // m from a building's centre: its interior and see-through glass are drawn; further off, opaque panes (fsPane)
const BUILDING_FLOATS = 32;  // per building in the `buildings` storage buffer (see WGSL_BUILDING): 16 static, 2 doors x 4, 8 plan
const BUILDING_DOORS = 2;    // doors per building the shaders know of (light through them, WGSL_BUILDING)
const BLD_ID = 256;          // interior, glass and door vertices: material + building index * BLD_ID
const BLD_LIT = 64;          // interior material flag: a lift car's, lit by its own lamp whatever the storey's are
const BLD_STACK = 128;       // interior material flag: a storey many share (drawn instanced, one storey higher per instance)
const BLD_DARK = 32;         // interior material flag: an enclosed space (a lift shaft): no daylight, no storey lamps, its own lamps only
const LIGHT_COLUMN_FLOATS = 16;  // a shaft's lamps in the buildings buffer (Buildings.buffer, shaftLight in WGSL)
const DOOR_SPEED = 1.6;      // door swing, fraction of its travel per s
const DOOR_REACH = 2.4;      // m: E opens or closes the door in view this close to the eye

return { WALK, INTERIOR_DRAW, BUILDING_FLOATS, BUILDING_DOORS, BLD_ID, BLD_LIT, BLD_STACK, BLD_DARK, LIGHT_COLUMN_FLOATS, DOOR_SPEED, DOOR_REACH };
});
