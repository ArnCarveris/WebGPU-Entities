'use strict';
// WGSL: the passes' shaders as a library of chunks (js/kits/gpu/wgsl-library.js), the shadows feature's over its stand-ins.

Features.world('imposter', (engine, kit) => {
const { kits } = engine;
const { WGSL_COMMON, WGSL_SKY, WGSL_MESH, WGSL_CULL, WGSL_IMPOSTER, WGSL_OVERLAY } = kit;

// No shadows (the shadows feature's WGSL_SHADOW / WGSL_CASTERS in their place): the sun reaches everything, nothing casts
const NO_SHADOW = /* wgsl */`
fn shadowAt(wp: vec3f, n: vec3f) -> f32 { return 1.0; }
fn shadowTint(c: vec3f, wp: vec3f) -> vec3f { return c; }
`;
const NO_CASTERS = /* wgsl */`
fn castShadows(c: vec3f, r: f32, f: f32, o: Inst) {}
`;

// the core's library (a new one per renderer: the features on in its world change it) and its modules' chunks
function imposterWgsl() {
    const L = new kits.gpu.WgslLibrary();
    L.define('SHADOW', NO_SHADOW);
    L.define('COMMON', WGSL_COMMON, { needs: ['SHADOW'] });
    L.define('SKY', WGSL_SKY, { needs: ['COMMON'] });
    L.define('MESH', WGSL_MESH, { needs: ['COMMON'] });
    L.define('IMPOSTER', WGSL_IMPOSTER, { needs: ['COMMON'] });
    L.define('CASTERS', NO_CASTERS);
    L.define('CULL', WGSL_CULL, { needs: ['COMMON', 'CASTERS'] });
    L.define('OVERLAY', WGSL_OVERLAY);
    return L;
}
const IMPOSTER_MODULES = { sky: ['SKY'], mesh: ['MESH'], imposter: ['IMPOSTER'], cull: ['CULL'], overlay: ['OVERLAY'] };

return { imposterWgsl, IMPOSTER_MODULES };
});
