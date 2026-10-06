'use strict';
// WGSL: the shallow-water flow simulation.

Features.part('water', (engine, feature) => {
// WGSL

// State texture (rgba32float): depth (m), velocity (cells per step, x and z), wet (recently wet, 0..1).
const WGSL_FLOW = /* wgsl */`
struct Sim {
    n: i32, sourceCount: u32, edgeMode: u32, frame: u32,
    cell: f32, stepTime: f32, diffusion: f32, acceleration: f32,
    linDamp: f32, sqrDamp: f32, absorption: f32, rain: f32,
    fricMin: f32, fricMax: f32, fricAmount: f32, seaLevel: f32,
    minDepth: f32, wetDecay: f32, evaporation: f32, velScale: f32,
    cfl: f32, turbulenceSpeed: f32, _p2: f32, _p3: f32,
}
struct Source { a: vec4f, b: vec4f }     // a: centre (cells), radius (cells), depth per step at the centre (< 0: sink); b.x: flat profile

@group(0) @binding(0) var<uniform> S: Sim;
@group(0) @binding(1) var terrainTex: texture_2d<f32>;
@group(0) @binding(2) var stateIn: texture_2d<f32>;
@group(0) @binding(3) var stateOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var<storage, read> sources: array<Source>;
@group(0) @binding(5) var surfOut: texture_storage_2d<rg32float, write>;
@group(0) @binding(6) var flowOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>, 4>;

var<private> OFFS: array<vec2i, 8> = array<vec2i, 8>(
    vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1),
    vec2i(-1, -1), vec2i(1, 1), vec2i(1, -1), vec2i(-1, 1));

fn inside(p: vec2i) -> bool { return p.x >= 0 && p.y >= 0 && p.x < S.n && p.y < S.n; }
fn H(p: vec2i) -> f32 { return textureLoad(terrainTex, p, 0).x; }
fn ST(p: vec2i) -> vec4f { return textureLoad(stateIn, p, 0); }

// RiverSim: cap at 0.499 cells per step, linear and quadratic damping, more friction in shallow water
fn regulate(v: vec2f, depth: f32, min9: f32) -> vec2f {
    let l = length(v) + 1e-5;
    var ln = min(l, 0.499);
    let range = max(S.fricMax - S.fricMin, 1e-4);
    let kc = clamp((depth - S.fricMin) / range, 0.0, 1.0);
    let k9 = clamp((min9 - S.fricMin) / range, 0.0, 1.0);
    ln *= S.linDamp * mix(S.fricAmount * S.fricAmount, 1.0, kc) * mix(S.fricAmount, 1.0, k9);
    let ld = ln * S.sqrDamp;
    ln -= ld * ld;
    return v * (max(ln, 0.0) / l);
}

// step 1: exchange water with the 8 neighbours along the surface gradient, accelerate, add sources
@compute @workgroup_size(8, 8)
fn simulate(@builtin(global_invocation_id) gid: vec3u) {
    let p = vec2i(gid.xy);
    if (!inside(p)) { return; }
    let c = ST(p);
    let hc = H(p);
    let sc = hc + c.x;
    var dsum = 0.0;
    var vadd = vec2f(0.0);
    var min9 = c.x;
    var max9 = c.x;
    for (var k = 0; k < 8; k++) {
        let o = OFFS[k];
        let q = p + o;
        if (!inside(q)) { continue; }
        let s = ST(q);
        min9 = min(min9, s.x);
        max9 = max(max9, s.x);
        // antisymmetric between the pair, so the exchange conserves mass
        let d = clamp(H(q) + s.x - sc, -c.x, s.x);
        let diag = k >= 4;
        dsum += d * select(1.0, 0.70710678, diag);
        vadd -= vec2f(o) * (d * select(1.0, 0.35355339, diag));
    }
    var depth = c.x + S.diffusion * dsum;
    // gravity waves travel ~sqrt(acceleration * depth / cell) cells per step: cap that for deep water (lakes)
    let accel = min(S.acceleration, S.cfl * S.cell / max(max9, 1e-3));
    var vel = c.yz + vadd * (accel / S.cell);
    vel = regulate(vel, depth, min9);
    vel *= clamp((depth - 1e-6) * 1e7, 0.0, 1.0);

    let pc = vec2f(p);
    var add = S.rain;
    var sink = 0.0;
    for (var i = 0u; i < S.sourceCount; i++) {
        let src = sources[i];
        let r = length(pc - src.a.xy) / src.a.z;
        if (r >= 1.0) { continue; }
        let prof = select(sqrt(1.0 - r), 1.0, src.b.x > 0.5);
        if (src.a.w >= 0.0) { add += src.a.w * prof; } else { sink -= src.a.w * prof; }
    }
    depth = max(0.0, depth * S.absorption + add - sink - S.evaporation);

    let border = p.x == 0 || p.y == 0 || p.x == S.n - 1 || p.y == S.n - 1;
    if (border && S.edgeMode == 1u) { depth = 0.0; vel = vec2f(0.0); }
    if (border && S.edgeMode == 2u) { depth = max(0.0, S.seaLevel - hc); }
    textureStore(stateOut, p, vec4f(depth, vel, c.w));
}

// step 2: move depth and momentum by the velocity; every neighbour's water lands on a bilinear footprint
@compute @workgroup_size(8, 8)
fn propagate(@builtin(global_invocation_id) gid: vec3u) {
    let p = vec2i(gid.xy);
    if (!inside(p)) { return; }
    var depth = 0.0;
    var mom = vec2f(0.0);
    var avg = vec2f(0.0);
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let q = p + vec2i(dx, dy);
            if (!inside(q)) { continue; }
            let s = ST(q);
            let off = vec2f(f32(dx), f32(dy)) + s.yz;
            let nd = max(vec2f(1.0) - abs(off), vec2f(0.0));
            let cd = nd.x * nd.y * s.x;
            depth += cd;
            mom += s.yz * cd;
            avg += s.yz;
        }
    }
    var vel = mom / (depth + 1e-6);
    vel = (vel * 25.0 + avg) / 34.0;
    let c = ST(p);
    let wet = max(c.w * S.wetDecay, select(0.0, 1.0, depth > S.minDepth));
    textureStore(stateOut, p, vec4f(depth, vel, wet));
}

// once per frame: render inputs (surface extended one cell over dry banks, velocity in m/s, turbulence) and stats
var<workgroup> wgVol: atomic<u32>;
var<workgroup> wgWet: atomic<u32>;
var<workgroup> wgMax: atomic<u32>;

@compute @workgroup_size(8, 8)
fn info(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
    let p = vec2i(gid.xy);
    if (inside(p)) {
        let s = ST(p);
        let h = H(p);
        let wetCell = s.x > S.minDepth;
        var surf = h + s.x;
        if (!wetCell) {
            var sum = 0.0;
            var cnt = 0.0;
            for (var k = 0; k < 8; k++) {
                let q = p + OFFS[k];
                if (!inside(q)) { continue; }
                let t = ST(q);
                if (t.x > S.minDepth) { sum += H(q) + t.x; cnt += 1.0; }
            }
            surf = select(-1e5, sum / max(cnt, 1.0), cnt > 0.0);
        }
        let speed = length(s.yz);
        let range = max(S.fricMax - S.fricMin, 1e-4);
        let pm = pow(mix(S.fricAmount, 1.0, clamp((s.x - S.fricMin) / range, 0.0, 1.0)), 4.0);
        let pert = clamp(speed * S.velScale / S.turbulenceSpeed / pm, 0.0, 1.0);
        let w = select(0.0, 1.0, wetCell);
        textureStore(surfOut, p, vec4f(surf, s.w, 0.0, 0.0));
        textureStore(flowOut, p, vec4f(s.x * w, s.yz * S.velScale * w, pert * w));
        atomicAdd(&wgVol, u32(s.x * S.cell * S.cell * 10.0));
        if (wetCell) {
            atomicAdd(&wgWet, 1u);
            atomicMax(&wgMax, bitcast<u32>(speed * S.velScale));
        }
    }
    workgroupBarrier();
    if (li == 0u) {
        atomicAdd(&stats[0], atomicLoad(&wgVol));
        atomicAdd(&stats[1], atomicLoad(&wgWet));
        atomicMax(&stats[2], atomicLoad(&wgMax));
    }
}
`;

return { WGSL_FLOW };
});
