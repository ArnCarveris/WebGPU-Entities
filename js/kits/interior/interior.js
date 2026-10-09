'use strict';
// Interior: what every building and vehicle has by default (an Origin, a VisArea with its portals, a weather shelter),
// and the InteriorIndex a world finds them by. Every query is O(1) in the number of interiors the world holds.

Features.kit('interior', (engine, kit) => {
const { Origin, GridHash, VisArea } = kit;

// spec: owner (the building or vehicle), kind ('building' | 'vehicle' | ...), origin (an Origin, or what Origin takes:
// a matrix or a function returning the owner's current pose), lo / hi (its VisArea box in that frame), portals
// (VisPortal specs), shelter (default true: no rain or snow falls inside, whatever the wind). The rooms inside are a
// world's areas and portals (AreaSet), if it has them
class Interior {
    constructor({ owner = null, kind = 'building', origin, lo, hi, portals = [], shelter = true }) {
        this.owner = owner;
        this.kind = kind;
        this.origin = origin instanceof Origin ? origin : new Origin(origin);
        this.area = new VisArea(lo, hi, portals);
        this.shelter = shelter;
        this.index = null;               // the InteriorIndex it is in
    }

    // how far (m) `eye` (world) is from its box (0 inside)
    distance(eye) {
        const q = this.origin.toLocal(eye), { lo, hi } = this.area;
        let d2 = 0;
        for (let k = 0; k < 3; k++) { const e = Math.max(lo[k] - q[k], 0, q[k] - hi[k]); d2 += e * e; }
        return Math.sqrt(d2);
    }

    // p (world) inside it
    contains(p) { return this.area.contains(this.origin.toLocal(p)); }
    shelters(p) { return this.shelter && this.contains(p); }

    // its bounding sphere in the world: [x, y, z, r]
    sphere() { const c = this.origin.toWorld(this.area.centre); c.push(this.area.radius); return c; }

    // its owner moved: re-bucket it if it crossed into other cells (O(1))
    moved() { this.index?.moved(this); }

    // can the camera at `eye` (world) see into it with frustum `planes` (Common.frustumPlanes, world)? From inside, yes;
    // from outside, if its box is in the frustum and one of its walls with portals faces the eye, is in the frustum and
    // has glass, an opening or an open door. At most six walls: O(1)
    seenFrom(eye, planes) {
        const A = this.area, q = this.origin.toLocal(eye);
        if (A.contains(q)) return true;
        if (!Interior.inFrustum(this.origin.toWorld(A.centre), A.radius, planes)) return false;
        for (const w of A.walls) {
            if ((q[0] - w.c[0]) * w.n[0] + (q[1] - w.c[1]) * w.n[1] + (q[2] - w.c[2]) * w.n[2] <= 0) continue;
            if (!w.glass && !w.doors.some(d => d.open())) continue;
            if (Interior.inFrustum(this.origin.toWorld(w.c), w.r, planes)) return true;
        }
        return false;
    }

    static inFrustum(c, r, planes) {
        for (const P of planes) if (P[0] * c[0] + P[1] * c[1] + P[2] * c[2] + P[3] < -r) return false;
        return true;
    }
}

// A world's interiors in GridHashes over their footprints: a fine one (cell m) for point queries and short ranges, a
// coarse one (`far` m) for long ranges (a vehicle seen kilometres off), so any query visits a bounded number of cells.
// Static ones are bucketed once; moving ones (vehicles) call Interior.moved() after they move and re-bucket only on
// crossing a cell edge.
class InteriorIndex {
    constructor(cell = 32, far = 1024) {
        this.grid = new GridHash(cell);
        this.coarse = new GridHash(far);
        this.list = [];
    }

    // where its origin is in the world (a vehicle's position)
    static at(it) { const m = it.origin.M; return [m[12], m[13], m[14]]; }

    // its footprint in xz (the box's corners as its origin turns them): a tall tower covers its plan, not its height
    rect(it) {
        const { lo, hi } = it.area, r = [Infinity, Infinity, -Infinity, -Infinity];
        for (const x of [lo[0], hi[0]]) for (const z of [lo[2], hi[2]]) {
            const p = it.origin.toWorld([x, lo[1], z]);
            r[0] = Math.min(r[0], p[0]); r[1] = Math.min(r[1], p[2]); r[2] = Math.max(r[2], p[0]); r[3] = Math.max(r[3], p[2]);
        }
        return r;
    }

    add(it) {
        it.index = this;
        it.seq = this.list.length;
        this.list.push(it);
        const r = this.rect(it);
        this.grid.insert(it, ...r);
        this.coarse.insert(it, ...r);
        return it;
    }

    moved(it) { const r = this.rect(it); this.grid.move(it, ...r); this.coarse.move(it, ...r); }

    // the interiors (of `kind`) whose cells lie within `range` m of p (in xz): candidates for the caller's exact test,
    // from the grid that keeps the cells visited few
    near(p, range, kind) {
        const out = [], g = range <= 8 * this.grid.cell ? this.grid : this.coarse;
        g.each(p[0] - range, p[2] - range, p[0] + range, p[2] + range, it => { if (!kind || it.kind === kind) out.push(it); });
        return out;
    }

    // the interior (of `kind`) whose origin is nearest p, within maxRange m: { it, d } or null. Rings of the coarse grid
    // outward from p's cell, stopping once no further ring can hold anything nearer: at most (2 maxRange / far + 3)^2 cells
    nearest(p, kind, maxRange) {
        const g = this.coarse, c = g.cell, ci = Math.floor(p[0] / c), cj = Math.floor(p[2] / c), K = Math.ceil(maxRange / c) + 1;
        let best = null, bd = maxRange;
        for (let k = 0; k <= K; k++) {
            g.ring(ci, cj, k, it => {
                if (kind && it.kind !== kind) return;
                const o = InteriorIndex.at(it), d = Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]);
                if (d < bd || (d === bd && best && it.seq < best.it.seq)) { bd = d; best = { it, d }; }
            });
            if (best && bd <= k * c) break;          // ring k + 1 is at least k cells away
        }
        return best;
    }

    // the interior (of `kind`, if given) p is inside, or null: the few in p's cell
    at(p, kind) {
        for (const it of this.grid.at(p[0], p[2])) if ((!kind || it.kind === kind) && it.contains(p)) return it;
        return null;
    }

    // is p sheltered from the weather by an interior?
    sheltered(p) {
        for (const it of this.grid.at(p[0], p[2])) if (it.shelters(p)) return it;
        return null;
    }

    // the interiors (of `kind`) the camera at `eye` sees into, within `range` m of their box, nearest first: [[distance,
    // it]]. Costs the cells within range and the interiors there, not the world's
    seen(eye, planes, range, kind) {
        const out = [];
        this.grid.each(eye[0] - range, eye[2] - range, eye[0] + range, eye[2] + range, it => {
            if (kind && it.kind !== kind) return;
            const d = it.distance(eye);
            if (d < range && it.seenFrom(eye, planes)) out.push([d, it]);
        });
        return out.sort((a, b) => a[0] - b[0]);
    }
}

return { Interior, InteriorIndex };
});
