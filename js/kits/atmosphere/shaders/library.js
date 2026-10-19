'use strict';
// The shaders as a library of named chunks (the gpu kit's WgslLibrary): every module the renderer and its passes make
// is the chunks it names. The core defines its own, and for what a feature brings (a round planet...) a neutral stub of
// the functions the core calls; a feature on in the world replaces the stub with its code (RendererExtension.wgsl).

Features.kit('atmosphere', (engine, kit) => {
const { WgslLibrary } = engine.kits.gpu;

// The outdoors drawn flat: the curvature feature's functions (the curvature kit's CurvatureWGSL), as a world without a
// `curvature` entity has them: drawn where it is
const FLAT_CURVE = /* wgsl */`
fn curveOn() -> bool { return false; }
fn curveOffset(p: vec3f) -> vec3f { return vec3f(0.0); }
fn curveToRender(p: vec3f) -> vec3f { return p; }
fn curveToWorld(r: vec3f) -> vec3f { return r; }
fn curveClip(clip: vec4f, p: vec3f) -> vec4f { return clip; }
fn curveShell(dir: vec3f, y: f32) -> vec2f { return vec2f(1.0, -1.0); }
fn curveSpan(dir: vec3f, yLo: f32, yHi: f32, tMax: f32) -> vec2f { return vec2f(0.0, -1.0); }
fn curveHorizonDip() -> f32 { return 0.0; }
fn curveSkyward(dir: vec3f) -> f32 { return dir.y; }
struct CurveBox { lo: vec3f, hi: vec3f };
fn curveBox(lo: vec3f, hi: vec3f) -> CurveBox { return CurveBox(lo, hi); }
`;

// the core's library (a new one per renderer: the features on in its world change it)
function atmosphereWgsl() {
    const L = new WgslLibrary(), k = kit;
    L.define('CURVE', FLAT_CURVE);
    L.define('SKY', k.WGSL_SKY, { needs: ['CURVE'] });
    for (const name of ['WEATHER_SAMPLE', 'DENSITY', 'SHADOW_SAMPLE', 'SHELTER', 'BUILDING', 'TERRAIN', 'SCENE', 'FINAL', 'BLOOM', 'OCCUPANCY',
        'WEATHER', 'SHADOW', 'GROUND', 'FROXEL', 'SKIP_SAMPLE', 'TILES', 'HAZE', 'HAZE_INTEGRATE', 'MARCH', 'RESOLVE', 'HISTORY_COPY',
        'FOREST', 'VEG_SCATTER', 'VEG_ALBEDO', 'VEG', 'VEG_IMP', 'VEG_CARPET']) L.define(name, k[`WGSL_${name}`]);
    L.define('BUS1', k.wgslBus(1));
    L.define('BUS2', k.wgslBus(2));
    L.define('IMPOSTER', () => engine.kits.imposter.imposterWGSL({ group: 3 }));
    return L;
}

return { atmosphereWgsl };
});
