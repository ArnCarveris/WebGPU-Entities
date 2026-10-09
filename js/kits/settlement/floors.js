'use strict';
// Storeys of a planned building (kits.interior FloorPlan): each room's floor, ceiling, walls (partitions with their
// doorways, the façade's inner face with its windows), stairs, furniture and lamps, built room by room so that every
// room is one vertex range of the interior mesh (drawn when the camera sees it: PortalVis over its areas), and the solids to walk on.

Features.kit('settlement', (engine, kit) => {
const { Common, kits } = engine;
const { lerp } = Common;
const { mulberry32 } = kits.noise;
const { rectMinusHoles, PALETTE: STRUCT_COLORS } = kits.mesh;
const { ROOM_FURNITURE, FURNITURE_ITEMS, FURNITURE_COLORS } = kit;

const PARTITION = 0.12;          // m: an inner wall
const EPS = 1e-4;

// B: the building being built: { S (the world's structures: quad / prism / box (a prism and a solid) in a ground frame,
// solids.add, cur (the triangle list built into) and iv (the interior's)), f (its ground frame), T (its archetype merged
// with its spec: storeyHeight, slab, wall, inner / floorColor / ceiling colours, curtain), hx, hz, t, H, faces (each
// face's o(u, d) -> local [x, z], len), windows(name, y): the window holes [u0, u1, y0, y1] of a storey whose floor is at
// y on that face, doors(name): the outer doors' holes on the ground floor, code(mat, stacked): a vertex's material code
// (its building's, flagged as one of a stacked storey), count(): the interior's vertices so far }
class FloorBuilder {
    constructor(B) { this.B = B; }

    // Storey s of plan P with its floor at y. o: { stacked (its vertices carry BLD_STACK: drawn instanced for many
    // storeys), stairsUp (its flights climb to the storey above; else the stairwell is floored over), ground (the outer
    // doors are in its façade), liftDoors (shaft index -> whether its landing door opens here), seed }. Returns per
    // room its vertex range: [[first, count], ...]
    storey(P, y, o) {
        const B = this.B, S = B.S, out = [];
        this.P = P; this.y = y; this.o = o;
        this.M = mat => B.code(mat, o.stacked);
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
        const B = this.B, T = B.T, P = this.P, y = this.y, H = B.H, kind = room.kind;
        if (kind === 'shaft') { this.walls(k, room, true); return; }       // its walls; its car and doors are the Lifts'
        const top = y + H - T.slab;
        if (kind === 'stair') { this.stairs(k, room); return; }
        this.flat(room.rects, y + 0.005, kind === 'lobby' || kind === 'hall' ? T.lobbyFloor || T.floorColor : T.floorColor);
        this.flat(room.rects, top, T.ceiling);
        for (const [x0, x1, z0, z1] of room.rects) B.S.solids.add(B.f, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y - T.slab, y);
        this.walls(k, room, true);
        this.facade(room);
        this.furnish(k, room);
        this.lamps(room, top);
    }

    // its partitions: an inner face along each stretch of wall that is not façade, less its doorways (with jambs and a
    // head), and a half-thick solid (the room on the other side adds the other half). draw: the faces too
    walls(k, room, draw) {
        const B = this.B, T = B.T, P = this.P, y = this.y, H = B.H, S = B.S, f = B.f;
        // a stairwell's and a shaft's walls run the storey's whole height (they are open from storey to storey)
        const full = room.kind === 'stair' || room.kind === 'shaft', top = full ? y + H : y + H - T.slab, half = PARTITION / 2;
        const ports = P.portalsOf(k), [X0, X1, Z0, Z1] = P.inner;
        for (const w0 of P.walls(k)) {
            // each face runs on through the joint at its ends (half the wall's thickness) so that two meeting round a
            // corner close it; not into the façade
            const lim = w0.axis === 'x' ? [X0, X1] : [Z0, Z1];
            const w = { ...w0, a0: Math.abs(w0.a0 - lim[0]) < EPS ? w0.a0 : w0.a0 - half, a1: Math.abs(w0.a1 - lim[1]) < EPS ? w0.a1 : w0.a1 + half };
            const off = w.at + w.side * half, holes = [];
            for (const p of ports) {
                if (p.axis !== w.axis || Math.abs(p.at - w.at) > EPS || p.c < w.a0 - EPS || p.c > w.a1 + EPS) continue;
                if (p.kind === 'lift' && !this.liftOpen(p)) continue;
                holes.push([p.c - p.w / 2, p.c + p.w / 2, y, p.h ? y + p.h : top + 1, p]);
            }
            const pt = (u, yy, o = off) => w.axis === 'x' ? f.at(u, yy, o) : f.at(o, yy, u);
            if (draw) {
                for (const [u0, u1, y0, y1] of rectMinusHoles(w.a0, w.a1, y, top, holes))
                    S.quad(pt(u0, y0), pt(u1, y0), pt(u1, y1), pt(u0, y1), T.inner, this.M(0));
                // a doorway's jambs and head, across this half of the wall
                for (const [u0, u1, , y1] of holes) {
                    const yh = Math.min(y1, top);
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

    // whether a shaft's landing door is in this storey (o.liftDoors: by the shaft's index in the core)
    liftOpen(p) {
        const P = this.P, sr = P.rooms[p.a].kind === 'shaft' ? p.a : p.b;
        return this.o.liftDoors ? this.o.liftDoors(P.coreIdx.shafts.indexOf(sr)) : true;
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
                S.prism(f, x, z, hw, hd, yc - 0.04, yc - 0.004, [1.0, 0.95, 0.86], this.M(7));
            }
        }
    }

    // A switchback stairwell: the floor landing at its -z end (where its door is), a flight up its first lane to the
    // half landing at the +z end, a flight back down the other lane to the storey above; a wall between the lanes.
    // Treads are slabs (a walker passes under the high end of a flight on the floor below). Without stairsUp (the top
    // storey) the well is floored over
    stairs(k, room) {
        const B = this.B, T = B.T, y = this.y, H = B.H, st = room.stair, [x0, x1, z0, z1] = room.rects[0];
        const lane = st.lane, land = st.landing, col = T.floorColor, rail = STRUCT_COLORS.wood;
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
        B.S.prism(fl, (x0 + x1) / 2, z1 - 0.05, 0.25, 0.04, y + H / 2 + 2.0, y + H / 2 + 2.15, [1.0, 0.95, 0.86], this.M(7));
        B.S.prism(fl, x0 + lane + 0.05, (z0 + z1) / 2, 0.03, (z1 - z0) / 2 - land, y + 0.95, y + 1.0, rail, this.M(0));
    }

    // what stands in the room (ROOM_FURNITURE by its kind): along its walls (not in front of a doorway or a window
    // low enough to be in the way) and free in it, or desks in rows; seeded per room
    furnish(k, room) {
        const plan = ROOM_FURNITURE[room.kind];
        if (!plan) return;
        const B = this.B, P = this.P, y = this.y, rnd = this.rnd, r = room.rects[0], [x0, x1, z0, z1] = r;
        const W = x1 - x0, D = z1 - z0;
        if (W < 1.6 || D < 1.6) return;
        const taken = [];
        // keep the doorways clear (1.3 m into the room)
        for (const p of P.portalsOf(k)) {
            const c = p.c, w = p.w / 2 + 0.35;
            if (p.axis === 'x') taken.push([c - w, c + w, p.at - 1.3, p.at + 1.3]);
            else taken.push([p.at - 1.3, p.at + 1.3, c - w, c + w]);
        }
        const overlaps = (a, b) => a[0] < b[1] && a[1] > b[0] && a[2] < b[3] && a[3] > b[2];
        const fits = q => q[0] >= x0 - EPS && q[1] <= x1 + EPS && q[2] >= z0 - EPS && q[3] <= z1 + EPS && !taken.some(t => overlaps(q, t));
        // an item in its own frame (u across its width, v out from its back) at (cx, cz), its back toward `back` (unit, local)
        const put = (it, cx, cz, back) => {
            const ux = -back[1], uz = back[0], vx = -back[0], vz = -back[1];
            for (const [u0, u1, v0, v1, ya, yb, cn] of it.parts) {
                const pc = [cx + ux * (u0 + u1) / 2 + vx * ((v0 + v1) / 2 - it.d / 2), cz + uz * (u0 + u1) / 2 + vz * ((v0 + v1) / 2 - it.d / 2)];
                const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2, hx = Math.abs(ux) * hu + Math.abs(vx) * hv, hz = Math.abs(uz) * hu + Math.abs(vz) * hv;
                this.box(pc[0] - hx, pc[0] + hx, pc[1] - hz, pc[1] + hz, y + ya, y + yb, FURNITURE_COLORS[cn], cn === 'metal' ? 4 : 0);
            }
        };
        const foot = (it, cx, cz, back, pad = 0.1) => {
            const hw = it.w / 2 + pad, hd = it.d / 2 + pad;
            return back[0] ? [cx - hd, cx + hd, cz - hw, cz + hw] : [cx - hw, cx + hw, cz - hd, cz + hd];
        };
        const sides = [[0, -1], [0, 1], [-1, 0], [1, 0]];       // backs toward -z, +z, -x, +x walls
        const along = (name) => {
            const it = FURNITURE_ITEMS[name];
            if (!it) return;
            const s0 = Math.floor(rnd() * 4);
            for (let n = 0; n < 4; n++) {
                const back = sides[(s0 + n) % 4], horiz = back[1] !== 0, len = horiz ? W : D;
                if (len < it.w + 0.4) continue;
                for (let tries = 0; tries < 6; tries++) {
                    const u = (rnd() - 0.5) * (len - it.w - 0.3);
                    const cx = horiz ? (x0 + x1) / 2 + u : back[0] < 0 ? x0 + it.d / 2 + 0.02 : x1 - it.d / 2 - 0.02;
                    const cz = horiz ? (back[1] < 0 ? z0 + it.d / 2 + 0.02 : z1 - it.d / 2 - 0.02) : (z0 + z1) / 2 + u;
                    const q = foot(it, cx, cz, back);
                    if (!fits(q)) continue;
                    taken.push(q);
                    put(it, cx, cz, back);
                    return;
                }
            }
        };
        const free = (name) => {
            const it = FURNITURE_ITEMS[name];
            if (!it) return;
            for (let tries = 0; tries < 10; tries++) {
                const back = sides[Math.floor(rnd() * 4)], cx = x0 + 1.0 + rnd() * Math.max(0, W - 2), cz = z0 + 1.0 + rnd() * Math.max(0, D - 2);
                const q = foot(it, cx, cz, back, 0.5);
                if (!fits(q)) continue;
                taken.push(q);
                put(it, cx, cz, back);
                return;
            }
        };
        for (const [name, n] of plan.wall || []) for (let c = 0; c < n; c++) along(name);
        if (plan.grid) {
            // desks in rows facing the façade, 1.9 m apart, 1.6 m along
            const it = FURNITURE_ITEMS[plan.grid], rows = W > D;
            const L = rows ? W : D, A = rows ? D : W;
            for (let a = 1.4; a + it.d + 0.8 < A; a += 1.9) for (let u = 1.0; u + it.w + 0.6 < L; u += it.w + 0.3) {
                const cx = rows ? x0 + u + it.w / 2 : x0 + a + it.d / 2, cz = rows ? z0 + a + it.d / 2 : z0 + u + it.w / 2;
                const back = rows ? [0, -1] : [-1, 0], q = foot(it, cx, cz, back, 0.05);
                if (!fits(q)) continue;
                taken.push(q);
                put(it, cx, cz, back);
            }
        }
        for (const [name, n] of plan.free || []) for (let c = 0; c < n; c++) free(name);
    }
}

return { FloorBuilder };
});
