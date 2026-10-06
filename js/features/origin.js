'use strict';
// Entity Origin, as a feature of WebGPU Entities: a Floating Origin with O(1) rebasing over a real-scale solar system.
// The engine is the one from the WebGPU-EntityOrigin demo; the host (js/engine/host.js) gives it its device, canvas
// target, input and HUD root, and builds its scenario from entities ("origin.*", see js/engine/scenario-format.js).

Features.define('origin', (engine) => {
const { Common } = engine;
const { DEG, clamp, v3, mulberry32, Toast, LabelLayer } = Common;

// =====================================================================================================
// Entity Origin: a Floating Origin in WebGPU with O(1) rebasing.
//
// Every position lives on an integer grid: WorldPos = integer cell (CELL metres) + local offset. The
// origin is a full matrix (translation, rotation, scale) and is the ONLY thing that changes on a rebase:
// 80 bytes to one uniform buffer. Instances stay in a static storage buffer as (cell, local, axes) and the
// vertex shader brings them into origin space itself:
//
//     p_origin = (R^T / s) * ( (cell - originCell) * CELL + (local - originLocal) + axes * vertex )
//
// The cell difference is an exact integer subtraction, so everything near the origin keeps full f32
// precision whatever its distance from the world centre, and rebasing never walks the entity list.
// =====================================================================================================

// ------------------------------------------------------------------------------------------ core/config
const CELL = 8192;                  // metres per grid cell (a power of two, so cell * CELL is exact in f32)
const MAX_CELL = 2 ** 30;           // |cell| limit: cell differences never overflow i32 (±8.8e12 m)
const MAX_BODIES = 32;
const ORIGIN_BYTES = 80;            // the entire floating-origin state on the GPU
const INSTANCE_FLOATS = 24;         // 96 bytes per instance
const BODY_FLOATS = 16;
const FRAME_FLOATS = 44;
const VERTEX_FLOATS = 7;            // pos, normal, material
const SAMPLES = 4;
const NEAR = 0.05;                  // near plane, origin units
const AU = 1.495978707e11;
const PATTERNS = { flat: 0, panels: 1, rock: 2, blink: 3, windows: 4, solar: 5, hazard: 6, regolith: 7 };
const SURFACES = { star: 0, rocky: 1, earth: 2, gas: 3, ice: 4, mars: 5 };

// -------------------------------------------------------------------------------------------- core/math
// Doubles on the CPU; only origin-relative values ever reach the GPU as f32 (v3 and the m4 basics: js/engine/common.js).

// Quaternions [x, y, z, w]
const quat = {
    id: () => [0, 0, 0, 1],
    mul(a, b) {
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
    },
    conj: q => [-q[0], -q[1], -q[2], q[3]],
    norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
    axisAngle(axis, rad) { const n = v3.norm(axis), s = Math.sin(rad / 2); return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)]; },
    rotate(q, v) {
        const u = [q[0], q[1], q[2]], t = v3.mul(v3.cross(u, v), 2);
        return v3.add(v3.add(v, v3.mul(t, q[3])), v3.cross(u, t));
    },
    axes: q => [quat.rotate(q, [1, 0, 0]), quat.rotate(q, [0, 1, 0]), quat.rotate(q, [0, 0, 1])],
    fromAxes(X, Y, Z) {
        const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
        const tr = m00 + m11 + m22;
        let s;
        if (tr > 0) { s = Math.sqrt(tr + 1) * 2; return quat.norm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]); }
        if (m00 > m11 && m00 > m22) { s = Math.sqrt(1 + m00 - m11 - m22) * 2; return quat.norm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]); }
        if (m11 > m22) { s = Math.sqrt(1 + m11 - m00 - m22) * 2; return quat.norm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]); }
        s = Math.sqrt(1 + m22 - m00 - m11) * 2; return quat.norm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
    },
    // shortest arc taking unit vector a onto unit vector b
    fromTo(a, b) {
        const d = v3.dot(a, b);
        if (d < -0.999999) {
            let ax = v3.cross([1, 0, 0], a);
            if (v3.len(ax) < 1e-6) ax = v3.cross([0, 1, 0], a);
            return quat.axisAngle(ax, Math.PI);
        }
        const c = v3.cross(a, b);
        return quat.norm([c[0], c[1], c[2], 1 + d]);
    },
    // [yaw, pitch, roll] in degrees: yaw about Y, then pitch about X, then roll about Z
    euler(deg) {
        return quat.mul(quat.mul(quat.axisAngle([0, 1, 0], (deg[0] || 0) * DEG), quat.axisAngle([1, 0, 0], (deg[1] || 0) * DEG)), quat.axisAngle([0, 0, 1], (deg[2] || 0) * DEG));
    },
    // camera-style orientation: looks down -Z
    look(fwd, up) {
        const Z = v3.norm(v3.mul(fwd, -1));
        let X = v3.cross(up, Z);
        if (v3.len(X) < 1e-9) X = v3.cross(Math.abs(Z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], Z);
        X = v3.norm(X);
        return quat.fromAxes(X, v3.cross(Z, X), Z);
    },
};

// Column-major 4x4 (Float64Array), WebGPU clip space; view from an orientation and a position
const m4 = {
    ...Common.m4,
    view(q, p) {
        const [X, Y, Z] = quat.axes(q);
        return new Float64Array([X[0], Y[0], Z[0], 0, X[1], Y[1], Z[1], 0, X[2], Y[2], Z[2], 0, -v3.dot(X, p), -v3.dot(Y, p), -v3.dot(Z, p), 1]);
    },
};

const f32Step = x => 2 ** (Math.floor(Math.log2(Math.max(Math.abs(x), 2 ** -126))) - 23);   // spacing of f32 values near x
const vec3Of = s => Array.isArray(s) ? s : [s, s, s];

function fmtDist(m) {
    const a = Math.abs(m);
    if (a >= 0.01 * AU) return `${(m / AU).toFixed(a >= 10 * AU ? 2 : 4)} AU`;
    if (a >= 1e7) return `${(m / 1e6).toFixed(1)} Mm`;
    if (a >= 1e4) return `${(m / 1e3).toFixed(1)} km`;
    if (a >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
    if (a >= 0.1 || a === 0) return `${m.toFixed(1)} m`;
    return `${(m * 1e3).toPrecision(2)} mm`;
}

// -------------------------------------------------------------------------------------- core/world-pos
// Unbounded position: integer cell + double offset in [0, CELL). Differences are exact near each other.
class WorldPos {
    constructor(c = [0, 0, 0], l = [0, 0, 0]) {
        this.c = c.slice();
        this.l = l.slice();
        this.fix();
    }

    static of(metres) { return new WorldPos([0, 0, 0], metres); }

    fix() {
        for (let i = 0; i < 3; i++) {
            const k = Math.floor(this.l[i] / CELL);
            if (k) { this.c[i] += k; this.l[i] -= k * CELL; }
        }
        return this;
    }

    clone() { return new WorldPos(this.c, this.l); }
    add(d) { return new WorldPos(this.c, v3.add(this.l, d)); }
    addIn(d) { this.l = v3.add(this.l, d); return this.fix(); }
    // this - o, in metres
    sub(o) {
        return [(this.c[0] - o.c[0]) * CELL + (this.l[0] - o.l[0]), (this.c[1] - o.c[1]) * CELL + (this.l[1] - o.l[1]), (this.c[2] - o.c[2]) * CELL + (this.l[2] - o.l[2])];
    }
    metres() { return [this.c[0] * CELL + this.l[0], this.c[1] * CELL + this.l[1], this.c[2] * CELL + this.l[2]]; }
    isZero() { return !this.c[0] && !this.c[1] && !this.c[2] && !this.l[0] && !this.l[1] && !this.l[2]; }
}

// ----------------------------------------------------------------------------------------- core/origin
// The floating origin: a coordinate frame with translation (WorldPos), rotation (quaternion) and uniform
// scale (metres per origin unit). World -> origin space is  p' = R^T (p - T) / s.
class Origin {
    constructor() {
        this.pos = new WorldPos();
        this.q = quat.id();
        this.scale = 1;
        this.axes = quat.axes(this.q);      // origin X / Y / Z in world space
        this.gpu = new ArrayBuffer(ORIGIN_BYTES);
        this.i32 = new Int32Array(this.gpu);
        this.f32 = new Float32Array(this.gpu);
    }

    get up() { return this.axes[1]; }

    set(pos, q, scale) {
        // snap the local part to f32 so CPU (double) and GPU (f32) agree exactly on where the origin is
        this.pos = new WorldPos(pos.c, pos.l.map(Math.fround));
        this.q = quat.norm(q);
        this.scale = scale;
        this.axes = quat.axes(this.q);
        this.pack();
    }

    vecToLocal(d) { const a = this.axes, k = 1 / this.scale; return [v3.dot(a[0], d) * k, v3.dot(a[1], d) * k, v3.dot(a[2], d) * k]; }
    toLocal(wp) { return this.vecToLocal(wp.sub(this.pos)); }

    // 80 bytes: cell (i32 x3), local (f32 x3), rows of R^T / s
    pack() {
        const p = this.pos, a = this.axes, k = 1 / this.scale, i = this.i32, f = this.f32;
        i[0] = p.c[0]; i[1] = p.c[1]; i[2] = p.c[2]; i[3] = 0;
        f[4] = p.l[0]; f[5] = p.l[1]; f[6] = p.l[2]; f[7] = 0;
        for (let r = 0; r < 3; r++) { f[8 + r * 4] = a[r][0] * k; f[9 + r * 4] = a[r][1] * k; f[10 + r * 4] = a[r][2] * k; f[11 + r * 4] = 0; }
    }
}

// ---------------------------------------------------------------------------------------- render/mesh
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

// ----------------------------------------------------------------------------------- render/materials
class MaterialTable {
    constructor(defs) {
        this.names = Object.keys(defs);
        this.byName = new Map(this.names.map((n, i) => [n, i]));
        this.data = new Float32Array(Math.max(1, this.names.length) * 12);
        this.names.forEach((n, i) => {
            const d = defs[n], a = d.albedo || [0.7, 0.7, 0.7], e = d.emissive || [0, 0, 0, 0];
            const pat = PATTERNS[d.pattern || 'flat'];
            if (pat === undefined) throw new Error(`material "${n}": unknown pattern "${d.pattern}"`);
            this.data.set([a[0], a[1], a[2], pat, e[0], e[1], e[2], e[3] ?? 1, d.spec ?? 0.2, d.shin ?? 16, d.scale ?? 1, d.rate ?? 1], i * 12);
        });
    }

    index(name) {
        const i = this.byName.get(name);
        if (i === undefined) throw new Error(`unknown material "${name}"`);
        return i;
    }
}

// ----------------------------------------------------------------------------------- render/instances
// One GPU instance: grid position + world-space axes (rotation * scale). Written once at build time;
// only dynamic entities write their own slot again.
class Instance {
    constructor(model) {
        this.model = model;
        this.pos = new WorldPos();
        this.axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        this.tint = [1, 1, 1];
        this.seed = 0;
        this.slot = -1;
    }

    place(pos, q, scale) {
        const a = quat.axes(q), s = vec3Of(scale);
        this.pos = pos;
        this.axes = [v3.mul(a[0], s[0]), v3.mul(a[1], s[1]), v3.mul(a[2], s[2])];
    }

    write(i32, f32) {
        const o = this.slot * INSTANCE_FLOATS, p = this.pos, a = this.axes;
        i32[o] = p.c[0]; i32[o + 1] = p.c[1]; i32[o + 2] = p.c[2]; i32[o + 3] = 0;
        f32[o + 4] = p.l[0]; f32[o + 5] = p.l[1]; f32[o + 6] = p.l[2]; f32[o + 7] = this.seed;
        for (let k = 0; k < 3; k++) { f32[o + 8 + k * 4] = a[k][0]; f32[o + 9 + k * 4] = a[k][1]; f32[o + 10 + k * 4] = a[k][2]; f32[o + 11 + k * 4] = 0; }
        f32[o + 20] = this.tint[0]; f32[o + 21] = this.tint[1]; f32[o + 22] = this.tint[2]; f32[o + 23] = 0;
    }
}

class InstanceStore {
    constructor(device, models) {
        this.device = device;
        let n = 0;
        for (const m of models) {
            m.first = n;
            m.instances.forEach((inst, i) => { inst.slot = n + i; });
            n += m.instances.length;
        }
        this.count = n;
        this.data = new ArrayBuffer(Math.max(1, n) * INSTANCE_FLOATS * 4);
        this.i32 = new Int32Array(this.data);
        this.f32 = new Float32Array(this.data);
        this.outOfRange = 0;
        for (const m of models) for (const inst of m.instances) {
            if (inst.pos.c.some(c => Math.abs(c) > MAX_CELL)) this.outOfRange++;
            inst.write(this.i32, this.f32);
        }
        this.buffer = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(this.buffer, 0, this.data);
        this.dirty = new Set();
        this.bytes = 0;             // uploaded last frame
    }

    get byteLength() { return this.data.byteLength; }

    touch(inst) { inst.write(this.i32, this.f32); this.dirty.add(inst.slot); }

    flush() {
        const B = INSTANCE_FLOATS * 4;
        this.bytes = 0;
        for (const s of this.dirty) { this.device.queue.writeBuffer(this.buffer, s * B, this.data, s * B, B); this.bytes += B; }
        this.dirty.clear();
    }

    destroy() { this.buffer.destroy(); }
}

// -------------------------------------------------------------------------------------- render/shaders
function cubeWGSL() {
    // 36 corners of the unit cube, counter-clockwise seen from outside
    const b = new MeshBuilder();
    b.box([0, 0, 0], [2, 2, 2], 0);
    const out = b.idx.map(i => `vec3f(${b.v[i * VERTEX_FLOATS]}, ${b.v[i * VERTEX_FLOATS + 1]}, ${b.v[i * VERTEX_FLOATS + 2]})`);
    return `var<private> CUBE: array<vec3f, 36> = array<vec3f, 36>(${out.join(', ')});`;
}

const WGSL = /* wgsl */`
const CELL: f32 = ${CELL}.0;

struct Frame {
    viewProj: mat4x4f,
    cam: vec4f,         // camera in origin space, w = time
    fwd: vec4f,         // w = near
    right: vec4f,       // w = tan(fov/2) * aspect
    up: vec4f,          // w = tan(fov/2)
    sun: vec4f,         // sun in origin space, w = radians per pixel
    sky: vec4f,         // atmosphere colour, w = star visibility
    misc: vec4f,        // exposure, sun intensity
};
struct Origin { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f };
struct Material { albedo: vec4f, emissive: vec4f, params: vec4f };
struct Instance { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f, tint: vec4f };
struct Body { center: vec4f, shape: vec4f, color: vec4f, atmo: vec4f };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> origin: Origin;
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(3) var<storage, read> instances: array<Instance>;
@group(0) @binding(4) var<storage, read> bodies: array<Body>;

${cubeWGSL()}

// ---- floating origin ----------------------------------------------------------------------------
// exact integer cell difference + small f32 remainder: precise near the origin at any world distance
fn relative(cell: vec3i, local: vec3f) -> vec3f {
    return vec3f(cell - origin.cell.xyz) * CELL + (local - origin.local.xyz);
}
fn toOrigin(v: vec3f) -> vec3f { return vec3f(dot(origin.ax.xyz, v), dot(origin.ay.xyz, v), dot(origin.az.xyz, v)); }
fn toWorldDir(d: vec3f) -> vec3f { return normalize(origin.ax.xyz * d.x + origin.ay.xyz * d.y + origin.az.xyz * d.z); }

// ---- noise / tone ------------------------------------------------------------------------------
fn hash3(p: vec3f) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}
fn noise3(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
               mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, octaves: i32) -> f32 {
    var a = 0.5;
    var s = 0.0;
    var q = p;
    for (var i = 0; i < octaves; i++) { s += a * noise3(q); q = q * 2.03 + vec3f(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
}
fn tone(c: vec3f) -> vec3f { return pow(vec3f(1.0) - exp(-c * frame.misc.x), vec3f(1.0 / 2.2)); }

// ---- sky ---------------------------------------------------------------------------------------
struct SkyOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f };

@vertex fn vsSky(@builtin(vertex_index) i: u32) -> SkyOut {
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    var o: SkyOut;
    o.clip = vec4f(xy, 0.0, 1.0);
    o.uv = xy;
    return o;
}

fn stars(d: vec3f) -> vec3f {
    var c = vec3f(0.0);
    for (var k = 0; k < 3; k++) {
        let s = 90.0 + f32(k) * 170.0;
        let p = d * s;
        let id = floor(p);
        let h = hash3(id + f32(k) * 17.0);
        if (h > 0.9) {
            let jitter = vec3f(hash3(id + 1.3), hash3(id + 2.7), hash3(id + 5.1)) - 0.5;
            let r = length(fract(p) - 0.5 - jitter * 0.6);
            let tint = mix(vec3f(0.65, 0.78, 1.0), vec3f(1.0, 0.82, 0.6), hash3(id + 9.0));
            c += tint * smoothstep(0.1, 0.0, r) * (h - 0.9) * 12.0 / (1.0 + f32(k));
        }
    }
    // faint galactic band, fixed in world space
    let band = exp(-abs(dot(d, normalize(vec3f(0.3, 0.9, 0.2)))) * 7.0);
    return c + vec3f(0.05, 0.05, 0.07) * band * (0.4 + fbm(d * 6.0, 4));
}

@fragment fn fsSky(v: SkyOut) -> @location(0) vec4f {
    let d = normalize(frame.fwd.xyz + frame.right.xyz * v.uv.x * frame.right.w + frame.up.xyz * v.uv.y * frame.up.w);
    let w = toWorldDir(d);
    return vec4f(tone(frame.sky.rgb + stars(w) * frame.sky.w), 1.0);
}

// ---- celestial bodies: exact ray / sphere per pixel -------------------------------------------------
// center.xyz origin space, center.w radius; shape = (altitude, surface, seed, halo); color.w emissive;
// atmo.w atmosphere height. The altitude comes from the CPU in doubles so the surface stays exact at 1 m.
struct BodyOut {
    @builtin(position) clip: vec4f,
    @location(0) ray: vec3f,
    @location(1) @interpolate(flat) bi: u32,
};
struct BodyFrag { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@vertex fn vsBody(@builtin(vertex_index) vi: u32, @builtin(instance_index) bi: u32) -> BodyOut {
    let b = bodies[bi];
    let dist = length(b.center.xyz - frame.cam.xyz);
    let half = max(b.center.w * max(b.shape.w, 1.02), dist * frame.sun.w * 8.0);
    let p = b.center.xyz + CUBE[vi] * half;
    var o: BodyOut;
    o.clip = frame.viewProj * vec4f(p, 1.0);
    o.ray = p - frame.cam.xyz;
    o.bi = bi;
    return o;
}

fn surfaceColor(b: Body, n: vec3f, t: f32) -> vec3f {
    let kind = u32(b.shape.y);
    let q = n + vec3f(b.shape.z);
    let base = b.color.rgb;
    let fine = clamp(1.0 - t / (b.center.w * 0.01), 0.0, 1.0);
    if (kind == 2u) {                                               // earth
        let h = fbm(q * 2.2, 6) + 0.06 * fbm(q * 40.0, 3);
        let land = smoothstep(0.52, 0.55, h);
        let landCol = mix(vec3f(0.1, 0.26, 0.07), vec3f(0.42, 0.36, 0.22), smoothstep(0.56, 0.75, h));
        var c = mix(vec3f(0.015, 0.06, 0.18), landCol, land);
        c = mix(c, vec3f(0.9), smoothstep(0.82, 0.9, abs(n.y) + 0.1 * h));
        let cloud = smoothstep(0.5, 0.72, fbm(q * 4.0 + vec3f(3.1), 5));
        return mix(c, vec3f(0.95), cloud * 0.85);
    }
    if (kind == 3u || kind == 4u) {                                 // gas / ice giant
        let w = fbm(q * vec3f(2.0, 10.0, 2.0), 5);
        let bands = select(12.0, 24.0, kind == 3u);
        let band = sin(n.y * bands + w * 4.0) * 0.5 + 0.5;
        var c = base * (0.72 + 0.4 * band);
        if (kind == 3u) { c = mix(c, base * vec3f(1.1, 0.75, 0.55), smoothstep(0.6, 0.8, w) * 0.6); }
        return c;
    }
    // rocky / mars: continents, then close-up detail that fades in near the camera
    let h = fbm(q * 3.0, 6);
    let d = (fbm(n * 2.0e4, 4) - 0.5) * 0.35 + (fbm(n * 3.0e5, 3) - 0.5) * 0.3 * fine;
    var c = base * (0.55 + 0.7 * h + d);
    if (kind == 5u) { c = mix(c, base * vec3f(0.45, 0.35, 0.3), smoothstep(0.55, 0.65, fbm(q * 5.0, 4))); }
    return c;
}

@fragment fn fsBody(v: BodyOut) -> BodyFrag {
    let b = bodies[v.bi];
    let dir = normalize(v.ray);
    let R = b.center.w;
    let oc = frame.cam.xyz - b.center.xyz;
    let bb = dot(oc, dir);
    let alt = b.shape.x;
    let c = alt * (alt + 2.0 * R);                  // |oc|^2 - R^2 without cancellation
    let disc = bb * bb - c;
    let near = frame.fwd.w;
    let fd = max(dot(dir, frame.fwd.xyz), 1e-6);
    var o: BodyFrag;
    if (disc >= 0.0 && c > 0.0 && bb < 0.0) {
        let t = c / (-bb + sqrt(disc));             // stable root: exact close to the surface
        let n = normalize(dir * t + oc);
        let p = frame.cam.xyz + dir * t;
        var col: vec3f;
        if (u32(b.shape.y) == 0u) {
            let g = fbm(toWorldDir(n) * 9.0 + vec3f(frame.cam.w * 0.01), 5);
            col = b.color.rgb * b.color.w * (0.7 + 0.6 * g) * (0.35 + 0.65 * pow(max(dot(n, -dir), 0.0), 0.35));
        } else {
            let alb = surfaceColor(b, toWorldDir(n), t);
            let L = normalize(frame.sun.xyz - p);
            let ndl = dot(n, L);
            col = alb * (max(ndl, 0.0) * frame.misc.y + 0.004);
            if (u32(b.shape.y) == 2u) { col += vec3f(0.6) * pow(max(dot(n, normalize(L - dir)), 0.0), 60.0) * max(ndl, 0.0) * 0.3; }
            if (b.atmo.w > 0.0) {
                let rim = pow(1.0 - max(dot(n, -dir), 0.0), 3.0);
                let day = smoothstep(-0.25, 0.35, ndl);
                col = mix(col, b.atmo.rgb * day * 0.5, 0.12 * day) + b.atmo.rgb * rim * day * 0.9;
            }
        }
        o.color = vec4f(tone(col), 1.0);
        o.depth = clamp(near / (t * fd), 0.0, 1.0);
        return o;
    }
    // missed: distant bodies still read as a dot, stars get a halo
    if (bb >= 0.0) { discard; }
    let dist = length(oc);
    let ang = length(oc - dir * bb) / dist;
    let angR = R / dist;
    let pix = frame.sun.w;
    let dotW = clamp((4.0 * pix - angR) / (3.0 * pix), 0.0, 1.0);
    let spot = exp(-pow(ang / (angR + 1.3 * pix), 2.0)) * dotW;
    var halo = 0.0;
    if (b.color.w > 0.0) { halo = exp(-max(ang - angR, 0.0) / (angR * 0.6 + pix * 3.0)) * 0.8; }
    let col = b.color.rgb * (spot * select(1.4, b.color.w, b.color.w > 0.0) + halo * 2.0);
    if (max(col.r, max(col.g, col.b)) < 0.004) { discard; }
    o.color = vec4f(tone(col), 1.0);
    o.depth = clamp(near / (dist * fd), 0.0, 1.0);
    return o;
}

// ---- entity instances ----------------------------------------------------------------------------
struct MeshOut {
    @builtin(position) clip: vec4f,
    @location(0) po: vec3f,
    @location(1) n: vec3f,
    @location(2) lp: vec3f,
    @location(3) onrm: vec3f,
    @location(4) @interpolate(flat) mat: u32,
    @location(5) @interpolate(flat) seed: f32,
    @location(6) tint: vec3f,
    @location(7) fade: f32,
};

@vertex fn vsMesh(@location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) mat: u32, @builtin(instance_index) ii: u32) -> MeshOut {
    let inst = instances[ii];
    let m = materials[mat];
    let center = toOrigin(relative(inst.cell.xyz, inst.local.xyz));
    var p = pos;
    var grow = 1.0;
    var fade = 1.0;
    if (u32(m.albedo.w) == 2u) {
        p = p * (0.72 + 0.56 * noise3(p * 1.9 + vec3f(inst.local.w * 7.31)));
        // sub-pixel rocks stay one pixel wide: distant fields read as dust instead of flickering
        let px = length(toOrigin(inst.ax.xyz)) / max(length(center - frame.cam.xyz) * frame.sun.w, 1e-30);
        if (px < 0.7) { grow = 0.7 / max(px, 1e-6); fade = sqrt(px / 0.7); }
    }
    let off = inst.ax.xyz * p.x + inst.ay.xyz * p.y + inst.az.xyz * p.z;
    let po = center + toOrigin(off) * grow;
    let nw = cross(inst.ay.xyz, inst.az.xyz) * nrm.x + cross(inst.az.xyz, inst.ax.xyz) * nrm.y + cross(inst.ax.xyz, inst.ay.xyz) * nrm.z;
    var o: MeshOut;
    o.clip = frame.viewProj * vec4f(po, 1.0);
    o.po = po;
    o.n = toOrigin(nw);
    o.lp = pos * vec3f(length(inst.ax.xyz), length(inst.ay.xyz), length(inst.az.xyz));
    o.onrm = nrm;
    o.mat = mat;
    o.seed = inst.local.w;
    o.tint = inst.tint.rgb;
    o.fade = fade;
    return o;
}

@fragment fn fsMesh(v: MeshOut) -> @location(0) vec4f {
    let faceN = cross(dpdx(v.po), dpdy(v.po));
    let m = materials[v.mat];
    let pat = u32(m.albedo.w);
    var n = normalize(v.n);
    if (pat == 2u) { n = normalize(faceN + vec3f(1e-20)); }
    let V = normalize(frame.cam.xyz - v.po);
    if (dot(n, V) < 0.0) { n = -n; }

    var alb = m.albedo.rgb * v.tint;
    var emi = m.emissive.rgb * m.emissive.w;
    // panel grid in object space (metres / scale); the axis along the normal draws no seams
    let an = abs(normalize(v.onrm));
    let g = v.lp / max(m.params.z, 1e-3);
    let q = abs(fract(g) - 0.5) * (vec3f(1.0) - step(vec3f(0.7), an));
    let seam = max(max(q.x, q.y), q.z);
    let line = smoothstep(0.45, 0.49, seam);
    let h = hash3(floor(g) * (vec3f(1.0) - step(vec3f(0.7), an)) + vec3f(v.seed * 3.0));
    switch pat {
        case 1u: { alb *= (0.84 + 0.16 * h) * mix(1.0, 0.45, line); emi *= 0.0; }
        case 2u, 7u: { alb *= 0.65 + 0.7 * fbm(v.lp * 0.6 + vec3f(v.seed * 11.0), 3); }
        case 3u: { emi *= smoothstep(0.55, 0.75, sin((frame.cam.w * m.params.w + v.seed) * 6.2832) * 0.5 + 0.5); }
        case 4u: {
            let lit = step(0.3, h) * (1.0 - smoothstep(0.26, 0.32, seam));
            alb *= mix(1.0, 0.45, line) * (1.0 - lit * 0.8);
            emi *= lit;
        }
        case 5u: { alb = mix(alb, vec3f(0.65), line); emi *= 0.0; }
        case 6u: { alb = select(vec3f(0.05), alb, fract(dot(v.lp, vec3f(1.0)) / max(m.params.z, 1e-3)) < 0.5); emi *= 0.0; }
        default: {}
    }

    let L = normalize(frame.sun.xyz - v.po);
    let diff = max(dot(n, L), 0.0);
    let H = normalize(L + V);
    let spec = m.params.x * pow(max(dot(n, H), 0.0), m.params.y) * diff;
    let amb = frame.sky.rgb * 0.25 + vec3f(0.016, 0.018, 0.024);
    let col = (alb * (diff * frame.misc.y + amb) + spec * frame.misc.y + emi) * v.fade;
    return vec4f(tone(col), 1.0);
}
`;

// ------------------------------------------------------------------------------------- render/renderer
class Renderer {
    // the host's device and canvas (fx: the feature context, see js/engine/host.js)
    constructor(fx) { this.fx = fx; }

    async init() {
        const device = this.device = this.fx.device;
        this.format = this.fx.format;

        const module = device.createShaderModule({ code: WGSL });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter(m => m.type === 'error');
        if (errors.length) throw new Error(errors.map(m => `WGSL ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));

        const U = GPUBufferUsage;
        this.frameData = new Float32Array(FRAME_FLOATS);
        this.frameBuf = device.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
        this.originBuf = device.createBuffer({ size: ORIGIN_BYTES, usage: U.UNIFORM | U.COPY_DST });
        this.bodyData = new Float32Array(MAX_BODIES * BODY_FLOATS);
        this.bodyBuf = device.createBuffer({ size: this.bodyData.byteLength, usage: U.STORAGE | U.COPY_DST });

        const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
            { binding: 1, visibility: vf, buffer: { type: 'uniform' } },
            { binding: 2, visibility: vf, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: vf, buffer: { type: 'read-only-storage' } },
            { binding: 4, visibility: vf, buffer: { type: 'read-only-storage' } },
        ] });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
        const multisample = { count: SAMPLES };
        const targets = [{ format: this.format }];
        const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
        const [sky, body, mesh] = await Promise.all([
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsSky' },
                fragment: { module, entryPoint: 'fsSky', targets },
                depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
            }),
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsBody' },
                fragment: { module, entryPoint: 'fsBody', targets },
                primitive: { cullMode: 'front' },   // inner faces: works from inside the bounding cube too
                depthStencil: depth,
            }),
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsMesh', buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    { shaderLocation: 2, offset: 24, format: 'uint32' },
                ] }] },
                fragment: { module, entryPoint: 'fsMesh', targets },
                primitive: { cullMode: 'none' },
                depthStencil: depth,
            }),
        ]);
        this.skyPipe = sky;
        this.bodyPipe = body;
        this.meshPipe = mesh;
        this.width = this.height = 0;
    }

    // world geometry, materials and instances: uploaded once per world build
    setWorld(world) {
        const d = this.device, U = GPUBufferUsage;
        for (const b of [this.vb, this.ib, this.matBuf]) b && b.destroy();
        const g = world.geometry;
        this.vb = d.createBuffer({ size: Math.max(16, g.vertices.byteLength), usage: U.VERTEX | U.COPY_DST });
        this.ib = d.createBuffer({ size: Math.max(16, g.indices.byteLength), usage: U.INDEX | U.COPY_DST });
        this.matBuf = d.createBuffer({ size: world.materials.data.byteLength, usage: U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.vb, 0, g.vertices);
        d.queue.writeBuffer(this.ib, 0, g.indices);
        d.queue.writeBuffer(this.matBuf, 0, world.materials.data);
        this.bindGroup = d.createBindGroup({ layout: this.layout, entries: [
            { binding: 0, resource: { buffer: this.frameBuf } },
            { binding: 1, resource: { buffer: this.originBuf } },
            { binding: 2, resource: { buffer: this.matBuf } },
            { binding: 3, resource: { buffer: world.store.buffer } },
            { binding: 4, resource: { buffer: this.bodyBuf } },
        ] });
    }

    // the whole cost of a rebase
    writeOrigin(origin) { this.device.queue.writeBuffer(this.originBuf, 0, origin.gpu); }

    resize() {
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height) return;
        this.width = w;
        this.height = h;
        for (const t of [this.msaa, this.depth]) t && t.destroy();
        this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.msaaView = this.msaa.createView();
        this.depthView = this.depth.createView();
    }

    render(world, bodyCount) {
        const d = this.device;
        d.queue.writeBuffer(this.frameBuf, 0, this.frameData);
        if (bodyCount) d.queue.writeBuffer(this.bodyBuf, 0, this.bodyData, 0, bodyCount * BODY_FLOATS);
        const enc = d.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.msaaView, resolveTarget: this.fx.target(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        pass.setBindGroup(0, this.bindGroup);
        pass.setPipeline(this.skyPipe);
        pass.draw(3);
        if (bodyCount) { pass.setPipeline(this.bodyPipe); pass.draw(36, bodyCount); }
        pass.setPipeline(this.meshPipe);
        pass.setVertexBuffer(0, this.vb);
        pass.setIndexBuffer(this.ib, 'uint32');
        let draws = 0;
        for (const m of world.modelList) {
            if (!m.instances.length || !m.indexCount) continue;
            pass.drawIndexed(m.indexCount, m.instances.length, m.firstIndex, 0, m.first);
            draws++;
        }
        pass.end();
        d.queue.submit([enc.finish()]);
        this.draws = draws + 1 + (bodyCount ? 1 : 0);
    }
}

// --------------------------------------------------------------------------------------- world/entities
// World entities. Each is built from a scenario definition ({ type, id, ... }) and spawned once, in
// scenario order, so an entity can use any earlier one as its parent.
class Entity {
    constructor(def, world) {
        this.def = def;
        this.world = world;
        this.id = def.id;
        this.label = def.label || '';
        this.frame = null;          // { pos: WorldPos, q }
        this.radius = 0;
        this.spacing = 0;           // proximity floor inside volumes (fields)
    }

    get pos() { return this.frame.pos; }

    spawn() { this.frame = this.world.resolve(this.def); }
    update(dt, t) {}
}

// Star / planet / moon: drawn as an exact per-pixel sphere (bodies pass), not as a mesh
class Body extends Entity {
    spawn() {
        super.spawn();
        const d = this.def;
        this.frame.q = quat.euler(d.rot || [0, 0, 0]);     // bodies keep world axes: lat / lon stay predictable
        this.radius = d.radius;
        this.surface = SURFACES[d.surface || 'rocky'];
        if (this.surface === undefined) throw new Error(`body "${this.id}": unknown surface "${d.surface}"`);
        this.atmosphere = d.atmosphere || null;
        this.seed = (this.world.bodies.length * 7.13) % 5;
        this.world.bodies.push(this);
        if (d.star && !this.world.sun) this.world.sun = this;
    }

    // per frame: origin-relative centre and camera altitude, both computed in doubles
    pack(f32, o, origin, cam) {
        const s = origin.scale, c = origin.toLocal(this.frame.pos), d = this.def, col = d.color || [1, 1, 1];
        const alt = (v3.len(cam.sub(this.frame.pos)) - this.radius) / s, a = this.atmosphere;
        f32.set([c[0], c[1], c[2], this.radius / s, alt, this.surface, this.seed, d.halo || 0,
            col[0], col[1], col[2], d.emissive || 0,
            a ? a.color[0] : 0, a ? a.color[1] : 0, a ? a.color[2] : 0, a ? a.height / s : 0], o);
    }
}

// One model instance; `spin` turns it about a local axis every frame
class Prop extends Entity {
    spawn() {
        super.spawn();
        const d = this.def;
        this.scale = vec3Of(d.scale ?? 1);
        this.inst = this.world.addInstance(d.model, this.frame.pos, this.frame.q, this.scale, { tint: d.tint });
        this.radius = this.inst.model.radius * Math.max(...this.scale);
        if (this.label) this.world.landmarks.push(this);
        if (d.spin) this.world.addDynamic(this);
    }

    update(dt, t) {
        const s = this.def.spin;
        const q = quat.mul(this.frame.q, quat.axisAngle(s.axis || [0, 1, 0], t * (s.rpm || 1) * Math.PI / 30));
        this.inst.place(this.frame.pos, q, this.scale);
        this.world.store.touch(this.inst);
    }
}

// Many instances scattered procedurally (seeded): sphere shell, ring, or disc on a surface frame
class Field extends Entity {
    spawn() {
        super.spawn();
        const d = this.def, w = this.world, rng = mulberry32(d.seed || 1), sh = d.shape || { sphere: 100 };
        const models = [].concat(d.model), n = Math.max(0, Math.round((d.count || 0) * w.density));
        const [smin, smax] = d.size || [1, 1], tintJ = d.tint ?? 0.15;
        for (let i = 0; i < n; i++) {
            const size = smin * Math.pow(smax / smin, rng() * rng());      // many small, few large
            const off = this.sample(sh, rng, size);
            const q = quat.norm([rng() - 0.5, rng() - 0.5, rng() - 0.5, rng() - 0.5]);
            const scale = [size, size * (0.6 + 0.4 * rng()), size * (0.6 + 0.4 * rng())];
            const k = 1 - tintJ + tintJ * 2 * rng();
            const tint = [k * (0.95 + 0.1 * rng()), k, k * (0.95 + 0.1 * rng())];
            w.addInstance(models[i % models.length], this.frame.pos.add(quat.rotate(this.frame.q, off)), q, scale, { tint, seed: rng() * 100 });
        }
        this.count = n;
        this.radius = sh.sphere || (sh.ring && sh.ring[1]) || sh.disc || 0;
        this.spacing = n ? this.radius / Math.cbrt(n) : 0;
        if (this.label) w.landmarks.push(this);
    }

    sample(sh, rng, size) {
        if (sh.ring) {
            const [r0, r1] = sh.ring, r = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * rng()), a = rng() * Math.PI * 2;
            return [Math.cos(a) * r, (rng() + rng() + rng() - 1.5) * (sh.thickness || 0) / 1.5, Math.sin(a) * r];
        }
        if (sh.disc) {
            const r0 = sh.inner || 0, r = Math.sqrt(r0 * r0 + (sh.disc * sh.disc - r0 * r0) * rng()), a = rng() * Math.PI * 2;
            return [Math.cos(a) * r, -size * (sh.sink ?? 0.3), Math.sin(a) * r];
        }
        const R = sh.sphere, k = Math.pow(sh.inner || 0, 3) / (R * R * R);
        const r = R * Math.cbrt(k + (1 - k) * rng());
        const z = rng() * 2 - 1, a = rng() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        return [s * Math.cos(a) * r, z * r, s * Math.sin(a) * r];
    }
}

// A model flying a circular orbit around a parent entity (its local XZ plane, tilted by `incl`)
class Orbiter extends Entity {
    spawn() {
        const d = this.def, o = d.orbit;
        this.parent = this.world.get(o.parent);
        this.scale = vec3Of(d.scale ?? 1);
        this.inst = this.world.addInstance(d.model, this.parent.pos, this.parent.frame.q, this.scale, { tint: d.tint });
        this.radius = this.inst.model.radius * Math.max(...this.scale);
        this.phase = (o.angle || 0) * DEG;
        this.update(0, 0, false);
        if (this.label) this.world.landmarks.push(this);
        this.world.addDynamic(this);
    }

    update(dt, t, touch = true) {
        const o = this.def.orbit, P = this.parent.frame;
        const a = this.phase + t * Math.PI * 2 / (o.period || 60);
        const qp = quat.mul(P.q, quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
        const pos = P.pos.add(quat.rotate(qp, [Math.cos(a) * o.radius, o.height || 0, -Math.sin(a) * o.radius]));
        const q = quat.look(quat.rotate(qp, [-Math.sin(a), 0, -Math.cos(a)]), quat.rotate(qp, [0, 1, 0]));
        this.frame = { pos, q };
        this.inst.place(pos, q, this.scale);
        if (touch) this.world.store.touch(this.inst);
    }
}

const ENTITY_TYPES = {
    body: Body,
    prop: Prop,
    field: Field,
    orbiter: Orbiter,
};

// ------------------------------------------------------------------------------------------- world/world
class World {
    constructor(scenario, device, density = 1) {
        this.scenario = scenario;
        this.density = density;
        this.materials = new MaterialTable(scenario.materials || {});
        this.models = new Map(Object.entries(scenario.models || {}).map(([n, parts]) => [n, new Model(n, parts, this.materials)]));
        this.modelList = [...this.models.values()];
        this.entities = [];
        this.byId = new Map();
        this.bodies = [];
        this.landmarks = [];
        this.dynamic = [];
        this.sun = null;
        for (const def of scenario.entities || []) {
            const Type = ENTITY_TYPES[def.type];
            if (!Type) throw new Error(`unknown entity type "${def.type}"`);
            const e = new Type(def, this);
            if (e.id) this.byId.set(e.id, e);
            e.spawn();
            this.entities.push(e);
        }
        if (this.bodies.length > MAX_BODIES) throw new Error(`more than ${MAX_BODIES} bodies`);
        this.geometry = new GeometryPool(this.modelList);
        this.store = new InstanceStore(device, this.modelList);
        this.sunPos = this.sun ? this.sun.pos : new WorldPos();
    }

    get(id) {
        const e = this.byId.get(id);
        if (!e) throw new Error(`unknown entity "${id}"`);
        return e;
    }

    addInstance(model, pos, q, scale, opts = {}) {
        const m = this.models.get(model);
        if (!m) throw new Error(`unknown model "${model}"`);
        const inst = new Instance(m);
        inst.place(pos, q, scale);
        if (opts.tint !== undefined) inst.tint = typeof opts.tint === 'number' ? [1, 1, 1] : opts.tint;
        inst.seed = opts.seed ?? m.instances.length * 0.618 % 1 * 100;
        m.instances.push(inst);
        return inst;
    }

    addDynamic(e) { this.dynamic.push(e); }

    // placement -> { pos: WorldPos, q }
    resolve(spec) {
        let pos, q = quat.id();
        if (spec.orbit) {
            const o = spec.orbit, P = this.get(o.parent), r = o.radius ?? P.radius + (o.altitude || 0);
            const qo = quat.mul(quat.mul(P.frame.q, quat.axisAngle([0, 1, 0], (o.node || 0) * DEG)), quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
            const a = (o.angle || 0) * DEG, local = [Math.cos(a) * r, 0, -Math.sin(a) * r];
            const radial = quat.rotate(qo, v3.norm(local)), along = v3.cross(quat.rotate(qo, [0, 1, 0]), radial);
            pos = P.pos.add(quat.rotate(qo, local));
            q = quat.fromAxes(along, radial, v3.cross(along, radial));          // Y points away from the parent
        } else if (spec.surface && typeof spec.surface === 'object') {
            const s = spec.surface, P = this.get(s.parent), lat = (s.lat || 0) * DEG, lon = (s.lon || 0) * DEG;
            const n = quat.rotate(P.frame.q, [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
            let east = v3.cross(quat.rotate(P.frame.q, [0, 1, 0]), n);
            east = v3.len(east) < 1e-9 ? quat.rotate(P.frame.q, [1, 0, 0]) : v3.norm(east);
            pos = P.pos.add(v3.mul(n, P.radius + (s.alt || 0)));
            q = quat.mul(quat.fromAxes(east, n, v3.cross(east, n)), quat.axisAngle([0, 1, 0], (s.heading || 0) * DEG));
        } else if (spec.parent) {
            const P = this.get(spec.parent);
            pos = P.pos.add(quat.rotate(P.frame.q, spec.offset || [0, 0, 0]));
            q = P.frame.q;
        } else {
            pos = WorldPos.of(spec.pos || [0, 0, 0]);
        }
        if (spec.rot) q = quat.mul(q, quat.euler(spec.rot));
        return { pos, q };
    }

    update(dt, t) {
        for (const e of this.dynamic) e.update(dt, t);
        this.store.flush();
    }

    // Distance to the nearest thing worth resolving (body surface or landmark), plus the dominant body
    proximity(pos) {
        let dist = Infinity, body = null, alt = Infinity, rel = Infinity, near = null;
        for (const b of this.bodies) {
            const a = v3.len(pos.sub(b.pos)) - b.radius;
            if (a < dist) dist = a;
            if (a / b.radius < rel) { rel = a / b.radius; body = b; alt = a; }
        }
        for (const l of this.landmarks) {
            const d = Math.max(v3.len(pos.sub(l.pos)) - l.radius, l.spacing);
            if (d < dist) { dist = d; near = l; }
        }
        return { dist: Math.max(dist, 0.5), body, alt, near };
    }

    get instanceCount() { return this.store.count; }

    destroy() { this.store.destroy(); }
}

// -------------------------------------------------------------------------------------- game/floating
// Rebase policy. Each part of the origin matrix follows the camera on its own rule; any change is one
// 80-byte upload, whatever the number of instances.
//   T  translation snaps to the camera once it is `distance` origin units away
//   R  rotation keeps origin +Y on the local vertical of the dominant body (minimal twist)
//   S  scale = metres per origin unit, a power of two that follows the distance to the nearest thing
class FloatingOrigin {
    constructor(cfg, renderer) {
        this.cfg = { distance: 512, angle: 0.25, scaleBase: 64, frameRange: 3, maxScaleExp: 44, ...cfg };
        this.renderer = renderer;
        this.origin = new Origin();
        this.translate = true;
        this.rotate = true;
        this.scale = true;
        this.everyFrame = false;
        this.stats = { count: 0, reason: '-', ms: 0, bytes: 0 };
        this.force = true;
    }

    update(camPos, world) {
        const o = this.origin, c = this.cfg, prox = world.proximity(camPos);
        let why = '';

        let s = o.scale;
        if (this.scale) {
            const exact = Math.log2(Math.max(prox.dist / c.scaleBase, 1)), cur = Math.log2(s);
            if (Math.abs(exact - cur) > 0.75) s = 2 ** clamp(Math.round(exact), 0, c.maxScaleExp);
        } else s = 1;
        if (s !== o.scale) why += 'S';

        let q = o.q;
        if (this.rotate) {
            const b = prox.body;
            if (b && prox.alt < b.radius * c.frameRange) {
                const up = v3.norm(camPos.sub(b.pos));
                if (v3.dot(up, o.up) < Math.cos(c.angle * DEG)) { q = quat.mul(quat.fromTo(o.up, up), o.q); why += 'R'; }
            }
        } else if (q[3] !== 1) { q = quat.id(); why += 'R'; }

        let pos = o.pos;
        if (this.translate) {
            if (why || this.everyFrame || this.force || v3.len(camPos.sub(o.pos)) / s > c.distance) { pos = camPos.clone(); why += 'T'; }
        } else if (!o.pos.isZero()) { pos = new WorldPos(); why += 'T'; }

        if (this.everyFrame && !why) why = 'O';
        if (why || this.force) {
            const t0 = performance.now();
            o.set(pos, q, s);
            this.renderer.writeOrigin(o);
            this.stats.ms = performance.now() - t0;
            this.stats.count++;
            this.stats.reason = why || 'init';
            this.stats.bytes = ORIGIN_BYTES;
            this.force = false;
        }
        return prox;
    }
}

// ----------------------------------------------------------------------------------------- game/camera
// Free-flight camera. It lives in world space (WorldPos + quaternion); its controls work in the origin
// frame: yaw turns about origin +Y, Space / C move along it, and speed is in origin units per second.
class Camera {
    constructor(fov = 60) {
        this.pos = new WorldPos();
        this.q = quat.id();
        this.fov = fov * DEG;
        this.vel = [0, 0, 0];
    }
}

class Input {
    constructor(io) {
        const canvas = io.canvas;
        this.keys = new Set();
        this.dx = this.dy = this.wheel = 0;
        this.pressed = [];
        this.dragging = false;
        io.listen(canvas, 'pointerdown', e => { this.dragging = true; canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); });
        io.listen(canvas, 'pointerup', e => { this.dragging = false; canvas.releasePointerCapture(e.pointerId); canvas.classList.remove('drag'); });
        io.listen(canvas, 'pointermove', e => { if (this.dragging) { this.dx += e.movementX; this.dy += e.movementY; } });
        io.listen(canvas, 'wheel', e => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
        io.listen(window, 'keydown', e => {
            if (e.repeat) return;
            this.keys.add(e.code);
            this.pressed.push(e.code);
            if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        });
        io.listen(window, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }

    down(code) { return this.keys.has(code); }
    consume() { const r = { dx: this.dx, dy: this.dy, wheel: this.wheel, pressed: this.pressed }; this.dx = this.dy = this.wheel = 0; this.pressed = []; return r; }
}

class CameraController {
    constructor(camera, input) {
        this.cam = camera;
        this.input = input;
        this.speedExp = 0;
        this.level = true;
    }

    // maxExp: with auto scale the speed already follows proximity, so the wheel only fine-tunes it
    // (a large boost on top would feed back into an exponential escape)
    update(dt, io, origin, prox, minAlt, maxExp) {
        const cam = this.cam, inp = this.input, U = origin.up;
        this.speedExp = clamp(this.speedExp - io.wheel, -8, maxExp);
        if (io.dx || io.dy) {
            cam.q = quat.norm(quat.mul(quat.axisAngle(U, -io.dx * 0.0025), cam.q));
            cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([1, 0, 0], -io.dy * 0.0025)));
        }
        const roll = (inp.down('KeyQ') ? 1 : 0) - (inp.down('KeyE') ? 1 : 0);
        const [X, , Z] = quat.axes(cam.q);
        if (roll) cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([0, 0, 1], roll * 1.3 * dt)));
        else if (this.level && prox.body && prox.alt < prox.body.radius * 0.5 && Math.abs(v3.dot(Z, U)) < 0.97) {
            // settle the horizon on origin +Y near a surface
            const err = Math.asin(clamp(v3.dot(X, U), -1, 1));
            cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([0, 0, 1], -err * Math.min(1, dt * 2.5))));
        }

        let m = [0, 0, 0];
        if (inp.down('KeyW') || inp.down('ArrowUp')) m = v3.sub(m, Z);
        if (inp.down('KeyS') || inp.down('ArrowDown')) m = v3.add(m, Z);
        if (inp.down('KeyA') || inp.down('ArrowLeft')) m = v3.sub(m, X);
        if (inp.down('KeyD') || inp.down('ArrowRight')) m = v3.add(m, X);
        if (inp.down('Space')) m = v3.add(m, U);
        if (inp.down('KeyC')) m = v3.sub(m, U);
        const boost = (inp.down('ShiftLeft') || inp.down('ShiftRight') ? 10 : 1) * (inp.down('ControlLeft') || inp.down('ControlRight') ? 0.1 : 1);
        this.unitSpeed = 6 * 2 ** this.speedExp * boost;           // origin units / s
        const target = v3.len(m) ? v3.mul(v3.norm(m), this.unitSpeed * origin.scale) : [0, 0, 0];
        cam.vel = v3.lerp(cam.vel, target, 1 - Math.exp(-dt * 6));
        cam.pos.addIn(v3.mul(cam.vel, dt));
        const edge = MAX_CELL * 0.9;
        if (cam.pos.c.some(c => Math.abs(c) > edge)) {
            cam.pos = new WorldPos(cam.pos.c.map(c => clamp(c, -edge, edge)), cam.pos.l);
            cam.vel = [0, 0, 0];
            this.atEdge = true;
        }

        // stay above every surface
        for (const b of prox.body ? [prox.body] : []) {
            const d = cam.pos.sub(b.pos), len = v3.len(d), floor = b.radius + minAlt;
            if (len < floor) {
                const n = v3.mul(d, 1 / len);
                cam.pos.addIn(v3.mul(n, floor - len));
                const vn = v3.dot(cam.vel, n);
                if (vn < 0) cam.vel = v3.madd(cam.vel, n, -vn);
            }
        }
    }
}

// ------------------------------------------------------------------------------------------- game/hud
// The screen keeps the in-world labels and toasts; the readout (lines) and every option are on the engine's handheld
// (FeatureWorld.handheld)
class Hud {
    constructor(ui) {
        this.lines = [];
        this.toaster = new Toast(ui.$('toast'));
        this.labels = new LabelLayer(ui.$('labels'));
        this.showLabels = true;
        this.last = 0;
    }

    toast(msg, ms) { this.toaster.show(msg, ms); }

    update(app, prox, now) {
        if (now - this.last < 100) return;
        this.last = now;
        const f = app.floating, o = f.origin, cam = app.camera, w = app.world, st = f.stats;
        const onoff = v => v ? '<span class="on">on </span>' : '<span class="off">OFF</span>';
        const camO = o.toLocal(cam.pos), wp = cam.pos.metres(), up = o.up;
        const tilt = Math.acos(clamp(up[1], -1, 1)) / DEG;
        const where = prox.body ? `${prox.body.label || prox.body.id}  alt ${fmtDist(prox.alt)}` : '-';
        const lines = [
            `<span class="t">ENTITY ORIGIN // ${w.scenario.name || 'scenario'}</span>`,
            `camera   ${fmtDist(v3.len(wp))} from world 0   speed ${fmtDist(v3.len(cam.vel))}/s`,
            `nearest  ${where}${prox.near ? `   · ${prox.near.label} ${fmtDist(v3.len(cam.pos.sub(prox.near.pos)))}` : ''}`,
            `<span class="t">ORIGIN MATRIX</span>  <span class="m">p' = R^T (p - T) / s</span>`,
            `${onoff(f.translate)} T  cell (${o.pos.c.join(', ')})`,
            `        local (${o.pos.l.map(x => x.toFixed(2)).join(', ')}) m`,
            `${onoff(f.rotate)} R  +Y = (${up.map(x => x.toFixed(3)).join(', ')})  ${tilt.toFixed(1)}° off world Y`,
            `${onoff(f.scale)} G  s = 2^${Math.log2(o.scale).toFixed(0)} = ${fmtDist(o.scale)} per unit`,
            `camera in origin space (${camO.map(x => x.toFixed(2)).join(', ')}) units   f32 step ${fmtDist(f32Step(v3.len(camO)) * o.scale)}`,
            `<span class="t">REBASE</span>   #${st.count}  last ${st.reason}  ${st.ms < 0.1 ? '<100' : (st.ms * 1000).toFixed(0)} µs  ${st.bytes} B${f.everyFrame ? '  <span class="w">every frame</span>' : ''}`,
            `<span class="m">         O(1): instance buffer untouched (${w.instanceCount.toLocaleString()} instances, ${(w.store.byteLength / 1048576).toFixed(1)} MB)</span>`,
            `GPU      ${app.renderer.draws} draws · ${w.bodies.length} bodies · ${w.dynamic.length} dynamic (${w.store.bytes} B/frame) · density ×${w.density}`,
            `         ${app.fps.toFixed(0)} fps${app.paused ? '  <span class="w">paused</span>' : ''}${w.store.outOfRange ? `  <span class="off">${w.store.outOfRange} beyond ±2^30 cells</span>` : ''}`,
        ];
        if (!f.translate) lines.push('<span class="off">translation rebasing off: classic float32 coordinates around world 0</span>');
        this.lines = lines;
    }

    // names of bodies and landmarks, projected in doubles
    drawLabels(app) {
        const L = this.labels;
        L.begin();
        if (!this.showLabels) return;
        L.font();
        const dpr = L.dpr, o = app.floating.origin, cam = app.camera, vp = app.viewProj;
        const items = [...app.world.bodies, ...app.world.landmarks], placed = [];
        for (const e of items) {
            if (!e.label) continue;
            const d = v3.len(cam.pos.sub(e.pos));
            if (d < e.radius * 1.5 && !(e instanceof Body)) continue;
            if (e instanceof Body && d - e.radius < e.radius * 0.05) continue;
            const at = L.place(vp, o.toLocal(e.pos));
            if (!at) continue;
            const [x, y] = at;
            if (placed.some(p => Math.abs(p[0] - x) < 140 * dpr && Math.abs(p[1] - y) < 13 * dpr)) continue;
            placed.push(at);
            const body = e instanceof Body;
            L.mark(at, body ? 'rgba(110,220,255,0.85)' : 'rgba(255,201,74,0.85)', `${e.label}  ${fmtDist(body ? d - e.radius : d)}`);
        }
    }
}

// ------------------------------------------------------------------------------------------ game/app
class App {
    constructor(fx) {
        this.fx = fx;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new Input(fx.io);
        this.hud = new Hud(fx.ui);
        this.camera = new Camera();
        this.controller = new CameraController(this.camera, this.input);
        this.density = 1;
        this.time = 0;
        this.paused = false;
        this.fps = 60;
        this.viewProj = new Float64Array(16);
    }

    async start() {
        await this.renderer.init();
        this.floating = new FloatingOrigin({}, this.renderer);
    }

    load(scenario, keepCamera = false) {
        const world = new World(scenario, this.renderer.device, this.density);
        if (this.world) this.world.destroy();
        this.world = world;
        this.scenario = scenario;
        this.renderer.setWorld(world);
        this.floating.cfg = { ...this.floating.cfg, ...(scenario.origin || {}) };
        this.floating.force = true;
        const camCfg = scenario.camera || {};
        this.camera.fov = (camCfg.fov || 60) * DEG;
        this.minAlt = camCfg.minAltitude ?? 1.7;
        this.lighting = { exposure: 1, sun: 1.6, ...(scenario.lighting || {}) };
        this.bookmarks = scenario.bookmarks || [];
        if (!keepCamera) {
            const b = this.bookmarks.find(b => b.key === scenario.start) || this.bookmarks[0];
            if (b) this.jump(b);
        }
    }

    jump(b) {
        const f = this.world.resolve(b.at), cam = this.camera;
        cam.pos = f.pos.clone();
        const up = quat.rotate(f.q, [0, 1, 0]);
        cam.q = b.look ? quat.look(v3.norm(this.world.get(b.look).pos.sub(cam.pos)), up) : f.q;
        cam.vel = [0, 0, 0];
        this.controller.speedExp = 0;
        this.hud.toast(b.name);
        this.fx.emit('jump', { name: b.name });
    }

    handleKeys(pressed) {
        const f = this.floating;
        for (const code of pressed) {
            const b = this.bookmarks.find(b => code === `Digit${b.key}` || code === `Numpad${b.key}`);
            if (b) { this.jump(b); continue; }
            switch (code) {
                case 'KeyT': f.translate = !f.translate; this.fx.emit('toggle', { on: f.translate }); this.hud.toast(f.translate ? 'Translation rebasing ON' : 'Translation rebasing OFF: origin pinned to world 0, float32 breaks down far away'); break;
                case 'KeyR': f.rotate = !f.rotate; this.fx.emit('toggle', { on: f.rotate }); this.hud.toast(f.rotate ? 'Rotation rebasing ON: origin +Y follows the local vertical' : 'Rotation rebasing OFF: origin axes = world axes'); break;
                case 'KeyG': f.scale = !f.scale; this.fx.emit('toggle', { on: f.scale }); this.hud.toast(f.scale ? 'Scale rebasing ON: units follow proximity' : 'Scale rebasing OFF: 1 unit = 1 m (use the wheel for speed)'); break;
                case 'KeyO': f.everyFrame = !f.everyFrame; this.fx.emit('toggle', { on: f.everyFrame }); this.hud.toast(f.everyFrame ? 'Rebasing every frame: cost stays one 80 B upload' : 'Rebasing on demand'); break;
                case 'KeyL': this.hud.showLabels = !this.hud.showLabels; break;
                case 'KeyP': this.paused = !this.paused; break;
                case 'BracketLeft': case 'BracketRight': {
                    const d = clamp(this.density * (code === 'BracketRight' ? 2 : 0.5), 1 / 16, 8);
                    if (d !== this.density) { this.density = d; this.load(this.scenario, true); this.hud.toast(`Field density ×${d}: ${this.world.instanceCount.toLocaleString()} instances`); }
                    break;
                }
            }
        }
    }

    // frame uniform: camera in origin space (doubles until the final f32 store)
    writeFrame(prox) {
        const r = this.renderer, o = this.floating.origin, cam = this.camera, F = r.frameData;
        const camO = o.toLocal(cam.pos), qO = quat.mul(quat.conj(o.q), cam.q), [X, Y, Z] = quat.axes(qO);
        const aspect = r.width / r.height, tanH = Math.tan(cam.fov / 2);
        this.viewProj = m4.mul(m4.reversedInfinite(cam.fov, aspect, NEAR), m4.view(qO, camO));
        F.set(this.viewProj, 0);
        F.set([camO[0], camO[1], camO[2], this.time % 3600], 16);
        F.set([-Z[0], -Z[1], -Z[2], NEAR], 20);
        F.set([X[0], X[1], X[2], tanH * aspect], 24);
        F.set([Y[0], Y[1], Y[2], tanH], 28);
        const sun = o.toLocal(this.world.sunPos);
        F.set([sun[0], sun[1], sun[2], 2 * tanH / r.height], 32);
        // sky: inside an atmosphere on the day side
        let sky = [0, 0, 0], starVis = 1;
        const b = prox.body;
        if (b && b.atmosphere) {
            const k = Math.pow(clamp(1 - prox.alt / b.atmosphere.height, 0, 1), 1.5);
            const upW = v3.norm(cam.pos.sub(b.pos)), sunW = v3.norm(this.world.sunPos.sub(cam.pos));
            const day = clamp((v3.dot(upW, sunW) + 0.15) / 0.4, 0, 1);
            sky = v3.mul(b.atmosphere.color, k * day * 0.9);
            starVis = 1 - clamp(k * day * 3, 0, 1);
        }
        F.set([sky[0], sky[1], sky[2], starVis], 36);
        F.set([this.lighting.exposure, this.lighting.sun, 0, 0], 40);
    }

    // update: input, camera, world, rebase; render: the frame. The host runs both, or (in a composition) the
    // camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        const r = this.renderer, w = this.world, f = this.floating;
        if (update) {
            if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
            if (!this.paused) this.time += dt;
            const io = this.input.consume();
            this.handleKeys(io.pressed);
            const near = w.proximity(this.camera.pos);
            if (!this.fx.cameraLocked) this.controller.update(dt, io, f.origin, near, this.minAlt, f.scale ? 6 : f.cfg.maxScaleExp);
            if (this.controller.atEdge) { this.controller.atEdge = false; this.hud.toast('Edge of the world: ±2^30 cells'); }
            w.update(dt, this.time);
            const count = f.stats.count;
            this.prox = f.update(this.camera.pos, w);         // O(1) rebase when needed
            if (f.stats.count !== count) this.fx.emit('rebase', { reason: f.stats.reason, scale: f.origin.scale });
        }
        if (!render) return;
        const prox = this.prox ||= f.update(this.camera.pos, w);
        r.resize();
        this.writeFrame(prox);
        w.bodies.forEach((b, i) => b.pack(r.bodyData, i * BODY_FLOATS, f.origin, this.camera.pos));
        r.render(w, w.bodies.length);
        this.hud.drawLabels(this);
        this.hud.update(this, prox, now);
    }
}

// ------------------------------------------------------------------------------------- feature world
// This demo as one world of the engine (js/engine/host.js calls these).
const HUD_HTML = `<canvas class="labels" data-hud="labels"></canvas><div data-hud="toast" class="panel"></div>`;

class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = HUD_HTML;
    }

    async init() {
        this.app = new App(this.fx);
        await this.app.start();
        this.app.load(this.fx.native);
    }

    frame(now, dt, opts) { this.app.frame(now, dt, opts); }

    // reversed-Z, infinite far plane, 4x MSAA; depth is in origin units: s metres each
    depth() {
        const r = this.app.renderer;
        return r.depthView && { view: r.depthView, kind: 'reversed', near: NEAR, samples: SAMPLES, scale: this.app.floating.origin.scale };
    }

    // the camera, in metres (doubles) from world 0
    get view() {
        const c = this.app.camera;
        return { pos: c.pos.metres(), fwd: quat.rotate(c.q, [0, 0, -1]), up: quat.rotate(c.q, [0, 1, 0]), fov: c.fov };
    }

    setView(v) {
        const c = this.app.camera;
        c.pos = WorldPos.of(v.pos);
        c.q = quat.look(v.fwd, v.up);
        if (v.fov) c.fov = v.fov;
        c.vel = [0, 0, 0];
    }

    // where an entity is (other worlds can ride on it: layer.transform.anchor)
    anchor(id) {
        const e = this.app.world?.byId.get(id);
        return e && e.frame ? { pos: e.frame.pos.metres(), q: e.frame.q } : null;
    }

    stats() {
        const a = this.app, f = a.floating, cam = a.camera, prox = a.prox || {};
        return {
            name: a.world.scenario.name, fps: a.fps, paused: a.paused,
            speed: v3.len(cam.vel), fromZero: v3.len(cam.pos.metres()),
            body: prox.body ? prox.body.label || prox.body.id : '', altitude: prox.alt ?? 0, near: prox.near ? prox.near.label : '',
            rebases: f.stats.count, reason: f.stats.reason, scale: f.origin.scale,
            translate: f.translate, rotate: f.rotate, scaling: f.scale, everyFrame: f.everyFrame,
            instances: a.world.instanceCount, draws: a.renderer.draws, density: a.density,
            sunAt: this.sunProbes(),
        };
    }

    // the direction to the sun in the frame of every entity marked `sunProbe` (worlds riding on it light by it, through a
    // link: { to: "valley.sunDir", value: "sol.sunAt['site']" })
    sunProbes() {
        const w = this.app.world, out = {};
        for (const e of w.entities) {
            if (!e.def.sunProbe || !e.frame) continue;
            const d = v3.norm(w.sunPos.sub(e.frame.pos));
            out[e.id] = quat.rotate(quat.conj(e.frame.q), d);
        }
        return out;
    }

    // the readout and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() {
        const a = this.app, f = a.floating;
        if (!a.world) return [];
        const key = code => () => a.handleKeys([code]);
        const B = a.bookmarks;
        return [
            { id: 'status', title: 'Status', sub: 'Camera, origin matrix, rebasing', icon: [[88, 86, 214], 'O'], sections: Handheld.panel(a.hud.lines) },
            B.length && { id: 'places', title: 'Places', sub: `${B.length} bookmarks`, icon: [[255, 149, 0], 'B'], sections: [
                { cells: B.map(b => ({ action: b.name, key: `bookmark ${b.key}`, run: () => a.jump(b) })), footer: 'The number keys jump there too.' }] },
            { id: 'options', title: 'Origin', sub: `rebasing ${[f.translate && 'T', f.rotate && 'R', f.scale && 'G'].filter(Boolean).join(' ') || 'off'} · density ×${a.density}`, icon: [[48, 176, 199], 'R'], sections: [
                { header: 'REBASING', cells: [
                    { toggle: 'Translation', on: f.translate, set: key('KeyT') },
                    { toggle: 'Rotation', on: f.rotate, set: key('KeyR') },
                    { toggle: 'Scale', on: f.scale, set: key('KeyG') },
                    { toggle: 'Every frame', on: f.everyFrame, set: key('KeyO') }],
                    footer: 'p\' = R^T (p - T) / s: what the GPU sees stays near zero however far the camera goes.' },
                { header: 'FIELD', cells: [
                    { choice: 'Density', options: [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8].map(d => `×${d < 1 ? `1/${1 / d}` : d}`), index: Math.round(Math.log2(a.density)) + 4,
                        pick: i => { const d = 2 ** (i - 4); if (d !== a.density) { a.density = d; a.load(a.scenario, true); } } }] },
                { header: 'VIEW', cells: [
                    { toggle: 'Labels', on: a.hud.showLabels, set: v => { a.hud.showLabels = v; } },
                    { toggle: 'Paused', on: a.paused, set: v => { a.paused = v; } }] },
            ] },
        ].filter(Boolean);
    }

    set(key, v) {
        const a = this.app, f = a.floating;
        if (key === 'paused') a.paused = !!v;
        else if (key === 'translate' || key === 'rotate' || key === 'scale') f[key] = !!v;
        else if (key === 'everyFrame') f.everyFrame = !!v;
        else if (key === 'labels') a.hud.showLabels = !!v;
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
