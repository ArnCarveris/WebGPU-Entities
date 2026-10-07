'use strict';
// Math: this engine's euler angles and model matrices over Common's quaternions and matrices.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;

// v3, quat and m4 are js/engine/common.js's; euler: degrees, a number is a yaw; [x, y, z] is applied as Ry * Rx * Rz
const quat = {
    ...Common.quat,
    euler(r) {
        if (r === undefined || r === null) return quat.identity();
        if (typeof r === 'number') r = [0, r, 0];
        return quat.yxz(r[1] * DEG, r[0] * DEG, r[2] * DEG);
    },
};

const m4 = {
    ...Common.m4,
    compose(pos, rot, scale) { return m4.fromTRS(pos || [0, 0, 0], quat.euler(rot), scale ?? 1); },
    det3(m) { return v3.dot([m[0], m[1], m[2]], v3.cross([m[4], m[5], m[6]], [m[8], m[9], m[10]])); },
};

return { quat, m4 };
});
