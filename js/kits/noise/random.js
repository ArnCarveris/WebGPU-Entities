'use strict';
// Seeded randomness: generators and integer hashes.

Features.kit('noise', (engine, kit) => {
// a seeded generator: each call the next number in [0, 1)
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// mulberry32 from any number (seeds close together give unrelated sequences)
const seededRandom = seed => mulberry32((seed * 2654435761) >>> 0 || 1);

// integer lattice points to [0, 1): 2D (with a seed) and 3D (with a seed)
function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function hash3(x, y, z, s) {
    let h = (Math.imul(x, 0x27d4eb2d) + Math.imul(y, 0x165667b1) + Math.imul(z, 0x9e3779b1) + Math.imul(s, 0x85ebca6b)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// the PCG hash of a u32, and it to [0, 1]: as NoiseWGSL.pcg's pcg / rnd in WGSL, so the CPU can pick what a shader picks
function pcg(v) {
    const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
    const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
}
const pcgRandom = v => Math.fround(pcg(v)) / 4294967295;

return { mulberry32, seededRandom, hash2, hash3, pcg, pcgRandom };
});
