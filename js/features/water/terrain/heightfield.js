'use strict';
// The CPU heightfield: authored by entities, edited by tools, uploaded to the GPU by dirty rectangle;
// and the flood fill that finds where standing water reaches.

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

// 4-connected flood fill of every cell below `level` reachable from the seeds; sets depth to the level
function floodFill(field, water, seeds, level) {
    const n = field.n, h = field.h, seen = new Uint8Array(n * n), stack = [];
    for (const s of seeds) if (h[s] < level && !seen[s]) { seen[s] = 1; stack.push(s); }
    let count = 0;
    while (stack.length) {
        const idx = stack.pop(), i = idx % n, j = (idx - i) / n;
        water[idx] = Math.max(water[idx], level - h[idx]);
        count++;
        const nb = [i > 0 ? idx - 1 : -1, i < n - 1 ? idx + 1 : -1, j > 0 ? idx - n : -1, j < n - 1 ? idx + n : -1];
        for (const q of nb) if (q >= 0 && !seen[q] && h[q] < level) { seen[q] = 1; stack.push(q); }
    }
    return count;
}

return { Heightfield, floodFill };
});
