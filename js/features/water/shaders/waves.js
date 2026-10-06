'use strict';
// WGSL: one surface-wave cascade layer.

Features.part('water', (engine, feature) => {
// One cascade layer: a res x res wave map (height, previous height, foam) centred on the camera.
const WGSL_WAVES = /* wgsl */`
struct Wave {
    origin: vec2f, texel: f32, res: i32,
    shift: vec2f, dt: f32, damping: f32,
    mapOrigin: vec2f, mapSize: f32, step: u32,
    noise: f32, foamGain: f32, minDepth: f32, heightScale: f32,
    splash: vec4f,
}
@group(0) @binding(0) var<uniform> W: Wave;
@group(0) @binding(1) var stateIn: texture_2d<f32>;
@group(0) @binding(2) var stateOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var flowTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var dispOut: texture_storage_2d<rgba16float, write>;

fn ld(p: vec2i) -> vec4f {
    if (p.x < 0 || p.y < 0 || p.x >= W.res || p.y >= W.res) { return vec4f(0.0); }
    return textureLoad(stateIn, p, 0);
}
fn smp(x: vec2f) -> vec4f {
    let q = x - 0.5;
    let i = vec2i(floor(q));
    let f = q - floor(q);
    return mix(mix(ld(i), ld(i + vec2i(1, 0)), f.x), mix(ld(i + vec2i(0, 1)), ld(i + vec2i(1, 1)), f.x), f.y);
}
fn hash(p: vec2u, s: u32) -> f32 {
    var h = p.x * 1664525u + p.y * 1013904223u + s * 2654435761u;
    h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u; h *= 3266489917u; h ^= h >> 16u;
    return f32(h) / 4294967295.0;
}

@compute @workgroup_size(8, 8)
fn waveStep(@builtin(global_invocation_id) gid: vec3u) {
    let p = vec2i(gid.xy);
    if (p.x >= W.res || p.y >= W.res) { return; }
    let world = W.origin + (vec2f(p) + 0.5) * W.texel;
    let fl = textureSampleLevel(flowTex, samp, (world - W.mapOrigin) / W.mapSize, 0.0);
    // semi-Lagrangian: fetch last step's state upstream (and from where this texel was before the layer moved)
    let src = vec2f(p) + 0.5 + W.shift - fl.yz * (W.dt / W.texel);
    let c = smp(src);
    let h1 = smp(src + vec2f(0.0, -1.0)).x;
    let h3 = smp(src + vec2f(-1.0, 0.0)).x;
    let h5 = smp(src + vec2f(1.0, 0.0)).x;
    let h7 = smp(src + vec2f(0.0, 1.0)).x;
    var k = (h1 + h3 + h5 + h7) * 0.5 - c.y;
    // sparse impulses, stronger where the flow is turbulent
    let r = hash(vec2u(p), W.step) * 2.0 - 1.0;
    let nz = r * (fl.w + 0.2) * 1.3;
    k += clamp(pow(abs(nz), 5.0) * 0.35 * sign(nz) * pow(W.damping, 16.0), -0.35, 0.35) * W.noise;
    k *= W.damping;
    let edge = smoothstep(W.minDepth, W.minDepth + 0.8, fl.x);
    k = clamp(k * edge, -1.0, 1.0);
    if (W.splash.z > 0.0) {
        let d = length(world - W.splash.xy);
        if (d < W.splash.z) { k = clamp(k - W.splash.w * (1.0 - d / W.splash.z) * edge, -1.0, 1.0); }
    }

    // foam: made by steep wave fronts and turbulence, carried by the flow, slowly dissolving
    let a = smp(src + vec2f(-3.0, -1.0)).x;
    let b = smp(src + vec2f(1.0, -3.0)).x;
    let cc = smp(src + vec2f(3.0, 1.0)).x;
    let dd = smp(src + vec2f(-1.0, 3.0)).x;
    let delta = abs(a - cc) + abs(b - dd);
    let fc = max(0.0, sin(delta * 50.0)) * step(0.2, delta);
    let n1 = hash(vec2u(p), W.step / 8u);
    let n2 = hash(vec2u(p) + 7u, W.step / 8u + 3u);
    let nf = clamp((pow(n1 * n2 - 0.2, 2.0) + 0.02) * 10.0, 0.0, 1.0);
    let fadd = (fc * 0.5 + clamp(fl.w - 0.6, 0.0, 1.0)) * 0.08 * W.foamGain * nf * edge;
    let foam = clamp((c.z + fadd) * 0.95 - 0.002, 0.0, 1.0);
    textureStore(stateOut, p, vec4f(k, c.x, foam, 0.0));
}

// sharper crests, as in RiverSim's combined height map
fn shapeH(h: f32) -> f32 { return h + pow(abs(h), 3.0) * 0.3; }

@compute @workgroup_size(8, 8)
fn waveDisplay(@builtin(global_invocation_id) gid: vec3u) {
    let p = vec2i(gid.xy);
    if (p.x >= W.res || p.y >= W.res) { return; }
    let c = ld(p);
    let hl = shapeH(ld(p - vec2i(1, 0)).x);
    let hr = shapeH(ld(p + vec2i(1, 0)).x);
    let hu = shapeH(ld(p - vec2i(0, 1)).x);
    let hd = shapeH(ld(p + vec2i(0, 1)).x);
    let g = vec2f(hr - hl, hd - hu) * (W.heightScale / (2.0 * W.texel));
    textureStore(dispOut, p, vec4f(shapeH(c.x) * W.heightScale, g, c.z));
}
`;

return { WGSL_WAVES };
});
