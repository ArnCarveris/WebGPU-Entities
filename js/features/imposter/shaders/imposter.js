'use strict';
// WGSL: drawing imposters (and their shadows) from the atlas.

Features.part('imposter', (engine, feature) => {
const { EMISSIVE_RANGE, WGSL_COMMON } = feature;

// Imposter: a quad facing the view that covers the bounding sphere. The vertex stage picks the three atlas
// frames around the view direction (in the instance's own space) and their weights; the fragment stage
// intersects the pixel's view ray with each frame's plane, refines the hit with the baked depth
// (parallax), samples and blends. fs lights the result and writes the reconstructed depth; fsShadow (from
// a cascade's orthographic light view) writes only that depth, so imposters cast their real shape.
const WGSL_IMPOSTER = WGSL_COMMON + /* wgsl */`
struct Imp { bound: vec4f, grid: vec4f };       // bound: centre, radius; grid: frames per side, full, 1 / frames, uv inset
@group(0) @binding(2) var clampSampler: sampler;
@group(1) @binding(0) var<uniform> A: Imp;
@group(1) @binding(1) var albedoTex: texture_2d<f32>;
@group(1) @binding(2) var normalTex: texture_2d<f32>;
@group(1) @binding(3) var surfaceTex: texture_2d<f32>;
@group(1) @binding(4) var emissiveTex: texture_2d<f32>;        // 1 x 1 black when the model has no emission
@group(2) @binding(0) var<storage, read> insts: array<Inst>;

var<private> QUAD: array<vec2f, 6> = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

fn signNZ(v: vec2f) -> vec2f { return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0)); }
fn octEncode(d: vec3f, full: bool) -> vec2f {
    if (full) {
        let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
        var p = n.xz;
        if (n.y < 0.0) { p = (1.0 - abs(p.yx)) * signNZ(p); }
        return p;
    }
    let h = vec3f(d.x, max(d.y, 0.0), d.z);
    let n = h / max(abs(h.x) + abs(h.y) + abs(h.z), 1e-6);
    return vec2f(n.x + n.z, n.z - n.x);
}
fn octDecode(p: vec2f, full: bool) -> vec3f {
    var n: vec3f;
    if (full) {
        n = vec3f(p.x, 1.0 - abs(p.x) - abs(p.y), p.y);
        if (n.y < 0.0) {
            let s = signNZ(n.xz);
            n = vec3f((1.0 - abs(p.y)) * s.x, n.y, (1.0 - abs(p.x)) * s.y);
        }
    } else {
        let o = vec2f(p.x - p.y, p.x + p.y) * 0.5;
        n = vec3f(o.x, 1.0 - abs(o.x) - abs(o.y), o.y);
    }
    return normalize(n);
}
fn frameRight(d: vec3f) -> vec3f {
    if (abs(d.y) > 0.9999) { return vec3f(1.0, 0.0, 0.0); }
    return normalize(vec3f(d.z, 0.0, -d.x));
}
fn cellDir(c: vec2f) -> vec3f { return octDecode(c / (A.grid.x - 1.0) * 2.0 - 1.0, A.grid.y > 0.5); }
fn atlasUV(c: vec2f, uv: vec2f) -> vec2f { return (c + clamp(uv, vec2f(A.grid.w), vec2f(1.0 - A.grid.w))) * A.grid.z; }

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) wp: vec3f,
    @location(1) q: vec2f,
    @location(2) @interpolate(flat) cellsA: vec4f,      // frames 0 and 1 (x, y)
    @location(3) @interpolate(flat) cellsB: vec4f,      // frame 2 (x, y), fade, world radius
    @location(4) @interpolate(flat) w: vec3f,
    @location(5) @interpolate(flat) center: vec3f,
    @location(6) @interpolate(flat) rot: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let I = insts[ii];
    let s = I.posScale.w;
    let c = I.posScale.xyz + qrot(I.rot, A.bound.xyz * s);
    let R = A.bound.w * s;
    var v = -V.dir.xyz;                 // toward the viewer
    var ext = R;                        // orthographic: the silhouette is the sphere's radius
    if (V.eye.w > 0.5) {
        let toCam = V.eye.xyz - c;
        let dist = max(length(toCam), 1e-4);
        v = toCam / dist;
        // the sphere's silhouette cone, cut by the plane through its centre
        ext = select(R * 4.0, R * dist / sqrt(max(dist * dist - R * R, 1e-6)), dist > R * 1.05);
    }
    var right = vec3f(1.0, 0.0, 0.0);
    if (abs(v.y) < 0.9999) { right = normalize(cross(vec3f(0.0, 1.0, 0.0), v)); }
    let up = cross(v, right);
    let q = QUAD[vi];
    var o: VOut;
    o.wp = c + (right * q.x + up * q.y) * ext;
    o.pos = V.viewProj * vec4f(o.wp, 1.0);
    o.q = q;
    let N = A.grid.x;
    let g = clamp((octEncode(qrot(qconj(I.rot), v), A.grid.y > 0.5) * 0.5 + 0.5) * (N - 1.0), vec2f(0.0), vec2f(N - 1.0));
    if (G.flags.x > 0.5 && V.dir.w < 0.5) {
        let b = min(floor(g), vec2f(N - 2.0));
        let f = g - b;
        if (f.x > f.y) {
            o.cellsA = vec4f(b, b + vec2f(1.0, 0.0));
            o.w = vec3f(1.0 - f.x, f.x - f.y, f.y);
        } else {
            o.cellsA = vec4f(b, b + vec2f(0.0, 1.0));
            o.w = vec3f(1.0 - f.y, f.y - f.x, f.x);
        }
        o.cellsB = vec4f(b + 1.0, I.extra.x, R);
    } else {
        let r = round(g);
        o.cellsA = vec4f(r, r);
        o.cellsB = vec4f(r, I.extra.x, R);
        o.w = vec3f(1.0, 0.0, 0.0);
    }
    o.center = c;
    o.rot = I.rot;
    return o;
}

// the blended surface along this pixel's view ray, premultiplied by coverage (albedo.a); full: all layers
struct Recon { albedo: vec4f, normal: vec4f, surface: vec4f, emissive: vec3f, hit: vec3f };
fn reconstruct(v: VOut, full: bool) -> Recon {
    let size = v.cellsB.w;
    let iq = qconj(v.rot);
    // the view ray in the object's space, in units of the bounding radius
    var ro = qrot(iq, v.wp - v.center) / size;
    var rd = qrot(iq, V.dir.xyz);
    if (V.eye.w > 0.5) {
        ro = qrot(iq, V.eye.xyz - v.center) / size;
        rd = normalize(qrot(iq, v.wp - V.eye.xyz));
    }
    var cells = array<vec2f, 3>(v.cellsA.xy, v.cellsA.zw, v.cellsB.xy);
    var ws = v.w;
    var o = Recon(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec3f(0.0), vec3f(0.0));
    for (var k = 0; k < 3; k++) {
        let cell = cells[k];
        let d = cellDir(cell);
        let r = frameRight(d);
        let u = cross(d, r);
        let den = min(dot(rd, d), -1e-4);
        var h = ro + rd * (-dot(ro, d) / den);                   // hit on the frame's plane through the centre
        let uv0 = vec2f(dot(h, r), -dot(h, u)) * 0.5 + 0.5;
        let gx = dpdx(uv0) * A.grid.z;
        let gy = dpdy(uv0) * A.grid.z;
        var uv = uv0;
        if (G.flags.y > 0.5) {
            let a0 = textureSampleGrad(albedoTex, clampSampler, atlasUV(cell, uv0), gx, gy).a;
            let d0 = textureSampleGrad(normalTex, clampSampler, atlasUV(cell, uv0), gx, gy).a;
            if (a0 > 0.02) {                                        // move to the baked surface depth and reproject
                h = ro + rd * ((d0 / a0 * 2.0 - 1.0 - dot(ro, d)) / den);
                uv = vec2f(dot(h, r), -dot(h, u)) * 0.5 + 0.5;
            }
        }
        let inside = select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
        let auv = atlasUV(cell, uv);
        let wk = ws[k] * inside;
        let ca = textureSampleGrad(albedoTex, clampSampler, auv, gx, gy);
        o.albedo += ca * wk;
        o.normal += textureSampleGrad(normalTex, clampSampler, auv, gx, gy) * wk;
        o.hit += h * (ca.a * wk);
        if (full) {
            o.surface += textureSampleGrad(surfaceTex, clampSampler, auv, gx, gy) * wk;
            o.emissive += textureSampleGrad(emissiveTex, clampSampler, auv, gx, gy).rgb * wk;
        }
    }
    return o;
}

struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(v: VOut) -> FOut {
    let R = reconstruct(v, true);
    let a = R.albedo.a;
    let cover = (a - 0.5) / max(fwidth(a), 1e-4) + 0.5;           // sharpened alpha to coverage
    var out: FOut;
    out.depth = v.pos.z;
    let edge = G.flags.w > 0.5 && max(abs(v.q.x), abs(v.q.y)) > 0.985;
    if (edge && cover < 1.0) {                                      // LOD tint: outline the billboard
        out.color = vec4f(0.35, 0.6, 1.0, 1.0);
        return out;
    }
    if (cover <= 0.0 || a < 0.02 || ign(v.pos.xy) < v.cellsB.z) { discard; }
    // premultiplied by coverage: divide by the blended coverage to get the surface back
    let n = qrot(v.rot, normalize((R.normal.xyz / a) * 2.0 - 1.0));
    let sf = R.surface / a;
    let wp = v.center + qrot(v.rot, R.hit / a * v.cellsB.w);
    var c = shade(Surface(R.albedo.rgb / a, n, sf.x, sf.y, sf.z, sf.w, R.emissive / a * ${EMISSIVE_RANGE}.0), wp);
    if (G.flags.w > 0.5) { c = mix(c, vec3f(0.25, 0.45, 1.0) * (0.3 + dot(c, vec3f(0.5))), 0.55); }
    out.color = vec4f(finish(c, wp), clamp(cover, 0.0, 1.0));
    if (G.flags.z > 0.5) {
        let cp = V.viewProj * vec4f(wp, 1.0);
        out.depth = clamp(cp.z / cp.w, 0.0, 1.0);
    }
    return out;
}

// far-cascade caster: the nearest frame's coverage only, depth of the quad (no depth output keeps early-z)
@fragment fn fsShadowCheap(v: VOut) {
    let iq = qconj(v.rot);
    let ro = qrot(iq, v.wp - v.center) / v.cellsB.w;
    let rd = qrot(iq, V.dir.xyz);
    let cell = v.cellsA.xy;
    let d = cellDir(cell);
    let r = frameRight(d);
    let h = ro + rd * (-dot(ro, d) / min(dot(rd, d), -1e-4));
    let uv = vec2f(dot(h, r), -dot(h, cross(d, r))) * 0.5 + 0.5;
    let a = textureSampleGrad(albedoTex, clampSampler, atlasUV(cell, uv), dpdx(uv) * A.grid.z, dpdy(uv) * A.grid.z).a;
    if (a < 0.5 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { discard; }
}

// shadow caster: the reconstructed surface's depth in the cascade
@fragment fn fsShadow(v: VOut) -> @builtin(frag_depth) f32 {
    let R = reconstruct(v, false);
    let a = R.albedo.a;
    if (a < 0.5) { discard; }
    let cp = V.viewProj * vec4f(v.center + qrot(v.rot, R.hit / a * v.cellsB.w), 1.0);
    return clamp(cp.z / cp.w, 0.0, 1.0);
}
`;

return { WGSL_IMPOSTER };
});
