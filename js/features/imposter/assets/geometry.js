'use strict';
// Geometry: part shapes and the mesh builder that merges them per material.

Features.part('imposter', (engine, feature) => {
const { Common, kits } = engine;
const { v3 } = Common;
const { seededRandom, valueNoise3 } = kits.noise;
const { VF, m4 } = feature;

// Geo: a shape in its own space (positions, normals, uv in metres, indices; CCW = front)
class Geo {
    constructor() { this.p = []; this.n = []; this.uv = []; this.idx = []; }
    get count() { return this.p.length / 3; }
    vert(p, n, uv) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.uv.push(uv[0], uv[1]); return this.count - 1; }
    tri(a, b, c) { this.idx.push(a, b, c); }
    quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
    P(i) { return [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]]; }
    N(i) { return [this.n[i * 3], this.n[i * 3 + 1], this.n[i * 3 + 2]]; }
    // flat polygon (convex, fan-triangulated) facing away from `inside`
    poly(pts, inside) {
        let n = v3.norm(v3.cross(v3.sub(pts[1], pts[0]), v3.sub(pts[2], pts[0])));
        const c = v3.mul(pts.reduce((a, p) => v3.add(a, p), [0, 0, 0]), 1 / pts.length);
        if (v3.dot(n, v3.sub(c, inside)) < 0) { pts = pts.slice().reverse(); n = v3.mul(n, -1); }
        const t1 = v3.norm(v3.sub(pts[1], pts[0])), t2 = v3.cross(n, t1), b = this.count;
        for (const p of pts) { const q = v3.sub(p, pts[0]); this.vert(p, n, [v3.dot(q, t1), -v3.dot(q, t2)]); }
        for (let i = 1; i + 1 < pts.length; i++) this.tri(b, b + i, b + i + 1);
    }
    smoothNormals() {
        const acc = new Float64Array(this.p.length);
        for (let i = 0; i < this.idx.length; i += 3) {
            const [a, b, c] = [this.idx[i], this.idx[i + 1], this.idx[i + 2]];
            const fn = v3.cross(v3.sub(this.P(b), this.P(a)), v3.sub(this.P(c), this.P(a)));
            for (const k of [a, b, c]) { acc[k * 3] += fn[0]; acc[k * 3 + 1] += fn[1]; acc[k * 3 + 2] += fn[2]; }
        }
        for (let i = 0; i < this.count; i++) {
            const n = v3.norm([acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]]);
            this.n[i * 3] = n[0]; this.n[i * 3 + 1] = n[1]; this.n[i * 3 + 2] = n[2];
        }
    }
    // make every triangle wind CCW around its vertex normals
    orient() {
        for (let i = 0; i < this.idx.length; i += 3) {
            const [a, b, c] = [this.idx[i], this.idx[i + 1], this.idx[i + 2]];
            const fn = v3.cross(v3.sub(this.P(b), this.P(a)), v3.sub(this.P(c), this.P(a)));
            if (v3.dot(fn, v3.add(v3.add(this.N(a), this.N(b)), this.N(c))) < 0) { this.idx[i + 1] = c; this.idx[i + 2] = b; }
        }
    }
}

const BOX_FACES = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];

// Part shapes: (part def) -> Geo. Each is built in its own space, then placed by the part's pos / rot / scale.
const SHAPES = {
    box(d) {
        const s = d.size || [1, 1, 1], h = [s[0] / 2, s[1] / 2, s[2] / 2], g = new Geo();
        for (const [n, u, v] of BOX_FACES) {
            const hn = Math.abs(v3.dot(h, n)), hu = Math.abs(v3.dot(h, u)), hv = Math.abs(v3.dot(h, v)), c = v3.mul(n, hn), b = g.count;
            for (const [a, e] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.vert(v3.add(c, v3.add(v3.mul(u, a * hu), v3.mul(v, e * hv))), n, [(a + 1) * hu, (1 - e) * hv]);
            g.quad(b, b + 1, b + 2, b + 3);
        }
        return g;
    },
    // y = 0 .. h, radius r0 at the bottom, r1 at the top; `jag` alternates the bottom radius (fir skirts)
    cylinder(d) {
        const r0 = d.r0 ?? d.r ?? 0.5, r1 = d.r1 ?? r0, h = d.h ?? 1, jag = d.jag || 0, g = new Geo();
        const seg = Math.max(3, (d.seg || 12) + (jag && (d.seg || 12) % 2 ? 1 : 0));
        const slope = (r0 - r1) / h, ravg = (r0 + r1) / 2, slant = Math.hypot(h, r0 - r1);
        const rb = i => r0 * (1 + (i % 2 ? -jag : jag));
        for (let i = 0; i <= seg; i++) {
            const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), n = v3.norm([ca, slope, sa]);
            g.vert([ca * rb(i), 0, sa * rb(i)], n, [a * ravg, 0]);
            g.vert([ca * r1, h, sa * r1], n, [a * ravg, slant]);
        }
        for (let i = 0; i < seg; i++) { const b = i * 2; g.quad(b, b + 1, b + 3, b + 2); }
        const cap = (y, rf, s) => {
            const c = g.vert([0, y, 0], [0, s, 0], [0, 0]), b = g.count;
            for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2, r = rf(i); g.vert([Math.cos(a) * r, y, Math.sin(a) * r], [0, s, 0], [Math.cos(a) * r, Math.sin(a) * r]); }
            for (let i = 0; i < seg; i++) { if (s < 0) g.tri(c, b + i, b + i + 1); else g.tri(c, b + i + 1, b + i); }
        };
        if (d.caps !== false) { cap(0, rb, -1); if (r1 > 1e-3) cap(h, () => r1, 1); }
        return g;
    },
    cone(d) { return SHAPES.cylinder({ ...d, r0: d.r ?? d.r0 ?? 0.5, r1: 0 }); },
    // icosphere, optionally displaced by 3D value noise (rocks)
    sphere(d) {
        const r = d.r ?? 1, amp = d.noise || 0, freq = d.freq || 1.5, seed = d.seed || 1, t = (1 + Math.sqrt(5)) / 2;
        let P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v3.norm);
        let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        for (let s = 0; s < (d.subdiv ?? 2); s++) {
            const cache = new Map(), mid = (a, b) => {
                const k = a < b ? a + ',' + b : b + ',' + a;
                if (!cache.has(k)) { cache.set(k, P.length); P.push(v3.norm(v3.mul(v3.add(P[a], P[b]), 0.5))); }
                return cache.get(k);
            };
            F = F.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
        }
        const g = new Geo();
        for (const p of P) {
            const k = r * (1 + amp * valueNoise3(p[0] * freq + 11, p[1] * freq, p[2] * freq, seed));
            g.vert(v3.mul(p, k), p, [(p[0] + p[2]) * k, p[1] * k]);
        }
        for (const f of F) g.tri(f[0], f[1], f[2]);
        g.smoothNormals();
        g.orient();
        return g;
    },
    knot(d) {
        const p = d.p || 2, q = d.q || 3, R = d.R || 1, tube = d.tube || 0.3, seg = d.seg || 200, rad = d.rad || 16, g = new Geo();
        const curve = u => { const qu = q / p * u, cs = Math.cos(qu); return [R * (2 + cs) * 0.5 * Math.cos(u), R * (2 + cs) * 0.5 * Math.sin(u), R * Math.sin(qu) * 0.5]; };
        for (let i = 0; i <= seg; i++) {
            const u = i / seg * p * Math.PI * 2, P1 = curve(u), P2 = curve(u + 0.01), T = v3.sub(P2, P1);
            const B = v3.norm(v3.cross(T, v3.add(P2, P1))), N = v3.norm(v3.cross(B, T));
            for (let j = 0; j <= rad; j++) {
                const v = j / rad * Math.PI * 2, pos = v3.add(P1, v3.add(v3.mul(N, -tube * Math.cos(v)), v3.mul(B, tube * Math.sin(v))));
                g.vert(pos, v3.norm(v3.sub(pos, P1)), [u * R, v * tube]);
            }
        }
        for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
            const a = i * (rad + 1) + j, b = (i + 1) * (rad + 1) + j;
            g.quad(a, b, b + 1, a + 1);
        }
        g.orient();
        return g;
    },
    // profile [[r, y], ...] from the bottom up, turned around Y; flat along the profile, smooth around
    lathe(d) {
        const prof = d.profile || [[0, 0], [1, 0], [1, 1], [0, 1]], seg = d.seg || 24, g = new Geo();
        for (let k = 0; k + 1 < prof.length; k++) {
            const [r0, y0] = prof[k], [r1, y1] = prof[k + 1], L = Math.hypot(r1 - r0, y1 - y0);
            if (L < 1e-6) continue;
            const nx = (y1 - y0) / L, ny = -(r1 - r0) / L, b = g.count;
            for (let i = 0; i <= seg; i++) {
                const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), n = [nx * ca, ny, nx * sa];
                g.vert([r0 * ca, y0, r0 * sa], n, [a * Math.max(r0, r1), y0]);
                g.vert([r1 * ca, y1, r1 * sa], n, [a * Math.max(r0, r1), y0 + L]);
            }
            for (let i = 0; i < seg; i++) { const c = b + i * 2; g.quad(c, c + 1, c + 3, c + 2); }
        }
        g.orient();
        return g;
    },
    // gable roof: `size` [width (x), height, depth (z)], ridge along x at y = height
    roof(d) {
        const [w, h, dd] = d.size || [4, 2, 4], x = w / 2, z = dd / 2, g = new Geo(), inside = [0, h / 3, 0];
        g.poly([[-x, 0, z], [x, 0, z], [x, h, 0], [-x, h, 0]], inside);
        g.poly([[x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, h, 0]], inside);
        g.poly([[x, 0, z], [x, 0, -z], [x, h, 0]], inside);
        g.poly([[-x, 0, -z], [-x, 0, z], [-x, h, 0]], inside);
        g.poly([[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]], [0, 1, 0]);
        return g;
    },
    // leaf cards scattered in an ellipsoid, normals bent outward so the clump lights like a volume
    foliage(d) {
        const [rx, ry, rz] = d.radius || [1, 1, 1], cnt = d.count || 40, s = (d.card || 0.8) / 2, rnd = seededRandom(d.seed || 1), g = new Geo();
        for (let k = 0; k < cnt; k++) {
            let u;
            do { u = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; } while (v3.len(u) > 1);
            const c = [u[0] * rx, u[1] * ry, u[2] * rz];
            const nr = v3.norm([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
            const t = v3.norm(v3.cross(nr, Math.abs(nr[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), b = v3.cross(nr, t);
            const out = v3.len(u) > 0.05 ? v3.norm(u) : nr, n = v3.norm(v3.add(v3.add(v3.mul(out, 0.85), v3.mul(nr, 0.15)), [0, 0.2, 0]));
            const base = g.count;
            for (const [a, e] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.vert(v3.add(c, v3.add(v3.mul(t, a * s), v3.mul(b, e * s))), n, [(a + 1) / 2, (1 - e) / 2]);
            g.quad(base, base + 1, base + 2, base + 3);
        }
        return g;
    },
};

// MeshBuilder: merges placed geometry into one vertex / index buffer, one submesh (index range) per material
class MeshBuilder {
    constructor() { this.groups = new Map(); }

    // src: { p, n, uv, col?, idx } (arrays or typed arrays); M: placement matrix; color: linear tint
    add(src, material, M = null, color = null) {
        const n = src.p.length / 3, v = new Float32Array(n * VF);
        for (let i = 0; i < n; i++) {
            const o = i * VF;
            v[o] = src.p[i * 3]; v[o + 1] = src.p[i * 3 + 1]; v[o + 2] = src.p[i * 3 + 2];
            v[o + 3] = src.n[i * 3]; v[o + 4] = src.n[i * 3 + 1]; v[o + 5] = src.n[i * 3 + 2];
            v[o + 6] = src.uv[i * 2]; v[o + 7] = src.uv[i * 2 + 1];
            if (src.col) { v[o + 8] = src.col[i * 3]; v[o + 9] = src.col[i * 3 + 1]; v[o + 10] = src.col[i * 3 + 2]; }
            else v[o + 8] = v[o + 9] = v[o + 10] = 1;
        }
        this.push(material, v, Uint32Array.from(src.idx), M, color);
    }

    // append another MeshData (nested imported model)
    addMesh(mesh, M) {
        for (const s of mesh.submeshes) {
            const v = mesh.vertices.slice(s.vfirst * VF, (s.vfirst + s.vcount) * VF);
            const idx = mesh.indices.slice(s.first, s.first + s.count).map(i => i - s.vfirst);
            this.push(s.material, v, idx, M, null);
        }
    }

    push(material, v, idx, M, color) {
        if (M) {
            const inv = m4.invert(M);
            for (let o = 0; o < v.length; o += VF) {
                const x = v[o], y = v[o + 1], z = v[o + 2], nx = v[o + 3], ny = v[o + 4], nz = v[o + 5];
                v[o] = M[0] * x + M[4] * y + M[8] * z + M[12];
                v[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
                v[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
                const a = inv[0] * nx + inv[1] * ny + inv[2] * nz, b = inv[4] * nx + inv[5] * ny + inv[6] * nz, c = inv[8] * nx + inv[9] * ny + inv[10] * nz;
                const l = Math.hypot(a, b, c) || 1;
                v[o + 3] = a / l; v[o + 4] = b / l; v[o + 5] = c / l;
            }
            if (m4.det3(M) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        }
        if (color) for (let o = 0; o < v.length; o += VF) { v[o + 8] *= color[0]; v[o + 9] *= color[1]; v[o + 10] *= color[2]; }
        let grp = this.groups.get(material);
        if (!grp) this.groups.set(material, grp = { chunks: [], verts: 0, idx: 0 });
        grp.chunks.push({ v, idx });
        grp.verts += v.length / VF;
        grp.idx += idx.length;
    }

    finish() {
        let nv = 0, ni = 0;
        for (const g of this.groups.values()) { nv += g.verts; ni += g.idx; }
        const V = new Float32Array(nv * VF), I = new Uint32Array(ni), subs = [];
        let vo = 0, io = 0;
        for (const [material, g] of this.groups) {
            const first = io, vfirst = vo;
            for (const c of g.chunks) {
                V.set(c.v, vo * VF);
                for (let i = 0; i < c.idx.length; i++) I[io + i] = c.idx[i] + vo;
                io += c.idx.length;
                vo += c.v.length / VF;
            }
            subs.push({ material, first, count: io - first, vfirst, vcount: vo - vfirst });
        }
        return new MeshData(V, I, subs);
    }
}

// Interleaved vertices + indices + submeshes, with bounds and the bounding sphere the imposter is baked around
class MeshData {
    constructor(vertices, indices, submeshes) {
        this.vertices = vertices;
        this.indices = indices;
        this.submeshes = submeshes;
        this.computeBounds();
    }

    get triangles() { return this.indices.length / 3; }

    computeBounds() {
        const V = this.vertices, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let o = 0; o < V.length; o += VF) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[o + k]); max[k] = Math.max(max[k], V[o + k]); }
        if (!V.length) { min.fill(0); max.fill(0); }
        this.min = min; this.max = max;
        this.center = v3.mul(v3.add(min, max), 0.5);
        let r = 0;
        for (let o = 0; o < V.length; o += VF) r = Math.max(r, Math.hypot(V[o] - this.center[0], V[o + 1] - this.center[1], V[o + 2] - this.center[2]));
        this.radius = Math.max(r, 1e-3);
    }

    // imported models: scale the largest side to `size` metres, base centred on the origin
    fit(size) {
        const ext = v3.sub(this.max, this.min), s = size / Math.max(ext[0], ext[1], ext[2], 1e-6);
        const o = [this.center[0], this.min[1], this.center[2]], V = this.vertices;
        for (let i = 0; i < V.length; i += VF) for (let k = 0; k < 3; k++) V[i + k] = (V[i + k] - o[k]) * s;
        this.computeBounds();
    }
}

return { Geo, SHAPES, MeshBuilder };
});
