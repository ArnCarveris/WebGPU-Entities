'use strict';
// Walking and buildings: body sizes, building archetypes and their furniture.

Features.part('cloud', (engine, feature) => {
// the lifts' sizes, speeds and colours are the transit kit's (kits.transit LIFT)
const { LIFT } = engine.kits.transit;
// what stands in buildings and their rooms is the settlement kit's (FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, ROOM_FURNITURE)
const { FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, ROOM_FURNITURE } = engine.kits.settlement;
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
//   plan: rooms off a corridor round a core (kits.interior FloorPlan) instead of one open room per storey: { module (a
//   room's width along the facade), corridor, ground ('hall': the ground floor open round the core, or 'rooms'), lifts
//   (lift shafts either side of the core's lift lobby: [left bank, right bank]) }; the core holds a switchback
//   stairwell and the lifts (Lifts). curtain: floor-to-ceiling glass between mullions instead of punched windows
const BUILDING_TYPES = {
    house: { storeyHeight: 2.8, plinth: 0.35, wall: 0.25, slab: 0.22, window: { width: 1.1, height: 1.25, sill: 0.9, pitch: 3.2 },
        door: { width: 1.0, height: 2.1, color: 'door' }, stairs: { width: 0.95 }, furnish: 'home', lamps: 0.5, porch: 0.6, shelter: true,
        inner: [0.84, 0.80, 0.72], floorColor: [0.40, 0.28, 0.18], ceiling: [0.90, 0.89, 0.86] },
    terminal: { storeyHeight: 3.8, plinth: 0.15, wall: 0.3, slab: 0.3, window: { width: 2.2, height: 2.1, sill: 0.8, pitch: 3.4 },
        door: { width: 1.6, height: 2.4, color: 'metal' }, stairs: { width: 1.4 }, furnish: 'hall', lamps: 1, porch: 1, shelter: true,
        inner: [0.80, 0.79, 0.75], floorColor: [0.52, 0.50, 0.46], ceiling: [0.88, 0.88, 0.86],
        plan: { module: 5.5, corridor: 2.0, ground: 'hall', lifts: [0, 1] } },
    block: { storeyHeight: 3.3, plinth: 0.3, wall: 0.3, slab: 0.25, window: { width: 1.6, height: 1.6, sill: 0.9, pitch: 3.6 },
        door: { width: 1.2, height: 2.3, color: 'metal' }, stairs: { width: 1.2 }, furnish: 'office', lamps: 0.6, porch: 1, shelter: true,
        inner: [0.82, 0.82, 0.80], floorColor: [0.38, 0.40, 0.42], ceiling: [0.90, 0.90, 0.88],
        plan: { module: 4.8, corridor: 1.8, ground: 'hall', lifts: [0, 1] } },
    kiosk: { storeyHeight: 2.4, plinth: 0, wall: 0.08, slab: 0.1, window: { width: 1.5, height: 1.25, sill: 0.95, pitch: 1.75 },
        door: { width: 0.9, height: 2.1, color: 'metal' }, stairs: false, furnish: 'kiosk', lamps: 1, porch: 0, shelter: true,
        inner: [0.78, 0.78, 0.74], floorColor: [0.30, 0.31, 0.30], ceiling: [0.86, 0.86, 0.84] },
    // a skyscraper's section (Buildings.tower)
    tower: { storeyHeight: 4, plinth: 0.2, wall: 0.35, slab: 0.35, window: { width: 2.75, height: 3.05, sill: 0.3, pitch: 3.0 },
        door: { width: 2.0, height: 3.0, color: 'metal' }, stairs: { width: 1.3 }, furnish: 'office', lamps: 0.9, porch: 1, shelter: true,
        inner: [0.86, 0.86, 0.84], floorColor: [0.30, 0.31, 0.33], ceiling: [0.92, 0.92, 0.90], curtain: true,
        plan: { module: 6, corridor: 2.2, ground: 'hall', lifts: [2, 2] } },
};
// A skyscraper (Buildings.tower): a lobby storey (m high) in a podium (m wide), then sections stepping in (setbacks, m
// wide each) made of `zone`-storey zones, each served by a pair of local lifts from its sky lobby; express shuttles stop
// at the lobby, each sky lobby and the observation deck at the top; a spire (m) on the roof
const TOWER = { lobby: 6, zone: 40, sections: [52, 46, 40, 34, 28], podium: 62, spire: 120 };

const INTERIOR_DRAW = 160;   // m from a building's centre: its interior and see-through glass are drawn; further off, opaque panes (fsPane)
const BUILDING_FLOATS = 32;  // per building in the `buildings` storage buffer (see WGSL_BUILDING): 16 static, 2 doors x 4, 8 plan
const BUILDING_DOORS = 2;    // doors per building the shaders know of (light through them, WGSL_BUILDING)
const BLD_ID = 256;          // interior, glass and door vertices: material + building index * BLD_ID
const BLD_LIT = 64;          // interior material flag: a lift car's, lit by its own lamp whatever the storey's are
const BLD_STACK = 128;       // interior material flag: a storey many share (drawn instanced, one storey higher per instance)
const DOOR_SPEED = 1.6;      // door swing, fraction of its travel per s
const DOOR_REACH = 2.4;      // m: E opens or closes the door in view this close to the eye

return {
    WALK, BUILDING_TYPES, ROOM_FURNITURE, LIFT, TOWER, FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, INTERIOR_DRAW, BUILDING_FLOATS,
    BUILDING_DOORS, BLD_ID, BLD_LIT, BLD_STACK, DOOR_SPEED, DOOR_REACH,
};
});
