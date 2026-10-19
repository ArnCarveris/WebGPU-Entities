'use strict';
// The shaders as a library of named chunks (the gpu kit's WgslLibrary): every module the renderer and its passes make
// is the chunks it names. The core defines its own, and for what a feature brings (a round planet, structures...) a
// neutral stub of the functions the core calls; a feature on in the world replaces the stub with its code
// (RendererExtension.wgsl), and adds its own chunks to the modules that draw it.

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

// No structures (the structures feature's WGSL_BLOCKERS in their place): nothing shades the sun, the rain or the lights
const NO_BLOCKERS = /* wgsl */`
fn structureLight(p: vec3f, sun: bool, rain: bool) -> vec3f { return vec3f(1.0); }
fn rainReaches(p: vec3f) -> f32 { return 1.0; }
fn lightSeen(k: i32, p: vec3f) -> f32 { return 1.0; }
fn structureTop(p: vec3f) -> f32 { return p.y; }
fn rainBlocked(p: vec3f, back: vec3f) -> bool { return false; }
`;
// ... no roofs over a view ray (WGSL_SHELTERED_RAY), none to drip off (WGSL_DRIP)
const NO_SHELTERED_RAY = /* wgsl */`
fn structuresOnRay(ro: vec3f, dir: vec3f, t0: f32, t1: f32) -> bool { return false; }
`;
const NO_DRIP = /* wgsl */`
fn drip(k: u32, vi: u32, o: ptr<function, LineOut>) {}
`;

// the core's library (a new one per renderer: the features on in its world change it)
function atmosphereWgsl() {
    const L = new WgslLibrary(), k = kit;
    L.define('CURVE', FLAT_CURVE);
    L.define('SKY', k.WGSL_SKY, { needs: ['CURVE'] });
    L.define('BLOCKERS', NO_BLOCKERS);
    L.define('SHELTER', k.WGSL_SHELTER, { needs: ['BLOCKERS'] });
    L.define('SHELTERED_RAY', NO_SHELTERED_RAY);
    L.define('DRIP', NO_DRIP);
    L.define('FINAL', k.WGSL_FINAL, { needs: ['DRIP'] });
    for (const name of ['WEATHER_SAMPLE', 'DENSITY', 'SHADOW_SAMPLE', 'TERRAIN', 'SCENE', 'BLOOM', 'OCCUPANCY', 'WEATHER', 'SHADOW', 'GROUND',
        'FROXEL', 'SKIP_SAMPLE', 'TILES', 'HAZE', 'HAZE_INTEGRATE', 'MARCH', 'RESOLVE', 'HISTORY_COPY', 'FOREST']) L.define(name, k[`WGSL_${name}`]);
    // an object's frame (Renderer.busData), for what a feature draws in its own: bound as group 1 in the scene module,
    // group 2 in the final one
    L.define('OBJECT1', k.wgslObject(1));
    L.define('OBJECT2', k.wgslObject(2));
    return L;
}

return { atmosphereWgsl };
});
