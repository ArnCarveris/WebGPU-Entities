'use strict';
// WGSL of what shelters and lights the camera: the rain's way, the cabin, the lights.

Features.kit('atmosphere', (engine, kit) => {
const { LIGHT_GRID, LIGHT_SPOT, LIGHT_ROOM } = kit;

// needs F. What shelters the camera and what lights it: the way the rain comes (rainBack), the cabin the camera is in
// (a bus, a lift car, a building: one box in its frame, F.busInv), the lights (LightWriter.write) on surfaces, drops
// and the air. The structures' boxes that shade them (lightSeen, structureLight...) are WGSL_BLOCKERS: the structures
// feature's, a neutral stub without it (shaders/library.js)
const WGSL_SHELTER = /* wgsl */`
// the way the rain (or snow) reaching height y came: back up against its fall, slanted by the wind as the near-field
// drops and flakes are (0.8 of the wind; rain falls at F.rain.y, from 2.5 m/s for drizzle to 10 m/s in a downpour, snow at
// 1.35 m/s, so drizzle and snow blow in further)
fn rainBack(y: f32) -> vec3f {
    let snow = smoothstep(F.precip.x - 250.0, F.precip.x + 250.0, y);
    return normalize(vec3f(-F.wind.x * 0.8, mix(F.rain.y, 1.35, snow), -F.wind.y * 0.8));
}

// The cabin of the bus nearest the camera (or the one ridden): one box in its frame (F.busInv), so the tests are O(1).
// Inside it no rain or snow falls (near-field drops, drips) and the volumetric march takes nothing (rain shafts, haze): a
// rain shelter that moves. Other buses further off only keep the rain off as shader boxes (Structures' blockers).
fn busLocal(p: vec3f) -> vec3f { return (F.busInv * vec4f(p, 1.0)).xyz; }

fn inCabin(p: vec3f) -> bool {
    if (F.cabinLo.w < 0.5) { return false; }
    let q = busLocal(p);
    return all(q > F.cabinLo.xyz) && all(q < F.cabinHi.xyz);
}

// where the ray from o along unit d is inside the cabin: [t in, t out] (t out < t in when it misses)
fn cabinSpan(o: vec3f, d: vec3f) -> vec2f {
    if (F.cabinLo.w < 0.5) { return vec2f(1.0, 0.0); }
    let q = busLocal(o);
    let ld = (F.busInv * vec4f(d, 0.0)).xyz;
    let inv = 1.0 / select(ld, vec3f(1e-6), abs(ld) < vec3f(1e-6));
    let a = (F.cabinLo.xyz - q) * inv;
    let b = (F.cabinHi.xyz - q) * inv;
    let tn = max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z));
    let tf = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
    return vec2f(max(tn, 0.0), tf);
}

// The lights (LightWriter.write): street lamps, porch lights and the bus station's canopy by night, the buses' headlights,
// tail lights and cabin glow, the lit rooms of the buildings near, and the flashlight. Light k at p: its intensity over
// the distance squared, windowed to 0 at its range, inside its cone for a spot; *l is the unit direction to it. Shadows:
// lightSeen
fn lightAt(k: i32, p: vec3f, l: ptr<function, vec3f>) -> vec3f {
    let A = F.lights[k * 4];
    let d = A.xyz - p;
    let d2 = dot(d, d);
    let r2 = A.w * A.w;
    if (d2 >= r2) { return vec3f(0.0); }
    let B = F.lights[k * 4 + 1];
    *l = d * inverseSqrt(max(d2, 1e-6));
    let x = d2 / r2;
    let win = sat(1.0 - x * x);
    var a = win * win / (d2 + F.lights[k * 4 + 3].y);
    if ((u32(F.lights[k * 4 + 3].x) & ${LIGHT_SPOT}u) != 0u) {
        let C = F.lights[k * 4 + 2];
        let c = smoothstep(B.w, C.w, dot(-*l, C.xyz));
        a *= c * c;
    }
    return B.rgb * a;
}

// what the lights give a surface at p (normal n, the view reflected about it r): diffuse irradiance (d) and a normalized
// Blinn-Phong highlight of exponent shin (s, to scale by the Fresnel and gloss as the sky's reflection is). Lights with a
// flag in skip are left out
struct Lamps { d: vec3f, s: vec3f };
fn lampsAt(p: vec3f, n: vec3f, v: vec3f, shin: f32, skip: u32) -> Lamps {
    var o = Lamps(vec3f(0.0), vec3f(0.0));
    let m = lightCell(p);
    for (var w = 0u; w < 2u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            if ((u32(F.lights[k * 4 + 3].x) & skip) != 0u) { continue; }
            var l = vec3f(0.0, 1.0, 0.0);
            let c = lightAt(k, p, &l);
            let nl = dot(n, l);
            if (nl <= 0.0 || c.r + c.g + c.b < 1e-5) { continue; }
            let seen = lightSeen(k, p);
            if (seen <= 0.0) { continue; }
            o.d += c * nl * seen;
            let h = normalize(l + v);
            o.s += c * nl * seen * pow(max(dot(n, h), 0.0), shin) * (shin + 8.0) / (8.0 * PI);
        }
    }
    return o;
}

// the lights that can reach p: bit k of word k / 32 (F.lightGrid; none outside its bounds)
fn lightCell(p: vec3f) -> vec2u {
    let b = F.lightBox;
    if (F.lightInfo.x < 0.5 || any(p.xz <= b.xy) || any(p.xz >= b.zw)) { return vec2u(0u); }
    let c = min(vec2u((p.xz - b.xy) / (b.zw - b.xy) * ${LIGHT_GRID}.0), vec2u(${LIGHT_GRID - 1}u));
    let i = c.y * ${LIGHT_GRID}u + c.x;
    let g = F.lightGrid[i >> 1u];
    return select(g.xy, g.zw, (i & 1u) != 0u);
}

// the lights on a raindrop, snowflake or splash at p (seen from the camera): rain scatters forward, so drops between the eye
// and a lamp glow. Not shadowed (the particles under roofs are gone already), so not the lit rooms (only their windows
// let their light out); lights far from the camera are skipped
fn lampsOnDrop(p: vec3f) -> vec3f {
    var o = vec3f(0.0);
    let e = normalize(F.cam.xyz - p);
    let m = lightCell(p);
    for (var w = 0u; w < 2u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            if ((u32(F.lights[k * 4 + 3].x) & ${LIGHT_ROOM}u) != 0u) { continue; }
            var l = vec3f(0.0, 1.0, 0.0);
            let c = lightAt(k, p, &l);
            o += c * (0.06 + 1.2 * hg(dot(-l, e), 0.6));
        }
    }
    return o;
}

// the stretch of [ta, tb] along the ray from ro along dir inside the cone of light k (apex A, axis D, cos of its edge ce): one
// nappe of a cone is convex, so it is one interval; the quadratic's roots split [ta, tb] into pieces, each inside or not
fn coneSpan(A: vec3f, D: vec3f, ce: f32, ro: vec3f, dir: vec3f, ta: f32, tb: f32) -> vec2f {
    let co = ro - A;
    let dd = dot(dir, D);
    let od = dot(co, D);
    let e2 = ce * ce;
    let a = dd * dd - e2;
    let b = 2.0 * (dd * od - e2 * dot(dir, co));
    let c = od * od - e2 * dot(co, co);
    var r = vec2f(ta, ta);
    let disc = b * b - 4.0 * a * c;
    if (disc >= 0.0 && abs(a) > 1e-7) {
        let s = sqrt(disc);
        let q0 = (-b - s) / (2.0 * a);
        let q1 = (-b + s) / (2.0 * a);
        r = clamp(vec2f(min(q0, q1), max(q0, q1)), vec2f(ta), vec2f(tb));
    }
    var cuts = array<f32, 4>(ta, r.x, r.y, tb);
    var lo = tb;
    var hi = ta;
    for (var i = 0; i < 3; i++) {
        if (cuts[i + 1] <= cuts[i]) { continue; }
        let v = co + dir * (0.5 * (cuts[i] + cuts[i + 1]));
        if (dot(v, D) > ce * length(v)) { lo = min(lo, cuts[i]); hi = max(hi, cuts[i + 1]); }
    }
    return vec2f(lo, hi);
}

// the light the air scatters toward the eye from the lights along the view ray from ro along dir, up to tEnd: their halos in
// rain, snow and mist, the flashlight's and the headlights' beams. Per light, over the ray's chord through its range sphere
// (and a narrow beam's cone), the softened inverse square 1 / (d^2 + size^2) integrates in closed form: the angle the chord
// spans seen from the light, over its softened distance from the ray. The rest (phase, cone, window) is taken where the ray
// passes nearest the light for a wide light, and sampled equiangularly for a narrow beam (dense near the light; jit
// staggers the samples per pixel, the march's history averages them). Not shadowed: the chord ends at the surface in the
// pixel, so a lamp behind a wall adds only the far tail of its halo, which is faint (and in rain the drops round a corner
// do glow). Not the lit rooms: their light is outside only past their windows
fn lampScatter(ro: vec3f, dir: vec3f, tEnd: f32, jit: f32) -> vec3f {
    let sigma = F.lightInfo.w;
    if (sigma <= 0.0) { return vec3f(0.0); }
    var o = vec3f(0.0);
    let cnt = i32(F.lightInfo.x);
    for (var k = 0; k < cnt; k++) {
        if ((u32(F.lights[k * 4 + 3].x) & ${LIGHT_ROOM}u) != 0u) { continue; }
        let A = F.lights[k * 4];
        let oc = A.xyz - ro;
        let tc = dot(oc, dir);
        let h2 = max(dot(oc, oc) - tc * tc, 0.0);
        let r2 = A.w * A.w;
        if (h2 >= r2) { continue; }
        let hc = sqrt(r2 - h2);
        var ta = max(tc - hc, 0.0);
        var tb = min(tc + hc, tEnd);
        if (tb <= ta) { continue; }
        let B = F.lights[k * 4 + 1];
        let C = F.lights[k * 4 + 2];
        let spot = (u32(F.lights[k * 4 + 3].x) & ${LIGHT_SPOT}u) != 0u;
        let narrow = spot && B.w >= 0.5;
        if (narrow) {
            let cs = coneSpan(A.xyz, C.xyz, B.w, ro, dir, ta, tb);
            ta = cs.x;
            tb = cs.y;
            if (tb <= ta) { continue; }
        }
        let hs = sqrt(h2 + F.lights[k * 4 + 3].y);
        let a0 = atan2(ta - tc, hs);
        let a1 = atan2(tb - tc, hs);
        let n = select(1, 4, narrow);
        var acc = 0.0;
        for (var j = 0; j < n; j++) {
            var t = clamp(tc, ta, tb);
            if (narrow) { t = tc + hs * tan(mix(a0, a1, (f32(j) + jit) / 4.0)); }
            let d = A.xyz - (ro + dir * t);
            let d2 = dot(d, d);
            let l = d * inverseSqrt(max(d2, 1e-6));
            let x = d2 / r2;
            let win = sat(1.0 - x * x);
            var c = win * win * exp(-sigma * t) * (0.04 + hg(dot(dir, l), 0.7));
            if (spot) { let q = smoothstep(B.w, C.w, dot(-l, C.xyz)); c *= q * q; }
            acc += c;
        }
        o += B.rgb * acc / f32(n) * (a1 - a0) / hs;
    }
    return o * sigma;
}
`;

// The frame of an object drawn in its own (each bus, each building's Origin: Renderer.busData, BUS_UNIFORM bytes each, at a
// dynamic offset): to clip space (built in doubles about the camera, so it does not jitter), to world and back, and its
// info (a bus: speed m/s, doors open 0..1; a building: the storey its frame is on). The scene module binds it as group
// 1, the final one as group 2
const BUS_UNIFORM = 256;
const wgslObject = group => /* wgsl */`
struct BusDraw { mvp: mat4x4f, model: mat4x4f, inv: mat4x4f, info: vec4f };
@group(${group}) @binding(0) var<uniform> busU: BusDraw;
`;

return { WGSL_SHELTER, BUS_UNIFORM, wgslObject };
});
