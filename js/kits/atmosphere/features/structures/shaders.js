'use strict';
// WGSL of the structures: the boxes that shade sun, rain and lights (in place of the core's stubs), the buildings'
// records, the structures' meshes, interiors, doors, panes and distant lights in the scene, the windows' glass and the
// drops running off the roofs in the final pass.

Features.feature('atmosphere/structures', (engine, kit) => {
const { LIGHT_CABIN, LIGHT_ROOM, POOL_ALBEDO, POLE_DRAW } = kit;
const { BLOCK_GRID, INTERIOR_DRAW, BLD_ID, BLD_LIT, BLD_STACK, BLD_DARK } = engine.kits.settlement;

// needs F. Structures (houses, the bus stop, bridge decks) stand in the shaders as up to MAX_BLOCKERS boxes, each turned
// by its yaw and sheared along its local x by a slope (bridge decks follow their arch). Box k in F.blockers:
//   [centre x, z, half size along local x, z] [cos yaw, sin yaw, bottom, top (m, at the centre)] [sky occlusion, slope, -, -]
// A grid over their bounds (F.blockGrid, built each frame for the sun and the wind) lists the boxes each cell's rays can
// reach, so a point tests only those.
// Local x runs along (cos, sin) in xz, local z along (-sin, cos). The boxes cast sun shadows, and rain cannot fall
// through them: a point is dry where the path its drops came along (back up against their fall, slanted by the wind)
// crosses a box. So the ground, the near-field drops and the shafts stay dry under roofs and decks and in the lee of walls.
const WGSL_BLOCKERS = /* wgsl */`
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

// how much of light k reaches p past the boxes it can reach (F.lightMask): one entered between the two blocks it, as does
// an enclosed one that holds p but not the light; but where a building's shell (blockers .w = 2 + its id) has p on one
// side and the light on the other, the light passes its windows and open doors (bldPass, WGSL_BUILDING): the street lamps
// and headlights shine into the rooms through them, a lit room or a flashlight in it out onto the street
fn lightSeen(k: i32, p: vec3f) -> f32 {
    let A = F.lights[k * 4].xyz;
    let L = A - p;
    let eps = 0.02 / max(length(L), 0.05);
    let size = sqrt(F.lights[k * 4 + 3].y);
    let m = F.lightMask[k];
    var vis = 1.0;
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let b = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            let s = blockerSpan(b, p, L);
            let encl = F.blockers[b * 3 + 2].w;
            let into = s.x > eps && s.x <= s.y && s.x < 1.0;                 // entered on the way to the light
            let held = encl > 0.5 && s.x < 0.0 && s.y > 0.0 && s.y < 1.0;     // holds p, not the light
            if (!into && !held) { continue; }
            if (encl < 1.5 || (into && s.y < 1.0)) { return 0.0; }          // not a shell, or in and out of it again
            vis *= bldPass(u32(encl - 1.5), select(A, p, held), select(p, A, held), size, !held);
            if (vis <= 0.0) { return 0.0; }
        }
    }
    return vis;
}

// the top of the boxes under p where one is over it (the highest a drop falling at p meets), else p's own height
fn structureTop(p: vec3f) -> f32 {
    var y = p.y;
    if (!nearStructures(p)) { return y; }
    let top = vec3f(p.x, F.blocks.z + 1.0, p.z);
    let m = blockCell(p);
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let b = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            let s = blockerSpan(b, top, vec3f(0.0, -1.0, 0.0));
            if (s.x <= s.y && s.y > 0.0) { y = max(y, top.y - max(s.x, 0.0)); }
        }
    }
    return y;
}

// a drop at p that came along -back (its path back up against its fall) met a structure: none falls there
fn rainBlocked(p: vec3f, back: vec3f) -> bool {
    if (!nearStructures(p)) { return false; }
    let m = blockCell(p);
    for (var w = 0u; w < 4u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            if (blockerRain(k, p, back)) { return true; }
            bits &= bits - 1u;
        }
    }
    return false;
}
`;

// the march: a view ray through the structures' bounds (no rain under their roofs and decks)
const WGSL_SHELTERED_RAY = /* wgsl */`
fn structuresOnRay(ro: vec3f, dir: vec3f, t0: f32, t1: f32) -> bool {
    return F.blocks.x > 0.5 && rayBoxC(ro, dir, vec3f(F.blockBox.x, F.blocks.y, F.blockBox.y), vec3f(F.blockBox.z, F.blocks.z, F.blockBox.w), t0, t1);
}
`;

// needs F, buildings. Building `id` (Buildings.add) in buildings[id * 8 ..]:
//   [centre x, z, cos yaw, sin yaw] [half size x, z, floor (m), storey height] [storeys, sill, window height, pitch]
//   [window width, wall thickness, share of storeys lit, faces with windows (bits: 1 -z, 2 +z, 4 -x, 8 +x)]
//   two doors as they stand (Buildings.record): [face 1..4 (-z +z -x +x; 0 none) + its leaf's swing 0..1, centre along
//   the face's local axis, width, height]
// Its interior, glass and door vertices carry material + id * BLD_ID. All of it is O(1) per pixel: the window pattern is
// a formula (the same one the mesh was built with), so the light through a window or a door is one box exit.
const WGSL_BUILDING = /* wgsl */`
struct Bld { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, f: vec4f, g: vec4f, h: vec4f };
fn bld(id: u32) -> Bld {
    let k = id * 8u;
    return Bld(buildings[k], buildings[k + 1u], buildings[k + 2u], buildings[k + 3u], buildings[k + 4u], buildings[k + 5u], buildings[k + 6u], buildings[k + 7u]);
}

// world to the building's frame (local x along (cos, sin), z along (-sin, cos), y stays the world height), and back
fn bldLocal(b: Bld, p: vec3f) -> vec3f { let r = p.xz - b.a.xy; return vec3f(r.x * b.a.z + r.y * b.a.w, p.y, -r.x * b.a.w + r.y * b.a.z); }
fn bldDir(b: Bld, d: vec3f) -> vec3f { return vec3f(d.x * b.a.z + d.z * b.a.w, d.y, -d.x * b.a.w + d.z * b.a.z); }
fn bldWorld(b: Bld, q: vec3f) -> vec3f { return vec3f(b.a.x + q.x * b.a.z - q.z * b.a.w, q.y, b.a.y + q.x * b.a.w + q.z * b.a.z); }
fn bldCentre(b: Bld) -> vec3f { return vec3f(b.a.x, b.b.z + b.c.x * b.b.w * 0.5, b.a.y); }
fn bldStorey(b: Bld, y: f32) -> f32 { return clamp(floor((y - b.b.z) / b.b.w), 0.0, b.c.x - 1.0); }

// how far (m) the camera is from the storey of the building that height y is on: within INTERIOR_DRAW its rooms are drawn
// (FrameWriter makes the same test per storey), so its windows are see-through there
fn bldStoreyDist(b: Bld, y: f32) -> f32 {
    let s = bldStorey(b, y);
    let lo = vec3f(-b.b.x, b.b.z + s * b.b.w, -b.b.y);
    let hi = vec3f(b.b.x, lo.y + b.b.w, b.b.y);
    let q = bldLocal(b, F.cam.xyz);
    return distance(q, clamp(q, lo, hi));
}

// a planned building's storey code (its floor plan's: 2 for an open hall, plus the share of such storeys lit), from the
// codes after the records (Buildings.buffer: b.g.z where its own start, b.g.w set if it has them); -1 for none
fn bldCode(b: Bld, s: f32) -> f32 {
    if (b.g.w < 0.5) { return -1.0; }
    let i = u32(b.g.z) + u32(s);
    return buildings[i / 4u][i % 4u];
}

// a planned building's storey s is an open hall (a lobby: the sun reaches anywhere in it) rather than rooms off a
// corridor (it reaches only the rooms on the façade it comes in by, b.g.xy deep)
fn bldHall(b: Bld, s: f32) -> bool { return bldCode(b, s) >= 2.0; }

// q (building frame) is inside one of the building's lift shafts (its lamp columns' rectangles)
fn inShaft(b: Bld, q: vec3f) -> bool {
    let cnt = u32(b.h.y + 0.5);
    for (var i = 0u; i < cnt; i++) {
        let k = u32(b.h.x + 0.5) / 4u + i * 4u;
        let r = buildings[k];
        let c = buildings[k + 2u];
        if (q.x > r.x && q.x < r.y && q.z > r.z && q.z < r.w && q.y > c.x - 3.0 && q.y < c.y + 3.0) { return true; }
    }
    return false;
}

// the light of a lift shaft's own lamps at q (building frame; n its normal there): the lamp column of the shaft holding q
// (a planned building's columns after its codes: b.h.x where they start, b.h.y how many; Buildings.buffer), a lamp every
// step m up its side wall between its lowest pit and its highest overrun; the few nearest above and below, an inverse
// square falling to nothing at its range, a little of it bounced round the narrow shaft. O(1) in the shaft's height
fn shaftLight(b: Bld, q: vec3f, n: vec3f) -> vec3f {
    var o = vec3f(0.0);
    let cnt = u32(b.h.y + 0.5);
    for (var i = 0u; i < cnt; i++) {
        let k = u32(b.h.x + 0.5) / 4u + i * 4u;
        let r = buildings[k];
        if (q.x < r.x - 0.1 || q.x > r.y + 0.1 || q.z < r.z - 0.1 || q.z > r.w + 0.1) { continue; }
        let a = buildings[k + 1u];
        let c = buildings[k + 2u];
        let col = buildings[k + 3u].rgb * c.w;
        let j0 = round((q.y - a.z) / a.w);
        for (var dj = -3; dj <= 3; dj++) {
            let ly = a.z + (j0 + f32(dj)) * a.w;
            if (ly < c.x || ly > c.y) { continue; }
            let L = vec3f(a.x, ly, a.y) - q;
            let d2 = dot(L, L);
            let fade = sat(1.0 - d2 / (c.z * c.z));
            o += col * (max(dot(n, L * inverseSqrt(d2)), 0.0) * 0.9 + 0.1) * fade * fade / (d2 + 0.25);
        }
        break;
    }
    return o;
}

// the lamps of storey s are on: a share of the storeys (its code's, else the building's b.d.z), picked by a hash
// (LightWriter.roomLights picks the same)
fn storeyLit(id: u32, b: Bld, s: f32) -> f32 {
    let c = bldCode(b, s);
    let share = select(b.d.z, c - select(0.0, 2.0, c >= 2.0), c >= 0.0);
    return select(0.0, 1.0, rnd(id * 131u + u32(s) * 7u + 3u) < share);
}

// how far (m) x along face f (1 -z, 2 +z, 3 -x, 4 +x; x is local x on the z faces, local z on the x ones), yr above the
// floor of storey s, is inside an opening of it, negative outside them all: its windows, spread evenly over it clear of
// its corners and, on the ground floor, of its doors (as Buildings.add lays them out), and its doors as their leaves
// stand (one swung by a hides cos a of its width from its hinge, seen square on)
fn openingEdge(b: Bld, f: f32, x: f32, yr: f32, s: f32) -> f32 {
    var e = -1e3;
    let usable = select(2.0 * b.b.y, 2.0 * b.b.x, f < 2.5) - 2.0 * (b.d.y + 0.2);
    if ((u32(b.d.w + 0.5) & (1u << u32(f - 1.0))) != 0u && usable >= b.d.x) {
        let nw = max(1.0, floor(usable / b.c.w));
        let cell = usable / nw;
        let uc = -usable * 0.5 + (clamp(floor((x + usable * 0.5) / cell), 0.0, nw - 1.0) + 0.5) * cell;
        var skip = false;
        if (s == 0.0) {
            for (var i = 0; i < 2; i++) {
                let r = select(b.f, b.e, i == 0);
                if (floor(r.x) == f && abs(uc - r.y) < (r.z + b.d.x) * 0.5 + 0.25) { skip = true; }
            }
        }
        if (!skip) { e = min(b.d.x * 0.5 - abs(x - uc), min(yr - b.c.y, b.c.y + b.c.z - yr)); }
    }
    if (s == 0.0) {
        for (var i = 0; i < 2; i++) {
            let r = select(b.f, b.e, i == 0);
            let open = fract(r.x);
            if (floor(r.x) != f || open <= 0.0) { continue; }
            let cover = r.z * cos(open * ${(95 * Math.PI / 180).toFixed(5)});
            let low = f == 1.0 || f == 4.0;
            let x0 = r.y - r.z * 0.5 + select(0.0, cover, low);
            let x1 = r.y + r.z * 0.5 - select(cover, 0.0, low);
            e = max(e, min(min(x - x0, x1 - x), min(yr, r.w - yr)));
        }
    }
    return e;
}

// where the ray from q (building frame, inside its shell) along d leaves the shell: x how far into the opening it leaves
// by (openingEdge: a window of q's own storey or a ground floor door; the floors and the roof are in the way of the rest,
// -1e3), y the multiple of d to there
fn bldExit(b: Bld, q: vec3f, d: vec3f) -> vec2f {
    let lo = vec3f(-b.b.x, b.b.z, -b.b.y);
    let hi = vec3f(b.b.x, b.b.z + b.c.x * b.b.w, b.b.y);
    let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
    let t = max((lo - q) * inv, (hi - q) * inv);
    let te = min(t.x, min(t.y, t.z));
    let e = q + d * te;
    let s = bldStorey(b, q.y);
    let yr = e.y - b.b.z - s * b.b.w;
    if (te == t.y || yr < 0.0 || yr > b.b.w) { return vec2f(-1e3, te); }
    if (te == t.x) { return vec2f(openingEdge(b, select(3.0, 4.0, d.x > 0.0), e.z, yr, s), te); }
    return vec2f(openingEdge(b, select(1.0, 2.0, d.z > 0.0), e.x, yr, s), te);
}

// how much of a light passes the shell of building id between pi (inside it) and po (outside): what the opening the
// segment leaves by lets through, its edges as soft as an emitter of that size (m) at the light's end makes them (srcIn:
// the light is the inside end)
fn bldPass(id: u32, pi: vec3f, po: vec3f, size: f32, srcIn: bool) -> f32 {
    let b = bld(id);
    let q = bldLocal(b, pi);
    let x = bldExit(b, q, bldLocal(b, po) - q);
    if (x.y >= 1.0) { return 1.0; }
    if (x.x < -100.0) { return 0.0; }
    let w = size * select(x.y / max(1.0 - x.y, 1e-3), (1.0 - x.y) / max(x.y, 1e-3), srcIn) + 0.02;
    return smoothstep(-w, w, x.x);
}

// what a lamp-lit room adds to a window seen from outside
fn windowGlow(id: u32, b: Bld, y: f32) -> vec3f { return vec3f(1.0, 0.86, 0.62) * 0.1 / max(F.sunCol.w, 0.2) * storeyLit(id, b, bldStorey(b, y)); }
`;

// the scene: the structures' meshes, the bulk geometry, the buildings' interiors, lift boxes, doors and panes, the
// distant lights
const WGSL_STRUCT = /* wgsl */`
// structures (houses, bus stop, bridges, roads): flat-shaded triangles, colour per vertex and a material
// (0 matte, 1 roof, 2 glass, 3 asphalt, 4 metal, 5 window, 6 water)
struct StructOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) col: vec4f };

@vertex fn vsStruct(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> StructOut {
    var o: StructOut;
    o.world = p;
    o.n = n;
    o.col = c;
    o.pos = F.viewProj * vec4f(curveToRender(p), 1.0);
    return o;
}

// a building's interior vertex, in its Origin's frame (Buildings.localize): to clip space with busU.mvp, built in
// doubles about the camera for the building drawn (its slot in busData, FrameWriter), and to the world with busU.model
// for its lighting. Each storey has its own frame: its vertices are over its own floor (0..H: PlannedBuilding), and the
// draw's instance is the storey it stands on (an unplanned building's one room: storey 0). That Origin is rebased on
// the storey nearest the eye (busU.info.z storeys up: FrameWriter), so (instance - that storey) is a small exact integer
// and a storey near the camera is a few metres from it in f32, at any height of a thousand-storey tower
@vertex fn vsInterior(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @builtin(instance_index) ii: u32) -> StructOut {
    let m = u32(c.a + 0.5);
    var q = p;
    q.y += (f32(ii) - busU.info.z) * bld(m / ${BLD_ID}u).b.w;
    var o: StructOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n, 0.0)).xyz;
    o.col = c;
    o.pos = curveClip(busU.mvp * vec4f(q, 1.0), o.world);
    return o;
}

// a box instance (Lifts: the cars, their doors, the landing doors), in its building's Origin frame as an interior's
// vertex is (busU): a unit cube scaled by its half sizes (b.xyz), turned by its yaw (a.w) about its centre (a.xyz); its
// colour (c.rgb) and material (b.w, as an interior's). A car's shell (c.w: the face that looks into the car, 1 +x 2 -x
// 3 +y 4 -y 5 +z 6 -z) is lit by the car's lamp on that face only: its other faces are the car's outside, dark in the
// shaft (BLD_DARK) but for the shaft's lamps
@vertex fn vsBox(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) ia: vec4f, @location(4) ib: vec4f, @location(5) ic: vec4f) -> StructOut {
    let cs = cos(ia.w);
    let sn = sin(ia.w);
    let l = p * ib.xyz;
    // (its centre over its building's floor rebased on the eye's storey, as vsInterior's: Lifts.instances' base)
    let q = ia.xyz + vec3f(l.x * cs - l.z * sn, l.y, l.x * sn + l.z * cs);
    var o: StructOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs, 0.0)).xyz;
    var m = u32(ib.w + 0.5);
    let side = u32(ic.w + 0.5);
    if (side != 0u && (m & ${BLD_LIT}u) != 0u) {
        let k = side - 1u;
        let out = n * sign(dot(n, p));                  // (the cube's face normal, outward whatever its winding)
        if (out[k / 2u] * select(1.0, -1.0, (k & 1u) == 1u) < 0.5) { m = m - ${BLD_LIT}u + ${BLD_DARK}u; }
    }
    o.col = vec4f(ic.rgb, f32(m));
    o.pos = curveClip(busU.mvp * vec4f(q, 1.0), o.world);
    return o;
}

@fragment fn fsStruct(i: StructOut) -> @location(0) vec4f {
    let mat = i32(i.col.a + 0.5);
    if (mat == 7) { return vec4f(lampGlow(i.world, i.n, i.col.rgb), 0.0); }
    return shadeStruct(i.world, i.n, i.col.rgb, mat);
}

// bulk geometry (Structures.bulk: a real place's roads and buildings): position and a colour word (rgb the square root of
// the linear colour, a the material); flat-shaded, its normal from the triangle's slope on screen. The position goes to
// the fragment about the eye, so the normal stays exact far from the world's origin
struct BulkOut { @builtin(position) pos: vec4f, @location(0) rel: vec3f, @location(1) col: vec4f };

@vertex fn vsBulk(@location(0) p: vec3f, @location(1) c: vec4f) -> BulkOut {
    var o: BulkOut;
    o.rel = p - F.cam.xyz;
    o.col = c;
    o.pos = F.viewProj * vec4f(curveToRender(p), 1.0);
    return o;
}

@fragment fn fsBulk(i: BulkOut) -> @location(0) vec4f {
    let n = normalize(cross(dpdy(i.rel), dpdx(i.rel)));
    let p = i.rel + F.cam.xyz;
    var col = i.col.rgb * i.col.rgb;
    var mat = i32(i.col.a * 255.0 + 0.5);
    var lit = 0.0;
    // a facade (material 8): rows of windows on its walls, storeys 3.4 m apart, bays 2.6 m along the world axis the wall
    // runs closest to (the derived normal is too rough for the wall's own axis so far from the origin); by night some
    // of them lit
    if (mat == 8) {
        let u = select(p.z, p.x, abs(n.z) > abs(n.x)) / 2.6;
        let v = p.y / 3.4;
        let px = pixelSize(p, n, normalize(-i.rel));
        let fade = 1.0 - smoothstep(0.6, 1.6, px);
        let win = step(0.18, fract(u)) * step(fract(u), 0.82) * step(0.28, fract(v)) * step(fract(v), 0.86) * step(abs(n.y), 0.5);
        let w = mix(0.45, win, fade);
        col = mix(col, vec3f(0.05, 0.07, 0.09), w);
        mat = select(0, 2, w > 0.5);
        if (F.lightInfo.y > 0.5) { lit = select(0.0, 1.0, hash12(floor(vec2f(u, v)) + floor(p.xz / 40.0)) < 0.3) * w; }
    }
    var o = shadeStruct(p, n, col, mat);
    o = vec4f(o.rgb + vec3f(1.0, 0.72, 0.42) * lit * 0.9 / max(F.sunCol.w, 0.2), o.a);
    return o;
}

// a lamp's diffuser (material 7: street lamps, porch lights, the canopy's lights): glass lit like any by day, glowing by
// night (F.lightInfo.y), the eye adapted to it as to the lamps indoors
fn lampGlow(p: vec3f, n: vec3f, col: vec3f) -> vec3f {
    if (F.lightInfo.y < 0.5) { return shadeStruct(p, n, col, 2).rgb; }
    return col * 2.6 / max(F.sunCol.w, 0.2);
}

// inside building id (WGSL_BUILDING): no weather; sky light that comes in through the windows (more near the outer walls
// than deep in the room), the sun where its ray leaves through a window of the same storey and nothing outside shades
// it (in a planned building, only into the rooms on the façade it comes in by), the ceiling lamps of the storey if
// they are on (the eye adapts to them, as in the bus), a little of a flash. m: the vertex's material code (its material,
// flags, building id). A lift car (BLD_LIT) is lit by its own lamp only, a lift shaft (BLD_DARK) by its own lamps only
fn shadeInterior(p: vec3f, nIn: vec3f, colIn: vec3f, m: u32) -> vec3f {
    let mat = m & 7u;
    let id = m / ${BLD_ID}u;
    let b = bld(id);
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }
    let q = bldLocal(b, p + n * 0.02);
    let lampC = vec3f(1.0, 0.9, 0.74) / max(F.sunCol.w, 0.2);
    if ((m & ${BLD_LIT}u) != 0u) {
        if (mat == 7u) { return colIn * lampC * 1.8; }
        var c = colIn * lampC * 0.3 * (0.4 + 0.6 * sat(n.y * 0.5 + 0.5));
        if (mat == 4u) { c += lampC * 0.08 * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)); }
        return c;
    }
    // an enclosed space (a lift shaft, BLD_DARK): no daylight and no storey lamps reach it; black but for its own lamps
    // (always on: they glow wherever they are seen, from end to end of the shaft), what they light, and a flashlight
    // (or anything else in one: the landing doors' shaft side, the counterweights)
    if ((m & ${BLD_DARK}u) != 0u || inShaft(b, q)) {
        if (mat == 7u) { return colIn * lampC * 2.2; }
        let alb = colIn;
        let lp = lampsAt(p + n * 0.02, n, v, 40.0, ${LIGHT_ROOM}u);
        var c = alb * (shaftLight(b, q, bldDir(b, n)) * lampC + lp.d + lampC * 0.0015);
        if (mat == 4u) { c += (shaftLight(b, q, bldDir(b, reflect(-v, n))) * lampC * 0.15 + lp.s) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)); }
        return c;
    }
    let storey = bldStorey(b, q.y);
    let lit = storeyLit(id, b, storey);
    // the sky's and sun's share (the clouds' shadow and the sky they leave), where the light comes in: on the façade
    // nearest q, just outside it. At p itself, inside a tower that stands in the clouds, it would be their density
    // drifting through the rooms as blotches
    var qf = q;
    if (b.b.x - abs(q.x) < b.b.y - abs(q.z)) { qf.x = sign(q.x) * (b.b.x + 0.5); } else { qf.z = sign(q.z) * (b.b.y + 0.5); }
    let sh = shadowAt(bldWorld(b, qf));
    if (mat == 7u) { return colIn * mix(F.ambient.rgb * sh.y * 0.08, lampC * 1.6, lit); }        // the lamps themselves
    let s = F.sunDir.xyz;
    var sun = 0.0;
    if (s.y > 0.0 && dot(n, s) > 0.0 && sh.x > 0.002) {
        // through the window or open door its ray leaves by, its edges softened by the sun's disc over the way there
        let ds = bldDir(b, s);
        let x = bldExit(b, q, ds);
        if (x.x > -100.0) {
            let w = 0.01 * x.y + 0.02;
            let el = q + ds * x.y;
            let e = bldWorld(b, el) + s * 0.1;
            sun = smoothstep(-w, w, x.x) * shadowAt(e).x * structureLight(e, true, false).x;
            // rooms off a corridor: the partitions keep it in the rooms of the façade it comes in by
            if (b.g.x + b.g.y > 0.0 && !bldHall(b, storey)) {
                let viaX = abs(abs(el.x) - b.b.x) < 0.05;
                if (select(abs(el.z - q.z), abs(el.x - q.x), viaX) > select(b.g.y, b.g.x, viaX) + b.d.y + 0.1) { sun = 0.0; }
            }
        }
    }
    let dw = min(b.b.x - abs(q.x), b.b.y - abs(q.z));
    let near = 1.0 - smoothstep(0.3, select(5.0, 11.0, b.g.x + b.g.y > 0.0), dw);       // (a curtain wall's deep floors: further)
    // and what the sunlit floors and walls bounce around the room (where the sun comes in at all)
    let sky = F.ambient.rgb * sh.y * (0.12 + 0.3 * near) * (0.75 + 0.25 * abs(n.y)) + F.sunCol.rgb * max(s.y, 0.0) * sh.x * (0.015 + 0.03 * near);
    // (b.h.z: its archetype's lamp strength; b.h.w: how much its walls bounce, lighting the ceilings: a white, high-key
    // interior is bright all round)
    let lamp = lampC * 0.13 * lit * b.h.z * (0.35 + 0.5 * b.h.w + (0.65 - 0.5 * b.h.w) * sat(n.y * 0.5 + 0.5));
    let alb = colIn;
    // the lights: the street's come in through the windows and open doors (lightSeen), a flashlight carried in lights the
    // room; the lit storeys' are their own lamps (lamp)
    let lp = lampsAt(p + n * 0.02, n, v, 40.0, ${LIGHT_CABIN | LIGHT_ROOM}u);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sun + sky + lamp + FLASH_COLOR * flashLit(p) * 0.004 * near + lp.d);
    if (mat == 4u) {
        let r = reflect(-v, n);
        col += (skyColor(r) * sh.y * 0.1 + lamp * 0.5 + lp.s) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)) * 0.3;
    }
    return col;
}

// a building's interior (its storeys within INTERIOR_DRAW): walls' inner faces, floors, stairs, furniture, lamps; the lift cars
@fragment fn fsInterior(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    return vec4f(shadeInterior(i.world, i.n, i.col.rgb, m), 0.0);
}

// a door leaf, open or shut: lit as the interior on its inner side, by the weather on its outer one
@fragment fn fsDoor(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    let id = m / ${BLD_ID}u;
    let b = bld(id);
    var n = normalize(i.n);
    if (dot(n, F.cam.xyz - i.world) < 0.0) { n = -n; }
    let q = bldLocal(b, i.world + n * 0.03);
    if (abs(q.x) < b.b.x - b.d.y + 0.01 && abs(q.z) < b.b.y - b.d.y + 0.01) { return vec4f(shadeInterior(i.world, n, i.col.rgb, m), 0.0); }
    return vec4f(shadeStruct(i.world, n, i.col.rgb, i32(m & 7u)).rgb, 0.0);
}

// a window seen from beyond INTERIOR_DRAW (its interior and its glass are not drawn there): an opaque pane that reflects
// the sky, glowing where the storey's lamps are on
@fragment fn fsPane(i: StructOut) -> @location(0) vec4f {
    let id = u32(i.col.a + 0.5) / ${BLD_ID}u;
    let b = bld(id);
    if (bldStoreyDist(b, i.world.y) < ${INTERIOR_DRAW}.0) { discard; }
    return vec4f(shadeStruct(i.world, i.n, i.col.rgb, 5).rgb + windowGlow(id, b, i.world.y), 0.0);
}

// a structure surface lit by the sky and the sun, under the cloud shadow, wet or snowy where the weather reaches it; alpha
// the rain surface code (WGSL_TERRAIN)
fn shadeStruct(p: vec3f, nIn: vec3f, colIn: vec3f, mat: i32) -> vec4f {
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }                                  // thin panels are seen from both sides
    // weather on it: snow settles on what faces up, rain wets what it reaches (walls less than roofs and roads)
    let gs = groundAt(p.xz);
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let sl = structureLight(p + n * 0.06, sh.x * dot(n, s) > 0.002, gs.x + gs.y > 0.002 && mat != 6);
    let snow = sat(gs.x * 3.0) * smoothstep(0.55, 0.85, n.y) * sl.y * select(1.0, 0.0, mat == 6);
    let wet = gs.y * sl.y * (0.35 + 0.65 * sat(n.y)) * (1.0 - snow);
    let glass = mat == 2 || mat == 5;
    // puddles on flat asphalt (and fewer on paving); rain rings on them, on open water, faintly on the wet film
    let flat = smoothstep(0.97, 0.995, n.y);
    let rainNow = sat(F.near.x * 1.5) * sl.y * (1.0 - snow);
    let puddle = puddleAt(p.xz, wet) * flat * select(select(0.0, 0.5, mat == 0), 1.0, mat == 3);
    let pool = select(puddle, 1.0, mat == 6);
    var rg = vec2f(0.0);
    if (!glass && rainNow > 0.0) { rg = rainRipples(p.xz, pixelSize(p, n, v), rainNow) * max(pool, 0.25 * wet * flat); }
    let nr = normalize(n + vec3f(-rg.x, 0.0, -rg.y));
    var alb = colIn * (0.9 + 0.2 * vnoise2(vec2f(p.x + p.z, p.y) * 1.7 + n.xz * 13.0));
    if (!glass) { alb *= (1.0 - select(0.35, 0.55, mat == 3) * wet) * (1.0 - 0.4 * puddle); }
    alb = mix(alb, vec3f(0.85, 0.88, 0.92), snow);
    // sky light from above, and light the ground bounces up into eaves, roof and deck undersides
    let bounce = (F.ambient.rgb * sh.y * 0.25 + F.sunCol.rgb * max(s.y, 0.0) * sh.x * 0.06) * sat(-n.y);
    var gloss = select(select(select(0.0, 0.04, mat == 1), 0.12, mat == 4), 0.8, glass);
    gloss = max(gloss, wet * select(0.3, 0.5, mat == 3));
    gloss = mix(gloss, 1.0, puddle);
    // the lights, with a highlight as sharp as the surface is glossy (open water as a puddle)
    let lp = lampsAt(p + n * 0.06, nr, v, mix(12.0, 900.0, select(gloss * gloss, 1.0, mat == 6)), 0u);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sl.x + F.ambient.rgb * sh.y * sl.z * (0.55 + 0.45 * n.y) + bounce + FLASH_COLOR * flashLit(p) * 0.03 + lp.d);
    // glass, metal and wet surfaces reflect the sky
    let r = reflect(-v, nr);
    let fres = 0.04 + 0.96 * pow(1.0 - max(dot(nr, v), 0.0), 5.0);
    let spec = skyColor(r) * sh.y * sl.z + F.sunCol.rgb * sh.x * sl.x * pow(max(dot(r, s), 0.0), 300.0) * 4.0 + lp.s;
    col += spec * fres * gloss + skyColor(r) * sh.y * sl.z * length(rg) * 1.5;   // the rings catch the sky at any angle
    if (mat == 6) {                                                     // open water, as on the terrain
        let fw = 0.02 + 0.98 * pow(1.0 - max(dot(nr, v), 0.0), 5.0);
        col = vec3f(0.01, 0.02, 0.025) * F.ambient.rgb * sl.z + spec * fw;
    }
    let kind = select(select(2.0, 3.0, mat == 3), 4.0, mat == 6);
    return vec4f(col, select(0.0, kind + 0.45 * puddle, rainNow > 0.0 && n.y > 0.7 && !glass));
}

// Distant lights by night (FarLights, FAR_FLOATS per instance): each lamp a point sprite added into the scene
// before the volumetrics, so the haze, rain and cloud in front dim it and the bloom spreads it. It carries the lamp's
// light reaching the eye (intensity over distance squared) spread over at least a pixel or so, so it fades with
// distance instead of flickering; near, the real lamp (its diffuser, its light) takes over as the sprite outgrows that.
// Lighting nothing, it costs one small quad per lamp.
struct FarOut { @builtin(position) pos: vec4f, @location(0) col: vec3f, @location(1) uv: vec2f };

@vertex fn vsFar(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) e: vec4f) -> FarOut {
    var o: FarOut;
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);                                 // dropped (behind the far plane of reversed Z)
    let clip = F.viewProj * vec4f(curveToRender(a.xyz), 1.0);
    if (clip.w < 1.0) { return o; }
    let v = a.xyz - F.cam.xyz;
    let d = length(v);
    let pxPerM = F.screen.y * 0.5 / (length(F.up.xyz) * clip.w);
    let rPhys = a.w * pxPerM;                                           // the lamp's glowing part, radius in pixels
    // near, the lamp shows itself (its diffuser, lampGlow; a fake one's within POLE_DRAW, vsFarPole) as it grows past a pixel
    var k = 1.0 - smoothstep(1.0, 2.5, rPhys);
    if (b.w > 0.5 && d > ${POLE_DRAW}.0) { k = 1.0; }
    // a narrow beam (headlights) glares inside its cone; outside it only the lamp's housing shows
    if (c.w > 0.5) { k *= mix(0.08, 1.0, smoothstep(c.w, 1.0, dot(-v / d, c.xyz))); }
    if (k <= 0.0) { return o; }
    // half-size R px, profile exp(-4 u^2) (u = 0 .. 1 over R), which sums to ~0.77 R^2 pixels
    let R = 2.0 * max(rPhys, 0.8);
    let pixSA = pow(2.0 * length(F.up.xyz) / F.screen.y, 2.0);         // solid angle of a pixel
    let L = b.rgb * k / (max(F.sunCol.w, 0.2) * d * d * 0.77 * R * R * pixSA);
    o.col = min(L, vec3f(60.0));
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    o.uv = corners[vi];
    o.pos = clip + vec4f(o.uv * R * 2.0 / F.screen.xy * clip.w, 0.0, 0.0);
    return o;
}

@fragment fn fsFar(i: FarOut) -> @location(0) vec4f {
    return vec4f(i.col * exp(-4.0 * dot(i.uv, i.uv)), 0.0);
}

// A real lamp's pool of light on the ground beyond the lights LightWriter.write takes (lampsAt): a decal over its reach,
// lit as lightAt lights the ground (window, softening, cone) on ground of POOL_ALBEDO, giving way by as much as its real
// light has come in (farLampReal: the same fade toward F.lightInfo.z), so the pool neither pops in nor doubles
struct PoolOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) col: vec3f, @location(2) @interpolate(flat) lamp: vec4f,
                 @location(3) @interpolate(flat) axis: vec4f, @location(4) @interpolate(flat) cone: vec2f };

@vertex fn vsFarPool(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) e: vec4f) -> PoolOut {
    var o: PoolOut;
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    let fade = smoothstep(F.lightInfo.z * 0.7, F.lightInfo.z, max(distance(a.xyz, F.cam.xyz) - e.y, 0.0));
    if (F.lightInfo.y < 0.5 || fade <= 0.0 || a.y - e.z > e.y) { return o; }
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    o.world = vec3f(a.x + corners[vi].x * e.y, e.z + 0.2, a.z + corners[vi].y * e.y);
    // drawn a little toward the eye (0.5% of the way), so roads lifted over the terrain and its bumps do not hide it
    o.pos = F.viewProj * vec4f(mix(curveToRender(o.world), F.cam.xyz, 0.005), 1.0);
    o.col = b.rgb * fade * vec3f(${POOL_ALBEDO}) / max(F.sunCol.w, 0.2);
    o.lamp = vec4f(a.xyz, e.y);
    o.axis = vec4f(c.xyz, c.w);
    o.cone = vec2f(e.x, a.w * a.w);
    return o;
}

@fragment fn fsFarPool(i: PoolOut) -> @location(0) vec4f {
    let d = i.lamp.xyz - i.world;
    let d2 = dot(d, d);
    let r2 = i.lamp.w * i.lamp.w;
    if (d2 >= r2) { discard; }
    let l = d * inverseSqrt(d2);
    let x = d2 / r2;
    let win = sat(1.0 - x * x);
    var k = win * win / (d2 + i.cone.y) * max(l.y, 0.0);
    if (i.axis.w > -1.5) { let cc = smoothstep(i.axis.w, i.cone.x, dot(-l, i.axis.xyz)); k *= cc * cc; }
    return vec4f(i.col * k, 0.0);
}

// a fake street lamp near the camera (World.nearPoles): the street lamp mesh (Renderer.poleMesh, as Fixtures.lamp builds
// one) per instance, at its pole's foot [x, ground, z, yaw], its diffuser (material 7) in the lamp's colour; shaded by fsStruct
@vertex fn vsFarPole(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) at: vec4f, @location(4) glow: vec4f) -> StructOut {
    let cs = cos(at.w);
    let sn = sin(at.w);
    var o: StructOut;
    o.world = vec3f(at.x + p.x * cs - p.z * sn, at.y + p.y, at.z + p.x * sn + p.z * cs);
    o.n = vec3f(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs);
    o.col = select(c, vec4f(glow.rgb, c.a), i32(c.a + 0.5) == 7);
    o.pos = F.viewProj * vec4f(curveToRender(o.world), 1.0);
    return o;
}
`;

// the final pass: the drops running off roof edges, the buildings' window glass
const WGSL_DRIP = /* wgsl */`
// rain running off roof edges near the camera (F.dripEdges): drop k of the drip particles leaves a point on an edge and
// falls freely to the ground. The drops gather at spouts along the edge, where the water runs together.
fn drip(k: u32, vi: u32, o: ptr<function, LineOut>) {
    let rain = F.near.x - F.near.y;
    let pick = rnd(k * 7u + 11u);
    if (rain <= 0.02 || rnd(k * 7u + 12u) > sat(rain * 1.6)) { return; }
    var e = 0;
    for (var j = 0; j < i32(F.drips.x) - 1; j++) { if (pick > F.dripEdges[j * 3 + 2].x) { e = j + 1; } }
    let A = F.dripEdges[e * 3];
    let B = F.dripEdges[e * 3 + 1];
    let alongX = F.dripEdges[e * 3 + 2].y > 0.5;
    if (rnd(k * 7u + 19u) > F.dripEdges[e * 3 + 2].z) { return; }
    // a side of the rectangle (by length; only the two along local x for eaves), and a point on it within 30 m of the
    // camera's place along it, so the drops gather where they can be seen. They run off at spouts every 0.35 m, some
    // harder than others
    let side = select(u32(rnd(k * 7u + 13u) * 4.0), u32(rnd(k * 7u + 13u) * 2.0) * 2u, alongX);
    let onX = side % 2u == 0u;
    let half = select(A.w, A.z, onX);
    let r = F.cam.xz - A.xy;
    let cl = vec2f(r.x * B.x + r.y * B.y, -r.x * B.y + r.y * B.x);
    let span = min(30.0, half);
    let mid = clamp(select(cl.y, cl.x, onX), -half + span, half - span);
    if (!alongX && rnd(k * 7u + 17u) > half / max(A.z, A.w)) { return; }      // short sides get fewer drops
    let spout = floor((mid + (rnd(k * 7u + 14u) - 0.5) * 2.0 * span + half) / 0.35);
    if (rnd(u32(spout) * 3u + side * 100003u + u32(e) * 7919u) < 0.3) { return; }
    let t = (spout + 0.5 + (rnd(k * 7u + 18u) - 0.5) * 0.3) * 0.35 - half;
    let sg = select(-1.0, 1.0, side >= 2u);
    let lp = select(vec2f(sg * (A.z + 0.04), t), vec2f(t, sg * (A.w + 0.04)), onX);
    let top = vec3f(A.x + lp.x * B.x - lp.y * B.y, B.z, A.y + lp.x * B.y + lp.y * B.x);
    // free fall over the drop B.w: the phase cycles through it, so the stream keeps running
    let tFall = sqrt(2.0 * B.w / 9.81);
    let ph = fract(F.cam.w / tFall + rnd(k * 7u + 15u));
    let ts = ph * tFall;
    // the wind picks the drops up as they fall, so the stream leans downwind in a straight line
    let wind = vec3f(F.wind.x, 0.0, F.wind.y) * 0.08;
    let p = top + (wind - vec3f(0.0, 4.9, 0.0)) * ts * ts;
    let vel = (wind * 2.0 - vec3f(0.0, 9.81, 0.0)) * ts - vec3f(0.0, 0.4, 0.0);
    let dist = distance(p, F.cam.xyz);
    if (dist > 120.0 || inCabin(p)) { return; }
    let a = F.viewProj * vec4f(p, 1.0);
    let b = F.viewProj * vec4f(p - vel * 0.05, 1.0);
    if (a.w < 0.5 || b.w < 0.5) { return; }
    let focal = F.screen.y * 0.5 / length(F.up.xyz);
    lineQuad(a, b, clamp(0.005 * focal / a.w, 1.0, 4.0), vi, o);
    let lightc = F.ambient.rgb * 0.9 + F.sunCol.rgb * 0.05 + lampsOnDrop(p);
    let fade = sat(dist / 1.5) * sat(1.0 - dist / 120.0) * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.9, 1.0, ph));
    (*o).col = vec4f(lightc * 1.3, (0.25 + 0.25 * rnd(k * 7u + 16u)) * fade * sat(rain * 2.0));
    (*o).uv.x = 0.0;
}
`;

const WGSL_WINDOW = /* wgsl */`
// a building's window glass (Buildings.add), drawn over the composite like the bus's: a faint tint, the sky
// reflected at grazing angles, rain drops on it where the rain reaches its outer side (one test per vertex). Towards
// INTERIOR_DRAW from the building it turns into the opaque pane fsPane draws beyond it, so the switch does not show
struct PaneOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) id: u32, @location(3) wet: f32 };

@vertex fn vsWindow(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> PaneOut {
    var o: PaneOut;
    o.world = p;
    o.n = n;                                                            // outward
    o.id = u32(c.a + 0.5) / ${BLD_ID}u;
    o.wet = rainReaches(p + n * 0.2);
    o.pos = F.viewProj * vec4f(curveToRender(p), 1.0);
    return o;
}

@fragment fn fsWindow(i: PaneOut) -> @location(0) vec4f {
    let b = bld(i.id);
    let dc = bldStoreyDist(b, i.world.y);
    if (dc >= ${INTERIOR_DRAW}.0) { discard; }
    let p = i.world;
    let v = normalize(F.cam.xyz - p);
    let out = normalize(i.n);
    let n = select(-out, out, dot(out, v) >= 0.0);
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let r = reflect(-v, n);
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, v)), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 600.0) * 6.0 + lampsAt(p + n * 0.02, n, v, 900.0, 0u).s;
    // drops as on the bus's windows, but still: a hashed 2 cm cell holds one or not, and they come and go slowly
    let rain = sat(F.near.x * 1.5) * sat(i.wet);
    var drop = 0.0;
    var rim = 0.0;
    if (rain > 0.01) {
        let g = vec2f(dot(p.xz, vec2f(-out.z, out.x)), p.y) / 0.02;
        let cell = floor(g);
        let cx = u32(i32(cell.x) + 1000000);
        let cy = u32(i32(cell.y) + 1000000);
        let life = floor(F.cam.w * 0.25 + rnd(cx * 7919u + cy));
        let h = rnd((cx * 73856093u) ^ (cy * 19349663u) ^ (u32(life) * 83492791u));
        if (h < rain * 0.3) {
            let c = vec2f(rnd(u32(h * 1e6)), rnd(u32(h * 1e6) + 7u)) * 0.5 + 0.25;
            let d = length(fract(g) - c) / (0.12 + 0.12 * fract(h * 13.0));
            drop = 1.0 - smoothstep(0.6, 1.0, d);
            rim = smoothstep(0.25, 0.85, d);
        }
    }
    let sky = F.ambient.rgb * sh.y;
    let dropCol = mix(sky * 0.25, sky * 2.2 + F.sunCol.rgb * sh.x * 0.05, rim);
    var a = sat(0.06 + fres * 0.85 + drop * 0.6);
    var c = spec * fres * (1.0 - drop) + vec3f(0.02, 0.025, 0.03) * F.ambient.rgb + dropCol * drop * 0.6;
    // the opaque pane it becomes (shadeStruct's window, mat 5, and the glow of a lit room)
    let far = smoothstep(${INTERIOR_DRAW - 40}.0, ${INTERIOR_DRAW}.0, dc);
    let pane = vec3f(0.06, 0.08, 0.10) * (F.ambient.rgb * sh.y * 0.55 + F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x) + spec * fres * 0.8 + windowGlow(i.id, b, p.y);
    c = mix(c, pane, far);
    a = mix(a, 1.0, far);
    return vec4f(tonemap(c / a), a);
}
`;

return { WGSL_BLOCKERS, WGSL_SHELTERED_RAY, WGSL_BUILDING, WGSL_STRUCT, WGSL_DRIP, WGSL_WINDOW };
});
