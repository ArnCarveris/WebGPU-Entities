'use strict';
// Value noise on the CPU: 2D and 3D lattices, fractal sums of them, ridged multifractal.

Features.kit('noise', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp } = Common;
const { hash2, hash3 } = kit;

// 2D value noise in [-1, 1] (seeded)
function valueNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

// ... in [0, 1]
const valueNoise01 = (x, y, seed) => valueNoise(x, y, seed) * 0.5 + 0.5;

// 3D value noise in [-1, 1] (seeded)
function valueNoise3(x, y, z, s = 0) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const h = (a, b, c) => hash3(ix + a, iy + b, iz + c, s);
    const x00 = lerp(h(0, 0, 0), h(1, 0, 0), u), x10 = lerp(h(0, 1, 0), h(1, 1, 0), u);
    const x01 = lerp(h(0, 0, 1), h(1, 0, 1), u), x11 = lerp(h(0, 1, 1), h(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

// the xz plane of valueNoise3, as a 2D noise (x, y, seed) for fbm
const valueNoise3xz = (x, z, s) => valueNoise3(x, 0, z, s);

// Fractal sum of `octaves` of a 2D noise(x, y, seed) (default valueNoise, in [-1, 1]): each octave `lacunarity` times
// the frequency and `gain` times the weight of the one before, moved by `offset` and its seed by `seedStep` per octave.
// ridged: each octave folded to 1 - |n| (sharp crests). normalize: divided by the total weight (about the noise's
// range), else the plain weighted sum (first weight 1).
function fbm(x, y, { octaves = 5, seed = 1, ridged = false, gain = 0.5, lacunarity = 2.03, offset = [17.3, -9.1], seedStep = 31,
    normalize = true, noise = valueNoise } = {}) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
        const n = noise(x * f + o * offset[0], y * f + o * offset[1], seed + o * seedStep);
        sum += (ridged ? 1 - Math.abs(n) : n) * amp;
        norm += amp;
        amp *= gain;
        f *= lacunarity;
    }
    return normalize ? sum / norm : sum;
}

// Ridged multifractal over the xz plane of valueNoise3: sharp crests (mountain ranges), each octave weighted by the one
// below it, in [0, 1]
function ridgedMultifractal(x, z, octaves, seed) {
    let t = 0, a = 0.5, w = 1, n = 0;
    for (let i = 0; i < octaves; i++) {
        let r = 1 - Math.abs(valueNoise3(x, 0, z, seed + i));
        r *= r * w;
        w = clamp(r * 2, 0, 1);
        t += r * a;
        n += a;
        x *= 2.07; z *= 2.07; a *= 0.5;
    }
    return t / n;
}

return { valueNoise, valueNoise01, valueNoise3, valueNoise3xz, fbm, ridgedMultifractal };
});
