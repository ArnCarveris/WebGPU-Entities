'use strict';
// FloorPlan: one storey of a building laid out as rectangles in its frame, from a storey plan (data: the building kit's
// storeyPlan): the core in the middle (its stairwell, lift shafts and lift lobby: the building kit's coreLayout), a
// corridor ring round it, and from each façade in to the ring a strip of room bands, double-loaded on corridors as deep
// as the strip needs, cut into rooms; a passage joins each strip's corridor to the ring. Or one open hall round the core.
// Every room is reachable through doorways. Pure data: a world builds the walls, floors, doors and its areas and portals
// from it.

Features.kit('interior', (engine, kit) => {
const EPS = 1e-4;

// [a0, a1] cut into pieces about `size` long, with cuts at `forced` (those inside it) kept
function splitSpan(a0, a1, size, forced = []) {
    const cuts = [a0, ...forced.filter(c => c > a0 + EPS && c < a1 - EPS).sort((p, q) => p - q), a1], out = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
        const L = cuts[k + 1] - cuts[k], n = Math.max(1, Math.round(L / size));
        for (let i = 0; i < n; i++) out.push([cuts[k] + L * i / n, cuts[k] + L * (i + 1) / n]);
    }
    return out;
}

// where rectangles a and b ([x0, x1, z0, z1]) touch along an edge: { axis ('x': the edge runs along x, at z = at;
// 'z': along z at x = at), at, a0, a1 (its stretch), side (+1: b lies on a's + side) } or null
function sharedEdge(a, b) {
    const ox0 = Math.max(a[0], b[0]), ox1 = Math.min(a[1], b[1]), oz0 = Math.max(a[2], b[2]), oz1 = Math.min(a[3], b[3]);
    if (ox1 - ox0 > EPS) {
        if (Math.abs(a[3] - b[2]) < EPS) return { axis: 'x', at: a[3], a0: ox0, a1: ox1, side: 1 };
        if (Math.abs(a[2] - b[3]) < EPS) return { axis: 'x', at: a[2], a0: ox0, a1: ox1, side: -1 };
    }
    if (oz1 - oz0 > EPS) {
        if (Math.abs(a[1] - b[0]) < EPS) return { axis: 'z', at: a[1], a0: oz0, a1: oz1, side: 1 };
        if (Math.abs(a[0] - b[1]) < EPS) return { axis: 'z', at: a[0], a0: oz0, a1: oz1, side: -1 };
    }
    return null;
}

// a weighted pick from { kind: weight } with r in [0, 1)
function pick(weights, r) {
    const e = Object.entries(weights || {}).filter(([, w]) => w > 0), sum = e.reduce((s, [, w]) => s + w, 0);
    if (!sum) return 'office';
    let a = r * sum;
    for (const [k, w] of e) { if ((a -= w) < 0) return k; }
    return e[e.length - 1][0];
}

// How a strip D m deep is filled with room bands and corridors from its façade in: m bands of rooms, a corridor after
// every even one that has another behind it (rooms on both sides of it), the last band backing onto the ring. The
// fewest bands whose rooms are no deeper than `max` (none shallower than `min` unless one band is all there is room for).
// Returns [{ kind: 'rooms' | 'corridor', d0, d1 (m in from the façade), band (rooms: 0 the façade's) }]
function strip(D, [min, max], corridor) {
    let m = 1;
    while (m < 12) {
        const R = (D - Math.floor(m / 2) * corridor) / m;
        if (R <= max) { if (R < min && m > 1) m--; break; }
        m++;
    }
    const R = (D - Math.floor(m / 2) * corridor) / m, out = [];
    let d = 0;
    for (let i = 0; i < m; i++) {
        out.push({ kind: 'rooms', d0: d, d1: d + R, band: i });
        d += R;
        if (i % 2 === 0 && i + 1 < m) { out.push({ kind: 'corridor', d0: d, d1: d + corridor }); d += corridor; }
    }
    return out;
}

// A storey's plan. o: { hx, hz (half the outer footprint), t (outer wall), core (the building kit's coreLayout: { w, d,
// stair, shafts, lobby }, or null), storey (its storeyPlan: layout 'rooms' | 'hall', ring, corridor, door, rooms { depth,
// module, outer, inner }, hall, entrances: the façades ('-z', '+z', '-x', '+x') a passage runs in from, to the ring:
// a way in from the street), partition (m), seed }. this.entrances: [{ face, c (m along the face: local x of a z face,
// z of an x face), w }]. Rooms: { kind (corridor | hall | stair | shaft | lobby | a
// roomType's id), rects, depth (m from the façade: rooms on it), facade, ring (the corridor round the core) };
// portals: { a, b (room indices), axis, at, c (centre along the edge), w, h (doorway; 0: the storey's full height),
// kind (door | opening | lift | stair) }.
class FloorPlan {
    constructor(o) {
        this.o = o;
        this.rooms = [];
        this.portals = [];
        this.entrances = [];
        const X = o.hx - o.t, Z = o.hz - o.t, core = o.core, sp = o.storey || {};
        this.inner = [-X, X, -Z, Z];
        this.coreIdx = {};
        this.rnd = mulberry(o.seed ?? 1);
        if (core) {
            if (core.stair) this.coreIdx.stair = this.add('stair', [core.stair.rect], { stair: core.stair });
            this.coreIdx.shafts = core.shafts.map(s => this.add('shaft', [s.rect], { shaft: s }));
            this.coreIdx.lobby = this.add('lobby', [core.lobby]);
        } else this.coreIdx.shafts = [];
        const cw = core ? core.w / 2 : 0, cd = core ? core.d / 2 : 0;
        const R = sp.rooms || {}, depth = R.depth || [3, 6.5], c = sp.ring ?? 2;
        if (sp.layout !== 'rooms' || !core || X - cw - c < depth[0] || Z - cd - c < depth[0]) this.hall(X, Z, cw, cd, sp.hall || 'hall');
        else this.bands(X, Z, cw, cd, sp);
        this.connect();
    }

    add(kind, rects, extra = {}) {
        this.rooms.push({ kind, rects: rects.filter(r => r[1] - r[0] > EPS && r[3] - r[2] > EPS), ...extra });
        return this.rooms.length - 1;
    }

    // an open storey round the core (a lobby, a sky lobby, a shop floor): one hall of roomType `kind`
    hall(X, Z, cw, cd, kind) {
        const rects = cw ? [[-X, X, cd, Z], [-X, X, -Z, -cd], [-X, -cw, -cd, cd], [cw, X, -cd, cd]] : [[-X, X, -Z, Z]];
        this.corridor = this.add(kind, rects, { hall: true, depth: Infinity });
        this.halls = [this.corridor];
    }

    // the ring round the core, then a strip from each façade to it: z strips (±z façades) run the building's whole width,
    // x strips the ring's length between them. Each strip's bands (strip()); rooms `module` m wide, the façade band's of
    // the outer kinds, the rest of the inner ones; one passage per strip from its corridors through to the ring, across
    // from the lift lobby (z strips) or at its middle (x strips)
    bands(X, Z, cw, cd, sp) {
        const c = sp.ring ?? 2, cc = sp.corridor ?? 1.8, R = sp.rooms || {}, depth = R.depth || [3, 6.5], module = R.module ?? 3.6;
        const rx = cw + c, rz = cd + c, lob = this.o.core.lobby, lobC = (lob[0] + lob[1]) / 2;
        this.corridor = this.add('corridor', [[-rx, rx, cd, rz], [-rx, rx, -rz, -cd], [-rx, -cw, -cd, cd], [cw, rx, -cd, cd]], { ring: true });
        this.halls = [this.corridor];
        // a strip: its façade at `outer` along axis `ax` ('z': the façade is a z = const line), `sg` the side, spanning
        // [s0, s1] along the façade, from the façade in to `inner`
        const strips = [
            { ax: 'z', sg: 1, face: '+z', outer: Z, inner: rz, s0: -X, s1: X, pass: Math.max(-rx + cc / 2, Math.min(rx - cc / 2, lobC)) },
            { ax: 'z', sg: -1, face: '-z', outer: Z, inner: rz, s0: -X, s1: X, pass: Math.max(-rx + cc / 2, Math.min(rx - cc / 2, lobC)) },
            { ax: 'x', sg: 1, face: '+x', outer: X, inner: rx, s0: -rz, s1: rz, pass: 0 },
            { ax: 'x', sg: -1, face: '-x', outer: X, inner: rx, s0: -rz, s1: rz, pass: 0 },
        ];
        const entr = new Set(sp.entrances || []);
        for (const st of strips) {
            const D = st.outer - st.inner, bands = strip(D, depth, cc);
            // local (a along the façade, d in from it) to a rectangle
            const rect = (a0, a1, d0, d1) => {
                const n0 = st.sg * (st.outer - d1), n1 = st.sg * (st.outer - d0), [lo, hi] = n0 < n1 ? [n0, n1] : [n1, n0];
                return st.ax === 'z' ? [a0, a1, lo, hi] : [lo, hi, a0, a1];
            };
            const corridors = bands.filter(b => b.kind === 'corridor');
            const p0 = st.pass - cc / 2, p1 = st.pass + cc / 2;
            // the corridors, and the passage from the outermost one in to the ring
            let pass = null;
            // an entrance: the passage runs on out through the façade band to the façade
            const from = entr.has(st.face) ? 0 : corridors.length ? corridors[0].d1 : null;
            if (from !== null) {
                const rects = corridors.map(b => rect(st.s0, st.s1, b.d0, b.d1));
                // (the passage in pieces across the room bands it crosses: its rectangles never overlap)
                for (const b of bands) if (b.kind === 'rooms' && b.d0 >= from - EPS) rects.push(rect(p0, p1, b.d0, b.d1));
                pass = [from, D];
                this.add('corridor', rects, { strip: true });
                if (from === 0) this.entrances.push({ face: st.face, c: st.pass, w: cc });
            }
            for (const b of bands) {
                if (b.kind !== 'rooms') continue;
                const inPass = pass && b.d0 >= pass[0] - EPS;
                for (const [a0, a1] of splitSpan(st.s0, st.s1, module, inPass ? [p0, p1] : [])) {
                    if (inPass && a0 >= p0 - EPS && a1 <= p1 + EPS) continue;
                    const kind = pick(b.band === 0 ? R.outer : R.inner, this.rnd());
                    this.add(kind, [rect(a0, a1, b.d0, b.d1)], { depth: b.band === 0 ? b.d1 - b.d0 : 0, facade: b.band === 0, band: b.band });
                }
            }
        }
    }

    // doorways: the lift lobby open onto the ring (or hall) at both ends, the stairwell's door at its -z end, each shaft's
    // landing door on the lobby (kind 'lift': the world hangs the doors in it); each corridor of a strip open onto the
    // ring at its passage; every room's door onto the corridor it shares most wall with, else into its neighbour nearer
    // the middle that does
    connect() {
        const R = this.rooms, I = this.coreIdx, door = this.o.storey?.door ?? 0.95, part = this.o.partition ?? 0.12;
        const halls = this.halls || [];
        const link = (a, b, e, w, kind, c, h) => this.portals.push({ a, b, axis: e.axis, at: e.at, c: c ?? (e.a0 + e.a1) / 2, w, h: h ?? (kind === 'opening' ? 0 : 2.15), kind });
        const touching = (a, b) => {
            let best = null;
            for (const ra of R[a].rects) for (const rb of R[b].rects) {
                const e = sharedEdge(ra, rb);
                if (e && (!best || e.a1 - e.a0 > best.a1 - best.a0)) best = e;
            }
            return best;
        };
        const ring = this.corridor;
        if (I.lobby !== undefined) for (const r of R[ring].rects) {
            const e = sharedEdge(R[I.lobby].rects[0], r);
            // as wide as the lobby less its walls' faces (half a partition each side), so its jambs meet them
            if (e && e.axis === 'x') link(I.lobby, ring, e, e.a1 - e.a0 - part, 'opening');
        }
        if (I.stair !== undefined) for (const r of R[ring].rects) {
            const e = sharedEdge(R[I.stair].rects[0], r);
            if (e && e.axis === 'x' && e.side < 0) link(I.stair, ring, e, Math.min(1.1, e.a1 - e.a0 - 0.3), 'door');
        }
        for (const k of I.shafts || []) {
            const s = R[k].shaft, e = touching(k, I.lobby);
            if (e) link(k, I.lobby, e, s.door.w, 'lift', s.door.c, s.door.h);
        }
        const corridors = R.map((r, k) => r.kind === 'corridor' || r.hall ? k : -1).filter(k => k >= 0);
        // the strips' corridors onto the ring, where their passages meet it
        for (const k of corridors) {
            if (!R[k].strip) continue;
            const e = touching(k, ring);
            if (e) link(k, ring, e, e.a1 - e.a0 - part, 'opening');
        }
        const isRoom = k => !['corridor', 'stair', 'shaft', 'lobby'].includes(R[k].kind) && !R[k].hall;
        const served = new Set();
        for (let k = 0; k < R.length; k++) {
            if (!isRoom(k)) continue;
            let best = null;
            for (const j of corridors) {
                const e = touching(k, j);
                if (e && e.a1 - e.a0 > door + 0.4 && (!best || e.a1 - e.a0 > best.e.a1 - best.e.a0)) best = { j, e };
            }
            if (!best) continue;
            const { j, e } = best, L = e.a1 - e.a0, mid = (e.a0 + e.a1) / 2;
            // off-centre toward the middle of the building, as office doors are
            const c = L > 2.6 ? mid + Math.sign(-mid || 1) * Math.min(0.6, L / 2 - door / 2 - 0.3) : mid;
            link(k, j, e, door, 'door', c);
            served.add(k);
        }
        // the rest: through a neighbour, nearest the middle first, until every room is reached (suites)
        for (let pass = 0; pass < 8; pass++) {
            let added = false;
            for (let k = 0; k < R.length; k++) {
                if (!isRoom(k) || served.has(k)) continue;
                let best = null;
                for (const j of served) {
                    const e = touching(k, j);
                    if (!e || e.a1 - e.a0 < door + 0.4) continue;
                    const rc = R[j].rects[0], d = Math.hypot((rc[0] + rc[1]) / 2, (rc[2] + rc[3]) / 2);
                    if (!best || d < best.d) best = { j, e, d };
                }
                if (!best) continue;
                link(k, best.j, best.e, door, 'door');
                served.add(k);
                added = true;
            }
            if (!added) break;
        }
    }

    // the room holding local (x, z), or -1
    roomAt(x, z) {
        for (let k = 0; k < this.rooms.length; k++) for (const r of this.rooms[k].rects) if (x >= r[0] && x <= r[1] && z >= r[2] && z <= r[3]) return k;
        return -1;
    }

    // the portals of room k, each with its far side (to) and the normal from room k into it
    portalsOf(k) {
        const out = [];
        this.portals.forEach((p, pi) => {
            if (p.a !== k && p.b !== k) return;
            const to = p.a === k ? p.b : p.a, own = this.rooms[k].rects;
            // which side of the edge room k lies on: a rect of it on the + side of the line
            const plus = own.some(r => p.axis === 'x' ? Math.abs(r[2] - p.at) < EPS && r[0] <= p.c + EPS && p.c <= r[1] + EPS
                : Math.abs(r[0] - p.at) < EPS && r[2] <= p.c + EPS && p.c <= r[3] + EPS);
            const n = p.axis === 'x' ? [0, 0, plus ? -1 : 1] : [plus ? -1 : 1, 0, 0];
            out.push({ ...p, pi, to, n });
        });
        return out;
    }

    // the stretches of room k's walls that are not façade nor between its own rectangles: { axis, at, a0, a1, side (the
    // room lies on this side of the line: +1 / -1) }
    walls(k) {
        const [X0, X1, Z0, Z1] = this.inner, own = this.rooms[k].rects, out = [];
        for (const r of own) {
            const edges = [
                { axis: 'x', at: r[2], a0: r[0], a1: r[1], side: 1 }, { axis: 'x', at: r[3], a0: r[0], a1: r[1], side: -1 },
                { axis: 'z', at: r[0], a0: r[2], a1: r[3], side: 1 }, { axis: 'z', at: r[1], a0: r[2], a1: r[3], side: -1 },
            ];
            for (const e of edges) {
                if (e.axis === 'x' && (Math.abs(e.at - Z0) < EPS || Math.abs(e.at - Z1) < EPS)) continue;
                if (e.axis === 'z' && (Math.abs(e.at - X0) < EPS || Math.abs(e.at - X1) < EPS)) continue;
                // less where another rectangle of the room continues across the line
                let segs = [[e.a0, e.a1]];
                for (const q of own) {
                    if (q === r) continue;
                    const s = sharedEdge(r, q);
                    if (!s || s.axis !== e.axis || Math.abs(s.at - e.at) > EPS) continue;
                    segs = segs.flatMap(([a, b]) => [[a, Math.min(b, s.a0)], [Math.max(a, s.a1), b]]).filter(([a, b]) => b - a > EPS);
                }
                for (const [a0, a1] of segs) out.push({ axis: e.axis, at: e.at, a0, a1, side: e.side });
            }
        }
        return out;
    }

    // how deep the façade rooms reach off the x façades and off the z ones ([x, z], m from the wall's inner face): the
    // sun reaches no deeper (rooms off a corridor; a hall's: Infinity)
    facadeDepth() {
        const out = [0, 0], [X0, X1, Z0, Z1] = this.inner;
        for (const room of this.rooms) {
            if (!room.facade) continue;
            for (const [x0, x1, z0, z1] of room.rects) {
                if (Math.abs(x0 - X0) < 1e-3 || Math.abs(x1 - X1) < 1e-3) out[0] = Math.max(out[0], x1 - x0);
                if (Math.abs(z0 - Z0) < 1e-3 || Math.abs(z1 - Z1) < 1e-3) out[1] = Math.max(out[1], z1 - z0);
            }
        }
        return out;
    }
}

// a tiny seeded generator (this kit does not use the noise kit)
function mulberry(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

return { FloorPlan, splitSpan, sharedEdge, stripBands: strip };
});
