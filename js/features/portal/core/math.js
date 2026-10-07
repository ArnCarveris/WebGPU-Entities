'use strict';
// Matrices.

Features.part('portal', (engine, feature) => {
const { Common } = engine;

// Matrix helpers (column-major Float64Array matrices) over js/engine/common.js's: yaw-only TRS and a basis.
const m4 = {
    ...Common.m4,
    trs(p, deg = 0, s = 1) {
        const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        const [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        return new Float64Array([c * sx, 0, -sn * sx, 0, 0, sy, 0, 0, sn * sz, 0, c * sz, 0, p[0], p[1], p[2], 1]);
    },
    basis(x, y, z, o) {
        return new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1]);
    },
};
const IDENTITY = m4.identity();

return { m4, IDENTITY };
});
