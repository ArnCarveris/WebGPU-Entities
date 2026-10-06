'use strict';
// WGSL for structures in the shaders: boxes that shade sun and rain, lamps, buildings and the bus cabin.

Features.part('cloud', (engine, feature) => {
const { BLOCK_GRID, LIGHT_GRID, LIGHT_SPOT, BUS_LEAF } = feature;

// needs F. Structures (houses, the bus stop, bridge decks) stand in the shaders as up to MAX_BLOCKERS boxes, each turned
// by its yaw and sheared along its local x by a slope (bridge decks follow their arch). Box k in F.blockers:
//   [centre x, z, half size along local x, z] [cos yaw, sin yaw, bottom, top (m, at the centre)] [sky occlusion, slope, -, -]
// A grid over their bounds (F.blockGrid, built each frame for the sun and the wind) lists the boxes each cell's rays can
// reach, so a point tests only those.
// Local x runs along (cos, sin) in xz, local z along (-sin, cos). The boxes cast sun shadows, and rain cannot fall
// through them: a point is dry where the path its drops came along (back up against their fall, slanted by the wind)
// crosses a box. So the ground, the near-field drops and the shafts stay dry under roofs and decks and in the lee of walls.
const WGSL_SHELTER = /* wgsl */`
// p can be shaded by a structure: inside the boxes' bounds (padded for long shadows and slanted rain), below the tallest
fn nearStructures(p: vec3f) -> bool {
    let b = F.blockBox;
    return F.blocks.x > 0.5 && p.y < F.blocks.z && all(p.xz > b.xy) && all(p.xz < b.zw);
}

// the boxes that can shade p (call when nearStructures(p)): bit k of word k / 32
fn blockCell(p: vec3f) -> vec4u {
    let b = F.blockBox;
    let c = min(vec2u((p.xz - b.xy) / (b.zw - b.xy) * ${BLOCK_GRID}.0), vec2u(${BLOCK_GRID - 1}u));
    return F.blockGrid[c.y * ${BLOCK_GRID}u + c.x];
}

// where the ray from o along d is inside box k: [t in, t out]
fn blockerSpan(k: i32, o: vec3f, d: vec3f) -> vec2f {
    let A = F.blockers[k * 3];
    let B = F.blockers[k * 3 + 1];
    let slope = F.blockers[k * 3 + 2].y;
    let r = o.xz - A.xy;
    let lx = r.x * B.x + r.y * B.y;
    let dx = d.x * B.x + d.z * B.y;
    let lo = vec3f(lx, o.y - slope * lx, -r.x * B.y + r.y * B.x);
    let ld = vec3f(dx, d.y - slope * dx, -d.x * B.y + d.z * B.x);
    let inv = 1.0 / select(ld, vec3f(1e-6), abs(ld) < vec3f(1e-6));
    let a = (vec3f(-A.z, B.z, -A.w) - lo) * inv;
    let b = (vec3f(A.z, B.w, A.w) - lo) * inv;
    return vec2f(max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z)), min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z)));
}

// the ray from o along d enters box k (a ray starting inside a box does not count, so surfaces do not shade themselves)
fn blockerHit(k: i32, o: vec3f, d: vec3f) -> bool {
    let s = blockerSpan(k, o, d);
    return s.x > 0.02 && s.x <= s.y;
}

// box k keeps the rain coming down along -r off p: the way back up enters it, or p is inside it and it is enclosed (a
// building's interior, Buildings.add: sheltered however the wind blows). One span either way (a ray from inside
// starts before the box's near side)
fn blockerRain(k: i32, p: vec3f, r: vec3f) -> bool {
    let s = blockerSpan(k, p, r);
    return (s.x > 0.02 && s.x <= s.y) || (F.blockers[k * 3 + 2].w > 0.5 && s.x < 0.0 && s.y > 0.0);
}

// the way the rain (or snow) reaching height y came: back up against its fall, slanted by the wind as the near-field
// drops and flakes are (0.8 of the wind; rain falls at F.rain.y, from 2.5 m/s for drizzle to 10 m/s in a downpour, snow at
// 1.35 m/s, so drizzle and snow blow in further)
fn rainBack(y: f32) -> vec3f {
    let snow = smoothstep(F.precip.x - 250.0, F.precip.x + 250.0, y);
    return normalize(vec3f(-F.wind.x * 0.8, mix(F.rain.y, 1.35, snow), -F.wind.y * 0.8));
}

// 1 where rain reaches p, 0 where a structure keeps it off
fn rainReaches(p: vec3f) -> f32 {
    if (!nearStructures(p)) { return 1.0; }
    let r = rainBack(p.y);
    let m = blockCell(p);
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            if (blockerRain(k, p, r)) { return 0.0; }
            bits &= bits - 1u;
        }
    }
    return 1.0;
}

// at a surface point p: x the sun reaches it, y the rain reaches it, z sky light left (less under roofs and decks).
// sun / rain false skip those tests (sun already shadowed by cloud, or the ground is dry anyway)
fn structureLight(p: vec3f, sun: bool, rain: bool) -> vec3f {
    var o = vec3f(1.0);
    if (!nearStructures(p)) { return o; }
    let s = F.sunDir.xyz;
    let doSun = sun && s.y > 0.0;
    let r = rainBack(p.y);
    let m = blockCell(p);
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            if (doSun && o.x > 0.0 && blockerHit(k, p, s)) { o.x = 0.0; }
            // a moving box (the bus) does not leave a dry patch: the ground it passes over stays wet
            if (rain && o.y > 0.0 && F.blockers[k * 3 + 2].z < 0.5 && blockerRain(k, p, r)) { o.y = 0.0; }
            let ao = F.blockers[k * 3 + 2].x;
            if (ao > 0.0 && blockerHit(k, p, vec3f(0.0, 1.0, 0.0))) { o.z = min(o.z, 1.0 - ao); }
        }
    }
    return o;
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
// tail lights and cabin glow, and the flashlight. Light k at p: its intensity over the distance squared, windowed to 0 at
// its range, inside its cone for a spot; *l is the unit direction to it. No shadows (lightSeen)
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

// no box between p and light k blocks it: the boxes it can reach (F.lightMask), entered between the two, or an enclosed
// one (a building's shell) that holds p but not the light, so walls keep the street lamps out of the rooms and a flashlight
// in a room in it
fn lightSeen(k: i32, p: vec3f) -> bool {
    let L = F.lights[k * 4].xyz - p;
    let eps = 0.02 / max(length(L), 0.05);
    let m = F.lightMask[k];
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let b = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            let s = blockerSpan(b, p, L);
            if (s.x > eps && s.x <= s.y && s.x < 1.0) { return false; }
            if (F.blockers[b * 3 + 2].w > 0.5 && s.x < 0.0 && s.y > 0.0 && s.y < 1.0) { return false; }
        }
    }
    return true;
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
            if (!lightSeen(k, p)) { continue; }
            o.d += c * nl;
            let h = normalize(l + v);
            o.s += c * nl * pow(max(dot(n, h), 0.0), shin) * (shin + 8.0) / (8.0 * PI);
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
// and a lamp glow. Not shadowed (the particles under roofs are gone already); lights far from the camera are skipped
fn lampsOnDrop(p: vec3f) -> vec3f {
    var o = vec3f(0.0);
    let e = normalize(F.cam.xyz - p);
    let m = lightCell(p);
    for (var w = 0u; w < 2u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
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
// do glow)
fn lampScatter(ro: vec3f, dir: vec3f, tEnd: f32, jit: f32) -> vec3f {
    let sigma = F.lightInfo.w;
    if (sigma <= 0.0) { return vec3f(0.0); }
    var o = vec3f(0.0);
    let cnt = i32(F.lightInfo.x);
    for (var k = 0; k < cnt; k++) {
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

// needs F, buildings. Building `id` (Buildings.add) in buildings[id * 4 ..]:
//   [centre x, z, cos yaw, sin yaw] [half size x, z, floor (m), storey height] [storeys, sill, window height, pitch]
//   [window width, wall thickness, share of storeys lit, faces with windows (bits: 1 -z, 2 +z, 4 -x, 8 +x)]
// Its interior, glass and door vertices carry material + id * BLD_ID. All of it is O(1) per pixel: the window pattern is
// a formula (the same one the mesh was built with), so the sun through a window is one box exit.
const WGSL_BUILDING = /* wgsl */`
struct Bld { a: vec4f, b: vec4f, c: vec4f, d: vec4f };
fn bld(id: u32) -> Bld { let k = id * 4u; return Bld(buildings[k], buildings[k + 1u], buildings[k + 2u], buildings[k + 3u]); }

// world to the building's frame (local x along (cos, sin), z along (-sin, cos), y stays the world height), and back
fn bldLocal(b: Bld, p: vec3f) -> vec3f { let r = p.xz - b.a.xy; return vec3f(r.x * b.a.z + r.y * b.a.w, p.y, -r.x * b.a.w + r.y * b.a.z); }
fn bldDir(b: Bld, d: vec3f) -> vec3f { return vec3f(d.x * b.a.z + d.z * b.a.w, d.y, -d.x * b.a.w + d.z * b.a.z); }
fn bldWorld(b: Bld, q: vec3f) -> vec3f { return vec3f(b.a.x + q.x * b.a.z - q.z * b.a.w, q.y, b.a.y + q.x * b.a.w + q.z * b.a.z); }
fn bldCentre(b: Bld) -> vec3f { return vec3f(b.a.x, b.b.z + b.c.x * b.b.w * 0.5, b.a.y); }
fn bldStorey(b: Bld, y: f32) -> f32 { return clamp(floor((y - b.b.z) / b.b.w), 0.0, b.c.x - 1.0); }

// the lamps of storey s are on: a share of the storeys (b.d.z), picked by a hash
fn storeyLit(id: u32, b: Bld, s: f32) -> f32 { return select(0.0, 1.0, rnd(id * 131u + u32(s) * 7u + 3u) < b.d.z); }

// u along a wall len m long, yr above its storey's floor, is in a window: they are spread evenly over the wall, keeping
// clear of its corners (as Buildings.add lays them out)
fn inWindow(b: Bld, u: f32, len: f32, yr: f32) -> bool {
    let usable = len - 2.0 * (b.d.y + 0.2);
    let nw = max(1.0, floor(usable / b.c.w));
    let cell = usable / nw;
    let k = (u + usable * 0.5) / cell;
    return k >= 0.0 && k < nw && abs(fract(k) - 0.5) * cell < b.d.x * 0.5 && yr > b.c.y && yr < b.c.y + b.c.z;
}

// the ray from q (building frame, inside) along local d leaves the building through a window of q's own storey (the floors
// above and below it are in the way of the others): xyz where it leaves, w 1 if through glass
fn throughWindow(b: Bld, q: vec3f, d: vec3f) -> vec4f {
    let lo = vec3f(-b.b.x, b.b.z, -b.b.y);
    let hi = vec3f(b.b.x, b.b.z + b.c.x * b.b.w, b.b.y);
    let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
    let t = max((lo - q) * inv, (hi - q) * inv);
    let te = min(t.x, min(t.y, t.z));
    let e = q + d * te;
    let yr = e.y - b.b.z - bldStorey(b, q.y) * b.b.w;
    if (te == t.y || yr < 0.0 || yr > b.b.w) { return vec4f(e, 0.0); }
    let faces = u32(b.d.w + 0.5);
    var hit = false;
    if (te == t.x) { hit = inWindow(b, e.z, 2.0 * b.b.y, yr) && (faces & select(4u, 8u, d.x > 0.0)) != 0u; }
    else { hit = inWindow(b, e.x, 2.0 * b.b.x, yr) && (faces & select(1u, 2u, d.z > 0.0)) != 0u; }
    return vec4f(e, select(0.0, 1.0, hit));
}

// what a lamp-lit room adds to a window seen from outside
fn windowGlow(id: u32, b: Bld, y: f32) -> vec3f { return vec3f(1.0, 0.86, 0.62) * 0.1 / max(F.sunCol.w, 0.2) * storeyLit(id, b, bldStorey(b, y)); }
`;

// One bus as it is drawn (each bus of each BusLine in turn, at a dynamic offset of BUS_UNIFORM bytes): its frame to clip
// space (built in doubles about the camera, so it does not jitter), to world and back, its speed (m/s) and doors open
// (0..1). The scene module binds it as group 1 (vsBus, fsBus), the final one as group 2 (the glass)
const BUS_UNIFORM = 256;
const wgslBus = group => /* wgsl */`
struct BusDraw { mvp: mat4x4f, model: mat4x4f, inv: mat4x4f, info: vec4f };
@group(${group}) @binding(0) var<uniform> busU: BusDraw;

// a bus vertex in its frame: door leaves (material flags ${BUS_LEAF[0]}, ${BUS_LEAF[1]}) slide apart outside the body as the doors open
fn busVertex(p: vec3f, mat: f32) -> vec3f {
    let m = u32(mat + 0.5);
    let o = busU.info.y;
    if ((m & ${BUS_LEAF[0]}u) != 0u) { return p + vec3f(-0.6 * o, 0.0, 0.07 * smoothstep(0.0, 0.25, o)); }
    if ((m & ${BUS_LEAF[1]}u) != 0u) { return p + vec3f(0.6 * o, 0.0, 0.07 * smoothstep(0.0, 0.25, o)); }
    return p;
}
`;

return { WGSL_SHELTER, WGSL_BUILDING, BUS_UNIFORM, wgslBus };
});
