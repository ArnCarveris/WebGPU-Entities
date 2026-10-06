'use strict';
// WGSL: the atlas overlay.

Features.part('imposter', (engine, feature) => {
// Atlas overlay: the focused model's atlas with its frame grid; the three frames in use are outlined
const WGSL_OVERLAY = /* wgsl */`
struct Ov { rect: vec4f, c01: vec4f, c2: vec4f, w: vec4f };    // c2: frame 2 (x, y), frames per side, view
@group(0) @binding(0) var<uniform> O: Ov;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var ta: texture_2d<f32>;
@group(0) @binding(3) var tn: texture_2d<f32>;
@group(0) @binding(4) var ts: texture_2d<f32>;
@group(0) @binding(5) var te: texture_2d<f32>;
var<private> Q01: array<vec2f, 6> = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
    let c = Q01[i];
    var o: VO;
    o.pos = vec4f(mix(O.rect.xy, O.rect.zw, c), 0.0, 1.0);
    o.uv = c;
    return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
    let a = textureSample(ta, smp, v.uv);
    let n = textureSample(tn, smp, v.uv);
    let sf = textureSample(ts, smp, v.uv);
    let em = textureSample(te, smp, v.uv);
    let g = v.uv * O.c2.z;
    let fw = max(fwidth(g), vec2f(1e-5));
    let chk = select(0.13, 0.19, (i32(floor(v.uv.x * 48.0)) + i32(floor(v.uv.y * 48.0))) % 2 == 0);
    let bg = vec3f(chk) * (1.0 - a.a);
    var c: vec3f;
    if (O.c2.w < 1.5) { c = pow(a.rgb, vec3f(1.0 / 2.2)) + bg; }
    else if (O.c2.w < 2.5) { c = n.rgb + bg; }
    else if (O.c2.w < 3.5) { c = vec3f(n.a) + bg; }
    else if (O.c2.w < 4.5) { c = vec3f(sf.r) + bg; }
    else if (O.c2.w < 5.5) { c = sf.gba + bg; }
    else { c = pow(em.rgb, vec3f(1.0 / 2.2)) + bg; }
    let e = min(fract(g), 1.0 - fract(g)) / fw;                   // pixels to the cell edge
    c = mix(c, vec3f(0.43, 0.86, 1.0), (1.0 - clamp(min(e.x, e.y), 0.0, 1.0)) * 0.35);
    let cell = floor(g);
    var hl = 0.0;
    if (all(cell == O.c01.xy)) { hl = max(hl, O.w.x); }
    if (all(cell == O.c01.zw)) { hl = max(hl, O.w.y); }
    if (all(cell == O.c2.xy)) { hl = max(hl, O.w.z); }
    let border = 1.0 - clamp(min(e.x, e.y) - 1.5, 0.0, 1.0);
    c = mix(c, vec3f(1.0, 0.55, 0.1), step(0.001, hl) * (border * (0.5 + 0.5 * hl) + 0.15 * hl));
    return vec4f(c, 1.0);
}
`;

return { WGSL_OVERLAY };
});
