'use strict';
// WGSL: the Perlin-Worley shape and Worley detail noise volumes.

Features.part('cloud', (engine, feature) => {
const { kits } = engine;
const { NoiseWGSL } = kits.noise;
const { NOISE_SHAPE, NOISE_DETAIL } = feature;

// Tileable 3D noise, baked once: shape (Perlin-Worley + 3 Worley fbm octaves) and detail (3 Worley fbm octaves).
const WGSL_NOISE = /* wgsl */`
@group(0) @binding(0) var shapeOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detailOut: texture_storage_3d<rgba8unorm, write>;

${NoiseWGSL.tileable3()}

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
