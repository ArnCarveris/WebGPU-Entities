'use strict';
// WGSL: the render passes: sky and terrain, then the water surface and debris.

Features.part('water', (engine, feature) => {
const WGSL_COMMON = /* wgsl */`
struct Frame {
    viewProj: mat4x4f,
    cam: vec4f,         // xyz, time
    camFwd: vec4f,      // xyz, near
    camRight: vec4f,    // xyz * tan(half fov x)
    camUp: vec4f,       // xyz * tan(half fov y)
    sunDir: vec4f,      // xyz, intensity
    sunColor: vec4f,    // rgb, exposure
    skyTop: vec4f,      // rgb, fog density
    skyHorizon: vec4f,  // rgb, highest terrain point
    ground: vec4f,      // rgb, ambient strength
    map: vec4f,         // origin x, origin z, cell, n
    screen: vec4f,      // width, height, min water depth, render mode
    water: vec4f,       // deep colour, foam
    absorb: vec4f,      // absorption per metre, refraction
    cursor: vec4f,      // x, z, radius, visible
    misc: vec4f,        // wave layers, detail strength, snow line, sea level
    layers: array<vec4f, 4>,   // newest display: origin x, z, size, time lerp
    layersB: array<vec4f, 4>,  // older display: origin x, z, newest slot
    extra: vec4f,       // flow scale
}
struct Particle { p: vec4f, q: vec4f }
struct Emitter { a: vec4f, b: vec4f }

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var terrainTex: texture_2d<f32>;
@group(0) @binding(2) var surfTex: texture_2d<f32>;
@group(0) @binding(3) var flowTex: texture_2d<f32>;
@group(0) @binding(4) var linSamp: sampler;
@group(0) @binding(5) var disp0: texture_2d_array<f32>;
@group(0) @binding(6) var disp1: texture_2d_array<f32>;
@group(0) @binding(7) var disp2: texture_2d_array<f32>;
@group(0) @binding(8) var disp3: texture_2d_array<f32>;
@group(0) @binding(9) var<storage, read> particles: array<Particle>;
@group(0) @binding(10) var<storage, read> emitters: array<Emitter>;

fn nCells() -> i32 { return i32(F.map.w); }
fn cellOf(xz: vec2f) -> vec2f { return (xz - F.map.xy) / F.map.z - 0.5; }
fn simUV(xz: vec2f) -> vec2f { return (xz - F.map.xy) / (F.map.z * F.map.w); }
fn loadH(p: vec2i) -> f32 { return textureLoad(terrainTex, clamp(p, vec2i(0), vec2i(nCells() - 1)), 0).x; }
fn loadSurf(p: vec2i) -> vec2f { return textureLoad(surfTex, clamp(p, vec2i(0), vec2i(nCells() - 1)), 0).xy; }
fn terrainAt(xz: vec2f) -> f32 {
    let c = cellOf(xz);
    let i = vec2i(floor(c));
    let f = c - floor(c);
    return mix(mix(loadH(i), loadH(i + vec2i(1, 0)), f.x), mix(loadH(i + vec2i(0, 1)), loadH(i + vec2i(1, 1)), f.x), f.y);
}
fn wetAt(xz: vec2f) -> f32 {
    let c = cellOf(xz);
    let i = vec2i(floor(c));
    let f = c - floor(c);
    return mix(mix(loadSurf(i).y, loadSurf(i + vec2i(1, 0)).y, f.x), mix(loadSurf(i + vec2i(0, 1)).y, loadSurf(i + vec2i(1, 1)).y, f.x), f.y);
}
fn flowAt(xz: vec2f) -> vec4f { return textureSampleLevel(flowTex, linSamp, simUV(xz), 0.0); }

fn hash21(p: vec2f) -> f32 {
    var q = fract(p * vec2f(123.34, 456.21));
    q += dot(q, q + 45.32);
    return fract(q.x * q.y);
}
// value noise with its analytic gradient: (value, d/dx, d/dy)
fn noised(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);
    let a = hash21(i);
    let b = hash21(i + vec2f(1.0, 0.0));
    let c = hash21(i + vec2f(0.0, 1.0));
    let d = hash21(i + vec2f(1.0, 1.0));
    let k = a - b - c + d;
    return vec3f(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2f(b - a, c - a) + k * u.yx));
}

fn skyColor(d: vec3f) -> vec3f {
    var c = mix(F.skyHorizon.rgb, F.skyTop.rgb, pow(clamp(d.y, 0.0, 1.0), 0.5));
    c = mix(c, F.skyHorizon.rgb * 0.7 + F.ground.rgb * 0.3, smoothstep(0.0, -0.25, d.y));
    let s = max(dot(d, F.sunDir.xyz), 0.0);
    c += F.sunColor.rgb * (pow(s, 6.0) * 0.12 + pow(s, 90.0) * 0.4) * min(F.sunDir.w, 1.5);
    return c;
}
fn ambient(n: vec3f) -> vec3f { return mix(F.ground.rgb, F.skyTop.rgb * 1.1, n.y * 0.5 + 0.5) * F.ground.w; }
fn applyFog(c: vec3f, p: vec3f) -> vec3f {
    let d = p - F.cam.xyz;
    let dist = length(d);
    let dir = d / max(dist, 1e-3);
    let f = 1.0 - exp(-dist * F.skyTop.w);
    let fc = F.skyHorizon.rgb + F.sunColor.rgb * pow(max(dot(dir, F.sunDir.xyz), 0.0), 8.0) * 0.25;
    return mix(c, fc, f);
}
fn tonemap(c: vec3f) -> vec3f {
    let x = max(c * F.sunColor.w, vec3f(0.0));
    let a = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    return pow(clamp(a, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}
// soft sun shadow marched through the heightfield
fn sunShadow(pos: vec3f) -> f32 {
    let d = F.sunDir.xyz;
    if (d.y < 0.005) { return 0.0; }
    var t = F.map.z;
    var res = 1.0;
    for (var i = 0; i < 40; i++) {
        let q = pos + d * t;
        if (q.y > F.skyHorizon.w) { break; }
        res = min(res, (q.y - terrainAt(q.xz)) / (t * 0.06));
        if (res < 0.0) { break; }
        t = t * 1.13 + F.map.z * 0.5;
    }
    return smoothstep(0.0, 1.0, clamp(res, 0.0, 1.0));
}
fn heat(x: f32) -> vec3f {
    let t = clamp(x, 0.0, 1.0);
    return clamp(vec3f(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), vec3f(0.0), vec3f(1.0));
}
fn hue(a: f32) -> vec3f { return clamp(abs(fract(a + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0)); }
fn cursorRing(xz: vec2f) -> f32 {
    if (F.cursor.w < 0.5) { return 0.0; }
    let d = abs(length(xz - F.cursor.xy) - F.cursor.z);
    return 1.0 - smoothstep(0.0, 1.2 + F.cursor.z * 0.02, d);
}
fn fullscreen(vi: u32) -> vec4f {
    let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
    return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}
fn viewRay(ndc: vec2f) -> vec3f { return normalize(F.camFwd.xyz + ndc.x * F.camRight.xyz + ndc.y * F.camUp.xyz); }
`;

// pass A: sky and terrain into the HDR scene target
const WGSL_SCENE = /* wgsl */`
struct SkyOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
    let p = fullscreen(vi);
    return SkyOut(p, p.xy);
}
@fragment fn fsSky(in: SkyOut) -> @location(0) vec4f {
    let d = viewRay(in.ndc);
    var c = skyColor(d);
    c += F.sunColor.rgb * F.sunDir.w * 12.0 * smoothstep(0.99955, 0.9998, dot(d, F.sunDir.xyz));
    return vec4f(c, 1.0);
}

struct TOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f }
@vertex fn vsTerrain(@builtin(vertex_index) vi: u32) -> TOut {
    let n = nCells();
    let w = n + 2;              // one skirt vertex ring around the map
    let i = i32(vi) % w - 1;
    let j = i32(vi) / w - 1;
    let c = clamp(vec2i(i, j), vec2i(0), vec2i(n - 1));
    let skirt = i != c.x || j != c.y;
    var h = loadH(c);
    let gx = (loadH(c + vec2i(1, 0)) - loadH(c - vec2i(1, 0))) / (2.0 * F.map.z);
    let gz = (loadH(c + vec2i(0, 1)) - loadH(c - vec2i(0, 1))) / (2.0 * F.map.z);
    var nrm = normalize(vec3f(-gx, 1.0, -gz));
    if (skirt) { h = min(h, F.misc.w) - 40.0; }
    let world = vec3f(F.map.x + (f32(c.x) + 0.5) * F.map.z, h, F.map.y + (f32(c.y) + 0.5) * F.map.z);
    return TOut(F.viewProj * vec4f(world, 1.0), world, nrm);
}
@fragment fn fsTerrain(in: TOut) -> @location(0) vec4f {
    let p = in.world;
    let n = normalize(in.normal);
    let nz = noised(p.xz * 0.045).x * 0.55 + noised(p.xz * 0.21).x * 0.3 + noised(p.xz * 1.3).x * 0.15;
    let slope = 1.0 - n.y;
    let grass = mix(vec3f(0.085, 0.14, 0.045), vec3f(0.22, 0.24, 0.10), nz);
    let rock = mix(vec3f(0.22, 0.20, 0.18), vec3f(0.40, 0.37, 0.33), nz);
    let sand = vec3f(0.50, 0.44, 0.32) * (0.85 + 0.3 * nz);
    let snow = vec3f(0.86, 0.89, 0.93);
    var alb = grass;
    alb = mix(alb, sand, 1.0 - smoothstep(F.misc.w + 1.0, F.misc.w + 5.0, p.y + nz * 2.0));
    alb = mix(alb, rock, smoothstep(0.26, 0.42, slope + nz * 0.12));
    alb = mix(alb, snow, smoothstep(F.misc.z, F.misc.z + 30.0, p.y + nz * 40.0) * (1.0 - smoothstep(0.35, 0.6, slope)));
    let fl = flowAt(p.xz);
    let bed = smoothstep(0.0, 0.4, fl.x);
    alb = mix(alb, mix(sand, rock, 0.35 + 0.3 * nz) * 0.85, bed * 0.8);
    alb *= mix(1.0, 0.5, clamp(wetAt(p.xz), 0.0, 1.0));

    let sh = sunShadow(p + n * 0.4);
    let ndl = max(dot(n, F.sunDir.xyz), 0.0);
    let sun = F.sunColor.rgb * F.sunDir.w;
    var col = alb * (sun * ndl * sh + ambient(n));
    if (fl.x > 0.02) {
        let t = F.cam.w;
        let v = noised(p.xz * 0.32 + vec2f(t * 0.35, t * 0.2)).x + noised(p.xz * 0.51 - vec2f(t * 0.25, -t * 0.3)).x;
        let caustic = pow(1.0 - abs(v - 1.0), 8.0) * exp(-fl.x * 0.35) * smoothstep(0.02, 0.25, fl.x);
        col += alb * sun * caustic * sh * ndl * 1.4;
    }
    if (F.screen.w > 0.5) {
        col = vec3f(dot(alb, vec3f(0.3, 0.55, 0.15))) * (ndl * sh * 0.7 + 0.3) * 1.2;
    }
    col = mix(col, vec3f(1.0, 0.8, 0.3) * 2.0, cursorRing(p.xz));
    return vec4f(applyFog(col, p), 1.0);
}
`;

// pass B: tonemapped scene, then water (refracting the scene) and debris on top
const WGSL_SURFACE = /* wgsl */`
@group(1) @binding(0) var sceneTex: texture_2d<f32>;
@group(1) @binding(1) var sceneDepth: texture_depth_2d;

@vertex fn vsComposite(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return fullscreen(vi); }
@fragment fn fsComposite(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    return vec4f(tonemap(textureLoad(sceneTex, vec2i(pos.xy), 0).rgb), 1.0);
}

fn dispSample(i: i32, uv: vec2f, slot: i32) -> vec4f {
    if (i == 0) { return textureSampleLevel(disp0, linSamp, uv, slot, 0.0); }
    if (i == 1) { return textureSampleLevel(disp1, linSamp, uv, slot, 0.0); }
    if (i == 2) { return textureSampleLevel(disp2, linSamp, uv, slot, 0.0); }
    return textureSampleLevel(disp3, linSamp, uv, slot, 0.0);
}
// sum of the wave cascades: (height, d/dx, d/dz, foam); each layer fades out towards its border
fn waves(xz: vec2f) -> vec4f {
    var acc = vec4f(0.0);
    for (var i = 0; i < 4; i++) {
        if (f32(i) >= F.misc.x) { break; }
        let L = F.layers[i];
        let B = F.layersB[i];
        let uvC = (xz - L.xy) / L.z;
        let e = min(min(uvC.x, 1.0 - uvC.x), min(uvC.y, 1.0 - uvC.y));
        let w = smoothstep(0.0, 0.12, e);
        if (w <= 0.0) { continue; }
        let slot = i32(B.z);
        let a = dispSample(i, uvC, slot);
        let b = dispSample(i, (xz - B.xy) / L.z, 1 - slot);
        acc += mix(b, a, L.w) * w;
    }
    return acc;
}
fn ripples(p: vec2f) -> vec2f {
    return noised(p * 0.16).yz * 0.16 * 0.45 + noised(p * 0.37 + 11.0).yz * 0.37 * 0.2 + noised(p * 0.83 + 23.0).yz * 0.83 * 0.08;
}
// two-phase flow map: detail ripples slide with the current and cross-fade every half period
fn flowDetail(xz: vec2f, vel: vec2f, t: f32) -> vec2f {
    let ph = fract(vec2f(t * 0.25, t * 0.25 + 0.5));
    let w0 = 1.0 - abs(ph.x * 2.0 - 1.0);
    let g0 = ripples(xz - vel * ph.x * 4.0);
    let g1 = ripples(xz - vel * ph.y * 4.0 + vec2f(37.1, 11.7));
    let breeze = ripples(xz * 0.6 + vec2f(t * 0.9, t * 0.4) + 71.0) * 0.35;
    return (g0 * w0 + g1 * (1.0 - w0)) * (0.35 + min(length(vel), 4.0) * 0.4) + breeze;
}
fn foamPattern(xz: vec2f, vel: vec2f, t: f32) -> f32 {
    let ph = fract(vec2f(t * 0.2, t * 0.2 + 0.5));
    let w0 = 1.0 - abs(ph.x * 2.0 - 1.0);
    let a = noised((xz - vel * ph.x * 5.0) * 0.55).x * 0.6 + noised((xz - vel * ph.x * 5.0) * 1.7).x * 0.4;
    let b = noised((xz - vel * ph.y * 5.0) * 0.55 + 5.3).x * 0.6 + noised((xz - vel * ph.y * 5.0) * 1.7 + 2.1).x * 0.4;
    return mix(b, a, w0);
}

struct WOut {
    @builtin(position) pos: vec4f,
    @location(0) world: vec3f,
    @location(1) grad: vec2f,
    @location(2) valid: f32,
}
fn surfOr(p: vec2i, fallback: f32) -> f32 {
    let s = loadSurf(p).x;
    return select(s, fallback, s < -1e4);
}
@vertex fn vsWater(@builtin(vertex_index) vi: u32) -> WOut {
    let n = nCells();
    let c = vec2i(i32(vi) % n, i32(vi) / n);
    let s = loadSurf(c).x;
    var y = s;
    var valid = 1.0;
    if (s < -1e4) {
        // dry: just under the terrain next to water (a smooth shoreline), far under it elsewhere (early-z rejects it)
        var near = false;
        for (var k = 0; k < 9; k++) { near = near || loadSurf(c + vec2i(k % 3 - 1, k / 3 - 1)).x > -1e4; }
        y = loadH(c) - select(50.0, 0.4, near);
        valid = 0.0;
    }
    let gx = (surfOr(c + vec2i(1, 0), y) - surfOr(c - vec2i(1, 0), y)) / (2.0 * F.map.z);
    let gz = (surfOr(c + vec2i(0, 1), y) - surfOr(c - vec2i(0, 1), y)) / (2.0 * F.map.z);
    let world = vec3f(F.map.x + (f32(c.x) + 0.5) * F.map.z, y, F.map.y + (f32(c.y) + 0.5) * F.map.z);
    return WOut(F.viewProj * vec4f(world, 1.0), world, vec2f(gx, gz) * valid, valid);
}
@fragment fn fsWater(in: WOut) -> @location(0) vec4f {
    let p = in.world;
    let toCam = F.cam.xyz - p;
    let dist = length(toCam);
    let v = toCam / dist;
    let fl = flowAt(p.xz);
    let vel = fl.yz * F.extra.x;
    let wv = waves(p.xz);
    let lod = 1.0 / (1.0 + dist / 300.0);
    let g = clamp(in.grad, vec2f(-0.6), vec2f(0.6)) + wv.yz * lod + flowDetail(p.xz, vel, F.cam.w) * (F.misc.y * lod);
    let n = normalize(vec3f(-g.x, 1.0, -g.y));

    // screen-space refraction against the terrain depth
    let px = in.pos.xy;
    let suv = px / F.screen.xy;
    let near = F.camFwd.w;
    let fragZ = near / in.pos.z;
    let sceneZ0 = near / max(textureLoad(sceneDepth, vec2i(px), 0), 1e-7);
    let thick0 = max(sceneZ0 - fragZ, 0.0);
    var ruv = suv + n.xz * F.absorb.w * min(thick0, 6.0) / (1.0 + fragZ * 0.01);
    ruv = clamp(ruv, vec2f(0.0), vec2f(0.999));
    var sceneZ = near / max(textureLoad(sceneDepth, vec2i(ruv * F.screen.xy), 0), 1e-7);
    if (sceneZ < fragZ) { ruv = suv; sceneZ = sceneZ0; }
    let refr = textureSampleLevel(sceneTex, linSamp, ruv, 0.0).rgb;
    let raw = textureSampleLevel(sceneTex, linSamp, suv, 0.0).rgb;
    let rayLen = max(sceneZ - fragZ, 0.0) * dist / fragZ;
    let T = exp(-F.absorb.rgb * rayLen);

    let sh = sunShadow(p + vec3f(0.0, 0.3, 0.0));
    let sun = F.sunColor.rgb * F.sunDir.w;
    let light = sun * (max(F.sunDir.y, 0.0) * sh * 0.8 + 0.1) + F.skyTop.rgb * F.ground.w;
    let under = refr * T + F.water.rgb * light * (1.0 - T);
    let r = reflect(-v, n);
    let refl = skyColor(normalize(vec3f(r.x, abs(r.y), r.z)));
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    var col = mix(under, refl, fres);
    col += sun * pow(max(dot(r, F.sunDir.xyz), 0.0), 500.0) * 10.0 * sh;

    let speed = length(fl.yz);
    let shore = (1.0 - smoothstep(0.0, 0.5, rayLen)) * smoothstep(0.3, 1.5, speed);
    let foamAmt = clamp(wv.w + max(fl.w - 0.75, 0.0) * 1.6 + shore * 0.3, 0.0, 1.0);
    let foam = clamp(foamAmt * 1.4, 0.0, 1.0) * clamp((foamPattern(p.xz, vel, F.cam.w) + 0.3 - (1.0 - foamAmt) * 0.5) * 1.7, 0.0, 1.0) * F.water.w;
    col = mix(col, vec3f(0.88, 0.92, 0.94) * (light + sun * 0.1), foam);
    col = applyFog(col, p);
    col = mix(raw, col, smoothstep(0.0, 0.25, thick0 * dist / fragZ));

    let mode = i32(F.screen.w + 0.5);
    if (mode == 1) { col = heat(sqrt(fl.x / 12.0)) * 0.9 + 0.1 * n.y; }
    if (mode == 2) { col = hue(atan2(fl.z, fl.y) / 6.2831853 + 0.5) * clamp(speed / 3.0, 0.08, 1.0); }
    if (mode == 3) { col = vec3f(foamAmt, fl.w * 0.6, 0.15 + 0.2 * fl.w); }
    if (mode == 4) { col = vec3f(0.5 + wv.x * 3.0, 0.5 + wv.x * 3.0, 0.6) * (0.5 + 0.5 * n.y) + vec3f(wv.w * 0.5, 0.0, 0.0); }
    col = mix(col, vec3f(1.0, 0.8, 0.3) * 2.0, cursorRing(p.xz));
    if (mode > 0) { return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0); }
    return vec4f(tonemap(col), 1.0);
}

struct DOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) col: vec3f }
@vertex fn vsDebris(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> DOut {
    let pt = particles[ii];
    let e = emitters[u32(pt.q.z)];
    let face = vi / 6u;
    let k = vi % 6u;
    let uv = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0))[k] - 0.5;
    let axis = face / 2u;
    let sgn = select(1.0, -1.0, (face & 1u) == 1u);
    var N = vec3f(0.0); var T = vec3f(0.0); var Bt = vec3f(0.0);
    if (axis == 0u) { N = vec3f(sgn, 0.0, 0.0); T = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), sgn > 0.0); }
    if (axis == 1u) { N = vec3f(0.0, sgn, 0.0); T = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), sgn > 0.0); }
    if (axis == 2u) { N = vec3f(0.0, 0.0, sgn); T = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), sgn > 0.0); }
    Bt = cross(N, T);
    let local = N * 0.5 + T * uv.x + Bt * uv.y;
    let s = e.b.w * (0.6 + 0.8 * pt.q.w);
    let scaled = local * vec3f(s, s * 0.28, s * 0.3);
    let ch = cos(pt.q.x);
    let sh = sin(pt.q.x);
    let rot = vec3f(ch * scaled.x - sh * scaled.z, scaled.y, sh * scaled.x + ch * scaled.z);
    let rn = vec3f(ch * N.x - sh * N.z, N.y, sh * N.x + ch * N.z);
    let world = pt.p.xyz + rot;
    return DOut(F.viewProj * vec4f(world, 1.0), world, rn, e.b.rgb * (0.75 + 0.5 * fract(pt.q.w * 7.0)));
}
@fragment fn fsDebris(in: DOut) -> @location(0) vec4f {
    let n = normalize(in.n);
    let c = in.col * (F.sunColor.rgb * F.sunDir.w * max(dot(n, F.sunDir.xyz), 0.0) + ambient(n));
    return vec4f(tonemap(applyFog(c, in.world)), 1.0);
}
`;

return { WGSL_COMMON, WGSL_SCENE, WGSL_SURFACE };
});
