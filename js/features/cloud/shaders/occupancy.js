'use strict';
// WGSL: the occupancy grid for empty-space skipping in the march.

Features.part('cloud', (engine, feature) => {
const { MAX_LAYERS, OCC_RES } = feature;

// Occupancy grid, each frame after the weather map: one thread per column, 32 height cells from the lowest cloud
// (layerInfo.z) to the highest top (features.z). A cell's bit is set where the noise clouds can exist at that height:
// within the convective layer up to the column's highest top (lowered bases under wall clouds included), in an anvil
// band, at shelf height, or in a genus layer's band, with the largest values over every weather texel a bilinear
// fetch in the column can touch. Most empty air the march crosses lies above the column's own top (the slab reaches
// up to the tallest storm anywhere) or outside the genus bands; a bound on the shape noise as well was measured to
// skip little more and cost as much as it saved.
// The analytic structures (motherships, shelf lines) are not in it; the march evaluates them per ray as before.
const WGSL_OCCUPANCY = /* wgsl */`
@group(1) @binding(0) var<storage, read_write> occOut: array<u32>;

@compute @workgroup_size(8, 8)
fn occupancy(@builtin(global_invocation_id) gid: vec3u) {
    let n = ${OCC_RES}u;
    if (gid.x >= n || gid.y >= n) { return; }
    let idx = gid.y * n + gid.x;
    let wn = i32(F.wdomain.w);
    let per = wn / i32(n);
    let t0 = vec2i(gid.xy) * per - 1;
    let t1 = t0 + per + 1;
    // near the map edges the samplers blend towards defaults: no bound there
    let fade = i32(ceil(f32(wn) / 12.0)) + 1;
    if (any(t0 < vec2i(fade)) || any(t1 >= vec2i(wn - fade))) { occOut[idx] = 0xffffffffu; return; }
    var w = vec2f(0.0);     // coverage, top
    var an = vec4f(0.0);    // anvil coverage, anvil top, shelf coverage, -
    var lc = vec4f(0.0);    // genus coverage
    var wall = 0.0;         // wall cloud lowering (m)
    for (var y = t0.y; y <= t1.y; y++) {
        for (var x = t0.x; x <= t1.x; x++) {
            let c = vec2i(x, y);
            w = max(w, textureLoad(weatherTex, c, 0).xy);
            an = max(an, textureLoad(anvilTex, c, 0));
            lc = max(lc, textureLoad(layerTex, c, 0));
            wall = max(wall, textureLoad(styleTex, c, 0).z);
        }
    }
    let base0 = F.cloud.x;
    let convTop = max(w.y, base0 + 400.0);
    let Y0 = F.layerInfo.z;
    let dy = (F.features.z - Y0) / 32.0;
    var bits = 0u;
    for (var k = 0u; k < 32u; k++) {
        let y0 = Y0 + dy * f32(k) - 1.0;
        let y1 = y0 + dy + 2.0;
        var on = false;
        for (var i = 0; i < ${MAX_LAYERS}; i++) {
            let A = F.layers[i * 3];
            if (lc[i] >= 0.01 && y1 > A.x && y0 < A.y) { on = true; }
        }
        if (an.z > 0.01 && y1 > base0 - 1100.0 && y0 < base0 + 1350.0) { on = true; }
        if (w.x >= 0.01 && y1 > base0 - wall && y0 < convTop) { on = true; }               // convective layer, towers
        if (an.x > 0.01 && y1 > base0 + 2500.0 && y0 < an.y) { on = true; }               // anvils
        if (on) { bits |= 1u << k; }
    }
    occOut[idx] = bits;
}
`;

return { WGSL_OCCUPANCY };
});
