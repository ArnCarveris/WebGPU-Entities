'use strict';
// Matrices.

Features.part('portal', (engine, feature) => {
const { Common } = engine;

// Matrices (column-major Float64Array): js/engine/common.js's (trs: yaw-only TRS, basis)
const { m4 } = Common;
const IDENTITY = m4.identity();

return { m4, IDENTITY };
});
