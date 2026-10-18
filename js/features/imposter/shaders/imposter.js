'use strict';
// WGSL: drawing imposters (and their shadows) from the atlas.

Features.part('imposter', (engine, feature) => {
const { imposterWGSL } = engine.kits.imposter;
const { WGSL_COMMON } = feature;

// Imposter: a quad facing the view that covers the bounding sphere. The vertex stage picks the three atlas
// frames around the view direction (in the instance's own space) and their weights; the fragment stage
// intersects the pixel's view ray with each frame's plane, refines the hit with the baked depth
// (parallax), samples and blends (the imposter kit's impCorner / impFrames / impReconstruct). fs lights the result
// and writes the reconstructed depth; fsShadow (from a cascade's orthographic light view) writes only that depth, so
// imposters cast their real shape.
const WGSL_IMPOSTER = WGSL_COMMON + imposterWGSL({ group: 1 }) + /* wgsl */`
@group(2) @binding(0) var<storage, read> insts: array<Inst>;

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
    let c = I.posScale.xyz + qrot(I.rot, impAtlas.bound.xyz * s);
    let R = impAtlas.bound.w * s;
    let q = IMP_QUAD[vi];
    let K = impCorner(c, R, V.eye, V.dir.xyz, q);
    let F = impFrames(qrot(qconj(I.rot), K.toView), G.flags.x > 0.5 && V.dir.w < 0.5);
    var o: VOut;
    o.wp = K.wp;
    o.pos = V.viewProj * vec4f(o.wp, 1.0);
    o.q = q;
    o.cellsA = F.cellsA;
    o.cellsB = vec4f(F.cell2, I.extra.x, R);
    o.w = F.w;
    o.center = c;
    o.rot = I.rot;
    return o;
}

fn frames(v: VOut) -> ImpFrames { return ImpFrames(v.cellsA, v.cellsB.xy, v.w); }

// the pixel's view ray in the instance's space, in units of its bounding radius
struct Ray { o: vec3f, d: vec3f };
fn viewRay(v: VOut) -> Ray {
    let size = v.cellsB.w;
    let iq = qconj(v.rot);
    var ro = qrot(iq, v.wp - v.center) / size;
    var rd = qrot(iq, V.dir.xyz);
    if (V.eye.w > 0.5) {
        ro = qrot(iq, V.eye.xyz - v.center) / size;
        rd = normalize(qrot(iq, v.wp - V.eye.xyz));
    }
    return Ray(ro, rd);
}

struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(v: VOut) -> FOut {
    let ray = viewRay(v);
    let R = impReconstruct(ray.o, ray.d, frames(v), G.flags.y > 0.5, true);
    let a = R.albedo.a;
    let cover = impSharpen(a);
    var out: FOut;
    out.depth = v.pos.z;
    let edge = G.flags.w > 0.5 && max(abs(v.q.x), abs(v.q.y)) > 0.985;
    if (edge && cover < 1.0) {                                      // LOD tint: outline the billboard
        out.color = vec4f(0.35, 0.6, 1.0, 1.0);
        return out;
    }
    if (cover <= 0.0 || a < 0.02 || ign(v.pos.xy) < v.cellsB.z) { discard; }
    let S = impResolve(R);
    let wp = v.center + qrot(v.rot, S.hit * v.cellsB.w);
    var c = shade(Surface(S.albedo, qrot(v.rot, S.n), S.surface.x, S.surface.y, S.surface.z, S.surface.w, S.emissive), wp);
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

return { WGSL_IMPOSTER };
});
