'use strict';
// A CPU heightfield: a square grid of heights, authored by entities.

Features.kit('terrain', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp, v3 } = Common;

// Heights on an n x n grid over a `size` m square centred on the origin. Cell (i, j) centre sits at
// (origin + (i + 0.5) * cell, origin + (j + 0.5) * cell); i runs along x, j along z. A feature extends it with what
// else its terrain holds (land use, a dirty rectangle for uploads...) and how it reaches the GPU.
class Heightfield {
    // reach: how far (m) raycast() looks by default
    constructor(size, n, base, { reach = 150000 } = {}) {
        this.size = size;
        this.n = n;
        this.cell = size / n;
        this.origin = -size / 2;
        this.base = base;
        this.h = new Float32Array(n * n).fill(base);
        this.min = base;
        this.max = base;
        this.reach = reach;
    }

    cx(i) { return this.origin + (i + 0.5) * this.cell; }
    ci(x) { return (x - this.origin) / this.cell - 0.5; }

    // calls fn(idx, x, z, i, j) for every cell centre inside the world-space box; returns the cells' rectangle
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

    // bilinear height at x, z (the edge cells beyond the grid)
    sample(x, z) {
        const n = this.n, fx = clamp(this.ci(x), 0, n - 1), fz = clamp(this.ci(z), 0, n - 1);
        const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j, h = this.h;
        return lerp(lerp(h[j * n + i], h[j * n + i + 1], tx), lerp(h[(j + 1) * n + i], h[(j + 1) * n + i + 1], tx), tz);
    }

    // unit normal of cell (i, j) from its neighbours' heights
    normal(i, j) {
        const n = this.n, h = this.h, c2 = this.cell * 2;
        const l = h[j * n + Math.max(i - 1, 0)], r = h[j * n + Math.min(i + 1, n - 1)];
        const u = h[Math.max(j - 1, 0) * n + i], d = h[Math.min(j + 1, n - 1) * n + i];
        return v3.norm([(l - r) / c2, 1, (u - d) / c2]);
    }

    updateRange() {
        let lo = Infinity, hi = -Infinity;
        for (const v of this.h) { if (v < lo) lo = v; if (v > hi) hi = v; }
        this.min = lo;
        this.max = hi;
    }

    // whether raycast() steps over p without testing it (a feature whose terrain ends at the grid says so)
    offMap(p) { return false; }

    // first hit of a ray with the heightfield, or null
    raycast(o, d, maxDist = this.reach) {
        const above = t => { const p = v3.add(o, v3.mul(d, t)); return p[1] - this.sample(p[0], p[2]); };
        if (above(0) < 0) return null;
        let t = 0, prev = 0;
        while (t < maxDist) {
            prev = t;
            t += Math.max(this.cell * 0.5, t * 0.004);
            const p = v3.add(o, v3.mul(d, t));
            if (this.offMap(p)) { if (p[1] < this.min) return null; continue; }
            if (above(t) < 0) {
                let a = prev, b = t;
                for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
                return v3.add(o, v3.mul(d, b));
            }
            if (p[1] > this.max + 100 && d[1] >= 0) return null;
        }
        return null;
    }
}

return { Heightfield };
});
