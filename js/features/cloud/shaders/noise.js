'use strict';
// WGSL: the Perlin-Worley shape and Worley detail noise volumes.

Features.part('cloud', (engine, feature) => {
const { NOISE_SHAPE, NOISE_DETAIL } = feature;

// Tileable 3D noise, baked once: shape (Perlin-Worley + 3 Worley fbm octaves) and detail (3 Worley fbm octaves).
const WGSL_NOISE = /* wgsl */`
@group(0) @binding(0) var shapeOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detailOut: texture_storage_3d<rgba8unorm, write>;

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
}

@compute @workgroup_size(4, 4, 4)
fn genShape(@builtin(global_invocation_id) gid: vec3u) {
    if (any(gid >= vec3u(${NOISE_SHAPE}u))) { return; }
    let p = (vec3f(gid) + 0.5) / ${NOISE_SHAPE}.0;
    var pf = 0.0; var amp = 1.0; var norm = 0.0; var freq = 4;
    for (var o = 0u; o < 5u; o++) { pf += perlin(p * f32(freq), freq, 11u + o) * amp; norm += amp; amp *= 0.5; freq *= 2; }
    pf = clamp(pf / norm * 1.3 + 0.5, 0.0, 1.0);
    let w = worleyFbm(p, 4, 30u);
    let pw = clamp(w + pf * (1.0 - w) - (1.0 - pf) * 0.35, 0.0, 1.0);     // Perlin-Worley
    textureStore(shapeOut, gid, vec4f(pw, worleyFbm(p, 4, 40u), worleyFbm(p, 8, 50u), worleyFbm(p, 16, 60u)));
}

@compute @workgroup_size(4, 4, 4)
fn genDetail(@builtin(global_invocation_id) gid: vec3u) {
    if (any(gid >= vec3u(${NOISE_DETAIL}u))) { return; }
    let p = (vec3f(gid) + 0.5) / ${NOISE_DETAIL}.0;
    textureStore(detailOut, gid, vec4f(worleyFbm(p, 2, 70u), worleyFbm(p, 4, 80u), worleyFbm(p, 8, 90u), 1.0));
}
`;

return { WGSL_NOISE };
});
