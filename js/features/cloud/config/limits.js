'use strict';
// GPU budgets, grid resolutions and the near-field particle limits the shaders and buffers are sized by.

Features.part('cloud', (engine, feature) => {
const NEAR = 1.0;
const MAX_CELLS = 64;
const CELL_FLOATS = 16;
const MAX_LAYERS = 4;
const MAX_MOTHERSHIPS = 4;           // analytic storm structures (see mothershipDensity / shelfLineDensity)
const MAX_SHELVES = 2;                // stratiform / cellular cloud genera besides the convective layer
const MAX_FLASHES = 6;
const MAX_BOLT_SEGS = 768;
const MAX_BLOCKERS = 128;            // structure boxes in the frame uniform (sun and rain shadows, see WGSL_SHELTER)
const BLOCK_GRID = 32;               // cells per side over their bounds, each listing the boxes that can shade it (4 x 32 bits)
const BLOCK_RANGE = 2500;            // only boxes this close to the camera (m) go into the frame, so the grid stays fine
const MAX_LIGHTS = 64;               // point and spot lights in the frame uniform (LightWriter.write), the most important first
const LIGHT_RANGE = 700;             // m: lights further from the camera than this (less their reach) are left out
const LIGHT_GRID = 32;               // cells per side over the lights' reach, each listing the lights that reach into it (2 x 32 bits)
const LIGHT_CABIN = 1, LIGHT_SPOT = 2;  // light flags: a bus's cabin glow (not on the cabin's own surfaces), a spot (cone)
// distant lights by night (World.buildFarLights, WGSL_FAR): every lamp as a glowing point sprite, lighting nothing
// per far light: [x, y, z, size (m)] [rgb intensity, fake] [axis, cos of the cone's edge (-2 none)] [cos of its core, range (m), ground height, -]
const FAR_FLOATS = 16;
const POOL_ALBEDO = [0.15, 0.165, 0.14];  // the ground under a real lamp far off (asphalt and verge), as its pool decal (vsFarPool) takes it
const MAX_FAR_DYN = 32;              // slots after the static ones, rewritten each frame: the buses' lights
const TOWN_BLOCK = 120, FAR_LAMP_PITCH = 40;  // m: townColor's street grid, and the fake street lamps' spacing along it
const FAR_LAMP_SIDE = 5, FAR_LAMP_H = 7, FAR_LAMP_REACH = 1.5;     // m: their heads off the street's centre line (alternate sides), above the ground
const ROAD_LAMP_STEP = 100;          // m between the pairs of street lamps along the bus road (BusLine.build)
const POLE_DRAW = 1000;              // m: the fake lamps' poles and heads are drawn this close (instanced, World.nearPoles)
const MAX_POLES = 2048;
const MAX_GLOWS = 6;                 // light-pollution domes (cityGlow): the towns, and clusters of the structures' lamps
const GLOW_GAIN = 6;                 // light pollution: the lamps' uplight (off the ground, out of the fixtures), as bright as it looks
const MAX_RAIN_ZONES = 64;           // points along the bus route with their own rain rate (RainZones, mixed rain)
const ZONE_STEP = 300, ZONE_RADIUS = 380;  // m between them, how far each one's rain reaches
const CLEAR_RADIUS = 450, CLEAR_WIDE = 3;   // a clear stretch's opening: m past its ends along the route, x that across it
const MAX_DRIPS = 8;                 // roof edges near the camera that rain runs off (see vsPrecip)
const DRIP_DENSITY = 100;           // at most this many of them per metre of edge
const DRIP_PARTICLES = 40000;        // near-field drops falling off those edges, drawn after the rain
const SPLASH_GRID = 128, SPLASH_RADIUS = 20;  // splashes near the camera (splash): world cells per side, m out from the camera
const SPLASH_PIECES = 9, SPLASH_MIST = 3;  // per splash cell: pieces, of which the first are mist sprites (the rest droplets)
const SPLASH_PARTICLES = SPLASH_GRID * SPLASH_GRID * SPLASH_PIECES;
// the spray off the ground (rainSpray): 1/m per unit rain, and its layers' scale heights (m) and weights: the dense
// carpet in the lowest 30 cm, a metre of mist over it, a thin veil some ten metres deep
const SPRAY = 0.03, SPRAY_LAYERS = [[0.2, 3.8], [1.0, 1.0], [8.0, 0.2]];
// beyond the splashes' mist sprites (splash), the carpet takes over their share: [scale height (m), weight]
const SPRAY_MIST = [0.25, 2.4];
const SPLASH_FADE = 0.4;            // the splashes and their mist fade out from this share of SPLASH_RADIUS to its end
const STRUCT_FLOATS = 10;            // structure mesh vertex: position, normal, colour, material
const GRID_N = 512;                 // terrain mesh vertices per side (inner part covers the heightfield, outer rings run to the horizon)
const NOISE_SHAPE = 128;
const NOISE_DETAIL = 32;
// occupancy grid for empty-space skipping: OCC_RES^2 columns over the weather map, 32 height cells each (one u32 of bits)
const OCC_RES = 256;
// cloud tile pre-pass: one ray per CLOUD_TILE^2 volumetric pixels finds the distance bins (64, square-root spaced out to
// the march distance) where cloud can be; the march evaluates clouds only there. Coverage is padded by TILE_COVER_PAD
// in the pre-pass, so its clouds are a little larger than the march's and small or thin ones are not missed
const CLOUD_TILE = 4;
const TILE_COVER_PAD = 0.15;
const WEATHER_RES = 512;
const SHADOW_RES = 384;
const GROUND_RES = 256;

return {
    NEAR, MAX_CELLS, CELL_FLOATS, MAX_LAYERS, MAX_MOTHERSHIPS, MAX_SHELVES, MAX_FLASHES, MAX_BOLT_SEGS, MAX_BLOCKERS,
    BLOCK_GRID, BLOCK_RANGE, MAX_LIGHTS, LIGHT_RANGE, LIGHT_GRID, LIGHT_SPOT, LIGHT_CABIN, FAR_FLOATS, POOL_ALBEDO,
    MAX_FAR_DYN, FAR_LAMP_PITCH, TOWN_BLOCK, FAR_LAMP_SIDE, FAR_LAMP_H, FAR_LAMP_REACH, ROAD_LAMP_STEP, POLE_DRAW,
    MAX_POLES, MAX_GLOWS, GLOW_GAIN, MAX_RAIN_ZONES, ZONE_STEP, ZONE_RADIUS, CLEAR_WIDE, CLEAR_RADIUS, MAX_DRIPS,
    DRIP_DENSITY, DRIP_PARTICLES, SPLASH_RADIUS, SPLASH_GRID, SPLASH_PIECES, SPLASH_MIST, SPLASH_PARTICLES, SPRAY,
    SPRAY_LAYERS, SPRAY_MIST, SPLASH_FADE, STRUCT_FLOATS, GRID_N, NOISE_SHAPE, NOISE_DETAIL, OCC_RES, CLOUD_TILE,
    TILE_COVER_PAD, WEATHER_RES, SHADOW_RES, GROUND_RES,
};
});
