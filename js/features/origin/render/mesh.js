'use strict';
// Meshes: building models from parts and packing them into one vertex / index buffer.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { VERTEX_FLOATS } = feature;

// Maps a Y-aligned part onto axis x / y / z (proper rotations, winding kept)
const ORIENT = {
    x: v => [v[1], -v[0], v[2]],
    y: v => v,
    z: v => [v[0], -v[2], v[1]],
};

class MeshBuilder {
    constructor() {
        this.v = [];                // VERTEX_FLOATS per vertex: position, normal, material
        this.idx = [];
    }

    get count() { return this.v.length / VERTEX_FLOATS; }

    vert(p, n, m) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], m); return this.count - 1; }
    tri(a, b, c) { this.idx.push(a, b, c); }

    // s = full sizes; faces wound counter-clockwise seen from outside
    box(c, s, m) {
        const h = [s[0] / 2, s[1] / 2, s[2] / 2];
        const faces = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
        for (const [a, sg, ui, vi] of faces) {
            const n = [0, 0, 0]; n[a] = sg;
            const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
                const p = [0, 0, 0]; p[a] = sg * h[a]; p[ui] = su * h[ui]; p[vi] = sv * h[vi];
                return this.vert(v3.add(c, p), n, m);
            });
            this.tri(ids[0], ids[1], ids[2]); this.tri(ids[0], ids[2], ids[3]);
        }
    }

    // cylinder / cone along `axis`: radius r at -h/2, r2 at +h/2
    cyl(c, r, h, m, { axis = 'y', seg = 16, r2 = r } = {}) {
        const R = ORIENT[axis], P = p => v3.add(c, R(p)), hh = h / 2, slope = (r - r2) / h, base = this.count;
        for (let j = 0; j <= seg; j++) {
            const a = j / seg * Math.PI * 2, x = Math.cos(a), z = Math.sin(a), n = R(v3.norm([x, slope, z]));
            this.vert(P([x * r, -hh, z * r]), n, m);
            this.vert(P([x * r2, hh, z * r2]), n, m);
        }
        for (let j = 0; j < seg; j++) { const i = base + j * 2; this.tri(i, i + 1, i + 3); this.tri(i, i + 3, i + 2); }
        for (const [y, rr, sg] of [[-hh, r, -1], [hh, r2, 1]]) {
            if (rr <= 0) continue;
            const n = R([0, sg, 0]), ctr = this.vert(P([0, y, 0]), n, m), b = this.count;
            for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2; this.vert(P([Math.cos(a) * rr, y, Math.sin(a) * rr]), n, m); }
            for (let j = 0; j < seg; j++) sg > 0 ? this.tri(ctr, b + j + 1, b + j) : this.tri(ctr, b + j, b + j + 1);
        }
    }

    sphere(c, r, m, seg = 16) {
        const rings = Math.max(4, seg >> 1), base = this.count;
        for (let i = 0; i <= rings; i++) {
            const th = i / rings * Math.PI;
            for (let j = 0; j <= seg; j++) {
                const ph = j / seg * Math.PI * 2, n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
                this.vert(v3.madd(c, n, r), n, m);
            }
        }
        for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
            const a = base + i * (seg + 1) + j, b = a + seg + 1;
            this.tri(a, a + 1, b); this.tri(a + 1, b + 1, b);
        }
    }

    torus(c, R0, r, m, { axis = 'y', seg = [48, 8] } = {}) {
        const O = ORIENT[axis], [su, sv] = seg, base = this.count;
        for (let i = 0; i <= su; i++) {
            const a = i / su * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
            for (let j = 0; j <= sv; j++) {
                const b = j / sv * Math.PI * 2, cb = Math.cos(b), sb = Math.sin(b);
                this.vert(v3.add(c, O([ca * (R0 + r * cb), r * sb, sa * (R0 + r * cb)])), O([ca * cb, sb, sa * cb]), m);
            }
        }
        for (let i = 0; i < su; i++) for (let j = 0; j < sv; j++) {
            const a = base + i * (sv + 1) + j, b = a + sv + 1;
            this.tri(a, b, a + 1); this.tri(a + 1, b, b + 1);
        }
    }

    // icosphere with shared vertices; the vertex shader roughens it per instance (seeded noise)
    rock(c, r, m, detail = 1) {
        const t = (1 + Math.sqrt(5)) / 2;
        const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v3.norm);
        let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        for (let d = 0; d < detail; d++) {
            const cache = new Map(), next = [];
            const mid = (a, b) => {
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                if (!cache.has(key)) { cache.set(key, verts.length); verts.push(v3.norm(v3.lerp(verts[a], verts[b], 0.5))); }
                return cache.get(key);
            };
            for (const [a, b, cc] of faces) {
                const ab = mid(a, b), bc = mid(b, cc), ca = mid(cc, a);
                next.push([a, ab, ca], [b, bc, ab], [cc, ca, bc], [ab, bc, ca]);
            }
            faces = next;
        }
        const base = this.count;
        for (const n of verts) this.vert(v3.madd(c, n, r), n, m);
        for (const [a, b, cc] of faces) this.tri(base + a, base + b, base + cc);
    }
}

// All models packed into one vertex / index buffer
class Model {
    constructor(name, parts, materials) {
        this.name = name;
        this.instances = [];
        this.first = 0;             // first instance slot, set when the instance buffer is built
        const b = new MeshBuilder();
        for (const p of parts) {
            const m = materials.index(p.mat);
            if (p.box) b.box(p.box.slice(0, 3), p.box.slice(3, 6), m);
            else if (p.cyl) b.cyl(p.cyl.slice(0, 3), p.cyl[3], p.cyl[4], m, { axis: p.axis || 'y', seg: p.seg || 16, r2: p.r2 ?? p.cyl[3] });
            else if (p.sphere) b.sphere(p.sphere.slice(0, 3), p.sphere[3], m, p.seg || 16);
            else if (p.torus) b.torus(p.torus.slice(0, 3), p.torus[3], p.torus[4], m, { axis: p.axis || 'y', seg: p.seg || [48, 8] });
            else if (p.rock) b.rock(p.rock.slice(0, 3), p.rock[3], m, p.detail ?? 1);
            else throw new Error(`model "${name}": unknown part ${JSON.stringify(p)}`);
        }
        this.builder = b;
        let r = 0;
        for (let i = 0; i < b.v.length; i += VERTEX_FLOATS) r = Math.max(r, Math.hypot(b.v[i], b.v[i + 1], b.v[i + 2]));
        this.radius = r;
    }
}

class GeometryPool {
    constructor(models) {
        let nv = 0, ni = 0;
        for (const m of models) { nv += m.builder.count; ni += m.builder.idx.length; }
        this.vertices = new ArrayBuffer(nv * VERTEX_FLOATS * 4);
        this.indices = new Uint32Array(ni);
        const f = new Float32Array(this.vertices), u = new Uint32Array(this.vertices);
        let v = 0, i = 0;
        for (const m of models) {
            const b = m.builder;
            for (let k = 0; k < b.v.length; k += VERTEX_FLOATS) {
                const o = (v + k / VERTEX_FLOATS) * VERTEX_FLOATS;
                for (let j = 0; j < 6; j++) f[o + j] = b.v[k + j];
                u[o + 6] = b.v[k + 6];
            }
            m.firstIndex = i;
            m.indexCount = b.idx.length;
            for (const x of b.idx) this.indices[i++] = x + v;
            v += b.count;
            m.builder = null;
        }
    }
}

return { MeshBuilder, Model, GeometryPool };
});
