'use strict';
// Structures (everything built on the terrain: Structures and its parts) as the GPU takes them: vertex and building
// record sizes, material flags, the shader boxes' budgets; and the doors. What buildings are (their archetypes, floor
// plans, cores, lifts, furniture) is data: the scenario's `building` entities and the floor-plan scenarios it includes
// (scenarios/plans/), built by the building kit.

Features.kit('settlement', (engine, kit) => {
const STRUCT_FLOATS = 10;            // structure mesh vertex: position, normal, colour, material
const MAX_BLOCKERS = 128;            // structure boxes in the frame uniform (sun and rain shadows, see WGSL_SHELTER)
const BLOCK_GRID = 32;               // cells per side over their bounds, each listing the boxes that can shade it (4 x 32 bits)
const BLOCK_RANGE = 2500;            // only boxes this close to the camera (m) go into the frame, so the grid stays fine
const MAX_DRIPS = 8;                 // roof edges near the camera that rain runs off (see vsPrecip)
const DRIP_DENSITY = 100;           // at most this many of them per metre of edge
const DRIP_PARTICLES = 40000;        // near-field drops falling off those edges, drawn after the rain

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

return {
    STRUCT_FLOATS, MAX_BLOCKERS, BLOCK_GRID, BLOCK_RANGE, MAX_DRIPS, DRIP_DENSITY, DRIP_PARTICLES,
    INTERIOR_DRAW, BUILDING_FLOATS, BUILDING_DOORS, BLD_ID, BLD_LIT, BLD_STACK, BLD_DARK, LIGHT_COLUMN_FLOATS, DOOR_SPEED, DOOR_REACH,
};
});
