'use strict';
// WGSL: instanced meshes and their shadow casters.

Features.part('imposter', (engine, feature) => {
const { WGSL_COMMON } = feature;

// Meshes: instanced from the culled mesh list; extra.x is the LOD fade (1 = fully mesh)
const WGSL_MESH = WGSL_COMMON + /* wgsl */`
// params: alpha cutoff, wrap, uv scale, flip backface normals; surf: specular, gloss; emissive: linear, x strength
struct Mat { color: vec4f, params: vec4f, surf: vec4f, emissive: vec4f };
@group(0) @binding(1) var repSampler: sampler;
@group(1) @binding(0) var<uniform> M: Mat;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(2) @binding(0) var<storage, read> insts: array<Inst>;

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) wp: vec3f,
    @location(1) n: vec3f,
    @location(2) uv: vec2f,
    @location(3) col: vec3f,
    @location(4) @interpolate(flat) fade: f32,
    @location(5) ao: f32,
};
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) col: vec3f, @location(4) ao: f32,
              @builtin(instance_index) ii: u32) -> VOut {
    let I = insts[ii];
    let wp = I.posScale.xyz + qrot(I.rot, p * I.posScale.w);
    var o: VOut;
    o.pos = V.viewProj * vec4f(wp, 1.0);
    o.wp = wp;
    o.n = qrot(I.rot, n);
    o.uv = uv * M.params.z;
    o.col = col;
    o.fade = I.extra.x;
    o.ao = ao;
    return o;
}
@fragment fn fs(v: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
    let t = textureSample(tex, repSampler, v.uv);
    let a = t.a * M.color.a;
    // alpha to coverage, sharpened to about one pixel: antialiased cutout edges without sorting
    let cover = select(1.0, (a - M.params.x) / max(fwidth(a), 1e-4) + 0.5, M.params.x > 0.0);
    if (cover <= 0.0 || ign(v.pos.xy) >= v.fade) { discard; }
    var n = normalize(v.n);
    if (!ff && M.params.w > 0.5) { n = -n; }
    var c = shade(Surface(t.rgb * v.col * M.color.rgb, n, v.ao, M.surf.x, M.surf.y, M.params.y, M.emissive.rgb), v.wp);
    if (G.flags.w > 0.5) { c = mix(c, vec3f(0.15, 0.9, 0.25) * (0.3 + dot(c, vec3f(0.5))), 0.55); }
    return vec4f(finish(c, v.wp), clamp(cover, 0.0, 1.0));
}
// shadow caster: depth only, alpha-tested
@fragment fn fsShadow(v: VOut) {
    if (textureSample(tex, repSampler, v.uv).a * M.color.a < M.params.x) { discard; }
}
`;

return { WGSL_MESH };
});
