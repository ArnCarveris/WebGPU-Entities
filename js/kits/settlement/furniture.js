'use strict';
// Furniture: what stands in buildings (by archetype, per storey) and in the rooms of a planned storey (by kind), and
// each item's footprint and parts.

Features.kit('settlement', (engine, kit) => {

// what stands in a building (an archetype's `furnish`), per storey (the last entry for the storeys above): items along the
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
    planter: { w: 0.8, d: 0.8, parts: [[-0.4, 0.4, 0, 0.8, 0, 0.6, 'stone'], [-0.32, 0.32, 0.08, 0.72, 0.6, 1.5, 'leaf']] },
};
const FURNITURE_COLORS = { fabric: [0.30, 0.34, 0.42], white: [0.82, 0.81, 0.78], dark: [0.16, 0.16, 0.17], wood: [0.46, 0.32, 0.20], linen: [0.86, 0.84, 0.80], metal: [0.40, 0.42, 0.44],
    stone: [0.55, 0.54, 0.50], leaf: [0.18, 0.34, 0.16] };
// what the rooms of a plan's storeys hold, by kind (kits.interior FloorPlan): items along their walls and free in them
// ([name, count]), or desks in rows (`grid`)
const ROOM_FURNITURE = {
    office: { wall: [['cabinet', 1], ['shelf', 1]], free: [['desk', 2]] },
    open: { wall: [['cabinet', 2], ['counter', 1]], grid: 'desk' },
    meeting: { wall: [['cabinet', 1]], free: [['table', 1]] },
    hall: { wall: [['counter', 1], ['bench', 4], ['shelf', 1]], free: [['bench', 4], ['planter', 4]] },
};

return { FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, ROOM_FURNITURE };
});
