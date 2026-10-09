'use strict';
// Buildings: the archetypes (BUILDING_TYPES merged with the scenario's), each building's shell, interior, glass, doors,
// roof and GPU record, and the building a point is inside.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, clamp, lerp } = Common;
const { mulberry32 } = kits.noise;
const { Interior, Origin, FloorPlan, coreLayout, sharedEdge } = kits.interior;
const {
    STRUCT_FLOATS, BUILDING_TYPES, BUILDING_DOORS, BLD_ID, FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS, rectMinusHoles,
    STRUCT_COLORS, GroundFrame, TOWER, INTERIOR_DRAW, BLD_STACK,
} = feature;
const { FloorBuilder, towerPlan } = kits.settlement;

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
    // and its GPU record (WGSL_BUILDING). With a `plan` (the archetype's or spec's; false: none) the interior is rooms off
    // a corridor round a core instead (planned): storeys of a kind are built once and drawn instanced, the core's lifts
    // are hung (unless spec.lifts is false: a tower hangs its own across its sections). A tower's section also gives
    // core (shared by them all), storeyInfo(s) ({ key, kind, stairsUp, ground }), liftDoor(shaft, info), hall (WGSL's
    // storey kinds). Returns the building ({ id, floor, top, ... })
    add(f, spec) {
        const S = this.S;
        const C = STRUCT_COLORS, A = this.types[spec.type || 'house'] || this.types.house;
        const T = { ...A, ...spec, window: { ...A.window, ...spec.window }, door: { ...A.door, ...spec.door } };
        const id = this.list.length, M = mat => mat + id * BLD_ID, rnd = mulberry32(T.seed ?? id * 7919 + 13);
        const hx = T.w / 2, hz = T.d / 2, t = T.wall, H = T.storeyHeight, n = Math.max(1, Math.round(T.storeys ?? 1)), W = T.window;
        // a curtain wall's panes fill its bays but for a slim mullion (its faces are square: the same bays all round)
        if (T.curtain) { const u = 2 * Math.min(T.w, T.d) / 2 - 2 * (t + 0.2); W.width = u / Math.max(1, Math.floor(u / W.pitch)) - 0.24; }
        const g = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => S.ground(...f.xz(sx * hx, sz * hz)));
        const gLo = T.base ?? Math.min(...g) - 1, floor = T.floor ?? Math.max(...g) + T.plinth, top = floor + n * H;
        const wallCol = T.color || C.walls[0], iv0 = S.iv.length / STRUCT_FLOATS, planned = !!T.plan;
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
        // corners and the doors: the same layout openingEdge in WGSL assumes)
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
            if (T.curtain) continue;                     // a curtain wall's glass is its own (curtainFace)
            for (let s = 0; s < n; s++) for (let i = 0; i < nw; i++) {
                const u = -usable / 2 + (i + 0.5) * cell, y0 = floor + s * H + W.sill;
                if (s === 0 && doors.some(d => d.face === name && Math.abs(u - d.at) < (d.w + W.width) / 2 + 0.25)) continue;
                hs.push([u - W.width / 2, u + W.width / 2, y0, y0 + W.height, 'window']);
            }
        }

        // what the planned interior's storeys are built with (FloorBuilder): this building's frame, sizes, faces, and the
        // window and door holes of a storey on a face
        const B = {
            S, f, id, T, hx, hz, t, H, n, floor, faces: FACES, fbox, M,
            code: (mat, stacked) => M(mat) + (stacked ? BLD_STACK : 0), count: () => S.iv.length / STRUCT_FLOATS,
            windows: (name, y) => {
                const fc = FACES[name], usable = fc.len - 2 * (t + 0.2), nw = Math.max(1, Math.floor(usable / W.pitch)), cell = usable / nw, out = [];
                if ((T.windows && !T.windows.includes(name)) || usable < W.width) return out;
                for (let i = 0; i < nw; i++) {
                    const u = -usable / 2 + (i + 0.5) * cell, y0 = y + W.sill;
                    if (Math.abs(y - floor) < 0.01 && doors.some(d => d.face === name && Math.abs(u - d.at) < (d.w + W.width) / 2 + 0.25)) continue;
                    out.push([u - W.width / 2, u + W.width / 2, y0, Math.min(y0 + W.height, y + H - T.slab)]);
                }
                return out;
            },
            doors: name => holes[name].filter(h => h[4] === 'door'),
        };

        // the plinth, and the walls: outer faces with their openings and the reveals through the wall outside, the inner
        // faces in the interior (a planned one's are its rooms'), glass at mid-wall in the windows (its normal outward),
        // or a curtain wall; a solid between the doors
        if (floor - gLo > 0.01) S.box(f, 0, 0, hx + 0.08, hz + 0.08, gLo, floor, C.plinth);
        for (const [name, fc] of Object.entries(FACES)) {
            const hs = holes[name], half = fc.len / 2, out = wdir([-fc.D[0], -fc.D[1]]), nOut = [out[0], 0, out[1]];
            const P = (u, y, d) => { const [x, z] = fc.o(u, d); return f.at(x, y, z); };
            const face = (rects, d, col, mat) => { for (const [u0, u1, y0, y1] of rects) S.quad(P(u0, y0, d), P(u1, y0, d), P(u1, y1, d), P(u0, y1, d), col, mat); };
            S.cur = S.v;
            if (T.curtain) this.curtainFace(B, fc, hs, nOut);
            else face(rectMinusHoles(-half, half, floor, top, hs), 0, wallCol, 0);
            S.quad(P(-half, top, 0), P(half, top, 0), P(half, top, t), P(-half, top, t), wallCol, 0);
            for (const [u0, u1, y0, y1, kind] of T.curtain ? [] : hs) {
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
            if (!planned) {
                S.cur = S.iv;
                face(rectMinusHoles(-half + t, half - t, floor, top, hs), t, T.inner, M(0));
                S.cur = S.v;
            }
            let a = -half;
            const wall = (u0, u1) => { if (u1 - u0 > 0.01) S.solids.add(f, ...fbox(fc, (u0 + u1) / 2, t / 2, (u1 - u0) / 2, t / 2), floor, top); };
            for (const h of hs.filter(h => h[4] === 'door').sort((p, q) => p[0] - q[0])) { wall(a, h[0]); a = h[1]; }
            wall(a, half);
        }

        // stairs: a switchback of straight flights along the first wall long enough (the one opposite the front door
        // first), flight s from storey s to s + 1 in lane s % 2 (even ones climb along the wall, odd ones back), a landing
        // at both ends. The slab above each flight is open over it
        const lo = [-hx + t, -hz + t], hi = [hx - t, hz - t], flights = [], reserved = [];
        const plan = planned ? this.planned(B, T, spec) : null;
        if (!planned) {
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
        }

        // doors: a leaf hinged at one side of the opening on its inner side, swinging into the room (doorMesh); shut, it
        // is a solid across the opening, open, one along the inner wall
        for (const d of doors) {
            const fc = FACES[d.face], u0 = d.at - d.w / 2, lt = 0.05, [x, z] = fc.o(u0 + 0.02, t - lt / 2 - 0.01);
            const shut = S.solids.add(f, ...fbox(fc, d.at, t / 2, d.w / 2, t / 2), floor, floor + d.h);
            const open = S.solids.add(f, ...fbox(fc, u0 + 0.05, t + d.w / 2, 0.05, d.w / 2), floor, floor + d.h);
            open.off = true;
            const [cx, cz] = fc.o(d.at, t / 2);
            S.doors.add(d.leaf = { building: id, hinge: f.xz(x, z), u: wdir(fc.U), d: wdir(fc.D), w: d.w - 0.04, h: d.h - 0.02, y: floor, lt, open: 0, target: 0,
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
        } else if (R.kind === 'terrace') {
            // a setback's terrace (Buildings.tower): the slab round the footprint of the section above (R.inner: its
            // half width), its top level with that section's floor, and a parapet at its edge
            const th = T.slab, hi = R.inner;
            for (const [x0, x1, z0, z1] of rectMinusHoles(-hx, hx, -hz, hz, [[-hi, hi, -hi, hi]]))
                S.box(f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, top - th, top, roofCol, R.mat ?? 0);
            for (const [ox, oz, ex, ez] of [[0, -hz + 0.1, hx, 0.1], [0, hz - 0.1, hx, 0.1], [-hx + 0.1, 0, 0.1, hz], [hx - 0.1, 0, 0.1, hz]])
                S.box(f, ox, oz, ex, ez, top, top + 1.1, STRUCT_COLORS.metal, 4);
        } else {
            const ov = R.overhang ?? 0.25, th = R.thick ?? 0.5;
            S.box(f, 0, 0, hx + ov, hz + ov, top, top + th, roofCol, R.mat ?? 0);
            // a roof that hardly overhangs shares the shell's shader box (one box less in every shelter test)
            if (ov > 0.5) S.boxes.add(f, 0, 0, hx + ov, hz + ov, top, top + th, 0.4, 0, gLo);
            if (R.drip !== false) S.boxes.drip(f, 0, 0, hx + ov, hz + ov, top, top - floor + T.plinth);
        }
        // the shell: enclosed, so nothing falls inside it however the wind blows (unless the archetype says otherwise)
        const roofTop = R.kind !== 'gable' && R.kind !== 'terrace' && (R.overhang ?? 0.25) <= 0.5 ? top + (R.thick ?? 0.5) : top;
        S.boxes.add(f, 0, 0, hx, hz, gLo, roofTop, 0, 0, gLo, T.shelter !== false).building = id;     // (light through its openings)
        // (each flight's start and its direction up it, in the world: to walk it in tests and tours)
        const stairs = flights.map(fl => { const [x, z] = fl.fc.o(fl.up ? fl.a0 - 0.6 : fl.a1 + 0.6, fl.d0 + fl.sw / 2); return { at: f.at(x, floor + fl.s * H, z), dir: wdir(fl.up ? fl.fc.U : [-fl.fc.U[0], -fl.fc.U[1]]) }; });
        if (doors.length > BUILDING_DOORS) console.warn(`building ${id}: only its first ${BUILDING_DOORS} doors let light through`);
        const hall = spec.hall || { zone: 0, off: 0, min: 0, first: plan?.info[0].kind === 'hall' ? 1 : 0, top: 0 };
        const b = { id, f, hx, hz, t, floor, top, n, H, stairs, doors, centre: [f.c[0], floor + n * H / 2, f.c[1]], range: [iv0, S.iv.length / STRUCT_FLOATS],
            plan, name: spec.name,
            record: [f.c[0], f.c[1], f.cs, f.sn, hx, hz, floor, H, n, W.sill, W.height, W.pitch, W.width, t, T.lamps ?? 0.5, faceMask],
            extra: [...(plan ? plan.depth : [0, 0]), hall.min, 0, hall.zone, hall.off, hall.first, hall.top] };
        // its interior (kits.interior): the rooms inside the walls in its own frame (origin on the floor at its centre), seen
        // from outside through its windows and its doors while they are open; a weather shelter unless the archetype says not
        const portals = [];
        for (const [name, fc] of Object.entries(FACES)) for (const [u0, u1, y0, y1, kind] of holes[name]) {
            const [x, z] = fc.o((u0 + u1) / 2, t / 2), leaf = kind === 'door' && doors.find(d => d.face === name && Math.abs(d.at - (u0 + u1) / 2) < 1e-6)?.leaf;
            portals.push({ c: [x, (y0 + y1) / 2 - floor, z], n: [-fc.D[0], 0, -fc.D[1]], w: u1 - u0, h: y1 - y0, kind, open: leaf ? () => leaf.open > 0.02 : null });
        }
        // a curtain wall: one portal for each face's glass, its whole height
        if (T.curtain) for (const [name, fc] of Object.entries(FACES)) {
            if (!(faceMask & fc.bit)) continue;
            const [x, z] = fc.o(0, t / 2);
            portals.push({ c: [x, (top - floor) / 2, z], n: [-fc.D[0], 0, -fc.D[1]], w: fc.len - 2 * t, h: top - floor, kind: 'window' });
        }
        b.interior = S.interiors.add(new Interior({ owner: b, kind: 'building', origin: Origin.yaw(f.c[0], floor, f.c[1], f.cs, f.sn),
            lo: [-hx + t, -0.2, -hz + t], hi: [hx - t, top - floor, hz - t], portals, shelter: T.shelter !== false }));
        Buildings.localize(S.iv, b);
        this.list.push(b);
        if (plan) this.areas(b, B, T, spec);
        // the lifts in its core: a car in each shaft, stopping at every storey
        if (plan && spec.lifts !== false && n > 1) for (const sh of plan.core.shafts)
            S.lifts.add({ f, rect: sh.rect, face: sh.face, kind: 'local', name: `${spec.name || 'Lift'} ${sh.bank ? 'B' : 'A'}${sh.index + 1}`,
                stops: Array.from({ length: n }, (_, s) => ({ y: floor + s * H, name: s === 0 ? 'G' : String(s), building: b, g: s })) });
        return b;
    }

    // A skyscraper on frame f, as the settlement kit's towerPlan lays it out (TOWER, spec overrides): its lobby storey in
    // a podium, then sections stepping in, each a building of the `tower` archetype (a curtain wall, planned storeys) on
    // the one below (its terrace round it), all round the same core, its lifts zoned; a spire stands on the roof.
    // spec: name, color, seed, lobby, zone, sections (widths, m), zonesPerSection, podium, spire, storeyHeight.
    // Returns { lobby, sections: [{ b, g0 }], top (m), storeys, stop(g) }
    tower(f, spec = {}) {
        const S = this.S, A = this.types.tower, C = STRUCT_COLORS;
        const T = towerPlan({ ...TOWER, storeyHeight: A.storeyHeight, stairWidth: A.stairs.width, ...spec }), hp = (spec.podium ?? TOWER.podium) / 2;
        const g = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => S.ground(...f.xz(sx * hp, sz * hp)));
        const gLo = Math.min(...g) - 1, floor0 = Math.max(...g) + A.plinth;
        const common = { type: 'tower', name: T.name, color: spec.color || [0.2, 0.22, 0.25], core: T.core, lifts: false, liftDoor: T.liftDoor, seed: spec.seed ?? 5 };
        const lobby = this.add(f, { ...common, w: 2 * hp, d: 2 * hp, storeys: 1, storeyHeight: T.LH, floor: floor0, base: gLo,
            window: { height: T.LH - 1.0, sill: 0.3 }, doors: [{ face: '-z', at: -6 }, { face: '-z', at: 6 }],
            storeyInfo: T.lobbyInfo, hall: { zone: 0, off: 0, min: 0, first: 1, top: 0 },
            roof: { kind: 'terrace', inner: T.sections[0].w / 2, drip: false } });
        const sections = [];
        let y = lobby.top, prev = lobby;
        for (const sec of T.sections) {
            const b = this.add(f, { ...common, w: sec.w, d: sec.w, storeys: sec.n, storeyHeight: T.H, floor: y, base: y, doors: [],
                storeyInfo: sec.storeyInfo, hall: sec.hall,
                roof: sec.last ? { kind: 'flat', overhang: 0.4, thick: 1.2, drip: false } : { kind: 'terrace', inner: sec.next / 2, drip: false } });
            sections.push({ b, g0: sec.g0 });
            prev.above = b;              // (stacked: their stairwells and shafts open into each other, joins)
            b.below = prev;
            prev = b;
            y = b.top;
        }
        // the crown and the spire, a beacon on its tip
        const roof = y + 1.2, sp = spec.spire ?? TOWER.spire;
        S.box(f, 0, 0, 7, 7, roof, roof + 6, C.metal, 4);
        for (let i = 0; i < 6; i++) {
            const a = 3.2 * (1 - i / 6) + 0.25, y0 = roof + 6 + i * sp / 6;
            S.prism(f, 0, 0, a, a, y0, y0 + sp / 6, C.metal, 4);
        }
        S.prism(f, 0, 0, 0.35, 0.35, roof + 6 + sp, roof + 6 + sp + 0.7, [1.0, 0.18, 0.12], 7);
        S.boxes.add(f, 0, 0, 7, 7, roof, roof + 6, 0.2, 0, roof);
        // storey g: its floor, building, name
        const stop = gg => {
            if (gg === 0) return { y: floor0, building: lobby, name: T.label(0), g: 0 };
            const sec = sections.find(q => gg >= q.g0 && gg < q.g0 + q.b.n);
            return { y: sec.b.floor + (gg - sec.g0) * T.H, building: sec.b, name: T.label(gg), g: gg };
        };
        for (const l of T.lifts) S.lifts.add({ f, rect: l.shaft.rect, face: l.shaft.face, kind: l.kind, group: l.group, name: l.name, stops: l.stops.map(stop) });
        return { lobby, sections, top: roof + 6 + sp, storeys: T.G, zone: T.Z, stop, sky: T.sky, label: T.label };
    }

    // The planned interior (T.plan: kits.interior FloorPlan): a plan per kind of storey (rooms; or a hall round the core),
    // each kind of storey (storeyInfo's key) built once at its first storey (FloorBuilder) and, when storeys share it,
    // stacked: its vertices drawn instanced one storey up per instance and its solids made real only near a walker
    // (Solids.stack). Returns { core, keys (per storey), tpl (key -> { s0, storeys, rooms (vertex ranges), first,
    // count, stacked, plan }), planOf(s) (its plan), depth ([how deep the rooms off the x faces, off the z faces
    // reach]: the sun reaches no deeper, WGSL_BUILDING), info (per storey) }
    planned(B, T, spec) {
        const { S, n, H, floor, hx, hz, t } = B, pl = { ...T.plan, ...(spec.plan || {}) };
        const core = spec.core || coreLayout({ stairs: n > 1 && T.stairs ? { lane: Math.max(1.1, T.stairs.width) } : false,
            banks: n > 1 ? pl.lifts || [0, 1] : [0, 0], shaft: pl.shaft, lobby: pl.lobby }, H);
        const info = spec.storeyInfo || (s => s === 0 ? { key: 'ground', kind: pl.ground || 'rooms', stairsUp: n > 1, ground: true }
            : s === n - 1 ? { key: 'top', kind: 'rooms', stairsUp: false } : { key: 'mid', kind: 'rooms', stairsUp: true });
        const infos = Array.from({ length: n }, (_, s) => info(s)), plans = {};
        const planOf = kind => plans[kind] ??= new FloorPlan({ hx, hz, t, core, corridor: pl.corridor, module: pl.module, minRoom: pl.minRoom, kind,
            seed: B.id * 31 + (kind === 'hall' ? 1 : 2) });
        const fb = new FloorBuilder(B), tpl = new Map();
        infos.forEach((o, s) => { if (!tpl.has(o.key)) tpl.set(o.key, { s0: s, storeys: [], info: o }); tpl.get(o.key).storeys.push(s); });
        for (const [key, tp] of tpl) {
            const P = planOf(tp.info.kind), y = floor + tp.s0 * H, stacked = tp.storeys.length > 1, first = S.iv.length / STRUCT_FLOATS;
            const opts = { ...tp.info, stacked, seed: B.id * 977 + tp.s0, liftDoors: k => spec.liftDoor ? spec.liftDoor(core.shafts[k], tp.info) : true };
            const build = () => { tp.rooms = fb.storey(P, y, opts); };
            if (stacked) S.solids.stack(y, H, si => infos[tp.s0 + si]?.key === key, build);
            else build();
            Object.assign(tp, { first, count: S.iv.length / STRUCT_FLOATS - first, stacked, plan: P });
        }
        // how deep the rooms off each pair of façades reach (from the wall's inner face)
        const depth = [0, 0], R = planOf('rooms'), X = hx - t, Z = hz - t;
        for (const room of R.rooms) {
            if (!['office', 'open', 'meeting'].includes(room.kind)) continue;
            for (const [x0, x1, z0, z1] of room.rects) {
                if (Math.abs(Math.abs(x0) - X) < 1e-3 || Math.abs(Math.abs(x1) - X) < 1e-3) depth[0] = Math.max(depth[0], x1 - x0);
                if (Math.abs(Math.abs(z0) - Z) < 1e-3 || Math.abs(Math.abs(z1) - Z) < 1e-3) depth[1] = Math.max(depth[1], z1 - z0);
            }
        }
        return { core, keys: infos.map(o => o.key), tpl, info: infos, depth, planOf: s => planOf(infos[s].kind) };
    }

    // A planned building's rooms as the world's areas and portals (S.areas: the interior kit's AreaSet, the portal
    // feature's Area and Portal, traversed by its PortalVis: RoomVis): each room's rectangles on every storey an Area
    // (its storey high), its stairwell and each lift shaft one Area its whole height; the portals between them, their
    // areas found as the portal feature finds them (areaAt either side, once every building's areas are in:
    // Structures.finish): every doorway (a lift's landing door where its shaft has one: closed while no car stands there
    // with its doors open, RoomVis), the openings between a room's own rectangles (a corridor's pieces), and each room's
    // stretches of façade, the storey's window band (the ground floor's doors too), out to the outdoors. area.room says
    // what to draw of it: { b, s, k } (room k of storey s), or { b, vert: 'stair' | shaft index }
    areas(b, B, T, spec) {
        const S = this.S, A = S.areas, { f, H, n, floor } = B, plan = b.plan, core = plan.core;
        const shape = r => [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]].map(([x, z]) => f.xz(x, z));
        const area = (r, y, h, room, reach = 0) => Object.assign(A.addArea({ id: A.areas.length, shape: shape(r), y, height: h, shelter: T.shelter !== false }), { room, reach });
        const dir = ([x, z]) => [x * f.cs - z * f.sn, 0, x * f.sn + z * f.cs];
        const portal = (x, z, y, w, h, nl, extra = {}) => { const [wx, wz] = f.xz(x, z); S.portalDefs.push({ def: { center: [wx, y, wz], size: [w, h], normal: dir(nl), ...extra.def }, landing: extra.landing }); };
        const P0 = plan.planOf(0), W = T.window, door = Math.max(0, ...(T.doors || []).map(d => d.height ?? T.door.height));
        const [X0, X1, Z0, Z1] = P0.inner;
        for (let s = 0; s < n; s++) {
            const P = plan.planOf(s), info = plan.info[s], yb = floor + s * H;
            P.rooms.forEach((room, k) => {
                if (room.kind === 'stair' || room.kind === 'shaft') return;
                for (const r of room.rects) area(r, yb, H, { b, s, k });
                // the openings between its own rectangles
                for (let i = 0; i < room.rects.length; i++) for (let j = i + 1; j < room.rects.length; j++) {
                    const e = sharedEdge(room.rects[i], room.rects[j]);
                    if (!e) continue;
                    const c = (e.a0 + e.a1) / 2, [x, z] = e.axis === 'x' ? [c, e.at] : [e.at, c];
                    portal(x, z, yb + (H - T.slab) / 2, e.a1 - e.a0, H - T.slab, e.axis === 'x' ? [0, 1] : [1, 0], { def: { passThrough: true } });
                }
                // its façade's stretches, the window band
                const [b0, b1] = info.ground ? [0, Math.max(W.sill + W.height, door)] : [W.sill, Math.min(W.sill + W.height, H - T.slab)];
                for (const r of room.rects) for (const [axis, at, a0, a1, nl] of [['x', r[2], r[0], r[1], [0, -1]], ['x', r[3], r[0], r[1], [0, 1]], ['z', r[0], r[2], r[3], [-1, 0]], ['z', r[1], r[2], r[3], [1, 0]]]) {
                    if (axis === 'x' ? Math.abs(at - (nl[1] < 0 ? Z0 : Z1)) > 1e-4 : Math.abs(at - (nl[0] < 0 ? X0 : X1)) > 1e-4) continue;
                    const c = (a0 + a1) / 2, [x, z] = axis === 'x' ? [c, at] : [at, c];
                    portal(x, z, yb + (b0 + b1) / 2, a1 - a0, b1 - b0, nl);
                }
            });
            // the doorways, the stair doors, the landing doors where the shaft has one on this storey
            for (const p of P.portals) {
                const sk = P.rooms[p.a].kind === 'shaft' ? p.a : P.rooms[p.b].kind === 'shaft' ? p.b : -1, j = sk >= 0 ? P.coreIdx.shafts.indexOf(sk) : -1;
                if (p.kind === 'lift' && spec.liftDoor && !spec.liftDoor(core.shafts[j], info)) continue;
                const h = p.h || H - T.slab, [x, z] = p.axis === 'x' ? [p.c, p.at] : [p.at, p.c];
                portal(x, z, yb + h / 2, p.w, h, p.axis === 'x' ? [0, 1] : [1, 0],
                    p.kind === 'lift' ? { landing: { f, rect: P.rooms[sk].shaft.rect, y: yb } } : {});
            }
        }
        // the stairwell and each shaft, after the rooms (a point on a doorway between them is the room's: areaAt takes
        // the first by index). The stairwell's flights hide what is more than a few storeys up or down it: its doors
        // further off are not looked through (AreaSet reach); a shaft's, its storeys near
        if (P0.coreIdx.stair !== undefined) area(P0.rooms[P0.coreIdx.stair].rects[0], floor, n * H, { b, vert: 'stair' }, 3 * H);
        P0.coreIdx.shafts.forEach((k, j) => area(P0.rooms[k].rects[0], floor, n * H, { b, vert: j }, 6 * H));
    }

    // a tower's sections stacked (b.above): their stairwells and shafts open into each other's, a portal over each
    joins(b) {
        const S = this.S, f = b.f, P0 = b.plan.planOf(0), up = [f.cs, 0, f.sn];
        for (const k of [P0.coreIdx.stair, ...P0.coreIdx.shafts]) {
            if (k === undefined) continue;
            const [x0, x1, z0, z1] = P0.rooms[k].rects[0], [x, z] = f.xz((x0 + x1) / 2, (z0 + z1) / 2);
            S.portalDefs.push({ def: { center: [x, b.top, z], size: [x1 - x0, z1 - z0], normal: [0, 1, 0], right: up, passThrough: true } });
        }
    }

    // A curtain wall's face (T.curtain): per storey a band of glass (one pane, see-through near and opaque far like any
    // window's) between spandrels; a mullion over every joint between the windows (openingEdge in WGSL sees the gaps
    // between them as wall), full-height corners; the ground floor's doors cut through, their reveals across the wall
    curtainFace(B, fc, hs, nOut) {
        const { S, f, T, floor, n, H, t } = B, W = T.window, half = fc.len / 2, top = floor + n * H;
        const usable = fc.len - 2 * (t + 0.2), nw = Math.max(1, Math.floor(usable / W.pitch)), cell = usable / nw, U = usable / 2;
        const P = (u, y, d) => { const [x, z] = fc.o(u, d); return f.at(x, y, z); };
        const quad = (u0, u1, y0, y1, d, col, mat) => S.quad(P(u0, y0, d), P(u1, y0, d), P(u1, y1, d), P(u0, y1, d), col, mat);
        const span = T.spandrel || [0.15, 0.17, 0.2], frame = T.mullion || [0.55, 0.57, 0.6], doors = hs.filter(h => h[4] === 'door');
        S.cur = S.v;
        quad(-half, -U, floor, top, 0, span, 4);
        quad(U, half, floor, top, 0, span, 4);
        for (let s = 0; s < n; s++) {
            const yb = floor + s * H, g0 = yb + W.sill, g1 = Math.min(g0 + W.height, top), yn = s + 1 < n ? yb + H + W.sill : top;
            const glass = s === 0 ? rectMinusHoles(-U, U, g0, g1, doors) : [[-U, U, g0, g1]];
            if (s === 0) for (const r of rectMinusHoles(-U, U, floor, g0, doors)) quad(r[0], r[1], r[2], r[3], 0, span, 4);
            if (yn > g1) quad(-U, U, g1, yn, 0, span, 4);
            for (const to of [S.glass, S.panes]) {
                S.cur = to;
                for (const [u0, u1, y0, y1] of glass) S.quadN(P(u0, y0, 0.05), P(u1, y0, 0.05), P(u1, y1, 0.05), P(u0, y1, 0.05), nOut, STRUCT_COLORS.window, B.M(5));
            }
            S.cur = S.v;
        }
        // the mullions, from the plinth (or a door's head) to the top
        for (let i = 0; i <= nw; i++) {
            const u = -U + i * cell, hw = Math.max(0.05, (cell - W.width) / 2), d = doors.find(h => u > h[0] - hw && u < h[1] + hw);
            S.prism(f, ...B.fbox(fc, u, -0.03, hw, 0.08), d ? d[3] : floor, top, frame, 4);
        }
        for (const [u0, u1, y0, y1] of doors) {
            const rv = (a, b) => S.quad(P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], t), P(a[0], a[1], t), span, 4);
            rv([u0, y0], [u0, y1]);
            rv([u1, y0], [u1, y1]);
            rv([u0, y1], [u1, y1]);
        }
    }

    // Its interior's vertices (built in the world) into its Origin's frame (on its floor at its centre, turned with it),
    // in doubles: the renderer draws them with a model-view built about the camera (vsInterior), so a room a few
    // kilometres from the world's origin, or at the top of a tower, has no f32 cracks between its walls and floors
    static localize(iv, b) {
        const { cs, sn, c } = b.f, tx = c[0], tz = c[1], ty = b.floor;
        for (let i = b.range[0] * STRUCT_FLOATS; i < b.range[1] * STRUCT_FLOATS; i += STRUCT_FLOATS) {
            const x = iv[i] - tx, z = iv[i + 2] - tz, nx = iv[i + 3], nz = iv[i + 5];
            iv[i] = x * cs + z * sn; iv[i + 1] -= ty; iv[i + 2] = -x * sn + z * cs;
            iv[i + 3] = nx * cs + nz * sn; iv[i + 5] = -nx * sn + nz * cs;
        }
    }

    // its GPU record (WGSL_BUILDING): the static part, then each door (BUILDING_DOORS) as it stands now: [face (1 -z,
    // 2 +z, 3 -x, 4 +x; 0 none) + how far its leaf has swung (0..1; 0 shut), its centre along the face's local axis (x
    // for the z faces, z for the x ones), width, height]. Its leaf is hinged at the low end of that axis on the -z and +x
    // faces, at the high end on the others (Buildings.add)
    record(b) {
        const doors = new Array(BUILDING_DOORS * 4).fill(0);
        b.doors.slice(0, BUILDING_DOORS).forEach((d, i) => {
            const face = { '-z': 1, '+z': 2, '-x': 3, '+x': 4 }[d.face];
            doors.splice(i * 4, 4, face + Math.min(d.leaf.open, 0.999), face === 1 || face === 4 ? d.at : -d.at, d.w, d.h);
        });
        return [...b.record, ...doors, ...b.extra];
    }

    // An unplanned building's interior draw (it is one room): the whole of it, into out as [first vertex, count,
    // instances, first instance]. A planned one's rooms are drawn as the portal traversal reaches them (RoomVis)
    draws(b, out) { if (!b.plan && b.range[1] > b.range[0]) out.push([b.range[0], b.range[1] - b.range[0], 1, 0, b]); }

    // every room of planned building b's storeys within INTERIOR_DRAW of the eye (RoomVis's fallback)
    near(b, eye, out) {
        const q = b.interior.origin.toLocal(eye), R = INTERIOR_DRAW, dh = Math.hypot(Math.max(Math.abs(q[0]) - b.hx, 0), Math.max(Math.abs(q[2]) - b.hz, 0));
        if (dh >= R) return;
        const dy = Math.sqrt(R * R - dh * dh);
        this.storeys(b, Math.floor((q[1] - dy) / b.H), Math.floor((q[1] + dy) / b.H), out);
    }

    // storeys lo..hi of planned building b, every room, into out (as draws)
    storeys(b, lo, hi, out) {
        const P = b.plan;
        lo = Math.max(0, lo); hi = Math.min(b.n - 1, hi);
        if (!P || hi < lo) return;
        const runs = (list, emit) => {
            for (let i = 0; i < list.length;) {
                let j = i;
                while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
                emit(list[i], j - i + 1);
                i = j + 1;
            }
        };
        for (const tp of P.tpl.values()) {
            if (!tp.count) continue;
            const list = tp.storeys.filter(s => s >= lo && s <= hi);
            if (!list.length) continue;
            if (tp.stacked) runs(list, (s, m) => out.push([tp.first, tp.count, m, s - tp.s0, b]));
            else out.push([tp.first, tp.count, 1, 0, b]);
        }
    }

    // the building p is inside (its interior), or null: the few buildings in p's cell of the InteriorIndex, O(1)
    inside(p) { return this.S.interiors.at(p, 'building')?.owner || null; }
}

return { Buildings };
});
