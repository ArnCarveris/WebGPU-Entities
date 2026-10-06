'use strict';
// WGSL: per-instance culling into mesh, imposter and shadow caster lists.

Features.part('imposter', (engine, feature) => {
const { WGSL_COMMON } = feature;

// Cull: per instance, the LOD fade from its camera distance, then
//   - camera frustum + far: the mesh list and / or the imposter list (both inside the fade band, where the
//     two dither complementary pixels)
//   - each shadow cascade's light box: that cascade's caster list, mesh or imposter by the same LOD (hard
//     switch at the middle of the band), whether or not the camera sees the instance
// List k of each output buffer starts at k * P.seg. The instance counts go straight into the indirect
// args (reset from a template every frame): the imposter draw's instanceCount counts imposters, the first
// submesh's counts meshes and the other submeshes follow it with atomicMax. No copies, no clears.
const WGSL_CULL = WGSL_COMMON + /* wgsl */`
struct Params { count: u32, hasImp: u32, radius: f32, lodScale: f32, center: vec4f, seg: u32, casts: u32, setWords: u32, subs: u32 };
@group(1) @binding(0) var<uniform> P: Params;
@group(1) @binding(1) var<storage, read> src: array<Inst>;
@group(1) @binding(2) var<storage, read_write> meshOut: array<Inst>;
@group(1) @binding(3) var<storage, read_write> impOut: array<Inst>;
@group(1) @binding(4) var<storage, read_write> args: array<atomic<u32>>;

fn push(list: u32, mesh: bool, o: Inst) {
    let base = list * P.setWords;
    if (!mesh) {
        impOut[list * P.seg + atomicAdd(&args[base + 1u], 1u)] = o;
    } else if (P.subs > 0u) {
        let k = atomicAdd(&args[base + 5u], 1u);
        meshOut[list * P.seg + k] = o;
        for (var i = 1u; i < P.subs; i++) { atomicMax(&args[base + 5u + 5u * i], k + 1u); }
    }
}

@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= P.count) { return; }
    let I = src[i];
    let s = I.posScale.w;
    let c = I.posScale.xyz + qrot(I.rot, P.center.xyz * s);
    let r = P.radius * s;
    let d = distance(c, G.camPos.xyz);
    var mode = u32(G.lod.w + 0.5);
    if (I.extra.x > 0.5) { mode = u32(I.extra.x + 0.5); }
    if (P.hasImp == 0u) { mode = 1u; }
    var f = 1.0;
    if (mode == 2u) {
        f = 0.0;
    } else if (mode == 0u) {
        let start = G.lod.x * P.lodScale * s;
        f = 1.0 - clamp((d - start) / max(start * G.lod.y, 1e-3), 0.0, 1.0);
    }
    var o = I;
    o.extra.x = f;

    var seen = d - r <= G.lod.z;
    for (var k = 0; k < 6; k++) {
        let pl = G.planes[k];
        if (dot(pl.xyz, c) + pl.w < -r) { seen = false; }
    }
    if (seen) {
        if (f > 0.0) { push(0u, true, o); }
        if (f < 1.0) { push(0u, false, o); }
    }

    if (P.casts == 0u || SH.params.w < 0.5) { return; }
    for (var cs = 0u; cs < u32(SH.params.x); cs++) {
        var inside = true;
        for (var k = 0u; k < 6u; k++) {
            let pl = SH.planes[cs * 6u + k];
            if (dot(pl.xyz, c) + pl.w < -r) { inside = false; }
        }
        if (inside) { push(cs + 1u, f >= 0.5, o); }
    }
}
`;

return { WGSL_CULL };
});
