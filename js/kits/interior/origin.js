'use strict';
// Origin: the local frame an interior is authored in (a building's footprint, a vehicle's body), and the spatial hash
// interiors are found by.

Features.kit('interior', (engine, kit) => {
// A rigid frame (rotation + translation, column-major 4x4). `src` is the matrix, or a function returning the owner's
// current one (a vehicle re-poses every frame: its interior's origin reads the pose it already keeps, nothing is copied).
// Rigid, so world -> local is the transposed rotation: O(1), no inverse kept.
class Origin {
    constructor(src) {
        if (typeof src === 'function') Object.defineProperty(this, 'M', { get: src });
        else this.M = src || Origin.IDENTITY;
    }

    // a frame at (x, y, z) turned by its yaw as (cos, sin): local x along (cs, sn) in xz, local z along (-sn, cs)
    static yaw(x, y, z, cs, sn) { return new Origin([cs, 0, sn, 0, 0, 1, 0, 0, -sn, 0, cs, 0, x, y, z, 1]); }

    get moving() { return Object.getOwnPropertyDescriptor(this, 'M')?.get !== undefined; }

    toWorld(q, w = 1) {
        const m = this.M;
        return [m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12] * w, m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13] * w, m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14] * w];
    }

    toLocal(p, w = 1) {
        const m = this.M, x = p[0] - m[12] * w, y = p[1] - m[13] * w, z = p[2] - m[14] * w;
        return [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
    }
}
Origin.IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// A uniform hash grid over xz: each item sits in the cells its [x0, z0, x1, z1] rectangle covers, so a point finds the
// few items around it in O(1) whatever the world holds, and a range query costs the cells it covers. Items that move
// re-bucket only when their rectangle crosses into other cells.
class GridHash {
    constructor(cell = 32) {
        this.cell = cell;
        this.cells = new Map();
        this.spans = new Map();          // item -> [i0, j0, i1, j1]
        this.size = 0;
    }

    static key(i, j) { return (i + 0x8000) * 0x10000 + (j + 0x8000); }

    span(x0, z0, x1, z1) { const c = this.cell; return [Math.floor(x0 / c), Math.floor(z0 / c), Math.floor(x1 / c), Math.floor(z1 / c)]; }

    insert(item, x0, z0, x1, z1) {
        const s = this.span(x0, z0, x1, z1);
        this.spans.set(item, s);
        this.size++;
        for (let j = s[1]; j <= s[3]; j++) for (let i = s[0]; i <= s[2]; i++) {
            const k = GridHash.key(i, j), list = this.cells.get(k);
            if (list) list.push(item); else this.cells.set(k, [item]);
        }
    }

    remove(item) {
        const s = this.spans.get(item);
        if (!s) return;
        this.spans.delete(item);
        this.size--;
        for (let j = s[1]; j <= s[3]; j++) for (let i = s[0]; i <= s[2]; i++) {
            const k = GridHash.key(i, j), list = this.cells.get(k), at = list.indexOf(item);
            if (at >= 0) list.splice(at, 1);
            if (!list.length) this.cells.delete(k);
        }
    }

    // a moved item: nothing to do while it stays in the same cells
    move(item, x0, z0, x1, z1) {
        const s = this.spans.get(item), n = this.span(x0, z0, x1, z1);
        if (s && s[0] === n[0] && s[1] === n[1] && s[2] === n[2] && s[3] === n[3]) return;
        this.remove(item);
        this.insert(item, x0, z0, x1, z1);
    }

    // the items whose cells hold (x, z)
    at(x, z) { return this.cells.get(GridHash.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) || GridHash.NONE; }

    // the items in the cells at Chebyshev distance k (in cells) from cell (ci, cj): a ring, for nearest-first searches
    ring(ci, cj, k, fn) {
        const visit = (i, j) => { const list = this.cells.get(GridHash.key(i, j)); if (list) for (const it of list) fn(it); };
        if (k === 0) { visit(ci, cj); return; }
        for (let i = ci - k; i <= ci + k; i++) { visit(i, cj - k); visit(i, cj + k); }
        for (let j = cj - k + 1; j < cj + k; j++) { visit(ci - k, j); visit(ci + k, j); }
    }

    // each item whose cells meet the rectangle, once
    each(x0, z0, x1, z1, fn) {
        const s = this.span(x0, z0, x1, z1), seen = new Set();
        for (let j = s[1]; j <= s[3]; j++) for (let i = s[0]; i <= s[2]; i++) {
            const list = this.cells.get(GridHash.key(i, j));
            if (list) for (const it of list) if (!seen.has(it)) { seen.add(it); fn(it); }
        }
    }
}
GridHash.NONE = Object.freeze([]);

return { Origin, GridHash };
});
