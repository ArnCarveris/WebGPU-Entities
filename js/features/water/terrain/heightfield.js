'use strict';
// The CPU heightfield: authored by entities, edited by tools, uploaded to the GPU by dirty rectangle.

Features.part('water', (engine, feature) => {
const { kits } = engine;

// The terrain (kits.terrain's Heightfield): authored by entities, edited by tools, uploaded to the GPU by dirty
// rectangle (touch). It ends at the grid's edge: rays step over what lies well beyond it.
class Heightfield extends kits.terrain.Heightfield {
    constructor(size, n, base) {
        super(size, n, base, { reach: 9000 });
        this.dirty = null;
    }

    offMap(p) { return Math.abs(p[0]) > this.size * 0.75 || Math.abs(p[2]) > this.size * 0.75; }

    touch(r) {
        const d = this.dirty;
        this.dirty = d ? { i0: Math.min(d.i0, r.i0), j0: Math.min(d.j0, r.j0), i1: Math.max(d.i1, r.i1), j1: Math.max(d.j1, r.j1) } : { ...r };
    }

    // smooth bump (amount > 0) or dent (amount < 0) of radius r
    brush(x, z, r, amount) {
        const rect = this.each(x - r, z - r, x + r, z + r, (idx, cx, cz) => {
            const d = Math.hypot(cx - x, cz - z) / r;
            if (d < 1) this.h[idx] += amount * (1 - d * d) * (1 - d * d);
        });
        this.touch(rect);
        this.max = Math.max(this.max, this.h.reduce((m, v) => v > m ? v : m, -Infinity));
    }
}

return { Heightfield };
});
