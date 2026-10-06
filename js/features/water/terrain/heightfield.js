'use strict';
// The CPU heightfield: authored by entities, edited by tools, uploaded to the GPU by dirty rectangle;
// and the flood fill that finds where standing water reaches.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { clamp, lerp, v3 } = Common;

// CPU copy of the terrain: authored by entities, edited by tools, uploaded to the GPU by dirty rectangle.
// Cell (i, j) centre sits at (origin + (i + 0.5) * cell, origin + (j + 0.5) * cell); i runs along x, j along z.
class Heightfield {
    constructor(size, n, base) {
        this.size = size;
        this.n = n;
        this.cell = size / n;
        this.origin = -size / 2;
        this.h = new Float32Array(n * n).fill(base);
        this.dirty = null;
        this.min = base;
        this.max = base;
    }

    cx(i) { return this.origin + (i + 0.5) * this.cell; }
    ci(x) { return (x - this.origin) / this.cell - 0.5; }

    // calls fn(idx, x, z, i, j) for every cell centre inside the world-space box
    each(x0, z0, x1, z1, fn) {
        const n = this.n;
        const i0 = clamp(Math.floor(this.ci(x0)), 0, n - 1), i1 = clamp(Math.ceil(this.ci(x1)), 0, n - 1);
        const j0 = clamp(Math.floor(this.ci(z0)), 0, n - 1), j1 = clamp(Math.ceil(this.ci(z1)), 0, n - 1);
        for (let j = j0; j <= j1; j++) {
            const z = this.cx(j);
            for (let i = i0; i <= i1; i++) fn(j * n + i, this.cx(i), z, i, j);
        }
        return { i0, j0, i1, j1 };
    }

    eachAll(fn) { return this.each(-Infinity, -Infinity, Infinity, Infinity, fn); }

    sample(x, z) {
        const n = this.n, fx = clamp(this.ci(x), 0, n - 1), fz = clamp(this.ci(z), 0, n - 1);
        const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j, h = this.h;
        const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
        return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
    }

    touch(r) {
        const d = this.dirty;
        this.dirty = d ? { i0: Math.min(d.i0, r.i0), j0: Math.min(d.j0, r.j0), i1: Math.max(d.i1, r.i1), j1: Math.max(d.j1, r.j1) } : { ...r };
    }

    updateRange() {
        let lo = Infinity, hi = -Infinity;
        for (const v of this.h) { if (v < lo) lo = v; if (v > hi) hi = v; }
        this.min = lo;
        this.max = hi;
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

    // first hit of a ray with the heightfield, or null
    raycast(o, d, maxDist = 9000) {
        let t = 0, prev = 0;
        const above = t => { const p = v3.add(o, v3.mul(d, t)); return p[1] - this.sample(p[0], p[2]); };
        if (above(0) < 0) return null;
        while (t < maxDist) {
            const step = Math.max(this.cell * 0.5, t * 0.004);
            prev = t;
            t += step;
            const p = v3.add(o, v3.mul(d, t));
            if (Math.abs(p[0]) > this.size * 0.75 || Math.abs(p[2]) > this.size * 0.75) { if (p[1] < this.min) return null; continue; }
            if (above(t) < 0) {
                let a = prev, b = t;
                for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
                return v3.add(o, v3.mul(d, b));
            }
        }
        return null;
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
