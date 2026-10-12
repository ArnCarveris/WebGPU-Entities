'use strict';
// InteriorDoors: the door leaves in a planned building's doorways, each one that opens and shuts. A storey kind's
// doorways (FloorBuilder: its template's `doors`) are built once, but each door of each storey is its own: its state
// is made the first time it is used (until then it stands open, as built) and kept by building, storey and doorway, so
// a tower's thousand storeys cost the doors someone has touched. A shut door closes its doorway's portal (the
// traversal stops there: PlannedBuilding.template tags the portal, AreaSet keeps it in `leaves`, RoomVis closes it) and
// is a solid a walker stops at. The leaves are drawn as box instances (the lifts' kind), only in the rooms the
// traversal reaches.
//
// A template doorway: { i (its portal in the storey's FloorPlan), a, b (its rooms), hinge [x, z] (in its building's
// frame), u (unit, along the wall from the hinge), n (unit, into room a: the way it opens), back, len (the leaf from
// that far behind the hinge to that far past it: shut, it fills the doorway to a few mm, as nothing is drawn behind a
// closed portal), y0, y1 (over the storey's floor), col }

Features.kit('building', (engine, kit) => {
const { Common } = engine;
const { DEG, v3 } = Common;

const SWING = 1.6;          // its travel per s (0 shut .. 1 open: square to the wall)
const REACH = 2.4;          // m: E opens or shuts the door in view this close to the eye
const THICK = 0.04;         // m: a leaf's thickness
const SHUT = 0.02;          // under this it is shut: its portal closed

class InteriorDoors {
    // S: the world's structures (interiors: the InteriorIndex its buildings are in); material(b, mat): a box's material
    // code in building b (the renderer's)
    constructor(S, { material = (b, mat) => mat } = {}) {
        this.S = S;
        this.material = material;
        this.state = new Map();      // `${building id}:${storey}:${doorway}` -> { open, target, ... } (touched doors only)
        this.moving = new Set();
    }

    // the doorways of storey s of planned section building b (its template's)
    of(b, s) { return b.plan?.tpl?.get(b.plan.keys[s])?.doors || []; }
    key(b, s, i) { return `${b.id}:${s}:${i}`; }
    // how far door i of storey s of b stands open (0 shut .. 1)
    openness(b, s, i) { return this.state.get(this.key(b, s, i))?.open ?? 1; }
    // a doorway portal's leaf ({ b, i, s }: AreaSet's P.leaf) open enough to see through
    isOpen(leaf) { return this.openness(leaf.b, leaf.s, leaf.i) > SHUT; }

    // a door's state, made on first use (open, as built), with where it is in the world (its hinge, its middle)
    door(b, s, d) {
        const key = this.key(b, s, d.i);
        let st = this.state.get(key);
        if (!st) {
            const O = b.interior.origin, y = s * b.H;
            const mid = [d.hinge[0] + d.u[0] * d.len / 2, y + (d.y0 + d.y1) / 2, d.hinge[1] + d.u[1] * d.len / 2];
            const h = O.toWorld([d.hinge[0], y + d.y0, d.hinge[1]]);
            st = { key, b, s, d, open: 1, target: 1, centre: O.toWorld(mid), hinge: [h[0], h[2]], y: h[1] };
            this.state.set(key, st);
        }
        return st;
    }

    // the leaf of doorway d opened `open` (0..1): its middle [x, z] (building frame), yaw, half length
    static pose(d, open) {
        const a = open * 90 * DEG, dir = [d.u[0] * Math.cos(a) + d.n[0] * Math.sin(a), d.u[1] * Math.cos(a) + d.n[1] * Math.sin(a)], c = (d.len - d.back) / 2;
        return { x: d.hinge[0] + dir[0] * c, z: d.hinge[1] + dir[1] * c, dir, yaw: Math.atan2(dir[1], dir[0]), half: (d.len + d.back) / 2 };
    }

    // the planned section building the point p is in, and its storey there: { b, s, q (p in its frame) } or null
    where(p) {
        const it = this.S.interiors.at(p, 'building'), b = it?.owner;
        if (!b?.plan?.tpl) return null;
        const q = b.interior.origin.toLocal(p), s = Math.floor(q[1] / b.H);
        return s >= 0 && s < b.n ? { b, s, q } : null;
    }

    // the door the eye looks at within REACH (the middle of its doorway), or null
    at(eye, fwd) {
        const w = this.where(eye);
        if (!w) return null;
        const { b, s, q } = w, O = b.interior.origin, f = O.toLocal(fwd, 0), y = s * b.H;
        let best = null, score = 0;
        for (const d of this.of(b, s)) {
            const c = [d.hinge[0] + d.u[0] * d.len / 2, y + (d.y0 + d.y1) / 2, d.hinge[1] + d.u[1] * d.len / 2], v = v3.sub(c, q), l = v3.len(v);
            if (l > REACH || l < 1e-3) continue;
            const k = v3.dot(v, f) / l, need = Math.cos(Math.atan2(d.len / 2 + 0.25, l));
            if (k > need && k - need > score) { score = k - need; best = d; }
        }
        return best ? this.door(b, s, best) : null;
    }

    // sends a door (at()'s) open or shut
    send(st, open) {
        st.target = open ? 1 : 0;
        if (st.open !== st.target) this.moving.add(st);
    }

    // the doors swing toward where they were sent; true if one moved
    update(dt) {
        for (const st of this.moving) {
            st.open = st.target > st.open ? Math.min(st.target, st.open + dt * SWING) : Math.max(st.target, st.open - dt * SWING);
            if (st.open === st.target) this.moving.delete(st);
        }
        return this.moving.size > 0;
    }

    // what a walker at p collides with: the leaves of its storey's touched doors that are not standing open
    colliders(p) {
        const w = this.where(p), out = [];
        if (!w) return out;
        const { b, s } = w, O = b.interior.origin, y = O.toWorld([0, s * b.H, 0])[1];
        for (const d of this.of(b, s)) {
            const st = this.state.get(this.key(b, s, d.i));
            if (!st || st.open > 0.95) continue;
            const P = InteriorDoors.pose(d, st.open), c = O.toWorld([P.x, 0, P.z]), dir = O.toWorld([P.dir[0], 0, P.dir[1]], 0);
            out.push({ x: c[0], z: c[2], hx: P.half, hz: THICK / 2 + 0.01, cs: dir[0], sn: dir[2], y0: y + d.y0, y1: y + d.y1, slope: 0 });
        }
        return out;
    }

    // The leaves in the rooms reached (seen: building -> storey -> Set of rooms, RoomVis's), as box instances into data
    // from instance `first` on (BOX_FLOATS = 12 each: [centre, yaw] [half sizes, material] [colour, 0]), the storeys
    // nearest the eye first; their centres' y over base(b) (the eye's storey's floor, as the lifts'). Returns the groups
    // [{ b, first, count }]
    instances(eye, data, first, seen, base) {
        const out = [], max = data.length / 12;
        let n = first;
        const all = [];
        for (const [b, storeys] of seen || []) {
            if (!b.plan?.tpl) continue;
            const ey = b.interior.origin.toLocal(eye)[1];
            for (const [s, rooms] of storeys) all.push({ b, s, rooms, dy: Math.abs(s * b.H + b.H / 2 - ey) });
        }
        all.sort((p, q) => p.dy - q.dy);
        const groups = new Map();
        for (const { b, s, rooms } of all) {
            const doors = this.of(b, s);
            if (!doors.length) continue;
            const y = b.floor + s * b.H - base(b), m = this.material(b, 0);
            let g = groups.get(b);
            for (const d of doors) {
                if (!rooms.has(d.a) && !rooms.has(d.b)) continue;
                if (n >= max) break;
                if (!g || g.first + g.count !== n) { g = { b, first: n, count: 0 }; out.push(g); groups.set(b, g); }
                const P = InteriorDoors.pose(d, this.openness(b, s, d.i));
                data.set([P.x, y + (d.y0 + d.y1) / 2, P.z, P.yaw, P.half, (d.y1 - d.y0) / 2, THICK / 2, m, d.col[0], d.col[1], d.col[2], 0], n * 12);
                n++;
                g.count++;
            }
        }
        return out;
    }
}

return { InteriorDoors };
});
