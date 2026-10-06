'use strict';
// Walking and buildings: body sizes, building archetypes and their furniture.

Features.part('cloud', (engine, feature) => {
// walking (Walker): body radius, highest step, eye height (m), speeds (m/s)
const WALK = { radius: 0.2, step: 0.5, head: 1.75, eye: 1.62, speed: 1.5, run: 4.5 };

// Buildings (Buildings.add): every house, terminal, town block and kiosk is a shell with real openings, an interior
// (floors, stairs, furniture, lamps), glass in its windows and doors that open. An archetype holds what is shared; the
// scenario's `buildings` adds archetypes or overrides keys of these, and each building (Village, BusStation) gives its
// own size, storeys, colours, roof and doors. Sizes in m:
//   storeyHeight, plinth (floor above the highest ground under it), wall (thickness), slab (floor thickness)
//   window { width, height, sill (above each storey's floor), pitch (m of wall per window; windows are spread evenly) }
//   door { width, height, color (STRUCT_COLORS key) }, stairs { width } (or false), furnish (FURNITURE key), lamps (share
//   of storeys lit), shelter (the interior keeps out rain and snow however the wind blows), inner / floorColor / ceiling colours
const BUILDING_TYPES = {
    house: { storeyHeight: 2.8, plinth: 0.35, wall: 0.25, slab: 0.22, window: { width: 1.1, height: 1.25, sill: 0.9, pitch: 3.2 },
        door: { width: 1.0, height: 2.1, color: 'door' }, stairs: { width: 0.95 }, furnish: 'home', lamps: 0.5, porch: 0.6, shelter: true,
        inner: [0.84, 0.80, 0.72], floorColor: [0.40, 0.28, 0.18], ceiling: [0.90, 0.89, 0.86] },
    terminal: { storeyHeight: 3.6, plinth: 0.15, wall: 0.3, slab: 0.3, window: { width: 1.45, height: 2.0, sill: 0.8, pitch: 1.6 },
        door: { width: 1.6, height: 2.4, color: 'metal' }, stairs: { width: 1.4 }, furnish: 'hall', lamps: 1, porch: 1, shelter: true,
        inner: [0.80, 0.79, 0.75], floorColor: [0.52, 0.50, 0.46], ceiling: [0.88, 0.88, 0.86] },
    block: { storeyHeight: 3.2, plinth: 0.3, wall: 0.3, slab: 0.25, window: { width: 1.3, height: 1.5, sill: 0.9, pitch: 1.8 },
        door: { width: 1.2, height: 2.3, color: 'metal' }, stairs: { width: 1.2 }, furnish: 'office', lamps: 0.6, porch: 1, shelter: true,
        inner: [0.82, 0.82, 0.80], floorColor: [0.38, 0.40, 0.42], ceiling: [0.90, 0.90, 0.88] },
    kiosk: { storeyHeight: 2.4, plinth: 0, wall: 0.08, slab: 0.1, window: { width: 1.5, height: 1.25, sill: 0.95, pitch: 1.75 },
        door: { width: 0.9, height: 2.1, color: 'metal' }, stairs: false, furnish: 'kiosk', lamps: 1, porch: 0, shelter: true,
        inner: [0.78, 0.78, 0.74], floorColor: [0.30, 0.31, 0.30], ceiling: [0.86, 0.86, 0.84] },
};
// what stands in a building (BUILDING_TYPES' furnish), per storey (the last entry for the storeys above): items along the
// walls (`wall`) and free in the room (`free`), each [name, count]. FURNITURE_ITEMS gives each item's footprint, w along the
// wall by d out from it, and its parts, boxes [u0, u1, v0, v1, y0, y1, colour] with u across its width and v from the wall
const FURNITURE = {
    home: [{ wall: [['sofa', 1], ['counter', 1], ['cabinet', 1]], free: [['table', 1]] },
        { wall: [['bed', 1], ['wardrobe', 1], ['desk', 1]], free: [] }],
    office: [{ wall: [['counter', 1], ['cabinet', 2]], free: [['bench', 2]] }, { wall: [['cabinet', 3]], free: [['desk', 4]] }],
    hall: [{ wall: [['counter', 1], ['bench', 3]], free: [['bench', 3]] }, { wall: [['cabinet', 3]], free: [['desk', 4]] }],
    kiosk: [{ wall: [['counter', 1], ['shelf', 1]], free: [] }],
};
const FURNITURE_ITEMS = {
    sofa: { w: 2.0, d: 0.85, parts: [[-1, 1, 0, 0.85, 0, 0.42, 'fabric'], [-1, 1, 0, 0.22, 0.42, 0.85, 'fabric'], [-1, -0.82, 0.22, 0.85, 0.42, 0.62, 'fabric'], [0.82, 1, 0.22, 0.85, 0.42, 0.62, 'fabric']] },
    counter: { w: 2.4, d: 0.62, parts: [[-1.2, 1.2, 0, 0.6, 0, 0.88, 'white'], [-1.2, 1.2, 0, 0.62, 0.88, 0.92, 'dark']] },
    cabinet: { w: 1.2, d: 0.45, parts: [[-0.6, 0.6, 0, 0.45, 0, 0.95, 'wood']] },
    shelf: { w: 1.6, d: 0.4, parts: [[-0.8, 0.8, 0, 0.4, 0, 1.9, 'wood']] },
    wardrobe: { w: 1.3, d: 0.6, parts: [[-0.65, 0.65, 0, 0.6, 0, 2.0, 'white']] },
    bed: { w: 1.5, d: 2.05, parts: [[-0.75, 0.75, 0, 2.05, 0, 0.32, 'wood'], [-0.72, 0.72, 0.05, 2.0, 0.32, 0.5, 'linen'], [-0.75, 0.75, 0, 0.06, 0, 0.95, 'wood']] },
    desk: { w: 1.4, d: 0.7, parts: [[-0.7, 0.7, 0, 0.7, 0.72, 0.76, 'wood'], [-0.68, -0.62, 0.05, 0.65, 0, 0.72, 'metal'], [0.62, 0.68, 0.05, 0.65, 0, 0.72, 'metal'], [-0.25, 0.25, 0.8, 1.2, 0, 0.45, 'dark']] },
    table: { w: 1.5, d: 1.9, parts: [[-0.75, 0.75, 0.5, 1.4, 0.72, 0.76, 'wood'], [-0.7, -0.64, 0.55, 0.61, 0, 0.72, 'wood'], [0.64, 0.7, 0.55, 0.61, 0, 0.72, 'wood'],
        [-0.7, -0.64, 1.29, 1.35, 0, 0.72, 'wood'], [0.64, 0.7, 1.29, 1.35, 0, 0.72, 'wood'], [-0.45, -0.05, 0.02, 0.42, 0, 0.45, 'fabric'],
        [-0.45, -0.05, 0.0, 0.05, 0.45, 0.9, 'wood'], [0.05, 0.45, 1.48, 1.88, 0, 0.45, 'fabric'], [0.05, 0.45, 1.85, 1.9, 0.45, 0.9, 'wood']] },
    bench: { w: 2.2, d: 0.5, parts: [[-1.1, 1.1, 0, 0.5, 0.4, 0.46, 'wood'], [-1.0, -0.94, 0.05, 0.45, 0, 0.4, 'metal'], [0.94, 1.0, 0.05, 0.45, 0, 0.4, 'metal']] },
};
const FURNITURE_COLORS = { fabric: [0.30, 0.34, 0.42], white: [0.82, 0.81, 0.78], dark: [0.16, 0.16, 0.17], wood: [0.46, 0.32, 0.20], linen: [0.86, 0.84, 0.80], metal: [0.40, 0.42, 0.44] };
const INTERIOR_DRAW = 160;   // m from a building's centre: its interior and see-through glass are drawn; further off, opaque panes (fsPane)
const BUILDING_FLOATS = 16;  // per building in the `buildings` storage buffer (see WGSL_BUILDING)
const BLD_ID = 256;          // interior, glass and door vertices: material + building index * BLD_ID
const DOOR_SPEED = 1.6;      // door swing, fraction of its travel per s
const DOOR_REACH = 2.4;      // m: E opens or closes the door in view this close to the eye

return {
    WALK, BUILDING_TYPES, FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, INTERIOR_DRAW, BUILDING_FLOATS, BLD_ID,
    DOOR_SPEED, DOOR_REACH,
};
});
