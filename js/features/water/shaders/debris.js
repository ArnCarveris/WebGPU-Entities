'use strict';
// WGSL: floating debris drifting with the current.

Features.part('water', (engine, feature) => {
const WGSL_DEBRIS_SIM = /* wgsl */`
struct Deb { dt: f32, time: f32, count: u32, n: i32, mapOrigin: vec2f, cell: f32, minDepth: f32 }
struct Particle { p: vec4f, q: vec4f }     // p: position, age; q: heading, dry time, emitter, seed
struct Emitter { a: vec4f, b: vec4f }      // a: x, z, radius, life; b: colour, size
@group(0) @binding(0) var<uniform> U: Deb;
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(2) var<storage, read> emitters: array<Emitter>;
@group(0) @binding(3) var flowTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var surfTex: texture_2d<f32>;
@group(0) @binding(6) var terrainTex: texture_2d<f32>;

fn rnd(s: ptr<function, u32>) -> f32 {
    *s = *s * 747796405u + 2891336453u;
    var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
    w = (w >> 22u) ^ w;
    return f32(w) / 4294967295.0;
}
fn cellLoad(t: texture_2d<f32>, p: vec2i) -> vec2f { return textureLoad(t, clamp(p, vec2i(0), vec2i(U.n - 1)), 0).xy; }
fn height(xz: vec2f) -> f32 {
    let c = (xz - U.mapOrigin) / U.cell - 0.5;
    let i = vec2i(floor(c));
    let f = c - floor(c);
    var s = array<f32, 4>();
    for (var k = 0; k < 4; k++) {
        let q = i + vec2i(k & 1, k >> 1);
        let sv = cellLoad(surfTex, q).x;
        s[k] = select(sv, cellLoad(terrainTex, q).x, sv < -1e4);
    }
    return mix(mix(s[0], s[1], f.x), mix(s[2], s[3], f.x), f.y);
}

@compute @workgroup_size(64)
fn updateDebris(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= U.count) { return; }
    var pt = parts[i];
    let e = emitters[u32(pt.q.z)];
    let size = U.cell * f32(U.n);
    let fl = textureSampleLevel(flowTex, samp, (pt.p.xz - U.mapOrigin) / size, 0.0);
    if (fl.x > max(U.minDepth * 2.0, e.b.w * 0.1)) {
        pt.p.x += fl.y * U.dt;
        pt.p.z += fl.z * U.dt;
        let sp = length(fl.yz);
        if (sp > 0.05) {
            let heading = atan2(fl.z, fl.y);
            var dh = heading - pt.q.x;
            dh = dh - 6.2831853 * round(dh / 6.2831853);
            pt.q.x += dh * min(1.0, U.dt * 0.6);
        }
        pt.q.x += sin(U.time * 0.7 + pt.q.w * 40.0) * U.dt * 0.15;
        // a little random walk; logs caught in still water count as stranded after a while
        let j = vec2f(sin(U.time * 1.3 + pt.q.w * 91.0), cos(U.time * 1.1 + pt.q.w * 57.0));
        pt.p.x += j.x * U.dt * 0.4;
        pt.p.z += j.y * U.dt * 0.4;
        pt.q.y = select(0.0, pt.q.y + U.dt * 0.1, sp < 0.2);
    } else {
        pt.q.y += U.dt;
    }
    pt.p.w += U.dt;
    let rel = (pt.p.xz - U.mapOrigin) / size;
    let out = any(rel < vec2f(0.005)) || any(rel > vec2f(0.995));
    if (pt.p.w > e.a.w || pt.q.y > 4.0 || out) {
        // respawn at the deepest of a few random spots around the emitter
        var s = i * 9781u + u32(U.time * 1000.0) * 6271u + 1u;
        var best = vec3f(e.a.xy, -1.0);
        for (var k = 0; k < 6; k++) {
            let a = rnd(&s) * 6.2831853;
            let r = sqrt(rnd(&s)) * e.a.z;
            let c = e.a.xy + vec2f(cos(a), sin(a)) * r;
            let d = textureSampleLevel(flowTex, samp, (c - U.mapOrigin) / size, 0.0).x;
            if (d > best.z) { best = vec3f(c, d); }
        }
        pt.p = vec4f(best.x, 0.0, best.y, 0.0);
        pt.q = vec4f(rnd(&s) * 6.2831853, 0.0, pt.q.z, rnd(&s));
    }
    pt.p.y = height(pt.p.xz) + e.b.w * 0.08 + sin(U.time * 1.7 + pt.q.w * 30.0) * 0.05;
    parts[i] = pt;
}
`;

return { WGSL_DEBRIS_SIM };
});
