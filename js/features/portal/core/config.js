'use strict';
// Buffer limits and layouts, patterns and defaults the renderer and shaders share.

Features.part('portal', (engine, feature) => {
const MAX_LIGHTS = 12;                 // point lights per area
const AREA_FLOATS = 12 + MAX_LIGHTS * 8;
const MAT_FLOATS = 12;
const MAX_DRAWS = 4096;
const DRAW_STRIDE = 256;
const MAX_FOG_PORTALS = 4;             // portals per draw whose front areas' fog the scene shader applies
const DRAW_FLOATS = 24 + MAX_FOG_PORTALS * 8;   // model, info, tint, fog planes, fog colours
const MAX_LINE_VERTS = 120000;
const MAX_POLY_VERTS = 30000;
const POLY_FLOATS = 11;                // pos3 normal3 color4 area
const MAX_DEPTH = 12;                  // portal traversal depth
const MAX_ENTRIES = 127;               // stencil refs are 7 bits; bit 7 is the "being marked" flag
const NEAR_PASS = 0.35;                // SECTR: IsPointInHull(cameraPos, maxNearClipDistance)
const DEPTH_FORMAT = 'depth24plus-stencil8';
const PATTERNS = { flat: 0, tiles: 1, panels: 2, noise: 3, grass: 4, hazard: 5, planks: 6, bricks: 7, screen: 8, rust: 9 };
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const DEFAULT_GLASS = [0.55, 0.7, 0.75, 0.12];

return {
    MAX_LIGHTS, AREA_FLOATS, MAT_FLOATS, MAX_DRAWS, DRAW_STRIDE, MAX_FOG_PORTALS, DRAW_FLOATS, MAX_LINE_VERTS,
    MAX_POLY_VERTS, POLY_FLOATS, MAX_DEPTH, MAX_ENTRIES, NEAR_PASS, DEPTH_FORMAT, PATTERNS, AXES, DEFAULT_GLASS,
};
});
