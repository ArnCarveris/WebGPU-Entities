'use strict';
// Quaternions, the view and projection matrices, and distances as text.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;
const { AU } = feature;

// Doubles on the CPU; only origin-relative values ever reach the GPU as f32 (v3 and the m4 basics: js/engine/common.js).

// Quaternions [x, y, z, w] (Common.quat's); euler: [yaw, pitch, roll] in degrees, yaw about Y, then pitch about X, then
// roll about Z
const quat = {
    ...Common.quat,
    euler: deg => Common.quat.yxz((deg[0] || 0) * DEG, (deg[1] || 0) * DEG, (deg[2] || 0) * DEG),
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
