'use strict';
// Buildings: the archetypes (BUILDING_TYPES merged with the scenario's), each building's shell, interior, glass, doors,
// roof and GPU record, and the building a point is inside.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, clamp, lerp } = Common;
const { mulberry32 } = kits.noise;
const {
    STRUCT_FLOATS, BUILDING_TYPES, BLD_ID, FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, rectMinusHoles,
    STRUCT_COLORS,
} = feature;

class Buildings {
    // types: the scenario's `buildings`, merged over BUILDING_TYPES (each archetype key by key, window and door too)
    constructor(S, types = {}) {
        this.S = S;
        this.list = [];              // per building: its GPU record (WGSL_BUILDING), its interior's vertex range, its frame
        this.types = {};
        for (const k of new Set([...Object.keys(BUILDING_TYPES), ...Object.keys(types)])) {
            const a = BUILDING_TYPES[k] || BUILDING_TYPES.house, b = types[k] || {};
            this.types[k] = { ...a, ...b, window: { ...a.window, ...b.window }, door: { ...a.door, ...b.door } };
        }
    }

    // a house (Village): a building of the `house` archetype (o.type) with a gable roof (ridge along local x, or across
    // with `across`), one or two storeys by its wall height, its door on the front (local -z), maybe a chimney
    house(f, w, dp, o) {
        const storeys = o.wallH > 5 ? 2 : 1;
        return this.add(f, {
            type: o.type || 'house', w, d: dp, storeys, storeyHeight: o.wallH / storeys, color: o.wall, seed: o.seed,
            roof: { kind: 'gable', pitch: o.pitch, eave: o.eave, across: o.across, chimney: o.chimney, color: o.roof }, doors: [{ face: '-z', at: o.door }],
        });
    }

    // A building of archetype spec.type (BUILDING_TYPES, the scenario's `buildings`), centred on frame f. spec: w, d (m
    // along local x, z), storeys, color (walls), roof { kind: gable (pitch, eave, across, chimney) | flat (overhang,
    // thick, drip), color }, doors [{ face, at (m along it), width, height }] (faces -z (the front), +z, -x, +x; default
    // one at the middle of the front), windows (the faces that have them; default all), floor / base (m: the floor and the
    // bottom of the plinth, for a building on something else than the ground), seed, and any archetype key to override.
    // Builds, all from that data:
    //   outside   the walls' outer faces with real openings and their reveals, plinth, roof
    //   interior  (drawn near it, Renderer) the walls' inner faces, floors and ceilings, stairs between the storeys
    //             (switchbacks along a wall, the slabs open above them, balustrades), furniture (FURNITURE), lamps
    //   glass     a pane in each window (see-through near it, fsWindow) and an opaque one for far off (fsPane)
    //   doors     leaves that swing into the room (E, DoorControl), and the solids to walk on: walls with door openings,
    //             floors, steps, furniture, a door's leaf while it is shut
    //   shader boxes  the shell enclosed (shelter: no rain or snow inside, whatever the wind) and the roof
    // and its GPU record (WGSL_BUILDING). Returns { id, floor, top }
    add(f, spec) {
        const S = this.S;
        const C = STRUCT_COLORS, A = this.types[spec.type || 'house'] || this.types.house;
        const T = { ...A, ...spec, window: { ...A.window, ...spec.window }, door: { ...A.door, ...spec.door } };
        const id = this.list.length, M = mat => mat + id * BLD_ID, rnd = mulberry32(T.seed ?? id * 7919 + 13);
        const hx = T.w / 2, hz = T.d / 2, t = T.wall, H = T.storeyHeight, n = Math.max(1, Math.round(T.storeys ?? 1)), W = T.window;
        const g = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => S.ground(...f.xz(sx * hx, sz * hz)));
        const gLo = T.base ?? Math.min(...g) - 1, floor = T.floor ?? Math.max(...g) + T.plinth, top = floor + n * H;
        const wallCol = T.color || C.walls[0], iv0 = S.iv.length / STRUCT_FLOATS;
        // the faces: o(u, d) is local [x, z] at u along the face and d in from its outer side; U, D those directions
        const FACES = {
            '-z': { len: 2 * hx, o: (u, d) => [u, -hz + d], U: [1, 0], D: [0, 1], bit: 1 },
            '+z': { len: 2 * hx, o: (u, d) => [-u, hz - d], U: [-1, 0], D: [0, -1], bit: 2 },
            '-x': { len: 2 * hz, o: (u, d) => [-hx + d, -u], U: [0, -1], D: [1, 0], bit: 4 },
            '+x': { len: 2 * hz, o: (u, d) => [hx - d, u], U: [0, 1], D: [-1, 0], bit: 8 },
        };
        const OPPOSITE = { '-z': '+z', '+z': '-z', '-x': '+x', '+x': '-x' };
        // in face coordinates: a box centred at u, d with half sizes along and in ([local x, z, half x, half z]); a rectangle
        // [x0, x1, z0, z1]; a local direction in the world; rectangles that overlap
        const fbox = (fc, u, d, hu, hd) => { const [x, z] = fc.o(u, d); return fc.U[0] ? [x, z, hu, hd] : [x, z, hd, hu]; };
        const frect = (fc, u0, u1, d0, d1) => { const a = fc.o(u0, d0), b = fc.o(u1, d1); return [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])]; };
        const wdir = ([x, z]) => [x * f.cs - z * f.sn, x * f.sn + z * f.cs];
        const overlaps = (a, b) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];

        // openings: the doors, then windows on every storey of the faces that have them (spread evenly, clear of the
        // corners and the doors: the same layout inWindow in WGSL assumes)
        const doors = (T.doors || [{ face: '-z', at: 0 }]).map(d => {
            const w = d.width ?? T.door.width, lim = FACES[d.face].len / 2 - t - 0.2 - w / 2;
            return { face: d.face, w, h: Math.min(d.height ?? T.door.height, H - 0.3), at: clamp(d.at ?? 0, -lim, lim) };
        });
        const holes = {};
        let faceMask = 0;
        for (const [name, fc] of Object.entries(FACES)) {
            const hs = holes[name] = doors.filter(d => d.face === name).map(d => [d.at - d.w / 2, d.at + d.w / 2, floor, floor + d.h, 'door']);
            const usable = fc.len - 2 * (t + 0.2), nw = Math.max(1, Math.floor(usable / W.pitch)), cell = usable / nw;
            if ((T.windows && !T.windows.includes(name)) || usable < W.width) continue;
            faceMask |= fc.bit;
            for (let s = 0; s < n; s++) for (let i = 0; i < nw; i++) {
                const u = -usable / 2 + (i + 0.5) * cell, y0 = floor + s * H + W.sill;
                if (s === 0 && doors.some(d => d.face === name && Math.abs(u - d.at) < (d.w + W.width) / 2 + 0.25)) continue;
                hs.push([u - W.width / 2, u + W.width / 2, y0, y0 + W.height, 'window']);
            }
        }

        // the plinth, and the walls: outer faces with their openings and the reveals through the wall outside, the inner
        // faces in the interior, glass at mid-wall in the windows (its normal outward), a solid between the doors
        if (floor - gLo > 0.01) S.box(f, 0, 0, hx + 0.08, hz + 0.08, gLo, floor, C.plinth);
        for (const [name, fc] of Object.entries(FACES)) {
            const hs = holes[name], half = fc.len / 2, out = wdir([-fc.D[0], -fc.D[1]]), nOut = [out[0], 0, out[1]];
            const P = (u, y, d) => { const [x, z] = fc.o(u, d); return f.at(x, y, z); };
            const face = (rects, d, col, mat) => { for (const [u0, u1, y0, y1] of rects) S.quad(P(u0, y0, d), P(u1, y0, d), P(u1, y1, d), P(u0, y1, d), col, mat); };
            S.cur = S.v;
            face(rectMinusHoles(-half, half, floor, top, hs), 0, wallCol, 0);
            S.quad(P(-half, top, 0), P(half, top, 0), P(half, top, t), P(-half, top, t), wallCol, 0);
            for (const [u0, u1, y0, y1, kind] of hs) {
                const rv = (a, b) => S.quad(P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], t), P(a[0], a[1], t), wallCol, 0);
                rv([u0, y0], [u0, y1]);
                rv([u1, y0], [u1, y1]);
                rv([u0, y1], [u1, y1]);
                if (kind !== 'window') continue;
                rv([u0, y0], [u1, y0]);
                for (const to of [S.glass, S.panes]) {
                    S.cur = to;
                    S.quadN(P(u0, y0, t / 2), P(u1, y0, t / 2), P(u1, y1, t / 2), P(u0, y1, t / 2), nOut, C.window, M(5));
                }
                S.cur = S.v;
            }
            S.cur = S.iv;
            face(rectMinusHoles(-half + t, half - t, floor, top, hs), t, T.inner, M(0));
            S.cur = S.v;
            let a = -half;
            const wall = (u0, u1) => { if (u1 - u0 > 0.01) S.solids.add(f, ...fbox(fc, (u0 + u1) / 2, t / 2, (u1 - u0) / 2, t / 2), floor, top); };
            for (const h of hs.filter(h => h[4] === 'door').sort((p, q) => p[0] - q[0])) { wall(a, h[0]); a = h[1]; }
            wall(a, half);
        }

        // stairs: a switchback of straight flights along the first wall long enough (the one opposite the front door
        // first), flight s from storey s to s + 1 in lane s % 2 (even ones climb along the wall, odd ones back), a landing
        // at both ends. The slab above each flight is open over it
        const lo = [-hx + t, -hz + t], hi = [hx - t, hz - t], flights = [], reserved = [];
        if (n > 1 && T.stairs) {
            const sw = T.stairs.width, steps = Math.ceil(H / 0.19), rise = H / steps, landing = 1.0, lanes = n > 2 ? 2 : 1;
            const first = doors[0]?.face ?? '-z', order = [OPPOSITE[first], ...Object.keys(FACES).filter(k => k !== first && k !== OPPOSITE[first]), first];
            for (const name of order) {
                const fc = FACES[name], run = Math.min(0.3, (fc.len - 2 * t - 2 * landing) / steps);
                const across = (fc.U[0] ? 2 * hz : 2 * hx) - 2 * t;
                if (run < 0.22 || across < lanes * sw + 1.5) continue;
                const a0 = -steps * run / 2, a1 = steps * run / 2;
                S.cur = S.iv;
                for (let s = 0; s + 1 < n; s++) {
                    const lane = s % 2, d0 = t + lane * sw, up = lane === 0, y = floor + s * H;
                    for (let k = 0; k < steps; k++) {
                        const u0 = up ? a0 + k * run : a1 - (k + 1) * run;
                        S.box(f, ...fbox(fc, u0 + run / 2, d0 + sw / 2, run / 2, sw / 2), y, y + (k + 1) * rise, T.floorColor, M(0));
                    }
                    flights.push({ s, fc, up, d0, sw, a0, a1, hole: frect(fc, up ? a0 - 0.25 : a0, up ? a1 : a1 + 0.25, d0, d0 + sw) });
                }
                reserved.push(frect(fc, a0 - landing, a1 + landing, t, t + lanes * sw + 0.3));
                break;
            }
        }
        // floors and ceilings: the ground floor, a slab per storey above (open over the flight below it, with a balustrade
        // along the opening's open sides), the top storey's ceiling
        S.cur = S.iv;
        const flat = (rects, y, col, mat) => { for (const [x0, x1, z0, z1] of rects) S.quad(f.at(x0, y, z0), f.at(x1, y, z0), f.at(x1, y, z1), f.at(x0, y, z1), col, mat); };
        flat([[lo[0], hi[0], lo[1], hi[1]]], floor + 0.005, T.floorColor, M(0));
        for (let s = 1; s < n; s++) {
            const y = floor + s * H, below = flights.filter(fl => fl.s === s - 1), pieces = rectMinusHoles(lo[0], hi[0], lo[1], hi[1], below.map(fl => fl.hole));
            flat(pieces, y, T.floorColor, M(0));
            flat(pieces, y - T.slab, T.ceiling, M(0));
            for (const [x0, x1, z0, z1] of pieces) S.solids.add(f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y - T.slab, y);
            for (const fl of below) {
                const [x0, x1, z0, z1] = fl.hole, e = (a, b) => S.quad(f.at(a[0], y - T.slab, a[1]), f.at(b[0], y - T.slab, b[1]), f.at(b[0], y, b[1]), f.at(a[0], y, a[1]), T.ceiling, M(0));
                e([x0, z0], [x1, z0]); e([x1, z0], [x1, z1]); e([x1, z1], [x0, z1]); e([x0, z1], [x0, z0]);
                const { fc, up, d0, sw, a0, a1 } = fl, rail = b => S.box(f, b[0], b[1], b[2], b[3], y, y + 1.0, C.wood, M(0));
                rail(fbox(fc, (a0 + a1) / 2, d0 + sw + 0.03, (a1 - a0) / 2 + 0.25, 0.03));
                rail(fbox(fc, up ? a0 - 0.28 : a1 + 0.28, d0 + sw / 2, 0.03, sw / 2));
            }
        }
        flat([[lo[0], hi[0], lo[1], hi[1]]], top - 0.01, T.ceiling, M(0));
        // lamps under each ceiling, about every 4 m (lit or not per storey, storeyLit in WGSL)
        const nlx = Math.max(1, Math.round((hi[0] - lo[0]) / 4)), nlz = Math.max(1, Math.round((hi[1] - lo[1]) / 4));
        for (let s = 0; s < n; s++) {
            const yc = s + 1 < n ? floor + (s + 1) * H - T.slab : top - 0.01;
            for (let i = 0; i < nlx; i++) for (let j = 0; j < nlz; j++) {
                const x = lerp(lo[0], hi[0], (i + 0.5) / nlx), z = lerp(lo[1], hi[1], (j + 0.5) / nlz);
                if (flights.some(fl => fl.s === s && overlaps([x - 0.3, x + 0.3, z - 0.3, z + 0.3], fl.hole))) continue;
                S.prism(f, x, z, 0.28, 0.28, yc - 0.05, yc - 0.005, [1.0, 0.95, 0.86], M(7));
            }
        }
        // furniture along the walls and out in the room, clear of the stairs, the landings and the doors' swing
        const plan = FURNITURE[T.furnish] || [];
        const swing = doors.map(d => frect(FACES[d.face], d.at - d.w / 2 - 0.25, d.at + d.w / 2 + 0.25, 0, t + d.w + 0.4));
        const names = Object.keys(FACES);
        for (let s = 0; s < n && plan.length; s++) {
            const p = plan[Math.min(s, plan.length - 1)], y = floor + s * H, taken = [...reserved, ...(s === 0 ? swing : [])];
            const fits = rc => rc[0] >= lo[0] - 1e-3 && rc[1] <= hi[0] + 1e-3 && rc[2] >= lo[1] - 1e-3 && rc[3] <= hi[1] + 1e-3 && !taken.some(q => overlaps(rc, q));
            const place = (name, free) => {
                const it = FURNITURE_ITEMS[name];
                if (!it) return;
                const f0 = Math.floor(rnd() * 4);
                for (let k = 0; k < 4; k++) {
                    const fc = FACES[names[(f0 + k) % 4]], half = fc.len / 2 - t - it.w / 2 - 0.1;
                    if (half < 0) continue;
                    const deep = (fc.U[0] ? 2 * hz : 2 * hx) - 2 * t;
                    for (let tries = 0; tries < 10; tries++) {
                        const u = (rnd() * 2 - 1) * half, v = free ? t + 1.0 + rnd() * Math.max(0, deep - it.d - 2.0) : t + 0.02;
                        const pad = free ? 0.6 : 0.15;
                        if (!fits(frect(fc, u - it.w / 2 - pad, u + it.w / 2 + pad, v - (free ? pad : 0), v + it.d + pad))) continue;
                        taken.push(frect(fc, u - it.w / 2 - 0.1, u + it.w / 2 + 0.1, v - 0.1, v + it.d + 0.1));
                        for (const [u0, u1, v0, v1, y0, y1, col] of it.parts)
                            S.box(f, ...fbox(fc, u + (u0 + u1) / 2, v + (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2), y + y0, y + y1, FURNITURE_COLORS[col], M(col === 'metal' ? 4 : 0));
                        return;
                    }
                }
            };
            for (const [name, count] of p.wall) for (let c = 0; c < count; c++) place(name, false);
            for (const [name, count] of p.free) for (let c = 0; c < count; c++) place(name, true);
        }
        S.cur = S.v;

        // doors: a leaf hinged at one side of the opening on its inner side, swinging into the room (doorMesh); shut, it
        // is a solid across the opening, open, one along the inner wall
        for (const d of doors) {
            const fc = FACES[d.face], u0 = d.at - d.w / 2, lt = 0.05, [x, z] = fc.o(u0 + 0.02, t - lt / 2 - 0.01);
            const shut = S.solids.add(f, ...fbox(fc, d.at, t / 2, d.w / 2, t / 2), floor, floor + d.h);
            const open = S.solids.add(f, ...fbox(fc, u0 + 0.05, t + d.w / 2, 0.05, d.w / 2), floor, floor + d.h);
            open.off = true;
            const [cx, cz] = fc.o(d.at, t / 2);
            S.doors.add({ building: id, hinge: f.xz(x, z), u: wdir(fc.U), d: wdir(fc.D), w: d.w - 0.04, h: d.h - 0.02, y: floor, lt, open: 0, target: 0,
                shut, openSolid: open, col: C[T.door.color] || C.door, mat: M(0), centre: f.at(cx, floor + 1.2, cz) });
        }
        // a lamp over the doors of a share of them (`porch`), on by night: a small glowing box on the wall, its light out
        // in front of it (outside the shell, so the walls keep it out of the rooms)
        if (mulberry32(id * 31 + 7)() < (T.porch ?? 0)) for (const d of doors) {
            const fc = FACES[d.face], y = Math.min(floor + d.h + 0.3, floor + H - 0.15);
            S.prism(f, ...fbox(fc, d.at, -0.05, 0.1, 0.05), y - 0.12, y + 0.12, [1.0, 0.86, 0.66], 7);
            const [lx, lz] = fc.o(d.at, -0.45);
            S.fixtures.light('porch', f.at(lx, y - 0.1, lz));
        }

        // the roof: a gable over the walls (its triangles close the attic) with eaves and maybe a chimney, or a flat slab
        // that overhangs; shader boxes for it (rain shadow, sky occlusion under the eaves), and its edges drip
        const R = T.roof || { kind: 'flat' }, roofCol = R.color || C.concrete;
        if (R.kind === 'gable') {
            const rf = R.across ? f.turned(Math.PI / 2) : f, rx = R.across ? hz : hx, rz = R.across ? hx : hz;
            const k = Math.tan(R.pitch ?? 35 * DEG), e = R.eave ?? 0.5, th = 0.18, yr = top + rz * k, yE = top - e * k, ex = rx + e;
            for (const sg of [-1, 1]) {
                const zE = sg * (rz + e);
                S.quad(rf.at(-ex, yE, zE), rf.at(ex, yE, zE), rf.at(ex, yr, 0), rf.at(-ex, yr, 0), roofCol, 1);
                S.quad(rf.at(-ex, yE - th, zE), rf.at(ex, yE - th, zE), rf.at(ex, yr - th, 0), rf.at(-ex, yr - th, 0), roofCol, 1);
                S.quad(rf.at(-ex, yE, zE), rf.at(ex, yE, zE), rf.at(ex, yE - th, zE), rf.at(-ex, yE - th, zE), roofCol, 1);
                for (const x of [-ex, ex]) S.quad(rf.at(x, yE, zE), rf.at(x, yr, 0), rf.at(x, yr - th, 0), rf.at(x, yE - th, zE), roofCol, 1);
            }
            for (const x of [-rx, rx]) S.tri(rf.at(x, top, -rz), rf.at(x, top, rz), rf.at(x, yr, 0), wallCol);
            if (R.chimney) {
                const cz = rz * 0.45, y = top + (rz - cz) * k;
                S.box(rf, rx * 0.5, cz, 0.35, 0.35, y - 0.3, yr + 0.8, C.brick);
            }
            S.boxes.add(rf, 0, 0, ex, rz + e, yE - th, lerp(top, yr, 0.55), 0.25, 0, gLo);
            S.boxes.drip(rf, 0, 0, ex, rz + e, yE - th, yE - th - (floor - T.plinth), true);
        } else {
            const ov = R.overhang ?? 0.25, th = R.thick ?? 0.5;
            S.box(f, 0, 0, hx + ov, hz + ov, top, top + th, roofCol, R.mat ?? 0);
            // a roof that hardly overhangs shares the shell's shader box (one box less in every shelter test)
            if (ov > 0.5) S.boxes.add(f, 0, 0, hx + ov, hz + ov, top, top + th, 0.4, 0, gLo);
            if (R.drip !== false) S.boxes.drip(f, 0, 0, hx + ov, hz + ov, top, top - floor + T.plinth);
        }
        // the shell: enclosed, so nothing falls inside it however the wind blows (unless the archetype says otherwise)
        const roofTop = R.kind !== 'gable' && (R.overhang ?? 0.25) <= 0.5 ? top + (R.thick ?? 0.5) : top;
        S.boxes.add(f, 0, 0, hx, hz, gLo, roofTop, 0, 0, gLo, T.shelter !== false);
        // (each flight's start and its direction up it, in the world: to walk it in tests and tours)
        const stairs = flights.map(fl => { const [x, z] = fl.fc.o(fl.up ? fl.a0 - 0.6 : fl.a1 + 0.6, fl.d0 + fl.sw / 2); return { at: f.at(x, floor + fl.s * H, z), dir: wdir(fl.up ? fl.fc.U : [-fl.fc.U[0], -fl.fc.U[1]]) }; });
        this.list.push({ id, f, hx, hz, t, floor, top, n, H, stairs, centre: [f.c[0], floor + n * H / 2, f.c[1]], range: [iv0, S.iv.length / STRUCT_FLOATS],
            record: [f.c[0], f.c[1], f.cs, f.sn, hx, hz, floor, H, n, W.sill, W.height, W.pitch, W.width, t, T.lamps ?? 0.5, faceMask] });
        return { id, floor, top };
    }

    // the building p is inside (its interior), or null
    inside(p) {
        return this.list.find(b => {
            const rx = p[0] - b.f.c[0], rz = p[2] - b.f.c[1], lx = rx * b.f.cs + rz * b.f.sn, lz = -rx * b.f.sn + rz * b.f.cs;
            return Math.abs(lx) < b.hx - b.t && Math.abs(lz) < b.hz - b.t && p[1] > b.floor - 0.2 && p[1] < b.top;
        }) || null;
    }
}

return { Buildings };
});
