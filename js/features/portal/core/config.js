'use strict';
// Buffer limits and layouts, patterns and defaults the renderer and shaders share.

Features.part('portal', (engine, feature) => {
const MAX_LIGHTS = 12;                 // point lights per area
const MAX_THROUGH = 16;                // lights per area that shine in through portals (world/light-transport.js)
const THROUGH_FLOATS = 32;             // light (pos radius, colour) + two portal apertures (centre, right, up)
const LIGHT_DEPTH = 2;                 // portals a light passes on its way into an area
const SUN_SOFT = 0.01;                 // the sun's penumbra (m) per metre from the aperture
const SUN_FAR = 1000;                  // how far toward the sun the scene shader puts it, to trace it like a point light
const AREA_FLOATS = 12 + MAX_LIGHTS * 8 + MAX_THROUGH * THROUGH_FLOATS;
const MAT_FLOATS = 12;
const MAX_DRAWS = 4096;
const DRAW_STRIDE = 256;
const MAX_FOG_PORTALS = 4;             // portals per draw whose front areas' fog the scene shader applies
const DRAW_FLOATS = 24 + MAX_FOG_PORTALS * 8;   // model, info, tint, fog planes, fog colours
const MAX_LINE_VERTS = 120000;
const MAX_POLY_VERTS = 30000;
const POLY_FLOATS = 11;                // pos3 normal3 color4 area
const MAX_DEPTH = 12;                  // portal traversal depth
const MAX_ENTRIES = 127;               // portal traversal entries per frame
// the stencil buffer as the renderer uses it (js/kits/gpu/stencil.js; where each slot lives is the layout's to say):
// a region per portal entry, squeezable down to 15 if the target's other users need bits (deeper entries then share
// their parent's region); and the flag that marks an aperture while its child's region is written. Render
// extensions (render/renderer.js) reserve theirs next to these (the GUI screens: "gui.surface")
const STENCIL = {
    'portal.regions': { values: MAX_ENTRIES, min: 15 },
    'portal.mark': { flag: true },
};
const NEAR_PASS = 0.35;                // SECTR: IsPointInHull(cameraPos, maxNearClipDistance)
const DEPTH_FORMAT = 'depth24plus-stencil8';
const PATTERNS = { flat: 0, tiles: 1, panels: 2, noise: 3, grass: 4, hazard: 5, planks: 6, bricks: 7, screen: 8, rust: 9 };
const { AXES } = engine.kits.mesh;     // the world axes
const DEFAULT_GLASS = [0.55, 0.7, 0.75, 0.12];

return {
    MAX_LIGHTS, MAX_THROUGH, THROUGH_FLOATS, LIGHT_DEPTH, SUN_SOFT, SUN_FAR, AREA_FLOATS, MAT_FLOATS, MAX_DRAWS, DRAW_STRIDE, MAX_FOG_PORTALS, DRAW_FLOATS, MAX_LINE_VERTS,
    MAX_POLY_VERTS, POLY_FLOATS, MAX_DEPTH, MAX_ENTRIES, STENCIL, NEAR_PASS, DEPTH_FORMAT, PATTERNS, AXES, DEFAULT_GLASS,
};
});
