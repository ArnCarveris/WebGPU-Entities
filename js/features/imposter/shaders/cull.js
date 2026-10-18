'use strict';
// WGSL: per-instance culling into mesh, imposter and shadow caster lists.

Features.part('imposter', (engine, feature) => {
const { lodListsWGSL } = engine.kits.imposter;
const { WGSL_COMMON } = feature;

// Cull: per instance, the LOD fade from its camera distance, then
//   - camera frustum + far: the mesh list and / or the imposter list (both inside the fade band, where the
//     two dither complementary pixels)
//   - each shadow cascade's light box: that cascade's caster list, mesh or imposter by the same LOD (hard
//     switch at the middle of the band), whether or not the camera sees the instance
// The lists and their indirect args are the imposter kit's LodLists (lodPush counts into the args).
const WGSL_CULL = WGSL_COMMON + lodListsWGSL({ group: 1, inst: 'Inst' }) + /* wgsl */`
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= lodP.count) { return; }
    let I = lodSrc[i];
    let s = I.posScale.w;
    let c = I.posScale.xyz + qrot(I.rot, lodP.center.xyz * s);
    let r = lodP.radius * s;
    let d = distance(c, G.camPos.xyz);
    var mode = u32(G.lod.w + 0.5);
    if (I.extra.x > 0.5) { mode = u32(I.extra.x + 0.5); }
    if (lodP.hasImp == 0u) { mode = 1u; }
    let f = lodFade(mode, d, G.lod.x * lodP.lodScale * s, G.lod.y);
    var o = I;
    o.extra.x = f;

    var seen = d - r <= G.lod.z;
    for (var k = 0; k < 6; k++) {
        let pl = G.planes[k];
        if (dot(pl.xyz, c) + pl.w < -r) { seen = false; }
    }
    if (seen) {
        if (f > 0.0) { lodPush(0u, true, o); }
        if (f < 1.0) { lodPush(0u, false, o); }
    }

    if (lodP.casts == 0u || SH.params.w < 0.5) { return; }
    for (var cs = 0u; cs < u32(SH.params.x); cs++) {
        var inside = true;
        for (var k = 0u; k < 6u; k++) {
            let pl = SH.planes[cs * 6u + k];
            if (dot(pl.xyz, c) + pl.w < -r) { inside = false; }
        }
        if (inside) { lodPush(cs + 1u, f >= 0.5, o); }
    }
}
`;

return { WGSL_CULL };
});
