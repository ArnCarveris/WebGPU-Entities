'use strict';
// Continuous distance-dependent LOD (CDLOD, Strugar 2010) for drawing a heightfield: a quadtree of square nodes about the
// heightfield's centre, picked each frame by distance from the eye, each drawn as the same patch of PATCH x PATCH cells.

Features.kit('terrain', (engine, kit) => {
const { clamp } = engine.Common;

const PATCH = 16;               // cells a side of the patch every node is drawn as
const MAX_NODES = 8192;         // nodes drawn a frame

// The patch's vertex index of cell corner (i, j); its triangles (a, c, b) and (b, c, d), split along b-c, ordered by
// quadrant (q = 0..3: x low/high, then z low/high) so a node can draw one quadrant alone (its first index q * QUARTER)
const patchIndices = () => {
    const N = PATCH + 1, H = PATCH / 2, out = new Uint32Array(PATCH * PATCH * 6);
    let k = 0;
    for (let q = 0; q < 4; q++) {
        const i0 = (q & 1) * H, j0 = (q >> 1) * H;
        for (let j = j0; j < j0 + H; j++) for (let i = i0; i < i0 + H; i++) {
            const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
            out[k++] = a; out[k++] = c; out[k++] = b;
            out[k++] = b; out[k++] = c; out[k++] = d;
        }
    }
    return out;
};

// LOD for a heightfield (field: n, cell, origin, size, base, h, rough; beyond the map easing to its base level). The
// finest nodes have vertices step m apart (default 1 m with procedural detail, else a quarter of a data cell: finer
// adds nothing to smooth heights); lod k's nodes are leaf * 2^k a side and kept within range(k) = range0 * 2^k of the
// eye, and within the last 25% of that range morph into the next lod's grid (vsTerrain), so neighbours meet without
// cracks or popping. detail (>= 1) scales range0: more of the view at each lod.
class TerrainLod {
    constructor(field, { step, detail = 1, ease = 20000 } = {}) {
        this.field = field;
        this.step = step || (field.rough > 0 ? 1 : field.cell / 4);
        this.leaf = PATCH * this.step;
        this.range0 = 4 * this.leaf * Math.max(1, detail);
        this.ease = ease;
        this.centre = field.origin + field.size / 2;
        this.nodes = new Float32Array(MAX_NODES * 4);
        this.draws = [];        // [firstIndex quarter (0 whole, 1..4 quadrant q + 1), firstInstance, count]
        this.count = 0;
        this.buildBounds();
    }

    // min / max mips of the heights (each level halves the last)
    buildBounds() {
        const f = this.field;
        let n = f.n, lo = Float32Array.from(f.h), hi = Float32Array.from(f.h);
        this.mips = [{ n, lo, hi }];
        while (n > 1) {
            const m = Math.ceil(n / 2), l2 = new Float32Array(m * m), h2 = new Float32Array(m * m);
            for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
                let a = Infinity, b = -Infinity;
                for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
                    const x = Math.min(2 * i + di, n - 1), z = Math.min(2 * j + dj, n - 1), k = z * n + x;
                    if (lo[k] < a) a = lo[k];
                    if (hi[k] > b) b = hi[k];
                }
                l2[j * m + i] = a; h2[j * m + i] = b;
            }
            n = m; lo = l2; hi = h2;
            this.mips.push({ n, lo, hi });
        }
        this.all = [this.mips.at(-1).lo[0], this.mips.at(-1).hi[0]];
    }

    // the lowest and highest terrain over the square x0..x1, z0..z1
    bounds(x0, z0, x1, z1) {
        const f = this.field, e0 = f.origin, e1 = f.origin + f.size;
        let lo = Infinity, hi = -Infinity;
        if (x1 > e0 && x0 < e1 && z1 > e0 && z0 < e1) {
            const n = f.n, i0 = clamp(Math.floor(f.ci(x0)), 0, n - 1), i1 = clamp(Math.ceil(f.ci(x1)), 0, n - 1);
            const j0 = clamp(Math.floor(f.ci(z0)), 0, n - 1), j1 = clamp(Math.ceil(f.ci(z1)), 0, n - 1);
            let m = 0;
            while (((Math.max(i1 - i0, j1 - j0)) >> m) > 2) m++;
            const L = this.mips[m];
            for (let j = j0 >> m; j <= j1 >> m; j++) for (let i = i0 >> m; i <= i1 >> m; i++) {
                const k = j * L.n + i;
                if (L.lo[k] < lo) lo = L.lo[k];
                if (L.hi[k] > hi) hi = L.hi[k];
            }
        }
        if (x0 < e0 || x1 > e1 || z0 < e0 || z1 > e1) {
            // beyond the map: its base, and near it the edge heights easing back to it
            lo = Math.min(lo, f.base); hi = Math.max(hi, f.base);
            if (x1 > e0 - this.ease && x0 < e1 + this.ease && z1 > e0 - this.ease && z0 < e1 + this.ease) {
                lo = Math.min(lo, this.all[0]); hi = Math.max(hi, this.all[1]);
            }
        }
        // the bicubic heights overshoot the data a little at sharp breaks, and the detail lifts and sinks it
        const pad = 0.15 * (hi - lo) + 4 * (this.field.rough || 0);
        return [lo - pad, hi + pad];
    }

    // The nodes to draw for an eye at cam (world), out to reach m, inside planes (render-space frustum planes; boxes
    // sink far * far / 2R towards the horizon on a planet of radius R, as drawn): this.nodes (x0, z0, size, lod each),
    // grouped into this.draws. Returns the node count.
    select(cam, planes, reach, R = 6371000) {
        const c = this.centre, off = Math.max(Math.abs(cam[0] - c), Math.abs(cam[2] - c));
        const top = Math.max(0, Math.ceil(Math.log2(2 * (reach + off) / this.leaf)));
        const root = this.leaf * 2 ** top, lists = [[], [], [], [], []];
        const dist = (x0, z0, s, lo, hi) => {
            const dx = Math.max(x0 - cam[0], 0, cam[0] - x0 - s), dz = Math.max(z0 - cam[2], 0, cam[2] - z0 - s);
            const dy = Math.max(lo - cam[1], 0, cam[1] - hi);
            return Math.hypot(dx, dy, dz);
        };
        const seen = (x0, z0, s, lo, hi) => {
            const far = Math.hypot(Math.max(Math.abs(cam[0] - x0), Math.abs(cam[0] - x0 - s)), Math.max(Math.abs(cam[2] - z0), Math.abs(cam[2] - z0 - s)));
            const a = [x0, lo - far * far / (2 * R), z0], b = [x0 + s, hi, z0 + s];
            return !planes.some(p => p[0] * (p[0] > 0 ? b[0] : a[0]) + p[1] * (p[1] > 0 ? b[1] : a[1]) + p[2] * (p[2] > 0 ? b[2] : a[2]) + p[3] < 0);
        };
                // whether the node (x0, z0) of lod k is drawn (by itself or its children); false: out of its range, its parent
        // draws its square
        const visit = (x0, z0, k) => {
            const s = this.leaf * 2 ** k, [lo, hi] = this.bounds(x0, z0, x0 + s, z0 + s), d = dist(x0, z0, s, lo, hi);
            if (d > this.range0 * 2 ** k) return false;
            if (d > reach) return true;
            if (k === 0 || d > this.range0 * 2 ** (k - 1)) { if (seen(x0, z0, s, lo, hi)) lists[0].push(x0, z0, s, k); return true; }
            const h = s / 2;
            for (let q = 0; q < 4; q++) {
                const cx = x0 + (q & 1) * h, cz = z0 + (q >> 1) * h;
                // the quadrant at this lod: this node's patch, its quarter q (drawn from cx, cz's node origin x0, z0)
                if (!visit(cx, cz, k - 1)) {
                    const [ql, qh] = this.bounds(cx, cz, cx + h, cz + h);
                    if (seen(cx, cz, h, ql, qh)) lists[q + 1].push(x0, z0, s, k);
                }
            }
            return true;
        };
        visit(c - root / 2, c - root / 2, top);
        this.draws = [];
        let n = 0;
        lists.forEach((l, q) => {
            const m = Math.min(l.length / 4, MAX_NODES - n);
            if (!m) return;
            this.nodes.set(l.slice(0, m * 4), n * 4);
            this.draws.push([q, n, m]);
            n += m;
        });
        this.top = top;
        return (this.count = n);
    }
}

return { TerrainLod, TERRAIN_PATCH: PATCH, TERRAIN_MAX_NODES: MAX_NODES, terrainPatchIndices: patchIndices };
});
