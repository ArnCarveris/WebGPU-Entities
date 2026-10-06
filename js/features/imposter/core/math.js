'use strict';
// Math: quaternions, matrices (column-major, WebGPU depth 0..1) and frustum planes.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;

// v3 and the m4 basics are js/engine/common.js's
const quat = {
    identity: () => [0, 0, 0, 1],
    axis(axis, rad) { const a = v3.norm(axis), s = Math.sin(rad / 2); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(rad / 2)]; },
    mul(a, b) {
        return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    },
    // degrees: a number is a yaw; [x, y, z] is applied as Ry * Rx * Rz
    euler(r) {
        if (r === undefined || r === null) return quat.identity();
        if (typeof r === 'number') r = [0, r, 0];
        return quat.mul(quat.mul(quat.axis([0, 1, 0], r[1] * DEG), quat.axis([1, 0, 0], r[0] * DEG)), quat.axis([0, 0, 1], r[2] * DEG));
    },
    rotate(q, v) { const t = v3.mul(v3.cross(q, v), 2); return v3.add(v3.add(v, v3.mul(t, q[3])), v3.cross(q, t)); },
    conj: q => [-q[0], -q[1], -q[2], q[3]],
};

const m4 = {
    ...Common.m4,
    fromTRS(p, q, s) {
        const [x, y, z, w] = q, [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
        return new Float64Array([(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
            2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
            2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, p[0], p[1], p[2], 1]);
    },
    compose(pos, rot, scale) { return m4.fromTRS(pos || [0, 0, 0], quat.euler(rot), scale ?? 1); },
    det3(m) { return v3.dot([m[0], m[1], m[2]], v3.cross([m[4], m[5], m[6]], [m[8], m[9], m[10]])); },
};

// Frustum planes (inside: dot(n, p) + d >= 0). Reversed infinite Z has no far plane: the 6th never culls.
function frustumPlanes(m) {
    const row = r => [m[r], m[4 + r], m[8 + r], m[12 + r]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const comb = (a, b, s) => a.map((x, i) => x + s * b[i]);
    const planes = [comb(r3, r0, 1), comb(r3, r0, -1), comb(r3, r1, 1), comb(r3, r1, -1), comb(r3, r2, -1)]
        .map(p => { const l = Math.hypot(p[0], p[1], p[2]) || 1; return p.map(x => x / l); });
    planes.push([0, 0, 0, 1]);
    return planes;
}

return { quat, m4, frustumPlanes };
});
