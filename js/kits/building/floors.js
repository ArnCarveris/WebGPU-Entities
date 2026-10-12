'use strict';
// Storeys of a planned building (kits.interior FloorPlan): each room's floor, ceiling, walls (partitions with their
// doorways, the façade's inner face with its windows), stairs, furniture and lamps. Built room by room so that every
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
// how far a layer laid on a surface stands off it (m): a skirting, the shadow gap's strip and an architrave off a wall's
// face, an inlay off the floor (and a border off the inlay), a strip off the ceiling or a soffit; well clear of it, so
// the two never fight for the depth at any distance
const SEAM = 0.002;               // m: how far a wall's face runs on past the face round a corner (no crack where they meet)
const LAYER = { skirting: 0.02, gap: 0.012, architrave: 0.03, floor: 0.015, ceiling: 0.025 };
const LAMP = [1.0, 0.95, 0.86];
const SHAFT = { wall: [0.46, 0.46, 0.45], rail: [0.32, 0.33, 0.35], ladder: [0.85, 0.66, 0.12], weight: [0.22, 0.23, 0.25], machine: [0.18, 0.36, 0.30],
    frame: [0.30, 0.31, 0.32], sill: [0.55, 0.56, 0.57], cabinet: [0.62, 0.63, 0.60] };

// B: the building being built (its world's): { S (the world's structures: quad / prism / box (a prism and a solid) in a
// ground frame, solids.add, cur (the triangle list built into) and iv (the interior's)), f (its ground frame), T (its
// archetype merged with its spec: storeyHeight, slab, wall, inner / floorColor / ceiling / lobbyFloor colours,
// curtain), hx, hz, t, H, faces (each face's o(u, d) -> local [x, z], len), windows(name, y): the window holes [u0, u1,
// y0, y1] of a storey whose floor is at y on that face, doors(name): the outer doors' holes on the ground floor,
// curtain, style (an interior style, its colours picked so that no two surfaces that meet look alike (contrast()):
// { accents { roomKind: colour | { wall, floor, ceiling } } (an accent wall, the room's longest, its floor, its ceiling), floor { color,
// gloss }, frame [colours] (a doorway's jambs, head and architrave), doors [colours] (an open leaf in each doorway that
// has a door), trim [colours] (the skirting and the shadow gap under the ceiling), floor.inlay / floor.stripe and
// ceiling { soffit, guide, entrance } (guiding shapes: floorShapes, ceilingShapes), lift (the cars' colours:
// PlannedBuilding.liftColors), furniture { neutral [colours] (every
// item's body), trims [colours], keep [item ids left as they are] } (the other parts of an item take the room's accent,
// or a trim colour that stands out from the body), rail (the stairs' handrail) })),
// code(mat, stacked, dark): a vertex's material code (dark: in an enclosed space lit by its own lamps only, a shaft),
// count(): the interior's vertices so far, lib (PlanLibrary) }
class FloorBuilder {
    constructor(B) { this.B = B; }

    // Storey s of plan P with its floor at y. o: { stacked (its vertices are drawn instanced for many storeys),
    // stairsUp (its flights climb to the storey above; else the stairwell is floored over), ground (the outer doors are
    // in its façade), shafts (per shaft of the core: its slice here, see shaft()), seed }. Returns per room its vertex
    // range: [[first, count], ...] (a shaft's is empty: its pieces are shaftPiece's). Its door leaves' doorways go into
    // this.doorways (see InteriorDoors)
    storey(P, y, o) {
        const B = this.B, S = B.S, out = [];
        this.P = P; this.y = y; this.o = o;
        this.doorways = [];
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

    flat(rects, y, col, mat = 0) {
        const S = this.B.S, f = this.B.f;
        for (const [x0, x1, z0, z1] of rects) S.quad(f.at(x0, y, z0), f.at(x1, y, z0), f.at(x1, y, z1), f.at(x0, y, z1), col, this.M(mat));
    }

    // of the colours `choices` (a list, or one), the one that stands out most from every colour in `against` (the
    // surfaces it meets): by the smallest of its differences in lightness and hue; null without choices
    static contrast(choices, against) {
        if (!choices) return null;
        const list = Array.isArray(choices[0]) ? choices : [choices], lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const refs = against.filter(Boolean);
        const score = c => Math.min(...refs.map(a => 2 * Math.abs(lum(c) - lum(a)) + Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])));
        return list.reduce((b, c) => (score(c) > score(b) ? c : b), list[0]);
    }

    // the floor of a kind of room: { col, mat } (its accent's, the style's, its room type's, the archetype's)
    floorOf(kind, room) {
        const T = this.B.T, rt = this.B.lib?.room(kind), ac = this.accent(kind), sf = T.style?.floor;
        const col = ac?.floor || sf?.color || rt?.floor || (kind === 'lobby' || room.hall ? T.lobbyFloor || T.floorColor : T.floorColor);
        return { col, mat: sf?.gloss ? 4 : 0 };
    }

    room(k, room) {
        const B = this.B, T = B.T, y = this.y, H = B.H, kind = room.kind;
        if (kind === 'shaft') return;
        if (kind === 'stair') { this.stairs(k, room); return; }
        const top = y + H - T.slab, rt = B.lib?.room(kind), fl = this.floorOf(kind, room);
        const ceil = this.accent(kind)?.ceiling || T.ceiling;
        this.flat(room.rects, y + 0.005, fl.col, fl.mat);
        this.flat(room.rects, top, ceil);
        this.floorShapes(room, y, fl);
        this.ceilingShapes(k, room, top, ceil);
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
        const wallCol = room.kind === 'shaft' ? SHAFT.wall : T.inner, ac = this.accent(room.kind)?.wall, St = room.kind === 'shaft' ? null : T.style;
        const floorCol = St && this.floorOf(room.kind, room).col;
        // (the style's accent wall: the room's longest stretch)
        const ws = P.walls(k), longest = ac ? ws.reduce((b, w, i) => (w.a1 - w.a0 > ws[b].a1 - ws[b].a0 ? i : b), 0) : -1;
        ws.forEach((w0, wi) => {
            const faceCol = wi === longest ? ac : wallCol;
            // Where each face ends (both faces stand half the wall's thickness off its line), by what is past the line's end:
            //   out    the room goes on round the end (an outside corner, a core's corner seen from the lobby): on by half
            //          the thickness, meeting the face round the corner (short, it leaves a slot through the whole wall)
            //   lines  a doorway in the wall across, its edge in this face's plane: on by half, lining that side of it
            //   on     another room's face goes on in the same plane: on the line, where the two meet (overlapping,
            //          coplanar, they would z-fight)
            //   in     an inside corner: on the line, in the wall across (on through it, it would show in the next room)
            // and at the façade, on the line. Running on, SEAM more (ending exactly on the face round the corner leaves a
            // hairline crack).
            const lim = w0.axis === 'x' ? [X0, X1] : [Z0, Z1], rects = room.rects, fp = w0.at + w0.side * half;
            const inRoom = (u, o) => rects.some(r => w0.axis === 'x' ? u > r[0] && u < r[1] && o > r[2] && o < r[3] : o > r[0] && o < r[1] && u > r[2] && u < r[3]);
            const goesOn = u => this.faces(P).some(([j, v]) => j !== k && v.axis === w0.axis && v.side === w0.side && Math.abs(v.at - w0.at) < EPS && u > v.a0 && u < v.a1);
            const lines = a => P.portals.some(p => p.axis !== w0.axis && Math.abs(p.at - a) < EPS && (Math.abs(p.c - p.w / 2 - fp) < EPS || Math.abs(p.c + p.w / 2 - fp) < EPS));
            const kind = (a, dir, l) => Math.abs(a - l) < EPS ? 'facade' : inRoom(a + dir * 0.02, w0.at + w0.side * 0.02) ? 'out'
                : goesOn(a + dir * 0.02) ? 'on' : lines(a) ? 'lines' : 'in';
            const k0 = kind(w0.a0, -1, lim[0]), k1 = kind(w0.a1, 1, lim[1]);
            const end = (a, dir, kd) => a + dir * (kd === 'out' || kd === 'lines' ? half + SEAM : 0);
            const w = { ...w0, a0: end(w0.a0, -1, k0), a1: end(w0.a1, 1, k1) };
            // a layer proud of the face (skirting, shadow gap), d deep: where two walls' layers meet at a corner, the square
            // where they cross is the x wall's. Round an outside corner the x wall's layer runs on by d (over the square),
            // the z wall's front too (meeting it) but not its top (cap); at an inside corner (in, or on where the wall goes
            // on past it) the z wall's stops at the x wall's layer's front (the x wall's runs on into the wall across)
            const round = (u0, u1, d, cap = false) => {
                const zw = w.axis === 'z';
                const e = (at, kd) => !at ? 0 : kd === 'out' ? (zw && cap ? -SEAM : d) : (kd === 'in' || kd === 'on') && zw ? -(half + d) : 0;
                return [u0 - e(u0 <= w.a0 + EPS, k0), u1 + e(u1 >= w.a1 - EPS, k1)];
            };
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
                const trim = FloorBuilder.contrast(St?.trim, [faceCol, floorCol, this.accent(room.kind)?.ceiling || T.ceiling]);
                for (const [u0, u1, y0, y1] of rectMinusHoles(w.a0, w.a1, y, top, holes)) {
                    S.quad(pt(u0, y0), pt(u1, y0), pt(u1, y1), pt(u0, y1), faceCol, this.M(0));
                    if (!trim || u1 - u0 < 0.05) continue;
                    // the style's skirting (proud of the face, its top closed) and the shadow gap under the ceiling: the
                    // wall's edges read against the floor and the ceiling
                    const o1 = off + w.side * LAYER.skirting, o0 = off + w.side * LAYER.gap;
                    if (y0 <= y + 0.01) {
                        const [s0, s1] = round(u0, u1, LAYER.skirting), [c0, c1] = round(u0, u1, LAYER.skirting, true);
                        S.quad(pt(s0, y, o1), pt(s1, y, o1), pt(s1, y + 0.09, o1), pt(s0, y + 0.09, o1), trim, this.M(0));
                        S.quad(pt(c0, y + 0.09, off), pt(c1, y + 0.09, off), pt(c1, y + 0.09, o1), pt(c0, y + 0.09, o1), trim, this.M(0));
                    }
                    if (y1 >= top - 0.01) {
                        const [g0, g1] = round(u0, u1, LAYER.gap);
                        S.quad(pt(g0, top - 0.035, o0), pt(g1, top - 0.035, o0), pt(g1, top, o0), pt(g0, top, o0), trim, this.M(0));
                    }
                }
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
                    // a doorway's jambs and head, across this half of the wall; with a style, in a colour that stands out
                    // from the wall round it and the floor, an architrave on its face, and the door leaf standing open in it
                    const fr = FloorBuilder.contrast(St?.frame, [faceCol, floorCol]) || T.inner;
                    // (no jamb at an end of the wall: the opening runs up to a corner, and the wall round it closes it; a
                    // jamb there would lie in that wall's face)
                    const atEnd = u => u <= w0.a0 + half + EPS || u >= w0.a1 - half - EPS;
                    // (nor where a wall's face across this one stands in the jamb's plane, running on through this wall: it
                    // lines that side of the opening, and a jamb there would z-fight with it)
                    const lined = u => this.faces(P).some(([, v]) => v.axis !== w.axis && Math.abs(v.at + v.side * half - u) < EPS &&
                        w.at > v.a0 - half - EPS && w.at < v.a1 + half + EPS);
                    for (const u of [u0, u1]) if (!atEnd(u) && !lined(u)) S.quad(pt(u, y), pt(u, y, w.at), pt(u, yh, w.at), pt(u, yh), fr, this.M(0));
                    if (y1 < top) S.quad(pt(u0, y1), pt(u1, y1), pt(u1, y1, w.at), pt(u0, y1, w.at), fr, this.M(0));
                    if (!St?.frame || y1 >= top || atEnd(u0) || atEnd(u1)) continue;
                    const o2 = off + w.side * LAYER.architrave, band = (a, b, c, d) => S.quad(pt(a, c, o2), pt(b, c, o2), pt(b, d, o2), pt(a, d, o2), fr, this.M(0));
                    band(u0 - 0.07, u0, y, y1 + 0.07);
                    band(u1, u1 + 0.07, y, y1 + 0.07);
                    band(u0, u1, y1, y1 + 0.07);
                    // its edges, from the wall's face out to it (seen from the side, no sliver of wall behind it)
                    for (const u of [u0 - 0.07, u0, u1, u1 + 0.07]) S.quad(pt(u, y, off), pt(u, y, o2), pt(u, y1 + (u === u0 || u === u1 ? 0 : 0.07), o2), pt(u, y1 + (u === u0 || u === u1 ? 0 : 0.07), off), fr, this.M(0));
                    for (const [a, b, yy] of [[u0 - 0.07, u1 + 0.07, y1 + 0.07], [u0, u1, y1]]) S.quad(pt(a, yy, off), pt(b, yy, off), pt(b, yy, o2), pt(a, yy, o2), fr, this.M(0));
                    // the leaf (once, from room a): hinged at the doorway's low end on room a's side, opening into room a. Not
                    // in the storey's mesh: each storey's door opens and shuts on its own (InteriorDoors draws it)
                    if (St.doors && p.kind === 'door' && p.a === k) {
                        const xz = (u, o) => w.axis === 'x' ? [u, o] : [o, u];
                        this.doorways.push({ i: p.pi, a: p.a, b: p.b, hinge: xz(u0 + 0.03, off - w.side * 0.02), u: xz(1, 0), n: xz(0, w.side),
                            back: 0.027, len: u1 - u0 - 0.033, y0: 0.003, y1: y1 - y - 0.003, col: FloorBuilder.contrast(St.doors, [faceCol, fr, floorCol]) });
                    }
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
        });
    }

    // every room's stretches of wall (FloorPlan.walls), [room, wall], once per plan
    faces(P) {
        const c = (this.faceCache ??= new WeakMap());
        if (!c.has(P)) c.set(P, P.rooms.flatMap((_, j) => P.walls(j).map(v => [j, v])));
        return c.get(P);
    }

    // the style's accent for a kind of room: { wall, floor } (a colour alone is the wall's), or null
    accent(kind) {
        const a = this.B.T.style?.accents?.[kind];
        return !a ? null : Array.isArray(a) ? { wall: a } : a;
    }

    // a landing door's frame seen from the lobby (w: the wall, its face at `off`): jambs and a head lining the opening
    // through the whole wall, an architrave proud of the face, a metal sill across its foot
    landingFrame(w, u0, u1, yh, pt) {
        const B = this.B, S = B.S, y = this.y, half = PARTITION / 2, M4 = this.M(4), C = SHAFT.frame;
        const back = w.at - w.side * half;                 // the shaft's face of the wall
        for (const u of [u0, u1]) S.quad(pt(u, y), pt(u, y, back), pt(u, yh, back), pt(u, yh), C, M4);
        S.quad(pt(u0, yh), pt(u1, yh), pt(u1, yh, back), pt(u0, yh, back), C, M4);
        S.quad(pt(u0, y + 0.012), pt(u1, y + 0.012), pt(u1, y + 0.012, back), pt(u0, y + 0.012, back), SHAFT.sill, M4);
        // the architrave: a band 8 cm wide, as proud as a doorway's (the skirting, less proud, butts into it)
        const o = w.at + w.side * (half + LAYER.architrave), face = (a, b, c, d) => S.quad(pt(a, c, o), pt(b, c, o), pt(b, d, o), pt(a, d, o), C, M4);
        face(u0 - 0.08, u0, y, yh + 0.08);
        face(u1, u1 + 0.08, y, yh + 0.08);
        face(u0, u1, yh, yh + 0.08);
        // its edges back to the wall's face (seen from the side, no sliver of wall behind it)
        const wf = w.at + w.side * half, edge = (u, y0, y1) => S.quad(pt(u, y0, wf), pt(u, y0, o), pt(u, y1, o), pt(u, y1, wf), C, M4);
        edge(u0 - 0.08, y, yh + 0.08); edge(u1 + 0.08, y, yh + 0.08); edge(u0, y, yh); edge(u1, y, yh);
        for (const [a, b, yy] of [[u0 - 0.08, u1 + 0.08, yh + 0.08], [u0, u1, yh]]) S.quad(pt(a, yy, wf), pt(b, yy, wf), pt(b, yy, o), pt(a, yy, o), C, M4);
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
        const M0 = 0, M4 = 4, IN = 0.025;    // IN: how far what stands against a wall runs into it
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
            const L = sh.lamp, z0 = L.z - L.n[1] * 0.04, z1 = L.z + L.n[1] * 0.03;     // (1 cm into its wall)
            this.box(L.x - 0.16, L.x + 0.16, Math.min(z0, z1), Math.max(z0, z1), y + ly - 0.05, y + ly + 0.05, LAMP, 7, true);
        }
        // the pit's floor (a lamp and a buffer on it), the overrun's ceiling, the machine room
        if (sl.pit !== undefined && sl.pit !== null) {
            const yp = y + sl.pit;
            this.box(ix0 - IN, ix1 + IN, iz0 - IN, iz1 + IN, yp - 0.3, yp, SHAFT.wall, M0);
            const c = sh.car.rect;
            this.box((c[0] + c[1]) / 2 - 0.15, (c[0] + c[1]) / 2 + 0.15, sh.car.zc - 0.15, sh.car.zc + 0.15, yp, yp + 0.5, SHAFT.weight, M4, true);
            this.box(ix0 + 0.05, ix0 + 0.1, iz0 + 0.3, iz0 + 0.5, yp + 0.6, yp + 0.75, LAMP, 7, true);
        }
        if (sl.top !== undefined && sl.top !== null) {
            const yt = y + sl.top;
            this.box(ix0 - IN, ix1 + IN, iz0 - IN, iz1 + IN, yt, yt + 0.25, SHAFT.wall, M0);
            this.box(ix0 + 0.4, ix0 + 0.8, iz0 + 0.4, iz0 + 0.6, yt - 0.06, yt - 0.01, LAMP, 7, true);
        }
        if (sl.machine) {
            const [m0, m1] = sl.machine, ym = y + m0, c = sh.car.rect, cx = (c[0] + c[1]) / 2;
            // the traction machine over the car's run, its sheave; the controller cabinet against the back wall
            this.box(cx - 0.45, cx + 0.45, sh.car.zc - 0.5, sh.car.zc + 0.2, ym, ym + 0.8, SHAFT.machine, M4);
            this.box(cx - 0.12, cx + 0.12, sh.car.zc + 0.2, sh.car.zc + 0.55, ym + 0.2, ym + 0.85, SHAFT.rail, M4);
            const bx = sh.sx > 0 ? ix0 - IN : ix1 - 0.4;
            this.box(bx, bx + 0.4 + IN, iz0 + 0.3, iz0 + 1.1, ym, ym + 1.9, SHAFT.cabinet, M4);
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
                // (its holes cut 4 mm small: the face laps over the reveals' edges, no crack where they meet)
                const lap = hs.map(([a, b, c, d]) => [a + 0.004, b - 0.004, c + 0.004, d - 0.004]);
                for (const [a, b, c, d] of rectMinusHoles(u0, u1, y, top, lap)) S.quad(P(a, c, t), P(b, c, t), P(b, d, t), P(a, d, t), T.inner, this.M(0));
                // a curtain wall's glass stands near its outer face: the reveals inside it (punched windows have theirs
                // through the whole wall with the outside)
                if (!T.curtain) continue;
                const d0 = 0.05;
                for (const [a, b, c, d] of hs) {
                    const rv = (p, q, from = d0) => S.quad(P(p[0], p[1], from), P(q[0], q[1], from), P(q[0], q[1], t), P(p[0], p[1], t), T.inner, this.M(0));
                    if (a > u0 + EPS) rv([a, c], [a, Math.min(d, top)]);
                    if (b < u1 - EPS) rv([b, c], [b, Math.min(d, top)]);
                    // the head and the sill from the façade's outer face: looking up (or down) through the glass, no
                    // sight of the spandrel's back between the glass's edge and the reveal
                    if (d < top) rv([a, d], [b, d], 0);
                    if (c > y + 0.01) rv([a, c], [b, c], 0);
                }
            }
        }
    }

    // the style's shapes on a room's floor (style.floor): an inlay (`inlay` { margin (m in from the walls), min (m: the
    // smallest rectangle that has one), colors }) in each rectangle big enough, a stripe down the middle of a long narrow
    // one (`stripe` { width, colors }: a corridor's); each in a colour that stands out from the floor, varying from room
    // to room
    floorShapes(room, y, fl) {
        const St = this.B.T.style?.floor;
        if (!St) return;
        const pick = (list, k) => this.vary(list, [fl.col], k), y1 = y + 0.005 + LAYER.floor;
        room.rects.forEach((r, i) => {
            const [x0, x1, z0, z1] = r, wx = x1 - x0, wz = z1 - z0, k = this.rnd() * 997 | 0;
            const In = St.inlay, Sp = St.stripe;
            if (Sp && Math.max(wx, wz) > 3 * Math.min(wx, wz) && Math.min(wx, wz) < 3.2) {
                const hw = (Sp.width ?? 0.3) / 2, c = pick(Sp.colors, k);
                this.flat([wx > wz ? [x0 + 0.3, x1 - 0.3, (z0 + z1) / 2 - hw, (z0 + z1) / 2 + hw] : [(x0 + x1) / 2 - hw, (x0 + x1) / 2 + hw, z0 + 0.3, z1 - 0.3]], y1, c, fl.mat);
            } else if (In && Math.min(wx, wz) >= (In.max ?? 9)) {
                // a big room: rug-sized inlays in a grid (In.tile m, In.gap m apart), all of the room's one colour
                const t = In.tile ?? 3, gp = In.gap ?? 1.2, nx = Math.max(1, Math.floor((wx - gp) / (t + gp))), nz = Math.max(1, Math.floor((wz - gp) / (t + gp)));
                const sx = (wx - nx * t) / (nx + 1), sz = (wz - nz * t) / (nz + 1);
                for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
                    const qx = x0 + sx + a * (t + sx), qz = z0 + sz + b * (t + sz);
                    this.flat([[qx, qx + t, qz, qz + t]], y1, pick(In.colors, k), fl.mat);
                }
            } else if (In && Math.min(wx, wz) >= (In.min ?? 3)) {
                const m = In.margin ?? 0.6, c = pick(In.colors, k);
                this.flat([[x0 + m, x1 - m, z0 + m, z1 - m]], y1, c, fl.mat);
                // a border inside it in the floor's colour: a frame of two tones
                if (In.border) this.flat([[x0 + m + In.border, x1 - m - In.border, z0 + m + In.border, z1 - m - In.border]], y1 + LAYER.floor, pick(In.colors, k + 1), fl.mat);
            }
        });
    }

    // the style's shapes on a room's ceiling (style.ceiling), there to guide, not to decorate: a dropped band round each
    // rectangle big enough (`soffit` { width, drop, colors }); down the middle of a corridor (a long narrow rectangle), a
    // band in the guide colour (`guide` { width, color }: the way to the lifts, over the floor's stripe); in from each
    // doorway of a room with an accent, a strip of that colour as wide as the doorway (`entrance` { length }): where the
    // room is entered. Every colour stands out from the ceiling (and a soffit's from the walls)
    ceilingShapes(k, room, top, ceil) {
        const St = this.B.T.style?.ceiling, T = this.B.T, S = this.B.S, f = this.B.f;
        if (!St) return;
        const So = St.soffit, G = St.guide, En = St.entrance, y1 = top - LAYER.ceiling;
        for (const [x0, x1, z0, z1] of room.rects) {
            const wx = x1 - x0, wz = z1 - z0;
            if (G && Math.max(wx, wz) > 3 * Math.min(wx, wz) && Math.min(wx, wz) < 3.2) {
                const hw = (G.width ?? 0.4) / 2, c = FloorBuilder.contrast(G.color, [ceil]);
                this.flat([wx > wz ? [x0, x1, (z0 + z1) / 2 - hw, (z0 + z1) / 2 + hw] : [(x0 + x1) / 2 - hw, (x0 + x1) / 2 + hw, z0, z1]], y1, c);
                continue;
            }
            if (So && Math.min(wx, wz) > 2 * (So.width ?? 0.45) + 1.2) {
                const sw = So.width ?? 0.45, d = So.drop ?? 0.14, c = FloorBuilder.contrast(So.colors, [ceil, T.inner]), yb = top - d;
                const ix0 = x0 + sw, ix1 = x1 - sw, iz0 = z0 + sw, iz1 = z1 - sw;
                // its underside round the rectangle, and its inner edge down from the ceiling
                for (const q of [[x0, x1, z0, iz0], [x0, x1, iz1, z1], [x0, ix0, iz0, iz1], [ix1, x1, iz0, iz1]]) this.flat([q], yb, c);
                const e = (a, b) => S.quad(f.at(a[0], yb, a[1]), f.at(b[0], yb, b[1]), f.at(b[0], top, b[1]), f.at(a[0], top, a[1]), c, this.M(0));
                e([ix0, iz0], [ix1, iz0]); e([ix1, iz0], [ix1, iz1]); e([ix1, iz1], [ix0, iz1]); e([ix0, iz1], [ix0, iz0]);
            }
        }
        const ac = this.accent(room.kind)?.wall;
        if (!En || !ac) return;
        const c = FloorBuilder.contrast(ac, [ceil]), L = En.length ?? 1.6, inRoom = (x, z) => room.rects.some(r => x > r[0] && x < r[1] && z > r[2] && z < r[3]);
        const sw = So?.width ?? 0.45, drop = So?.drop ?? 0.14;
        for (const p of this.P.portalsOf(k)) {
            if (p.kind === 'lift') continue;
            const hw = p.w / 2, X = p.axis === 'x';
            const sg = (X ? inRoom(p.c, p.at + 0.1) : inRoom(p.at + 0.1, p.c)) ? 1 : -1;
            // the rectangle it enters: with a soffit, the strip runs across its underside, then on along the ceiling
            const r = room.rects.find(q => X ? p.c > q[0] && p.c < q[1] && p.at + sg * 0.1 > q[2] && p.at + sg * 0.1 < q[3] : p.at + sg * 0.1 > q[0] && p.at + sg * 0.1 < q[1] && p.c > q[2] && p.c < q[3]);
            const soffit = So && r && Math.min(r[1] - r[0], r[3] - r[2]) > 2 * sw + 1.2;
            const span = (d0, d1, yy) => {
                const a0 = p.at + sg * d0, a1 = p.at + sg * d1, lo = Math.min(a0, a1), hi = Math.max(a0, a1);
                this.flat([X ? [p.c - hw, p.c + hw, lo, hi] : [lo, hi, p.c - hw, p.c + hw]], yy, c);
            };
            if (soffit) { span(0, sw, top - drop - LAYER.ceiling); span(sw, L, top - LAYER.ceiling); }
            else span(0, L, top - LAYER.ceiling);
        }
    }

    // a colour of `choices` for something on surfaces `against`: of those that stand out from them (by at least half as
    // much as the best one), the k-th: so that rooms vary while every colour stays readable
    vary(choices, against, k) {
        if (!choices) return null;
        const ok = this.readable(choices, against);
        return ok[k % ok.length];
    }

    // of the colours `choices`, those that stand out from `against` by at least half as much as the best of them does
    readable(choices, against) {
        const list = Array.isArray(choices[0]) ? choices : [choices];
        if (list.length === 1) return list;
        const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const score = c => Math.min(...against.filter(Boolean).map(a => 2 * Math.abs(lum(c) - lum(a)) + Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])));
        const best = Math.max(...list.map(score));
        return list.filter(c => score(c) >= best * 0.5);
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
        const lane = st.lane, land = st.landing, col = this.floorOf(room.kind, room).col, rail = T.style?.rail || PALETTE.wood;
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
        // the handrail: on the wall's face beside the first flight, 0.9 m over its nosings, rising with it
        const rx0 = x0 + lane - 0.08, rx1 = x0 + lane - 0.02, ra = z0 + land, rb = z1 - land, ya = y + rise + 0.9, yb = y + H / 2 + 0.9;
        const P = (x, z, yy) => fl.at(x, yy, z), Mr = this.M(0), bar = [[rx0, ya, ra], [rx1, ya, ra], [rx1, yb, rb], [rx0, yb, rb]];
        for (const dy of [0, 0.05]) B.S.quad(...bar.map(([x, yy, z]) => P(x, z, yy + dy)), rail, Mr);
        for (const x of [rx0, rx1]) B.S.quad(P(x, ra, ya), P(x, rb, yb), P(x, rb, yb + 0.05), P(x, ra, ya + 0.05), rail, Mr);
        for (const [z, yy] of [[ra, ya], [rb, yb]]) B.S.quad(P(rx0, z, yy), P(rx1, z, yy), P(rx1, z, yy + 0.05), P(rx0, z, yy + 0.05), rail, Mr);
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
        // the style: every item's body neutral, its other parts the room's accent (some items as they are)
        const F = this.B.T.style?.furniture, ac = this.accent(room.kind)?.wall, T = this.B.T;
        const body = F && FloorBuilder.contrast(F.neutral, [T.inner, this.floorOf(room.kind, room).col]);
        const trim = F && FloorBuilder.contrast([...(ac ? [ac] : []), ...(F.trims || [])], [body]);
        const colour = (col, i, it) => !F || F.keep?.includes(it.id) ? col : i === 0 ? body || col : trim || col;
        for (const r of room.rects) furnishRoom(r, rt.furniture, this.B.lib, this.rnd,
            (x0, x1, z0, z1, ya, yb, col, fin, i, it) => this.box(x0, x1, z0, z1, y + ya, y + yb, colour(col, i, it), fin === 'metal' ? 4 : 0), keep);
    }
}

return { FloorBuilder, SHAFT_COLORS: SHAFT };
});
