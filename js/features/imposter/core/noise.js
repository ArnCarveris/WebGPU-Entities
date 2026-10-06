'use strict';
// Seeded noise: value noise, ridged multifractal and fbm.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { clamp, lerp, mulberry32 } = Common;

const rng = seed => mulberry32((seed * 2654435761) >>> 0 || 1);
function hash3(x, y, z, s) {
    let h = (Math.imul(x, 0x27d4eb2d) + Math.imul(y, 0x165667b1) + Math.imul(z, 0x9e3779b1) + Math.imul(s, 0x85ebca6b)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function noise3(x, y, z, s = 0) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const h = (a, b, c) => hash3(ix + a, iy + b, iz + c, s);
    const x00 = lerp(h(0, 0, 0), h(1, 0, 0), u), x10 = lerp(h(0, 1, 0), h(1, 1, 0), u);
    const x01 = lerp(h(0, 0, 1), h(1, 0, 1), u), x11 = lerp(h(0, 1, 1), h(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}
// ridged multifractal: sharp crests (mountain ranges), each octave weighted by the one below it
function ridged(x, z, octaves, s) {
    let t = 0, a = 0.5, w = 1, n = 0;
    for (let i = 0; i < octaves; i++) {
        let r = 1 - Math.abs(noise3(x, 0, z, s + i));
        r *= r * w;
        w = clamp(r * 2, 0, 1);
        t += r * a;
        n += a;
        x *= 2.07; z *= 2.07; a *= 0.5;
    }
    return t / n;
}
function fbm(x, z, octaves, s) {
    let a = 0.5, f = 1, t = 0, n = 0;
    for (let i = 0; i < octaves; i++) { t += a * noise3(x * f, 0, z * f, s + i); n += a; a *= 0.5; f *= 2.03; }
    return t / n;
}

return { rng, noise3, ridged, fbm };
});
