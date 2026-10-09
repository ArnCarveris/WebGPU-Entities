'use strict';
// AreaSet: a world's areas (area 0 the outdoors), portals and occluders, found by point (areaAt) and traversed from the
// camera by PortalVis: the portal feature's World, and any other world built of areas.

Features.kit('interior', (engine, kit) => {
const { GridHash, QuadTree, Portal, PortalVis, aabbVisible } = kit;

// A world of areas: `areas` (Area; [0] the outdoors, Area.outdoors), `portals` (Portal, each listed by both its areas),
// `occluders` (Occluder, by the area holding them), `vehicles` (optional: areas aboard one are in its frame, its Origin:
// veh.toLocal, veh.M, veh.areaGrid). The world that extends it builds them, then:
//   indexAreas()           areaAt in O(1) whatever the number of areas: GridHashes over their footprints (the world's,
//                          each vehicle's in its frame); with `bandH` (m) also bucketed by height bands, for areas
//                          stacked storey on storey (a tower: thousands over the same footprint)
//   addPortal(def)         a Portal (its areas probed by areaAt unless def.front / def.back say: an area's id or index)
//   indexOutdoorPortals()  the portals out to the outdoors in a tree (a QuadTree; or `Tree`, e.g. a BVHTree when they
//                          stand storey over storey), so a traversal from outdoors tests those in its frustum only
//   visGraph(o)            the graph a PortalVis traverses ({ root, maxRange (m: from outdoors, only portals within it
//                          of the eye: what a city's windows are seen through), nearPass })
//   addStack(st)           storeys that repeat (a tower's thousand, each a hundred rooms): their areas and portals made
//                          only for the storeys near the eye, the traversal or a query (and dropped again past `cap`
//                          storeys), so a building costs what the storeys round the camera do (see addStack)
// With `vehiclesFirst`, an area aboard a vehicle (a lift car) holds a point before any area it moves through.
class AreaSet {
    constructor({ bandH = 0, cap = 320, vehiclesFirst = false } = {}) {
        this.areas = [];
        this.portals = [];
        this.occluders = [];
        this.areaById = new Map();
        this.bandH = bandH;
        this.vehiclesFirst = vehiclesFirst;
        this.stacks = [];
        this.stackGrid = new GridHash(64);
        this.live = new Map();           // `${stack}:${storey}` -> its materialized areas and portals (least recently used first)
        this.cap = cap;
        this.freeAreas = [];
        this.freePortals = [];
        this.landings = new Set();       // the live portals with a `landing` (lift landing doors: the world opens and closes them)
        this.frame = 0;
    }

    addArea(def, AreaType = kit.Area) {
        const a = new AreaType(def, this.areas.length);
        this.areas.push(a);
        if (a.id !== undefined) this.areaById.set(a.id, a.index);
        return a;
    }

    addPortal(def) {
        const P = new Portal(def, this.portals.length, this);
        if (P.front === P.back) { this.warnings?.push(`portal "${def.id}" connects "${this.areas[P.front].id}" to itself; skipped`); return null; }
        this.portals.push(P);
        if (P.id !== undefined) this.portalById?.set(P.id, P);
        this.areas[P.front].portals.push(P.index);
        this.areas[P.back].portals.push(P.index);
        return P;
    }

    // the areas in GridHashes over their footprints, so areaAt is O(1) however many there are: the world's in one (or
    // one per height band), each vehicle's in its own, in its frame (its Origin), so they move with it for free
    indexAreas() {
        this.areaGrid = new GridHash(16);
        this.bands = this.bandH ? new Map() : null;
        for (const veh of this.vehicles || []) { veh.areaGrid = new GridHash(16); veh.areaReach = 0; }
        for (const a of this.areas) {
            if (!a || a.index === 0 || a.live) continue;
            const veh = a.vehicle;
            if (veh) veh.areaGrid.insert(a, ...a.bbox);
            else if (this.bands) {
                for (let k = Math.floor(a.y / this.bandH); k <= Math.floor((a.top - 1e-6) / this.bandH); k++) {
                    if (!this.bands.has(k)) this.bands.set(k, new GridHash(16));
                    this.bands.get(k).insert(a, ...a.bbox);
                }
            } else this.areaGrid.insert(a, ...a.bbox);
            // how far from its origin a vehicle's areas reach: further off, p is in none of them (no transform needed)
            if (veh) for (const x of [a.bbox[0], a.bbox[2]]) for (const z of [a.bbox[1], a.bbox[3]]) for (const y of [a.y, a.top]) veh.areaReach = Math.max(veh.areaReach, Math.hypot(x, y, z));
        }
    }

    // an area by id (or its index)
    areaIndex(id) {
        if (id === undefined || id === null) return undefined;
        if (typeof id === 'number') return id;
        if (!this.areaById.has(id)) { this.warnings?.push(`unknown area "${id}"`); return 0; }
        return this.areaById.get(id);
    }

    // the vehicles whose cells hold p (all of them while the world is being built)
    vehiclesAt(p) { return this.vehicleGrid ? this.vehicleGrid.at(p[0], p[2]) : this.vehicles || []; }

    // FarCry SetCurAreas / SECTR GetContaining: point query, outdoors when nothing contains it (the first area that does,
    // by index). The few areas in p's cell of each grid: O(1) in the number of areas
    areaAt(p) {
        let best = 0;
        for (const veh of this.vehiclesAt(p)) {
            const M = veh.M, r = veh.areaReach;
            if (!r || (p[0] - M[12]) ** 2 + (p[1] - M[13]) ** 2 + (p[2] - M[14]) ** 2 > r * r) continue;
            const l = veh.toLocal(p);
            for (const a of veh.areaGrid.at(l[0], l[2])) if ((!best || a.index < best) && a.containsLocal(l)) best = a.index;
        }
        // aboard: the vehicle's area, not the shaft it moves through
        if (best && this.vehiclesFirst) return best;
        if (this.stacks.length) this.ensureAt(p);
        const grid = this.bands ? this.bands.get(Math.floor(p[1] / this.bandH)) : this.areaGrid;
        if (grid) for (const a of grid.at(p[0], p[2])) if ((!best || a.index < best) && a.containsLocal(p)) best = a.index;
        return best;
    }

    // the area nearest p within r (m) whose height holds p, by its footprint's bounds: for a point that is in none (a
    // wall's thickness, a sealed void), the space it is seen from. 0 if none
    nearestArea(p, r = 2) {
        if (this.stacks.length) this.ensureAt(p);
        const grid = this.bands ? this.bands.get(Math.floor(p[1] / this.bandH)) : this.areaGrid;
        let best = 0, bd = r;
        grid?.each(p[0] - r, p[2] - r, p[0] + r, p[2] + r, a => {
            if (p[1] < a.y || p[1] >= a.top) return;
            const [x0, z0, x1, z1] = a.bbox, d = Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(z0 - p[2], 0, p[2] - z1));
            if (d < bd) { bd = d; best = a.index; }
        });
        return best;
    }

    // the areas (not the outdoors) whose footprint bounds meet [x0, x1] x [z0, z1] and whose height meets [y0, y1]: the
    // grids' cells there (the bands that height spans), and the areas aboard vehicles. For a map of what is round the eye
    areasIn(x0, z0, x1, z1, y0 = -Infinity, y1 = Infinity) {
        const out = new Set(), take = a => { if (a && a.index && a.top > y0 && a.y < y1) out.add(a); };
        if (this.bands) {
            const keys = Number.isFinite(y0) && Number.isFinite(y1) ? null : [...this.bands.keys()];
            const k0 = Math.floor(y0 / this.bandH), k1 = Math.floor(y1 / this.bandH);
            for (const k of keys || Array.from({ length: k1 - k0 + 1 }, (_, i) => k0 + i)) this.bands.get(k)?.each(x0, z0, x1, z1, take);
        } else this.areaGrid?.each(x0, z0, x1, z1, take);
        if (!this.areaGrid && !this.bands) for (const a of this.areas) take(a);
        for (const a of this.areas) {
            if (!a?.vehicle) continue;
            const sh = a.shape2D(), xs = sh.map(p => p[0]), zs = sh.map(p => p[1]);
            if (Math.max(...xs) >= x0 && Math.min(...xs) <= x1 && Math.max(...zs) >= z0 && Math.min(...zs) <= z1) take(a);
        }
        return [...out];
    }

    // the portals out to the outdoors in a tree (a vehicle's apart: they move with it, tested while it is in view)
    indexOutdoorPortals(Tree = QuadTree) {
        const out = this.portals.filter(P => P.front === 0 || P.back === 0);
        this.outdoorPortals = new Tree(out.filter(P => !P.vehicle));
        this.movingOutdoorPortals = (this.vehicles || []).map(veh => ({ veh, portals: out.filter(P => P.vehicle === veh).map(P => P.index) })).filter(v => v.portals.length);
    }

    // The portals of entry e's area worth testing (PortalVis). Outdoors holds every exit portal of every building, so there
    // the outdoor-portal tree gives only those whose bounds meet e's frustum (its planes pushed out by nearPass + 1 m: a
    // broad phase that never drops one the tests would pass, the camera standing in an aperture included; with maxRange,
    // also within a box that far round the eye), in index order as the full list would visit them. Cost: the tree nodes in
    // view, not the world's portals
    // An area with a `reach` (m: a tall stairwell, whose flights hide what is further up and down) offers only its portals
    // within that of the eye
    candidates(e, nearPass, maxRange = 0, eye = null, st = { nodes: 0, objs: 0 }) {
        const A = this.areas[e.area];
        if (A.stacks && eye) for (const S of A.stacks) this.ensureRange(S, eye[1] - (A.reach || S.H), eye[1] + (A.reach || S.H), true);
        if (A.reach && eye) return A.portals.filter(i => {
            const P = this.portals[i];
            return Math.hypot(Math.max(P.min[0] - eye[0], 0, eye[0] - P.max[0]), Math.max(P.min[1] - eye[1], 0, eye[1] - P.max[1]), Math.max(P.min[2] - eye[2], 0, eye[2] - P.max[2])) <= A.reach;
        });
        if (e.area !== 0 || !this.outdoorPortals) return A.portals;
        const pad = nearPass + 1, planes = e.planes.map(q => [q[0], q[1], q[2], q[3] + pad]), out = [];
        // a vehicle's (the ship's): only while its bounding sphere is in view
        for (const { veh, portals } of this.movingOutdoorPortals) if (veh.inPlanes(planes)) out.push(...portals);
        const query = maxRange ? [...planes, ...[0, 1, 2].flatMap(k => {
            const n = [0, 0, 0];
            n[k] = 1;
            const m = [0, 0, 0];
            m[k] = -1;
            return [[...n, -(eye[k] - maxRange)], [...m, eye[k] + maxRange]];
        })] : planes;
        this.outdoorPortals?.query(query, P => out.push(P.index), st);
        // the façades of the stacks near: their storeys within range made, the portals out of them in the frustum
        if (this.stacks.length && eye) {
            const R = maxRange || 200;
            this.stackGrid.each(eye[0] - R, eye[2] - R, eye[0] + R, eye[2] + R, S => {
                if (!this.ensureRange(S, eye[1] - R, eye[1] + R, true)) return;
                for (const L of this.liveOf(S, eye[1] - R, eye[1] + R)) {
                    if (!L.outdoor.length || !aabbVisible(L.min, L.max, query)) continue;
                    for (const i of L.outdoor) { const P = this.portals[i]; if (aabbVisible(P.min, P.max, query)) out.push(i); }
                }
            });
        }
        return out.sort((a, b) => a - b);
    }

    // ------------------------------------------------------------------------------------------- stacks
    // st: { origin (Origin: the building's frame), base (m: storey 0's floor, world), H (m), n (storeys), rect ([x0, z0,
    // x1, z1]: the footprint's world bounds), key(s) (the template storey s is built from, or null), template(key) -> {
    // areas: [{ rect [x0, x1, z0, z1] (local), y (over the storey's floor), height, room (what the world draws of it;
    // the storey is added as s), shelter }], portals: [{ center (local x, z; y over the storey's floor), size, normal
    // (local), a, b (a template area's index, { tall: an area's index }, or 0: the outdoors), kind, passThrough, closed,
    // landing (the world's: a lift's landing door) }] }, tall ([area indices]: areas that run up through the storeys,
    // the stairwell and the shafts: they list the live storeys' portals into them), maxPerQuery (new storeys a query may
    // make at once: the rest come in the frames after) }. Returns st
    addStack(st) {
        st.id = this.stacks.length;
        st.maxPerQuery ??= 12;
        this.stacks.push(st);
        this.stackGrid.insert(st, ...st.rect);
        for (const i of st.tall || []) (this.areas[i].stacks ||= []).push(st);
        return st;
    }

    // the stacks over p: the storey of each that holds p's height made (and touched)
    ensureAt(p) {
        for (const S of this.stackGrid.at(p[0], p[2])) {
            const s = Math.floor((p[1] - S.base) / S.H);
            if (s >= 0 && s < S.n) this.materialize(S, s);
        }
    }

    // the storeys of stack S between heights y0 and y1 made, nearest the middle first (with `limit`, at most
    // S.maxPerQuery new ones). Returns whether S has storeys there
    ensureRange(S, y0, y1, limit = false) {
        const s0 = Math.max(0, Math.floor((y0 - S.base) / S.H)), s1 = Math.min(S.n - 1, Math.floor((y1 - S.base) / S.H));
        if (s1 < s0) return false;
        const mid = (s0 + s1) / 2, order = [];
        for (let s = s0; s <= s1; s++) order.push(s);
        order.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
        let made = 0;
        for (const s of order) {
            const L = this.live.get(`${S.id}:${s}`);
            if (L) { L.touched = this.frame; continue; }
            if (limit && made >= S.maxPerQuery) continue;
            if (this.materialize(S, s)) made++;
        }
        return true;
    }

    // the live storeys of S between heights y0 and y1
    liveOf(S, y0, y1) {
        const out = [], s0 = Math.max(0, Math.floor((y0 - S.base) / S.H)), s1 = Math.min(S.n - 1, Math.floor((y1 - S.base) / S.H));
        for (let s = s0; s <= s1; s++) { const L = this.live.get(`${S.id}:${s}`); if (L) out.push(L); }
        return out;
    }

    // storey s of stack S as areas and portals (kept while used; the least recently touched dropped past `cap`).
    // Returns the new storey, or null if it was live already (or has none)
    materialize(S, s) {
        const id = `${S.id}:${s}`;
        let L = this.live.get(id);
        if (L) {
            L.touched = this.frame;
            this.live.delete(id);
            this.live.set(id, L);
            return null;
        }
        const key = S.key(s);
        if (key === null || key === undefined) return null;
        const T = S.template(key), y = S.base + s * S.H, O = S.origin, oy = O.M[13];
        L = { S, s, areas: [], portals: [], outdoor: [], touched: this.frame, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (const d of T.areas) {
            const [x0, x1, z0, z1] = d.rect, shape = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => { const w = O.toWorld([x, 0, z]); return [w[0], w[2]]; });
            const index = this.freeAreas.length ? this.freeAreas.pop() : this.areas.length;
            const a = new kit.Area({ shape, y: y + d.y, height: d.height, shelter: d.shelter }, index);
            a.room = d.room ? { ...d.room, s } : null;
            a.live = L;
            this.areas[index] = a;
            this.bandInsert(a);
            L.areas.push(index);
        }
        const ref = r => typeof r === 'object' && r !== null ? r.tall ?? 0 : L.areas[r];
        for (const d of T.portals) {
            const c = O.toWorld([d.center[0], d.center[1] + y - oy, d.center[2]]), n = O.toWorld(d.normal, 0);
            const index = this.freePortals.length ? this.freePortals.pop() : this.portals.length;
            const P = new Portal({ center: c, size: d.size, normal: n, front: ref(d.a), back: ref(d.b), kind: d.kind, passThrough: d.passThrough, frame: false, closed: d.closed }, index, this);
            P.landing = d.landing ? { ...d.landing, s, y } : null;
            this.portals[index] = P;
            this.areas[P.front].portals.push(index);
            this.areas[P.back].portals.push(index);
            if (P.front === 0 || P.back === 0) L.outdoor.push(index);
            if (P.landing) this.landings.add(P);
            for (let k = 0; k < 3; k++) { L.min[k] = Math.min(L.min[k], P.min[k]); L.max[k] = Math.max(L.max[k], P.max[k]); }
            L.portals.push(index);
        }
        this.live.set(id, L);
        if (this.live.size > this.cap) this.evict();
        return L;
    }

    // drops the least recently touched storeys (none touched this frame) down to 7/8 of `cap`
    evict() {
        for (const [id, L] of this.live) {
            if (this.live.size <= this.cap * 7 / 8) break;
            if (L.touched >= this.frame) continue;
            this.live.delete(id);
            const gone = new Set(L.portals);
            for (const i of L.portals) {
                const P = this.portals[i];
                for (const a of [P.front, P.back]) {
                    const A = this.areas[a];
                    if (A && A.live !== L) A.portals = A.portals.filter(k => !gone.has(k));
                }
                this.landings.delete(P);
                this.portals[i] = null;
                this.freePortals.push(i);
            }
            for (const i of L.areas) {
                this.bandRemove(this.areas[i]);
                this.areas[i] = null;
                this.freeAreas.push(i);
            }
        }
    }

    bandInsert(a) {
        if (!this.bands) { this.areaGrid.insert(a, ...a.bbox); return; }
        for (let k = Math.floor(a.y / this.bandH); k <= Math.floor((a.top - 1e-6) / this.bandH); k++) {
            if (!this.bands.has(k)) this.bands.set(k, new GridHash(16));
            this.bands.get(k).insert(a, ...a.bbox);
        }
    }

    bandRemove(a) {
        if (!this.bands) { this.areaGrid.remove(a); return; }
        for (let k = Math.floor(a.y / this.bandH); k <= Math.floor((a.top - 1e-6) / this.bandH); k++) this.bands.get(k)?.remove(a);
    }

    // the graph PortalVis traverses (kits.interior): areas and portals by index. o: root(eye) (default areaAt), maxRange
    // (see candidates), nearPass (what PortalVis is given: the broad phase pads by it)
    visGraph({ root = null, maxRange = 0, nearPass = () => 0.35 } = {}) {
        const set = this, st = { nodes: 0, objs: 0 };
        return {
            root: eye => { set.eye = eye; return root ? root(eye) : set.areaAt(eye); },
            portals: e => set.candidates(e, nearPass(), maxRange, set.eye, st).map(i => set.portals[i]),
            occluders: a => set.areas[a].occluders.map(i => set.occluders[i]),
            get count() { return set.areas.length; },
            get portalCount() { return set.portals.length; },
            all: () => set.areas.map((a, i) => a ? i : -1).filter(i => i >= 0),
            st,
        };
    }
}

return { AreaSet };
});
