'use strict';
// WGSL: cascaded sun shadows, over the core's stand-ins (shaders/library.js: NO_SHADOW, NO_CASTERS), and the casters'
// fragment stages of the mesh and imposter modules.

Features.feature('imposter/imposter/shadows', (engine, kit) => {
// Cascaded shadow maps. splits: far edge of each cascade (camera view depth); texel: world size of one
// shadow texel per cascade; planes: 6 per cascade (caster culling); params: cascades, map size, tint, enabled
const WGSL_SHADOW = /* wgsl */`
struct Shadow { mats: array<mat4x4f, 4>, splits: vec4f, texel: vec4f, planes: array<vec4f, 24>, params: vec4f };
@group(0) @binding(3) var<uniform> SH: Shadow;
@group(0) @binding(4) var shadowMap: texture_depth_2d_array;
@group(0) @binding(5) var shadowSampler: sampler_comparison;

fn cascadeOf(wp: vec3f) -> u32 {
    let depth = dot(wp - G.camPos.xyz, G.camFwd.xyz);
    var c = 0u;
    for (var i = 0u; i < 3u; i++) { if (depth > SH.splits[i]) { c = i + 1u; } }
    return c;
}
// sun visibility at wp: normal-offset lookup in its cascade, 3 x 3 PCF, fading out at the shadow distance
fn shadowAt(wp: vec3f, n: vec3f) -> f32 {
    if (SH.params.w < 0.5) { return 1.0; }
    let depth = dot(wp - G.camPos.xyz, G.camFwd.xyz);
    let last = SH.splits[3];
    if (depth > last) { return 1.0; }
    let c = cascadeOf(wp);
    let L = normalize(G.sunDir.xyz);
    let t = SH.texel[c];
    let p = wp + n * t * (1.0 + 2.0 * (1.0 - abs(dot(n, L)))) + L * t;
    let lp = SH.mats[c] * vec4f(p, 1.0);
    let uv = vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
    let ts = 1.0 / SH.params.y;
    var sum = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * ts, i32(c), lp.z);
        }
    }
    return mix(sum / 9.0, 1.0, smoothstep(last * 0.85, last, depth));
}
var<private> CASCADE_TINT: array<vec3f, 4> = array<vec3f, 4>(vec3f(1.0, 0.3, 0.3), vec3f(0.3, 1.0, 0.3), vec3f(0.3, 0.5, 1.0), vec3f(1.0, 0.9, 0.2));
// the cascades tinted (the panel's cascade tint)
fn shadowTint(c: vec3f, wp: vec3f) -> vec3f {
    if (SH.params.z > 0.5 && SH.params.w > 0.5 && dot(wp - G.camPos.xyz, G.camFwd.xyz) < SH.splits[3]) {
        return mix(c, CASCADE_TINT[cascadeOf(wp)] * (0.2 + dot(c, vec3f(0.4))), 0.4);
    }
    return c;
}
`;

// Cull: each shadow cascade's light box: that cascade's caster list, mesh or imposter by the same LOD (hard switch at
// the middle of the band), whether or not the camera sees the instance
const WGSL_CASTERS = /* wgsl */`
fn castShadows(c: vec3f, r: f32, f: f32, o: Inst) {
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

const WGSL_MESH_SHADOW = /* wgsl */`
// shadow caster: depth only, alpha-tested
@fragment fn fsShadow(v: VOut) {
    if (textureSample(tex, repSampler, v.uv).a * M.color.a < M.params.x) { discard; }
}
`;

// fsShadow (from a cascade's orthographic light view) writes only the reconstructed depth, so imposters cast their real shape
const WGSL_IMPOSTER_SHADOW = /* wgsl */`
// far-cascade caster: the nearest frame's coverage only, depth of the quad (no depth output keeps early-z)
@fragment fn fsShadowCheap(v: VOut) {
    let iq = qconj(v.rot);
    if (impCoverage(qrot(iq, v.wp - v.center) / v.cellsB.w, qrot(iq, V.dir.xyz), v.cellsA.xy) < 0.5) { discard; }
}

// shadow caster: the reconstructed surface's depth in the cascade
@fragment fn fsShadow(v: VOut) -> @builtin(frag_depth) f32 {
    let ray = viewRay(v);
    let R = impReconstruct(ray.o, ray.d, frames(v), G.flags.y > 0.5, false);
    let a = R.albedo.a;
    if (a < 0.5) { discard; }
    let cp = V.viewProj * vec4f(v.center + qrot(v.rot, R.hit / a * v.cellsB.w), 1.0);
    return clamp(cp.z / cp.w, 0.0, 1.0);
}
`;

return { WGSL_SHADOW, WGSL_CASTERS, WGSL_MESH_SHADOW, WGSL_IMPOSTER_SHADOW };
});
