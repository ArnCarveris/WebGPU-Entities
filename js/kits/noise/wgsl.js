'use strict';
// Noise on the GPU: WGSL functions to put into a shader, each under the name the shader calls it by.

Features.kit('noise', (engine, kit) => {
// Each takes the WGSL function's name (and, for noises, the name of the hash or noise it is built on, which the shader
// must also have), and returns its source.
const NoiseWGSL = {
    // ------------------------------------------------------------------------------------------- hashes to [0, 1)
    // the classic sin hash, vec2f -> f32 (cheap; fine at small coordinates)
    hashSin2: (name = 'hash') => /* wgsl */`
fn ${name}(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }`,

    // Dave Hoskins' hash without sine, vec2f -> f32 and vec3f -> f32
    hash12: (name = 'hash12') => /* wgsl */`
fn ${name}(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}`,
    hash13: (name = 'hash13') => /* wgsl */`
fn ${name}(p: vec3f) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}`,

    // a fract-only hash, vec2f -> f32
    hashFract2: (name = 'hash21') => /* wgsl */`
fn ${name}(p: vec2f) -> f32 {
    var q = fract(p * vec2f(123.34, 456.21));
    q += dot(q, q + 45.32);
    return fract(q.x * q.y);
}`,

    // integer hashes: a lattice point and a seed -> f32
    hashU2: (name = 'hash') => /* wgsl */`
fn ${name}(p: vec2u, s: u32) -> f32 {
    var h = p.x * 1664525u + p.y * 1013904223u + s * 2654435761u;
    h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u; h *= 3266489917u; h ^= h >> 16u;
    return f32(h) / 4294967295.0;
}`,

    // PCG: u32 -> u32, and rnd: u32 -> [0, 1]
    pcg: (name = 'pcg', rnd = 'rnd') => /* wgsl */`
fn ${name}(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn ${rnd}(v: u32) -> f32 { return f32(${name}(v)) / 4294967295.0; }`,

    // interleaved gradient noise of a pixel (dithering)
    ign: (name = 'ign') => /* wgsl */`
fn ${name}(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }`,

    // ------------------------------------------------------------------------------------------- value noise
    // in [0, 1] on a 2D lattice of hash(vec2f)
    value2: (name, hash) => /* wgsl */`
fn ${name}(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(${hash}(i), ${hash}(i + vec2f(1.0, 0.0)), u.x), mix(${hash}(i + vec2f(0.0, 1.0)), ${hash}(i + vec2f(1.0, 1.0)), u.x), u.y);
}`,

    // ... with its analytic gradient: (value, d/dx, d/dy)
    value2Grad: (name, hash) => /* wgsl */`
fn ${name}(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);
    let a = ${hash}(i);
    let b = ${hash}(i + vec2f(1.0, 0.0));
    let c = ${hash}(i + vec2f(0.0, 1.0));
    let d = ${hash}(i + vec2f(1.0, 1.0));
    let k = a - b - c + d;
    return vec3f(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2f(b - a, c - a) + k * u.yx));
}`,

    // in [0, 1] on a 3D lattice of hash(vec3f)
    value3: (name, hash) => /* wgsl */`
fn ${name}(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(${hash}(i), ${hash}(i + vec3f(1, 0, 0)), u.x), mix(${hash}(i + vec3f(0, 1, 0)), ${hash}(i + vec3f(1, 1, 0)), u.x), u.y),
               mix(mix(${hash}(i + vec3f(0, 0, 1)), ${hash}(i + vec3f(1, 0, 1)), u.x), mix(${hash}(i + vec3f(0, 1, 1)), ${hash}(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}`,

    // Fractal sum of noise(p) (vec2f or vec3f: `dim`): octaves fixed (a number) or a parameter (fbm(p, octaves)); each
    // octave at 2.03 times the frequency, moved by `shift`, half the weight (first 0.5); normalize: divided by the
    // total weight
    fbm: (name, noise, { dim = 2, octaves = 4, shift, normalize = false }) => {
        const T = `vec${dim}f`, param = typeof octaves !== 'number';
        return /* wgsl */`
fn ${name}(p: ${T}${param ? ', octaves: i32' : ''}) -> f32 {
    var s = 0.0; var a = 0.5; var n = 0.0; var q = p;
    for (var i = 0; i < ${param ? 'octaves' : octaves}; i++) { s += a * ${noise}(q); n += a; a *= 0.5; q = q * 2.03 + ${T}(${shift.join(', ')}); }
    return ${normalize ? 's / n' : 's'};
}`;
    },

    // ------------------------------------------------------------------------------------------- tileable 3D noise
    // Worley (1 - distance to the nearest feature point) and gradient (Perlin) noise that tile every `period` cells, and
    // a 3-octave Worley fbm; seeded (u32). Brings its helpers: pcg3, h33, wrapc, gradAt.
    tileable3: () => /* wgsl */`
fn pcg3(v0: vec3u) -> vec3u {
    var v = v0 * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
fn h33(c: vec3i, seed: u32) -> vec3f { return vec3f(pcg3(vec3u(c) + vec3u(seed, seed * 7u, seed * 13u))) / 4294967295.0; }
fn wrapc(c: vec3i, period: i32) -> vec3i { return ((c % vec3i(period)) + vec3i(period)) % vec3i(period); }

fn worley(p: vec3f, period: i32, seed: u32) -> f32 {
    let id = vec3i(floor(p));
    let f = fract(p);
    var md = 1e9;
    for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let o = vec3i(x, y, z);
                let d = vec3f(o) + h33(wrapc(id + o, period), seed) - f;
                md = min(md, dot(d, d));
            }
        }
    }
    return clamp(1.0 - sqrt(md), 0.0, 1.0);
}

fn gradAt(c: vec3i, period: i32, seed: u32) -> vec3f { return normalize(h33(wrapc(c, period), seed) * 2.0 - 1.0 + 1e-4); }

fn perlin(p: vec3f, period: i32, seed: u32) -> f32 {
    let i = vec3i(floor(p));
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    var v: array<f32, 8>;
    for (var k = 0; k < 8; k++) {
        let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
        v[k] = dot(gradAt(i + o, period, seed), f - vec3f(o));
    }
    let x0 = mix(v[0], v[1], u.x); let x1 = mix(v[2], v[3], u.x);
    let x2 = mix(v[4], v[5], u.x); let x3 = mix(v[6], v[7], u.x);
    return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

fn worleyFbm(p: vec3f, freq: i32, seed: u32) -> f32 {
    return worley(p * f32(freq), freq, seed) * 0.625 + worley(p * f32(freq * 2), freq * 2, seed + 1u) * 0.25 + worley(p * f32(freq * 4), freq * 4, seed + 2u) * 0.125;
}`,
};

return { NoiseWGSL };
});
