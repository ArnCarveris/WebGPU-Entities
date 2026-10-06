'use strict';
// Half floats for rgba16float uploads and readback, and WGSL's pcg hash on the CPU.

Features.part('cloud', (engine, feature) => {
// half floats for rgba16float uploads / readback
const toHalf = (() => {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    return v => {
        f[0] = v;
        const x = u[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
        if (e <= 0) return s;
        if (e >= 31) return s | 0x7c00;
        return s | (e << 10) | (m >>> 13);
    };
})();
const fromHalf = h => {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
};

// WGSL's pcg, bit for bit
function pcg32(v) {
    const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
    const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
}

return { toHalf, fromHalf, pcg32 };
});
