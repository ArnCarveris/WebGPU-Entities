'use strict';
// Collision: segments and boxes the player slides along.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;

// CollisionSet: walkable floors (triangles) and walls (XZ segments with a height range) taken
// from the scene triangles, hashed on a 2D grid. Vehicles keep their own set in vehicle space.

function pushSeg(p, r, lo, hi, s) {
    if (s.y1 <= lo || s.y0 >= hi) return;
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((p[0] - s.x0) * dx + (p[2] - s.z0) * dz) / L2));
    const qx = s.x0 + dx * t, qz = s.z0 + dz * t;
    let ex = p[0] - qx, ez = p[2] - qz;
    const d = Math.hypot(ex, ez);
    if (d >= r) return;
    if (d < 1e-6) { const L = Math.sqrt(L2); ex = -dz / L; ez = dx / L; } else { ex /= d; ez /= d; }
    p[0] = qx + ex * r; p[2] = qz + ez * r;
}
class CollisionSet {
    constructor(cell = 2) { this.cell = cell; this.floors = new Map(); this.walls = new Map(); this.nFloors = 0; this.nWalls = 0; }
    key(x, z) { return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell); }
    each(x0, z0, x1, z1, fn) {
        const c = this.cell;
        for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) fn(i * 100003 + j);
    }
    put(map, k, item) { let l = map.get(k); if (!l) map.set(k, l = []); l.push(item); }
    addTri(a, b, c) {
        const n = v3.cross(v3.sub(b, a), v3.sub(c, a)), l = v3.len(n);
        if (l < 1e-8) return;
        const ny = n[1] / l;
        if (ny > 0.55) {
            const f = { a, b, c };
            this.each(Math.min(a[0], b[0], c[0]), Math.min(a[2], b[2], c[2]), Math.max(a[0], b[0], c[0]), Math.max(a[2], b[2], c[2]), k => this.put(this.floors, k, f));
            this.nFloors++;
        } else if (Math.abs(ny) < 0.55) {
            const h = Math.hypot(n[0], n[2]), nx = n[0] / h, nz = n[2] / h, tx = -nz, tz = nx;
            let s0 = Infinity, s1 = -Infinity, o = 0, y0 = Infinity, y1 = -Infinity;
            for (const q of [a, b, c]) { const t = q[0] * tx + q[2] * tz; s0 = Math.min(s0, t); s1 = Math.max(s1, t); o += (q[0] * nx + q[2] * nz) / 3; y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
            if (s1 - s0 < 1e-3) return;
            const seg = { x0: tx * s0 + nx * o, z0: tz * s0 + nz * o, x1: tx * s1 + nx * o, z1: tz * s1 + nz * o, y0, y1 }, m = 0.5;
            this.each(Math.min(seg.x0, seg.x1) - m, Math.min(seg.z0, seg.z1) - m, Math.max(seg.x0, seg.x1) + m, Math.max(seg.z0, seg.z1) + m, k => this.put(this.walls, k, seg));
            this.nWalls++;
        }
    }
    ground(x, z, maxY) {
        const l = this.floors.get(this.key(x, z));
        let best = -Infinity;
        if (l) for (const { a, b, c } of l) {
            const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
            if (Math.abs(d) < 1e-9) continue;
            const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const y = w0 * a[1] + w1 * b[1] + w2 * c[1];
            if (y <= maxY && y > best) best = y;
        }
        return best;
    }
    pushOut(p, r, lo, hi) {
        const l = this.walls.get(this.key(p[0], p[2]));
        if (l) for (let it = 0; it < 2; it++) for (const s of l) pushSeg(p, r, lo, hi, s);
    }
}

return { pushSeg, CollisionSet };
});
