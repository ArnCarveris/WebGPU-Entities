'use strict';
// Grid cell size, buffer layouts and the pattern and surface ids the shaders share.

Features.part('origin', (engine, feature) => {
const CELL = 8192;                  // metres per grid cell (a power of two, so cell * CELL is exact in f32)
const MAX_CELL = 2 ** 30;           // |cell| limit: cell differences never overflow i32 (±8.8e12 m)
const MAX_BODIES = 32;
const ORIGIN_BYTES = 80;            // the entire floating-origin state on the GPU
const INSTANCE_FLOATS = 24;         // 96 bytes per instance
const BODY_FLOATS = 16;
const FRAME_FLOATS = 44;
const VERTEX_FLOATS = 7;            // pos, normal, material
const SAMPLES = 4;
const NEAR = 0.05;                  // near plane, origin units
const AU = 1.495978707e11;
const PATTERNS = { flat: 0, panels: 1, rock: 2, blink: 3, windows: 4, solar: 5, hazard: 6, regolith: 7 };
const SURFACES = { star: 0, rocky: 1, earth: 2, gas: 3, ice: 4, mars: 5 };

return {
    CELL, MAX_CELL, MAX_BODIES, ORIGIN_BYTES, INSTANCE_FLOATS, BODY_FLOATS, FRAME_FLOATS, VERTEX_FLOATS, SAMPLES,
    NEAR, AU, PATTERNS, SURFACES,
};
});
