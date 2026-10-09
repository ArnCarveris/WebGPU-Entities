'use strict';
// Common: the helpers several features (and the engine) share, so each feature script keeps only what is its own.
// A feature takes them from its factory's `engine` ({ Common } = engine); engine scripts use the global.
//
//   scalars      DEG, clamp, sat01, lerp, smoothstep
//   v3, quat, m4 3-vectors as arrays; quaternions [x, y, z, w]; column-major 4x4 (Float64Array), WebGPU clip space
//                (depth 0..1); frustumPlanes
//   yawPitch     the yaw / pitch (radians) of a fly camera looking along a direction
//   polylines    polylineLengths, polylineNearest, polylineBox on [x, z] points
//   GroundFrame  a centre [x, z] and yaw on the ground (what structures and settlements are laid out with)
//   GPU          makeBuffer, gridIndices, bindLayout / bindGroup (bind groups from a list of binding kinds)
//   text         fmtKm (m or km), fmtNum (k / M / G with a unit), fmtK (k / M counts)
//   controls     PointerInput (look / act / keys on a world's canvas; a camera: kits.view's FirstPersonView)
//
// Bigger generic building blocks (random and noise, a first-person view, a world's HUD, terrain, transit lines...) are
// kits (js/kits, see Features.KITS).

const Common = (() => {
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sat01 = x => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------------ vectors
const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    madd: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

// ------------------------------------------------------------------------------------------------ quaternions
// [x, y, z, w]. Features add their own conventions (euler angles...) with { ...Common.quat, ... }.
const quat = {
    identity: () => [0, 0, 0, 1],
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
    // yaw about Y, then pitch about X, then roll about Z (radians): Ry * Rx * Rz
    yxz(yaw, pitch, roll) {
        return quat.mul(quat.mul(quat.axisAngle([0, 1, 0], yaw), quat.axisAngle([1, 0, 0], pitch)), quat.axisAngle([0, 0, 1], roll));
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
    // camera-style orientation: looks down -Z
    look(fwd, up) {
        const Z = v3.norm(v3.mul(fwd, -1));
        let X = v3.cross(up, Z);
        if (v3.len(X) < 1e-9) X = v3.cross(Math.abs(Z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], Z);
        X = v3.norm(X);
        return quat.fromAxes(X, v3.cross(Z, X), Z);
    },
};

// --------------------------------------------------------------------------------------------- matrices
// Features add their own with { ...Common.m4, ... }.
const m4 = {
    identity() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    mul(a, b) {
        const o = new Float64Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
        return o;
    },
    // reversed Z, infinite far plane: depth = near / view distance (1 at the near plane, 0 at infinity)
    reversedInfinite(fovy, aspect, near) {
        const f = 1 / Math.tan(fovy / 2);
        return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
    },
    // depth 0 at the near plane, 1 at the far one
    perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
        return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]);
    },
    translate(t) { const m = m4.identity(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; },
    // translation p, yaw `deg` degrees about y, scale s (a number or [x, y, z])
    trs(p, deg = 0, s = 1) {
        const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        const [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        return new Float64Array([c * sx, 0, -sn * sx, 0, 0, sy, 0, 0, sn * sz, 0, c * sz, 0, p[0], p[1], p[2], 1]);
    },
    // columns x, y, z and origin o
    basis(x, y, z, o) {
        return new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1]);
    },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    // translation p, rotation q (a quaternion), scale s (a number or [x, y, z])
    fromTRS(p, q, s) {
        const [x, y, z, w] = q, [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
        return new Float64Array([(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
            2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
            2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, p[0], p[1], p[2], 1]);
    },
    // a point (with the translation) or a direction (without) through m: [x, y, z]
    point(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    },
    dir(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
    },
    // view matrix from the eye and its basis (rows: right, up, back)
    view(eye, r, u, f) {
        const b = [-f[0], -f[1], -f[2]];
        return new Float64Array([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0,
            -v3.dot(r, eye), -v3.dot(u, eye), -v3.dot(b, eye), 1]);
    },
    // the model-view of frame m (column-major, model to world) for the eye and its basis, built in doubles about the eye:
    // what is near the eye keeps its precision however far from the world's origin both are (an f32 world-space vertex a
    // few kilometres out is millimetres off)
    aboutEye(m, eye, r, u, f) {
        const rows = [r, u, [-f[0], -f[1], -f[2]]], mv = new Float64Array(16);
        for (let c = 0; c < 4; c++) for (let k = 0; k < 3; k++) {
            const col = c < 3 ? [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]] : [m[12] - eye[0], m[13] - eye[1], m[14] - eye[2]];
            mv[c * 4 + k] = v3.dot(rows[k], col);
        }
        mv[15] = 1;
        return mv;
    },
    lookAt(eye, target, up) {
        const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
        return new Float64Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1]);
    },
    // a point to clip space: [x, y, z, w]
    project(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]];
    },
    // the inverse; the identity when `a` is singular
    invert(a) {
        const o = new Float64Array(16);
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det) return m4.identity();
        det = 1 / det;
        o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
        o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
        o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
        o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
        o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
        return o;
    },
};

// Frustum planes of a view-projection [nx, ny, nz, d], unit normals, inside when dot(n, p) + d >= 0: left, right,
// bottom, top, near, far. Reversed infinite Z (m4.reversedInfinite) has no far plane: the 6th never culls.
function frustumPlanes(m, { reversed = false } = {}) {
    const row = r => [m[r], m[4 + r], m[8 + r], m[12 + r]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const comb = (a, b, s) => a.map((x, i) => x + s * b[i]);
    const planes = [comb(r3, r0, 1), comb(r3, r0, -1), comb(r3, r1, 1), comb(r3, r1, -1), ...(reversed ? [comb(r3, r2, -1)] : [r2, comb(r3, r2, -1)])]
        .map(p => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return p.map(x => x / l); });
    if (reversed) planes.push([0, 0, 0, 1]);
    return planes;
}

// a fly camera (forward = [-sin yaw cos pitch, sin pitch, -cos yaw cos pitch]) looking along d
const yawPitch = d => ({ yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(clamp(d[1], -1, 1)) });

// ----------------------------------------------------------------------------------------------- polylines
// arc length at each point
function polylineLengths(pts) {
    const lens = [0];
    for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return lens;
}

// nearest point on a polyline: { dist, s (arc length at that point) }
function polylineNearest(pts, lens, x, z) {
    let best = Infinity, bs = 0;
    for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
        const px = ax + dx * t - x, pz = az + dz * t - z, d = px * px + pz * pz;
        if (d < best) { best = d; bs = lens[k] + t * Math.sqrt(l2); }
    }
    return { dist: Math.sqrt(best), s: bs };
}

// [x0, z0, x1, z1] around the points, `pad` wider
function polylineBox(pts, pad) {
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    return [Math.min(...xs) - pad, Math.min(...zs) - pad, Math.max(...xs) + pad, Math.max(...zs) + pad];
}

// a frame on the ground: centre [x, z] and yaw; local x runs along (cos, sin) in xz, local z along (-sin, cos)
class GroundFrame {
    constructor(c, yaw) { this.c = c; this.yaw = yaw; this.cs = Math.cos(yaw); this.sn = Math.sin(yaw); }
    static facing(c, z) { return new GroundFrame(c, Math.atan2(-z[0], z[1])); }      // local +z along z
    at(lx, y, lz) { return [this.c[0] + lx * this.cs - lz * this.sn, y, this.c[1] + lx * this.sn + lz * this.cs]; }
    xz(lx, lz) { const p = this.at(lx, 0, lz); return [p[0], p[2]]; }
    turned(a) { return new GroundFrame(this.c, this.yaw + a); }
}

// ------------------------------------------------------------------------------------------------------ GPU
function makeBuffer(device, size, usage, data) {
    const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, mappedAtCreation: !!data });
    if (data) { new data.constructor(b.getMappedRange()).set(data); b.unmap(); }
    return b;
}

// two triangles per cell of a w x w vertex grid
function gridIndices(w) {
    const idx = new Uint32Array((w - 1) * (w - 1) * 6);
    let o = 0;
    for (let j = 0; j < w - 1; j++) for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    return idx;
}

// bind group layout entries from binding kinds, in binding order: uniform, read (read-only storage), storage, tex[:sample
// type], tex3d, array (2d-array), depth, sampler, write:<format> / write3d:<format> (write-only storage textures)
function bindLayoutEntry(binding, visibility, kind) {
    const [k, arg] = kind.split(':'), e = { binding, visibility };
    if (k === 'uniform') e.buffer = { type: 'uniform' };
    else if (k === 'read') e.buffer = { type: 'read-only-storage' };
    else if (k === 'storage') e.buffer = { type: 'storage' };
    else if (k === 'tex') e.texture = { sampleType: arg || 'float', viewDimension: '2d' };
    else if (k === 'tex3d') e.texture = { sampleType: 'float', viewDimension: '3d' };
    else if (k === 'array') e.texture = { sampleType: 'float', viewDimension: '2d-array' };
    else if (k === 'depth') e.texture = { sampleType: 'depth', viewDimension: '2d' };
    else if (k === 'sampler') e.sampler = { type: 'filtering' };
    else if (k === 'write') e.storageTexture = { access: 'write-only', format: arg, viewDimension: '2d' };
    else if (k === 'write3d') e.storageTexture = { access: 'write-only', format: arg, viewDimension: '3d' };
    else throw new Error(`layout kind ${kind}`);
    return e;
}
const bindResource = r => r instanceof GPUBuffer ? { buffer: r } : r;
function bindLayout(device, visibility, kinds) {
    return device.createBindGroupLayout({ entries: kinds.map((k, b) => bindLayoutEntry(b, visibility, k)) });
}
// resources (buffers, views, samplers) in binding order
function bindGroup(device, layout, resources, label) {
    return device.createBindGroup({ label, layout, entries: resources.map((r, binding) => ({ binding, resource: bindResource(r) })) });
}

// ----------------------------------------------------------------------------------------------------- text
const fmtKm = d => d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)} km`;
function fmtNum(x, unit = '') {
    const a = Math.abs(x);
    if (a >= 1e9) return `${(x / 1e9).toFixed(2)}G${unit}`;
    if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M${unit}`;
    if (a >= 1e4) return `${(x / 1e3).toFixed(1)}k${unit}`;
    return `${x.toFixed(a < 10 ? 1 : 0)}${unit}`;
}
const fmtK = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));

// ---------------------------------------------------------------------------------------------- controls
// Pointer and keys over a world's canvas (io: its InputRouter scope): left drag looks; the right button (or Ctrl + left)
// acts, `acting` while held and once per press in consume().clicks. Without `act`, any button looks.
class PointerInput {
    constructor(io, { act = true } = {}) {
        const el = io.canvas;
        this.el = el;
        this.keys = new Set();
        this.pressed = [];
        this.dx = this.dy = this.wheel = 0;
        this.mouse = [0, 0];
        this.looking = false;
        this.acting = false;
        this.clicks = [];
        io.listen(el, 'contextmenu', e => e.preventDefault());
        io.listen(el, 'pointerdown', e => {
            el.setPointerCapture(e.pointerId);
            if (act && (e.button === 2 || (e.button === 0 && e.ctrlKey))) { this.acting = true; this.clicks.push([e.clientX, e.clientY]); }
            else if (e.button === 0 || !act) { this.looking = true; el.classList.add('drag'); }
        });
        io.listen(el, 'pointermove', e => {
            this.mouse = [e.clientX, e.clientY];
            if (this.looking) { this.dx += e.movementX; this.dy += e.movementY; }
        });
        const up = () => { this.looking = this.acting = false; el.classList.remove('drag'); };
        io.listen(el, 'pointerup', up);
        io.listen(el, 'pointercancel', up);
        io.listen(el, 'wheel', e => { e.preventDefault(); this.wheel += Math.sign(e.deltaY); }, { passive: false });
        io.listen(window, 'keydown', e => {
            if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
            if (!e.repeat) this.pressed.push(e.code);
            this.keys.add(e.code);
        });
        io.listen(window, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => { this.keys.clear(); up(); });
    }

    // what happened since the last call
    consume() {
        const r = { dx: this.dx, dy: this.dy, wheel: this.wheel, pressed: this.pressed, clicks: this.clicks };
        this.dx = this.dy = this.wheel = 0;
        this.pressed = [];
        this.clicks = [];
        return r;
    }
}

return {
    DEG, clamp, sat01, lerp, smoothstep, v3, quat, m4, frustumPlanes, yawPitch,
    polylineLengths, polylineNearest, polylineBox, GroundFrame, makeBuffer, gridIndices, bindLayoutEntry, bindResource, bindLayout, bindGroup,
    fmtKm, fmtNum, fmtK, PointerInput,
};
})();
