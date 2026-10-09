'use strict';
// Storeys of a planned building (kits.interior FloorPlan): each room's floor, ceiling, walls (partitions with their
// doorways, the fa�ade's inner face with its windows), stairs, furniture and lamps. Built room by room so that every
// room is one vertex range of the interior mesh (drawn when the camera sees it: PortalVis over its areas), with the
// solids to walk on. The lift shafts are pieces of their own (shaftPiece): each kind of slice of a shaft (its pit, a
// plain stretch, a stretch with a landing door, the overrun and machine room...) built once and drawn instanced up the
// shaft, apart from the storeys round it.

Features.kit('building', (engine, kit) => {
const { Common, kits } = engine;
const { lerp } = Common;
const { mulberry32 } = kits.noise;
const { rectMinusHoles, PALETTE } = kits.mesh;
const { furnishRoom, PARTITION } = kit;

const EPS = 1e-4;
const LAMP = [1.0, 0.95, 0.86];
const SHAFT = { wall: [0.46, 0.46, 0.45], rail: [0.32, 0.33, 0.35], ladder: [0.85, 0.66, 0.12], weight: [0.22, 0.23, 0.25], machine: [0.18, 0.36, 0.30],
    frame: [0.30, 0.31, 0.32], sill: [0.55, 0.56, 0.57], cabinet: [0.62, 0.63, 0.60] };

// B: the building being built (its world's): { S (the world's structures: quad / prism / box (a prism and a solid) in a
// ground frame, solids.add, cur (the triangle list built into) and iv (the interior's)), f (its ground frame), T (its
// archetype merged with its spec: storeyHeight, slab, wall, inner / floorColor / ceiling / lobbyFloor colours,
// curtain), hx, hz, t, H, faces (each face's o(u, d) -> local [x, z], len), windows(name, y): the window holes [u0, u1,
// y0, y1] of a storey whose floor is at y on that face, doors(name): the outer doors' holes on the ground floor,
// code(mat, stacked, dark): a vertex's material code (dark: in an enclosed space lit by its own lamps only, a shaft),
// count(): the interior's vertices so far, lib (PlanLibrary) }
class FloorBuilder {
    constructor(B) { this.B = B; }

    // Storey s of plan P with its floor at y. o: { stacked (its vertices are drawn instanced for many storeys),
    // stairsUp (its flights climb to the storey above; else the stairwell is floored over), ground (the outer doors are
    // in its façade), shafts (per shaft of the core: its slice here, see shaft()), seed }. Returns per room its vertex
    // range: [[first, count], ...] (a shaft's is empty: its pieces are shaftPiece's)
    storey(P, y, o) {
        const B = this.B, S = B.S, out = [];
        this.P = P; this.y = y; this.o = o;
        this.dark = false;
        this.M = mat => B.code(mat, o.stacked, this.dark);
        this.rnd = mulberry32(o.seed ?? 7);
        S.cur = S.iv;
        P.rooms.forEach((room, k) => {
            const first = B.count();
            this.room(k, room);
            out.push([first, B.count() - first]);
        });
        S.cur = S.v;
        return out;
    }

    // local box (x0..x1, z0..z1, y0..y1) as a mesh, and a solid unless `ghost`
    box(x0, x1, z0, z1, y0, y1, col, mat, ghost = false) {
        const S = this.B.S, f = this.B.f, args = [f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y0, y1, col, this.M(mat)];
        return ghost ? S.prism(...args) : S.box(...args);
    }

    flat(rects, y, col) {
        const S = this.B.S, f = this.B.f;
        for (const [x0, x1, z0, z1] of rects) S.quad(f.at(x0, y, z0), f.at(x1, y, z0), f.at(x1, y, z1), f.at(x0, y, z1), col, this.M(0));
    }

    room(k, room) {
        const B = this.B, T = B.T, y = this.y, H = B.H, kind = room.kind;
        if (kind === 'shaft') return;
        if (kind === 'stair') { this.stairs(k, room); return; }
        const top = y + H - T.slab, rt = B.lib?.room(kind);
        const floor = rt?.floor || (kind === 'lobby' || room.hall ? T.lobbyFloor || T.floorColor : T.floorColor);
        this.flat(room.rects, y + 0.005, floor);
        this.flat(room.rects, top, T.ceiling);
        for (const [x0, x1, z0, z1] of room.rects) B.S.solids.add(B.f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y - T.slab, y);
        this.walls(k, room, true);
        this.facade(room);
        this.furnish(k, room, rt);
        this.lamps(room, top);
    }

    // its partitions: an inner face along each stretch of wall that is not façade, less its doorways (with jambs and a
    // head), and a half-thick solid (the room on the other side adds the other half). draw: the faces too. A lift's
    // landing door is framed from the lobby's side, through the wall's whole thickness (no seam to see the shaft by)
    walls(k, room, draw) {
        const B = this.B, T = B.T, P = this.P, y = this.y, H = B.H, S = B.S, f = B.f;
        // a stairwell's and a shaft's walls run the storey's whole height (they are open from storey to storey)
        const full = room.kind === 'stair' || room.kind === 'shaft', top = full ? y + H : y + H - T.slab, half = PARTITION / 2;
        const ports = P.portalsOf(k), [X0, X1, Z0, Z1] = P.inner;
        const wallCol = room.kind === 'shaft' ? SHAFT.wall : T.inner;
        for (const w0 of P.walls(k)) {
            // each face runs on through the joint at its ends (half the wall's thickness) so that two meeting round a
            // corner close it; not into the façade
            const lim = w0.axis === 'x' ? [X0, X1] : [Z0, Z1];
            const w = { ...w0, a0: Math.abs(w0.a0 - lim[0]) < EPS ? w0.a0 : w0.a0 - half, a1: Math.abs(w0.a1 - lim[1]) < EPS ? w0.a1 : w0.a1 + half };
            const off = w.at + w.side * half, holes = [];
            for (const p of ports) {
                if (p.axis !== w.axis || Math.abs(p.at - w.at) > EPS || p.c < w.a0 - EPS || p.c > w.a1 + EPS) continue;
                let h = p.h;
                if (p.kind === 'lift') {
                    const L = this.landing(p);
                    if (!L) continue;
                    h = L.h;
                }
                holes.push([p.c - p.w / 2, p.c + p.w / 2, y, h ? y + h : top + 1, p]);
            }
            const pt = (u, yy, o = off) => w.axis === 'x' ? f.at(u, yy, o) : f.at(o, yy, u);
            if (draw) {
                for (const [u0, u1, y0, y1] of rectMinusHoles(w.a0, w.a1, y, top, holes))
                    S.quad(pt(u0, y0), pt(u1, y0), pt(u1, y1), pt(u0, y1), wallCol, this.M(0));
                for (const [u0, u1, , y1, p] of holes) {
                    const yh = Math.min(y1, top);
                    if (p.kind === 'lift') {
                        // from the lobby: the frame through the wall, an architrave round it, the sill; from the shaft (dark:
                        // its lamps light it), the jambs and head across its half of the wall, so that no slot between the
                        // wall's face and the landing doors behind it is seen through
                        if (room.kind !== 'shaft') this.landingFrame(w, u0, u1, yh, pt);
                        else {
                            for (const u of [u0, u1]) S.quad(pt(u, y), pt(u, y, w.at), pt(u, yh, w.at), pt(u, yh), wallCol, this.M(0));
                            S.quad(pt(u0, yh), pt(u1, yh), pt(u1, yh, w.at), pt(u0, yh, w.at), wallCol, this.M(0));
                        }
                        continue;
                    }
                    // a doorway's jambs and head, across this half of the wall
                    for (const u of [u0, u1]) S.quad(pt(u, y), pt(u, y, w.at), pt(u, yh, w.at), pt(u, yh), T.inner, this.M(0));
                    if (y1 < top) S.quad(pt(u0, y1), pt(u1, y1), pt(u1, y1, w.at), pt(u0, y1, w.at), T.inner, this.M(0));
                }
            }
            // solids: the stretches between the doorways (a doorway's head is over any walker's head)
            let a = w0.a0;
            const solid = (u0, u1) => {
                if (u1 - u0 < 0.01) return;
                const c = (u0 + u1) / 2, o = w.at + w.side * half / 2;
                if (w.axis === 'x') S.solids.add(f, c, o, (u1 - u0) / 2, half / 2, y, top);
                else S.solids.add(f, o, c, half / 2, (u1 - u0) / 2, y, top);
            };
            for (const [u0, u1] of holes.map(h => [h[0], h[1]]).sort((p, q) => p[0] - q[0])) { solid(a, u0); a = u1; }
            solid(a, w0.a1);
        }
    }

    // a landing door's frame seen from the lobby (w: the wall, its face at `off`): jambs and a head lining the opening
    // through the whole wall, an architrave proud of the face, a metal sill across its foot
    landingFrame(w, u0, u1, yh, pt) {
        const B = this.B, S = B.S, y = this.y, half = PARTITION / 2, M4 = this.M(4), C = SHAFT.frame;
        const back = w.at - w.side * half;                 // the shaft's face of the wall
        for (const u of [u0, u1]) S.quad(pt(u, y), pt(u, y, back), pt(u, yh, back), pt(u, yh), C, M4);
        S.quad(pt(u0, yh), pt(u1, yh), pt(u1, yh, back), pt(u0, yh, back), C, M4);
        S.quad(pt(u0, y + 0.012), pt(u1, y + 0.012), pt(u1, y + 0.012, back), pt(u0, y + 0.012, back), SHAFT.sill, M4);
        // the architrave: a band 8 cm wide, 2 cm proud
        const o = w.at + w.side * (half + 0.02), face = (a, b, c, d) => S.quad(pt(a, c, o), pt(b, c, o), pt(b, d, o), pt(a, d, o), C, M4);
        face(u0 - 0.08, u0, y, yh + 0.08);
        face(u1, u1 + 0.08, y, yh + 0.08);
        face(u0, u1, yh, yh + 0.08);
    }

    // a shaft's landing on this storey (o.shafts: by the shaft's index in the core): { h } for a landing door, a service
    // opening into its machine room (as high as the room), or null for a blank wall
    landing(p) {
        const P = this.P, sr = P.rooms[p.a].kind === 'shaft' ? p.a : p.b, j = P.coreIdx.shafts.indexOf(sr), sl = this.o.shafts?.[j];
        if (!sl) return { h: p.h };
        if (sl.door) return { h: p.h };
        if (sl.service) return { h: Math.min(sl.service, p.h) };
        return null;
    }

    // Shaft j of plan P's piece for a storey whose floor is at y: slice sl (see shaft()); o: { stacked (drawn instanced
    // up the shaft), light (the core's shaftLight) }. Dark: lit by the shaft's own lamps. Returns its vertex range
    shaftPiece(P, j, y, sl, o) {
        const B = this.B, S = B.S, k = P.coreIdx.shafts[j], first = B.count(), shafts = [];
        shafts[j] = sl;
        this.P = P; this.y = y; this.o = { ...o, shafts };
        this.dark = true;
        this.M = mat => B.code(mat, o.stacked, true);
        S.cur = S.iv;
        this.shaft(k, P.rooms[k]);
        S.cur = S.v;
        this.dark = false;
        return [first, B.count() - first];
    }

    // Shaft k's slice of this storey: its walls (the storey's whole height, the landing's opening where it has one),
    // and of what is in it (o.shafts[j], heights over this storey's floor; each optional): run [y0, y1] (the car's: its
    // guide rails and the counterweight's), ladder [y0, y1] (the emergency ladder up the technical space), pit (the pit's
    // floor), top (the overrun's ceiling), machine [y0, y1] (the machine room over it: its floor, the machine, the
    // controller, a lamp)
    shaft(k, room) {
        const B = this.B, y = this.y, H = B.H, sh = room.shaft, sl = this.o.shafts?.[this.P.coreIdx.shafts.indexOf(k)] || {};
        this.walls(k, room, true);
        const [x0, x1, z0, z1] = sh.rect, half = PARTITION / 2, ix0 = x0 + half, ix1 = x1 - half, iz0 = z0 + half, iz1 = z1 - half;
        const clip = r => r ? [Math.max(r[0], 0), Math.min(r[1], H)] : null;
        const run = clip(sl.run), lad = clip(sl.ladder);
        const M0 = 0, M4 = 4;
        // the car's guide rails on its sides (T sections: a web and a blade), the counterweight's two at the back
        if (run && run[1] > run[0]) {
            const cx = (sh.car.rect[0] + sh.car.rect[1]) / 2;
            for (const zr of sh.rails) this.box(cx - 0.05, cx + 0.05, zr - 0.04, zr + 0.04, y + run[0], y + run[1], SHAFT.rail, M4, true);
            const cw = sh.counterweight.rect;
            for (const zr of [cw[2] - 0.03, cw[3] + 0.03]) this.box(cw[0], cw[1], zr - 0.02, zr + 0.02, y + run[0], y + run[1], SHAFT.rail, M4, true);
        }
        // the emergency ladder: two stiles and rungs every 0.3 m, its rungs 16 cm off the side wall
        if (lad && lad[1] > lad[0]) {
            // (the stiles from the side wall out to the rungs' plane; rungs at heights that line up from storey to storey)
            const L = sh.ladder, wz = L.z - L.n[1] * 0.16, sz = [Math.min(wz, L.z) - 0.02, Math.max(wz, L.z) + 0.02];
            for (const u of [L.x - L.w / 2, L.x + L.w / 2]) this.box(u - 0.025, u + 0.025, sz[0], sz[1], y + lad[0], y + lad[1], SHAFT.ladder, M4, true);
            for (let r = y + 0.15 + Math.ceil((lad[0] - 0.15) / 0.3 - 1e-6) * 0.3; r < y + lad[1] - 0.05; r += 0.3)
                this.box(L.x - L.w / 2, L.x + L.w / 2, L.z - 0.016, L.z + 0.016, r - 0.016, r + 0.016, SHAFT.ladder, M4, true);
        }
        // the shaft's lamps (o.light, the core's shaftLight) up the technical space's side wall, along the car's run
        const SL = this.o.light;
        if (SL && run && sh.lamp) for (let i = 0; i < SL.perStorey; i++) {
            const ly = SL.y + i * H / SL.perStorey;
            if (ly < run[0] || ly > run[1]) continue;
            const L = sh.lamp, z0 = L.z - L.n[1] * 0.03, z1 = L.z + L.n[1] * 0.03;
            this.box(L.x - 0.16, L.x + 0.16, Math.min(z0, z1), Math.max(z0, z1), y + ly - 0.05, y + ly + 0.05, LAMP, 7, true);
        }
        // the pit's floor (a lamp and a buffer on it), the overrun's ceiling, the machine room
        if (sl.pit !== undefined && sl.pit !== null) {
            const yp = y + sl.pit;
            this.box(ix0, ix1, iz0, iz1, yp - 0.3, yp, SHAFT.wall, M0);
            const c = sh.car.rect;
            this.box((c[0] + c[1]) / 2 - 0.15, (c[0] + c[1]) / 2 + 0.15, sh.car.zc - 0.15, sh.car.zc + 0.15, yp, yp + 0.5, SHAFT.weight, M4, true);
            this.box(ix0 + 0.05, ix0 + 0.1, iz0 + 0.3, iz0 + 0.5, yp + 0.6, yp + 0.75, LAMP, 7, true);
        }
        if (sl.top !== undefined && sl.top !== null) {
            const yt = y + sl.top;
            this.box(ix0, ix1, iz0, iz1, yt, yt + 0.25, SHAFT.wall, M0);
            this.box(ix0 + 0.4, ix0 + 0.8, iz0 + 0.4, iz0 + 0.6, yt - 0.06, yt - 0.01, LAMP, 7, true);
        }
        if (sl.machine) {
            const [m0, m1] = sl.machine, ym = y + m0, c = sh.car.rect, cx = (c[0] + c[1]) / 2;
            // the traction machine over the car's run, its sheave; the controller cabinet against the back wall
            this.box(cx - 0.45, cx + 0.45, sh.car.zc - 0.5, sh.car.zc + 0.2, ym, ym + 0.8, SHAFT.machine, M4);
            this.box(cx - 0.12, cx + 0.12, sh.car.zc + 0.2, sh.car.zc + 0.55, ym + 0.2, ym + 0.85, SHAFT.rail, M4);
            const bx = sh.sx > 0 ? ix0 : ix1 - 0.4;
            this.box(bx, bx + 0.4, iz0 + 0.3, iz0 + 1.1, ym, ym + 1.9, SHAFT.cabinet, M4);
            this.box(ix0 + 0.3, ix1 - 0.3, (iz0 + iz1) / 2 - 0.15, (iz0 + iz1) / 2 + 0.15, y + m1 - 0.06, y + m1 - 0.01, LAMP, 7, true);
        }
    }

    // the façade's inner face along the room's outer edges, with this storey's windows (and the outer doors on the
    // ground floor) cut out and their reveals through the wall
    facade(room) {
        const B = this.B, T = B.T, y = this.y, H = B.H, S = B.S, t = B.t, [X0, X1, Z0, Z1] = [-B.hx + t, B.hx - t, -B.hz + t, B.hz - t];
        const top = y + H - T.slab;
        for (const r of room.rects) {
            const edges = [];
            if (Math.abs(r[2] - Z0) < EPS) edges.push(['-z', r[0], r[1]]);
            if (Math.abs(r[3] - Z1) < EPS) edges.push(['+z', -r[1], -r[0]]);
            if (Math.abs(r[0] - X0) < EPS) edges.push(['-x', -r[3], -r[2]]);
            if (Math.abs(r[1] - X1) < EPS) edges.push(['+x', r[2], r[3]]);
            for (const [name, u0, u1] of edges) {
                const fc = B.faces[name], P = (u, yy, d) => { const [x, z] = fc.o(u, d); return B.f.at(x, yy, z); };
                const hs = [...B.windows(name, y), ...(this.o.ground ? B.doors(name) : [])].map(([a, b, c, d]) => [Math.max(a, u0), Math.min(b, u1), c, d]).filter(h => h[1] - h[0] > EPS);
                for (const [a, b, c, d] of rectMinusHoles(u0, u1, y, top, hs)) S.quad(P(a, c, t), P(b, c, t), P(b, d, t), P(a, d, t), T.inner, this.M(0));
                // a curtain wall's glass stands near its outer face: the reveals inside it (punched windows have theirs
                // through the whole wall with the outside)
                if (!T.curtain) continue;
                const d0 = 0.05;
                for (const [a, b, c, d] of hs) {
                    const rv = (p, q) => S.quad(P(p[0], p[1], d0), P(q[0], q[1], d0), P(q[0], q[1], t), P(p[0], p[1], t), T.inner, this.M(0));
                    if (a > u0 + EPS) rv([a, c], [a, Math.min(d, top)]);
                    if (b < u1 - EPS) rv([b, c], [b, Math.min(d, top)]);
                    if (d < top) rv([a, d], [b, d]);
                    if (c > y + 0.01) rv([a, c], [b, c]);
                }
            }
        }
    }

    // a ceiling panel about every 4 m over the room (lit or not with its storey, storeyLit in WGSL)
    lamps(room, yc) {
        const S = this.B.S, f = this.B.f;
        for (const [x0, x1, z0, z1] of room.rects) {
            const nx = Math.max(1, Math.round((x1 - x0) / 4.2)), nz = Math.max(1, Math.round((z1 - z0) / 4.2));
            if ((x1 - x0) < 1.2 || (z1 - z0) < 1.2) continue;
            for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
                const x = lerp(x0, x1, (i + 0.5) / nx), z = lerp(z0, z1, (j + 0.5) / nz), hw = Math.min(0.3, (x1 - x0) / 4), hd = Math.min(0.3, (z1 - z0) / 4);
                S.prism(f, x, z, hw, hd, yc - 0.04, yc - 0.004, LAMP, this.M(7));
            }
        }
    }

    // A switchback stairwell: the floor landing at its -z end (where its door is), a flight up its first lane to the
    // half landing at the +z end, a flight back down the other lane to the storey above; a wall between the lanes.
    // Treads are slabs (a walker passes under the high end of a flight on the floor below). Without stairsUp (the top
    // storey) the well is floored over
    stairs(k, room) {
        const B = this.B, T = B.T, y = this.y, H = B.H, st = room.stair, [x0, x1, z0, z1] = room.rects[0];
        const lane = st.lane, land = st.landing, col = T.floorColor, rail = PALETTE.wood;
        this.walls(k, room, true);
        if (!this.o.stairsUp) {
            this.flat([[x0, x1, z0, z1]], y + 0.005, col);
            this.flat([[x0, x1, z0, z1]], y + H - T.slab, T.ceiling);
            B.S.solids.add(B.f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y - T.slab, y);
            this.lamps(room, y + H - T.slab);
            return;
        }
        const steps = Math.ceil(H / 2 / 0.18), rise = H / 2 / steps, run = (z1 - z0 - 2 * land) / steps, thick = 0.22;
        // the floor landing; on the ground storey (no flights below) the well's whole floor
        if (this.o.ground) this.box(x0, x1, z0, z1, y - T.slab, y, col, 0);
        else this.box(x0, x1, z0, z0 + land, y - T.slab, y, col, 0);
        this.box(x0, x1, z1 - land, z1, y + H / 2 - thick, y + H / 2, col, 0);
        for (let i = 0; i < steps; i++) {
            const ta = y + (i + 1) * rise, za = z0 + land + i * run;
            this.box(x0, x0 + lane, za, za + run, ta - thick, ta, col, 0);
            const tb = y + H / 2 + (i + 1) * rise, zb = z1 - land - (i + 1) * run;
            this.box(x1 - lane, x1, zb, zb + run, tb - thick, tb, col, 0);
        }
        // the wall between the lanes, and a handrail on it
        this.box(x0 + lane, x1 - lane, z0 + land, z1 - land, y, y + H, T.inner, 0);
        // a lamp on the half landing's wall
        const fl = B.f;
        B.S.prism(fl, (x0 + x1) / 2, z1 - 0.05, 0.25, 0.04, y + H / 2 + 2.0, y + H / 2 + 2.15, LAMP, this.M(7));
        B.S.prism(fl, x0 + lane + 0.05, (z0 + z1) / 2, 0.03, (z1 - z0) / 2 - land, y + 0.95, y + 1.0, rail, this.M(0));
    }

    // what stands in the room (its roomType's furniture, the library's items): seeded per room, its doorways kept clear
    furnish(k, room, rt) {
        if (!rt?.furniture || !this.B.lib) return;
        const y = this.y, keep = [];
        for (const p of this.P.portalsOf(k)) {
            const c = p.c, w = p.w / 2 + 0.35;
            if (p.axis === 'x') keep.push([c - w, c + w, p.at - 1.3, p.at + 1.3]);
            else keep.push([p.at - 1.3, p.at + 1.3, c - w, c + w]);
        }
        for (const r of room.rects) furnishRoom(r, rt.furniture, this.B.lib, this.rnd,
            (x0, x1, z0, z1, ya, yb, col, fin) => this.box(x0, x1, z0, z1, y + ya, y + yb, col, fin === 'metal' ? 4 : 0), keep);
    }
}

return { FloorBuilder, SHAFT_COLORS: SHAFT };
});
