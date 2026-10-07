'use strict';
// VisArea: the space an interior encloses, as a box in its origin's frame, and the portals (doors, windows, openings)
// it is seen through from outside.

Features.kit('interior', (engine, kit) => {
// A portal of a VisArea, in the area's frame: centre c, outward normal n, size w x h; kind door | window | opening.
// open() says whether it can be seen through now (a window's glass always can; a shut door cannot).
class VisPortal {
    constructor({ c, n, w, h, kind = 'opening', open = null }) {
        Object.assign(this, { c, n, w, h, kind });
        this.open = open || (() => true);
    }
}

// The box [lo, hi] in its origin's frame, and its portals. For culling, the portals are folded once into one aperture per
// wall they pierce (a box has at most six): a camera outside sees in only through a wall facing it, so the test is O(1)
// however many windows the walls have.
class VisArea {
    constructor(lo, hi, portals = []) {
        this.lo = lo;
        this.hi = hi;
        this.centre = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
        this.radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
        this.portals = portals.map(p => p instanceof VisPortal ? p : new VisPortal(p));
        this.walls = VisArea.walls(this.portals);
    }

    contains(q) {
        const { lo, hi } = this;
        return q[0] > lo[0] && q[0] < hi[0] && q[1] > lo[1] && q[1] < hi[1] && q[2] > lo[2] && q[2] < hi[2];
    }

    // one aperture per outward direction: the bounds of its portals (centre c, bounding radius r, normal n); `glass` when
    // one of them is a window or an opening (always seen through), else its doors are asked
    static walls(portals) {
        const by = new Map();
        for (const p of portals) {
            const key = p.n.map(v => Math.round(v * 8)).join(',');
            let w = by.get(key);
            if (!w) by.set(key, w = { n: p.n, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], glass: false, doors: [] });
            const r = Math.hypot(p.w, p.h) / 2;
            for (let k = 0; k < 3; k++) { w.lo[k] = Math.min(w.lo[k], p.c[k] - r); w.hi[k] = Math.max(w.hi[k], p.c[k] + r); }
            if (p.kind === 'door') w.doors.push(p); else w.glass = true;
        }
        return [...by.values()].map(w => ({
            n: w.n, glass: w.glass, doors: w.doors,
            c: [0, 1, 2].map(k => (w.lo[k] + w.hi[k]) / 2), r: Math.hypot(w.hi[0] - w.lo[0], w.hi[1] - w.lo[1], w.hi[2] - w.lo[2]) / 2,
        }));
    }
}

return { VisPortal, VisArea };
});
