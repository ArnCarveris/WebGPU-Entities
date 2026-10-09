'use strict';
// AreaSet: a world's areas (area 0 the outdoors), portals and occluders, found by point (areaAt) and traversed from the
// camera by PortalVis: the portal feature's World, and any other world built of areas.

Features.kit('interior', (engine, kit) => {
const { GridHash, QuadTree, Portal, PortalVis } = kit;

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
class AreaSet {
    constructor({ bandH = 0 } = {}) {
        this.areas = [];
        this.portals = [];
        this.occluders = [];
        this.areaById = new Map();
        this.bandH = bandH;
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
            if (a.index === 0) continue;
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
        const grid = this.bands ? this.bands.get(Math.floor(p[1] / this.bandH)) : this.areaGrid;
        if (grid) for (const a of grid.at(p[0], p[2])) if ((!best || a.index < best) && a.containsLocal(p)) best = a.index;
        return best;
    }

    // the area nearest p within r (m) whose height holds p, by its footprint's bounds: for a point that is in none (a
    // wall's thickness, a sealed void), the space it is seen from. 0 if none
    nearestArea(p, r = 2) {
        const grid = this.bands ? this.bands.get(Math.floor(p[1] / this.bandH)) : this.areaGrid;
        let best = 0, bd = r;
        grid?.each(p[0] - r, p[2] - r, p[0] + r, p[2] + r, a => {
            if (p[1] < a.y || p[1] >= a.top) return;
            const [x0, z0, x1, z1] = a.bbox, d = Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(z0 - p[2], 0, p[2] - z1));
            if (d < bd) { bd = d; best = a.index; }
        });
        return best;
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
        this.outdoorPortals.query(query, P => out.push(P.index), st);
        return out.sort((a, b) => a - b);
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
            all: () => set.areas.map((a, i) => i),
            st,
        };
    }
}

return { AreaSet };
});
