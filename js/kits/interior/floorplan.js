'use strict';
// FloorPlan: one storey of a building laid out as rectangles in its frame: a core (stairwell, lift shafts either side of
// a lift lobby), a corridor round it (and along the long axis of an elongated building), and rooms between the corridor
// and the façades, every room reachable through doorways. Pure data: a feature builds the walls, floors, doors and its
// interior's areas and portals (an AreaSet) from it.

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

// The core, centred on the footprint and laid along local x: [stairwell | left bank | lift lobby | right bank], each the
// core's full depth (along z). spec: { stairs: { lane (m, each flight's width), landing (m) } | false, banks: [left
// shafts, right shafts], shaft: [width along z, depth along x] (outside their walls), lobby (m) }; H: the tallest storey
// (the stairwell must hold two flights of half of it, ~0.18 m risers on 0.28 m treads, and a landing at each end).
// Returns its size (w along x, d along z) and its parts relative to its centre.
function coreLayout(spec, H) {
    const st = spec.stairs === false ? null : { lane: 1.2, landing: 1.25, ...spec.stairs };
    const [sw, sd] = spec.shaft || [2.3, 2.5], banks = spec.banks || [0, 1], lobby = spec.lobby ?? 3.0;
    const steps = Math.ceil(H / 2 / 0.18), run = steps * 0.28;
    const d = Math.max(st ? run + 2 * st.landing : 0, banks[0] * sw, banks[1] * sw, 4.5);
    const stairW = st ? 2 * st.lane + 0.2 : 0;
    const w = stairW + (banks[0] ? sd : 0) + lobby + (banks[1] ? sd : 0);
    let x = -w / 2;
    const parts = { w, d, shafts: [] };
    if (st) { parts.stair = { rect: [x, x + stairW, -d / 2, d / 2], ...st }; x += stairW; }
    const bank = (n, side) => {
        const x0 = x, x1 = x + sd, z0 = -n * sw / 2;
        for (let i = 0; i < n; i++)
            parts.shafts.push({ bank: side, index: i, rect: [x0, x1, z0 + i * sw, z0 + (i + 1) * sw], face: side === 0 ? '+x' : '-x' });
        x += sd;
    };
    if (banks[0]) bank(banks[0], 0);
    parts.lobby = [x, x + lobby, -d / 2, d / 2];
    x += lobby;
    if (banks[1]) bank(banks[1], 1);
    return parts;
}

// A storey's plan. o: { hx, hz (half the outer footprint), t (outer wall), core (coreLayout's, or null), corridor (m),
// module (m: a room's width along the façade), minRoom (m: shallower bands become corridor), kind ('rooms' | 'hall'),
// seed }. Rooms: { kind (corridor | office | open | meeting | hall | lobby | stair | shaft), rects, name, depth (m from
// the façade) }; portals: { a, b (room indices), axis, at, c (centre along the edge), w, h (doorway; h: of the storey,
// 0 = full) , kind (door | opening | lift | stair) }.
class FloorPlan {
    constructor(o) {
        this.o = o;
        this.rooms = [];
        this.portals = [];
        const X = o.hx - o.t, Z = o.hz - o.t;
        this.inner = [-X, X, -Z, Z];
        const core = o.core;
        const c = o.corridor ?? 1.8;
        this.coreIdx = {};
        const add = (kind, rects, extra = {}) => { this.rooms.push({ kind, rects, ...extra }); return this.rooms.length - 1; };
        // the core's rooms, centred
        if (core) {
            if (core.stair) this.coreIdx.stair = add('stair', [core.stair.rect], { stair: core.stair });
            this.coreIdx.shafts = core.shafts.map(s => add('shaft', [s.rect], { shaft: s }));
            this.coreIdx.lobby = add('lobby', [core.lobby]);
        }
        const cw = core ? core.w / 2 : 0, cd = core ? core.d / 2 : 0;
        if (o.kind === 'hall' || !core) { this.hall(X, Z, cw, cd); return; }
        // corridor: a ring round the core; along the long axis it runs on (a spine) to leave end rooms as deep as the
        // side ones. Laid out with x the long axis (`swap` turns it back)
        const swap = Z > X, LX = swap ? Z : X, LZ = swap ? X : Z, kx = swap ? cd : cw, kz = swap ? cw : cd;
        const T = r => swap ? [r[2], r[3], r[0], r[1]] : r;
        const rx = kx + c, rz = kz + c, minRoom = o.minRoom ?? 2.6, module = o.module ?? 5;
        const side = LZ - rz;
        if (side < minRoom || LX - rx < minRoom) { this.hall(X, Z, cw, cd); return; }
        const spine = (LX - rx) > 1.5 * side, sx = spine ? Math.max(rx, LX - Math.min(8, Math.max(4.5, side))) : rx;
        const corr = [[-rx, rx, kz, rz], [-rx, rx, -rz, -kz], [-rx, -kx, -kz, kz], [kx, rx, -kz, kz]];
        if (spine) corr.push([rx, sx, -c / 2, c / 2], [-sx, -rx, -c / 2, c / 2]);
        this.corridor = add('corridor', corr.map(T));
        // rooms: two side bands (from the corridor to the façade) and two ends, cut into modules
        const rnd = mulberry(o.seed ?? 1);
        const roomKind = depth => depth > 9 ? 'open' : rnd() < 0.18 ? 'meeting' : 'office';
        // deep bands hold open-plan floors about as wide as they are deep, not strips
        const width = depth => depth > 9 ? Math.max(module, depth * 0.9) : module;
        for (const sg of [-1, 1]) {
            for (const [a0, a1] of splitSpan(-sx, sx, width(side), [-rx, rx])) {
                const z0 = Math.abs((a0 + a1) / 2) < rx ? rz : c / 2, depth = LZ - z0;
                const r = sg > 0 ? [a0, a1, z0, LZ] : [a0, a1, -LZ, -z0];
                add(roomKind(depth), [T(r)], { depth });
            }
            const f = spine ? c / 2 : rz;
            for (const [a0, a1] of splitSpan(-LZ, LZ, width(LX - sx), [-f - 0.5, f + 0.5])) {
                const depth = LX - sx, r = sg > 0 ? [sx, LX, a0, a1] : [-LX, -sx, a0, a1];
                add(depth > 9 ? 'open' : 'office', [T(r)], { depth, end: true });
            }
        }
        this.connect();
    }

    // an open storey round the core (a lobby, a sky lobby, a shop floor): one hall
    hall(X, Z, cw, cd) {
        const rects = cw ? [[-X, X, cd, Z], [-X, X, -Z, -cd], [-X, -cw, -cd, cd], [cw, X, -cd, cd]] : [[-X, X, -Z, Z]];
        this.corridor = this.rooms.push({ kind: 'hall', rects: rects.filter(r => r[1] - r[0] > EPS && r[3] - r[2] > EPS), depth: Infinity }) - 1;
        this.connect();
    }

    // doorways: every room onto the corridor (or the hall) where it touches it, else into the neighbour in its band
    // nearer the middle; the core: the lobby open at both ends, the stairwell's door at its -z end, the shafts' doors
    // on the lobby (kind 'lift': the feature hangs the landing doors in them)
    connect() {
        const R = this.rooms, C = this.corridor, I = this.coreIdx, door = this.o.door ?? 0.95;
        const link = (a, b, e, w, kind, c) => this.portals.push({ a, b, axis: e.axis, at: e.at, c: c ?? (e.a0 + e.a1) / 2, w, h: kind === 'opening' ? 0 : 2.15, kind });
        const touching = (a, b) => {
            let best = null;
            for (const ra of R[a].rects) for (const rb of R[b].rects) {
                const e = sharedEdge(ra, rb);
                if (e && (!best || e.a1 - e.a0 > best.a1 - best.a0)) best = e;
            }
            return best;
        };
        if (I.lobby !== undefined) {
            for (const r of R[C].rects) {
                const e = sharedEdge(R[I.lobby].rects[0], r);
                // as wide as the lobby less its walls' faces (half a partition each side), so its jambs meet them
                if (e && e.axis === 'x') link(I.lobby, C, e, e.a1 - e.a0 - (this.o.partition ?? 0.12), 'opening');
            }
        }
        if (I.stair !== undefined) {
            const s = R[I.stair].rects[0];
            for (const r of R[C].rects) {
                const e = sharedEdge(s, r);
                if (e && e.axis === 'x' && e.side < 0) link(I.stair, C, e, Math.min(1.1, e.a1 - e.a0 - 0.3), 'door');
            }
        }
        for (const k of I.shafts || []) link(k, I.lobby, touching(k, I.lobby), 1.1, 'lift');
        for (let k = 0; k < R.length; k++) {
            const r = R[k];
            if (!['office', 'open', 'meeting'].includes(r.kind)) continue;
            const e = touching(k, C);
            if (e && e.a1 - e.a0 > door + 0.5) {
                // off-centre toward the core end of the shared stretch, as office doors are
                const mid = (e.a0 + e.a1) / 2, c = e.a1 - e.a0 > 2.6 ? mid + Math.sign(-mid || 1) * Math.min(0.6, (e.a1 - e.a0) / 2 - door / 2 - 0.3) : mid;
                link(k, C, e, door, 'door', c);
                continue;
            }
            // not on the corridor: through the neighbour nearest the middle that is
            let best = null;
            for (let j = 0; j < R.length; j++) {
                if (j === k || !['office', 'open', 'meeting'].includes(R[j].kind)) continue;
                const e2 = touching(k, j);
                if (!e2 || e2.a1 - e2.a0 < door + 0.5) continue;
                const rc = R[j].rects[0], d = Math.hypot((rc[0] + rc[1]) / 2, (rc[2] + rc[3]) / 2);
                if (!best || d < best.d) best = { j, e: e2, d };
            }
            if (best) link(k, best.j, best.e, door, 'door');
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
                { axis: 'x', at: r[2], a0: r[0], a1: r[1], side: 1, out: -1 }, { axis: 'x', at: r[3], a0: r[0], a1: r[1], side: -1, out: 1 },
                { axis: 'z', at: r[0], a0: r[2], a1: r[3], side: 1, out: -1 }, { axis: 'z', at: r[1], a0: r[2], a1: r[3], side: -1, out: 1 },
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
}

// a tiny seeded generator (this kit does not use the noise kit)
function mulberry(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

return { FloorPlan, coreLayout, splitSpan, sharedEdge };
});
