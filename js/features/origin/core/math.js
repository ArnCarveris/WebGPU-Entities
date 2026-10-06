'use strict';
// Quaternions, the view and projection matrices, and distances as text.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;
const { AU } = feature;

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

return { quat, m4, f32Step, vec3Of, fmtDist };
});
