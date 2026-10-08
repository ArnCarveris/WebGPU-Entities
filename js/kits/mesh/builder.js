'use strict';
// MeshBuilder: the reference builder of the common mesh interface (triangles with a position, normal and material
// each), splitting one by a plane, and the bounds of a placed box.

Features.kit('mesh', (engine, kit) => {
const { Common } = engine;
const { v3, m4 } = Common;
const { newell, planeDist, AXES } = kit;

// Triangles as data: vertex = pos(3) normal(3) material(1), indexed. `resolve` turns a material reference (what entities
// pass: a scenario material name, { color, kind }...) into the vertex's material value; a number is taken as it is.
// `models(builder, name, M)` adds a scenario model's parts (the world's: World.addModel). While `M` is set, every
// vertex goes through it. min / max: the bounds of what was added.
class MeshBuilder {
    constructor(resolve = m => m, models = null) {
        this.data = []; this.idx = []; this.count = 0; this.M = null;
        this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity];
        this.resolve = resolve;
        this.models = models;
    }
    mat(m) { return typeof m === 'number' ? m : this.resolve(m); }
    vert(p, n, m) {
        if (this.M) { p = m4.point(this.M, p); n = v3.norm(m4.dir(this.M, n)); }
        this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], m);
        for (let k = 0; k < 3; k++) { if (p[k] < this.min[k]) this.min[k] = p[k]; if (p[k] > this.max[k]) this.max[k] = p[k]; }
        return this.count++;
    }
    // convex polygon; winding is fixed to face n (no n: its Newell normal)
    poly(pts, n, m) {
        if (pts.length < 3) return;
        const nw = newell(pts);
        if (v3.len(nw) < 1e-9) return;
        if (!n) n = v3.norm(nw);
        m = this.mat(m);
        const flip = v3.dot(nw, n) < 0, base = this.count;
        for (const p of pts) this.vert(p, n, m);
        for (let k = 1; k < pts.length - 1; k++) {
            if (flip) this.idx.push(base, base + k + 1, base + k); else this.idx.push(base, base + k, base + k + 1);
        }
    }
    quad(a, b, c, d, m) { this.poly([a, b, c, d], null, m); }
    tri(a, b, c, m) { this.poly([a, b, c], null, m); }
    // box at c with axes ax (unit) and half sizes h
    box(c, ax, h, m) {
        m = this.mat(m);
        for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
            const j = (i + 1) % 3, k = (i + 2) % 3, n = v3.mul(ax[i], s), fc = v3.madd(c, n, h[i]);
            const J = v3.mul(ax[j], h[j]), K = v3.mul(ax[k], h[k]);
            this.poly([v3.sub(v3.sub(fc, J), K), v3.sub(v3.add(fc, J), K), v3.add(v3.add(fc, J), K), v3.add(v3.sub(fc, J), K)], n, m);
        }
    }
    // axis-aligned box from min to max
    cuboid(lo, hi, m) {
        this.box([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], AXES, [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2], m);
    }
    cylinder(b, r, h, seg, m) {
        m = this.mat(m);
        const top = [], bot = [];
        for (let i = 0; i < seg; i++) {
            const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
            const p0 = [b[0] + Math.cos(a0) * r, b[1], b[2] + Math.sin(a0) * r], p1 = [b[0] + Math.cos(a1) * r, b[1], b[2] + Math.sin(a1) * r];
            this.poly([p0, p1, [p1[0], b[1] + h, p1[2]], [p0[0], b[1] + h, p0[2]]], [Math.cos(am), 0, Math.sin(am)], m);
            top.push([p0[0], b[1] + h, p0[2]]); bot.push(p0);
        }
        this.poly(top, [0, 1, 0], m); this.poly(bot, [0, -1, 0], m);
    }
    cone(b, r, h, seg, m) {
        m = this.mat(m);
        const apex = [b[0], b[1] + h, b[2]], bot = [];
        for (let i = 0; i < seg; i++) {
            const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
            const p0 = [b[0] + Math.cos(a0) * r, b[1], b[2] + Math.sin(a0) * r], p1 = [b[0] + Math.cos(a1) * r, b[1], b[2] + Math.sin(a1) * r];
            this.poly([p0, p1, apex], v3.norm([Math.cos(am) * h, r, Math.sin(am) * h]), m);
            bot.push(p0);
        }
        this.poly(bot, [0, -1, 0], m);
    }
    // a scenario model's parts, placed with matrix M
    model(name, M) {
        if (!this.models) throw new Error('this world\'s meshes take no scenario models');
        this.models(this, name, M);
    }
    finish() { return this; }
}

// Split a MeshBuilder by a plane [nx, ny, nz, d] into [negative side, positive side].
// Straddling triangles are clipped; position and normal are interpolated, winding is kept.
function splitMesh(b, plane) {
    const neg = new MeshBuilder(b.resolve, b.models), pos = new MeshBuilder(b.resolve, b.models), eps = 1e-5;
    const V = i => ({ p: [b.data[i * 7], b.data[i * 7 + 1], b.data[i * 7 + 2]], n: [b.data[i * 7 + 3], b.data[i * 7 + 4], b.data[i * 7 + 5]], m: b.data[i * 7 + 6] });
    const emit = (dst, verts) => {
        if (verts.length < 3) return;
        const base = dst.count;
        for (const v of verts) dst.vert(v.p, v.n, v.m);
        for (let k = 1; k < verts.length - 1; k++) dst.idx.push(base, base + k, base + k + 1);
    };
    const clip = (tri, ds, sign) => {
        const out = [];
        for (let i = 0; i < 3; i++) {
            const a = tri[i], c = tri[(i + 1) % 3], da = ds[i] * sign, dc = ds[(i + 1) % 3] * sign;
            if (da >= 0) out.push(a);
            if ((da >= 0) !== (dc >= 0)) {
                const t = da / (da - dc);
                out.push({ p: v3.lerp(a.p, c.p, t), n: v3.norm(v3.lerp(a.n, c.n, t)), m: a.m });
            }
        }
        return out;
    };
    for (let t = 0; t < b.idx.length; t += 3) {
        const tri = [V(b.idx[t]), V(b.idx[t + 1]), V(b.idx[t + 2])], ds = tri.map(v => planeDist(plane, v.p));
        if (ds.every(d => d <= eps)) emit(neg, tri);
        else if (ds.every(d => d >= -eps)) emit(pos, tri);
        else { emit(pos, clip(tri, ds, 1)); emit(neg, clip(tri, ds, -1)); }
    }
    return [neg, pos];
}

// World-space AABB of a box (anything with min / max: a chunk, a builder) placed with matrix `model`
function worldBounds(model, box) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
        const p = m4.point(model, [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    }
    return { min: mn, max: mx };
}

return { MeshBuilder, splitMesh, worldBounds };
});
