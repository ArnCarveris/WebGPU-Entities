'use strict';
// WGSL shared by the passes: views, cascaded shadows, the LOD dither, surfaces and the sky.

Features.part('imposter', (engine, feature) => {
const WGSL_COMMON = /* wgsl */`
struct Globals {
    viewProj: mat4x4f,
    camPos: vec4f,          // w: time
    sunDir: vec4f,          // w: exposure
    sunColor: vec4f,        // w: intensity
    skyTop: vec4f,
    skyHorizon: vec4f,
    ambientSky: vec4f,
    ambientGround: vec4f,   // w: ambient strength
    fog: vec4f,             // w: density
    planes: array<vec4f, 6>,
    lod: vec4f,             // start distance (per 5 m of radius), fade band fraction, far, mode (0 auto, 1 mesh, 2 imposter)
    flags: vec4f,           // frame blend, depth parallax, pixel depth offset, LOD tint
    invViewProj: mat4x4f,
    screen: vec4f,
    light: vec4f,           // x: emission scale (lights on / off)
    camFwd: vec4f,
};
@group(0) @binding(0) var<uniform> G: Globals;

// Cascaded shadow maps. splits: far edge of each cascade (camera view depth); texel: world size of one
// shadow texel per cascade; planes: 6 per cascade (caster culling); params: cascades, map size, tint, enabled
struct Shadow { mats: array<mat4x4f, 4>, splits: vec4f, texel: vec4f, planes: array<vec4f, 24>, params: vec4f };
@group(0) @binding(3) var<uniform> SH: Shadow;
@group(0) @binding(4) var shadowMap: texture_depth_2d_array;
@group(0) @binding(5) var shadowSampler: sampler_comparison;

// The view a pass renders from: the camera (perspective, from eye) or a shadow cascade (orthographic, along dir)
struct View { viewProj: mat4x4f, eye: vec4f, dir: vec4f };      // eye.w: 1 perspective, 0 orthographic; dir.w: 1 cheap (far cascades)
@group(3) @binding(0) var<uniform> V: View;

struct Inst { posScale: vec4f, rot: vec4f, extra: vec4f };

fn qrot(q: vec4f, v: vec3f) -> vec3f {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}
fn qconj(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }
// interleaved gradient noise: the LOD cross-fade dither
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

fn skyColor(rd: vec3f) -> vec3f {
    let L = normalize(G.sunDir.xyz);
    var c = mix(G.skyHorizon.rgb, G.skyTop.rgb, pow(clamp(rd.y, 0.0, 1.0), 0.45));
    c = mix(c, G.fog.rgb, clamp(-rd.y * 6.0, 0.0, 1.0));
    let s = max(dot(rd, L), 0.0);
    return c + G.sunColor.rgb * (pow(s, 900.0) * 30.0 + pow(s, 12.0) * 0.18);
}
fn fogColor(rd: vec3f) -> vec3f {
    let s = max(dot(rd, normalize(G.sunDir.xyz)), 0.0);
    return G.fog.rgb + G.sunColor.rgb * pow(s, 10.0) * 0.12;
}
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

// Surface properties (what meshes read from materials and imposters from their atlases), lit by the
// current lighting scenario. Nothing here is baked, so any lighting works with the same atlases.
struct Surface { albedo: vec3f, n: vec3f, ao: f32, spec: f32, gloss: f32, wrap: f32, emissive: vec3f };
fn shade(s: Surface, wp: vec3f) -> vec3f {
    let L = normalize(G.sunDir.xyz);
    let V = normalize(G.camPos.xyz - wp);
    let ndl = dot(s.n, L);
    let diff = max((ndl + s.wrap) / (1.0 + s.wrap), 0.0);
    let e = exp2(s.gloss * 10.0 + 1.0);                                   // Blinn-Phong exponent 2..2048
    let spec = s.spec * (e + 8.0) / 25.13 * pow(max(dot(s.n, normalize(L + V)), 0.0), e) * max(ndl, 0.0);
    let sun = G.sunColor.rgb * G.sunColor.w * mix(0.6, 1.0, s.ao) * shadowAt(wp, s.n);
    let hemi = mix(G.ambientGround.rgb, G.ambientSky.rgb, s.n.y * 0.5 + 0.5) * G.ambientGround.w * s.ao;
    var c = s.albedo * (sun * diff + hemi) + sun * spec + s.emissive * G.light.x;
    if (SH.params.z > 0.5 && SH.params.w > 0.5 && dot(wp - G.camPos.xyz, G.camFwd.xyz) < SH.splits[3]) {
        c = mix(c, CASCADE_TINT[cascadeOf(wp)] * (0.2 + dot(c, vec3f(0.4))), 0.4);
    }
    return c;
}
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
fn present(c: vec3f) -> vec3f { return pow(aces(c * G.sunDir.w), vec3f(1.0 / 2.2)); }
fn finish(c: vec3f, wp: vec3f) -> vec3f {
    let v = wp - G.camPos.xyz;
    let d = max(length(v), 1e-4);
    return present(mix(c, fogColor(v / d), 1.0 - exp(-d * G.fog.w)));
}
`;

const WGSL_SKY = WGSL_COMMON + /* wgsl */`
struct SOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> SOut {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    var o: SOut;
    o.pos = vec4f(p, 0.0, 1.0);
    o.ndc = p;
    return o;
}
@fragment fn fs(v: SOut) -> @location(0) vec4f {
    let w = G.invViewProj * vec4f(v.ndc, 0.5, 1.0);
    return vec4f(present(skyColor(normalize(w.xyz / w.w - G.camPos.xyz))), 1.0);
}
`;

return { WGSL_COMMON, WGSL_SKY };
});
