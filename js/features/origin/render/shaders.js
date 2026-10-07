'use strict';
// WGSL: sky, celestial bodies and entity instances, relative to the floating origin.

Features.part('origin', (engine, feature) => {
const { kits } = engine;
const { NoiseWGSL } = kits.noise;
const { CELL, VERTEX_FLOATS, MeshBuilder } = feature;

function cubeWGSL() {
    // 36 corners of the unit cube, counter-clockwise seen from outside
    const b = new MeshBuilder();
    b.box([0, 0, 0], [2, 2, 2], 0);
    const out = b.idx.map(i => `vec3f(${b.v[i * VERTEX_FLOATS]}, ${b.v[i * VERTEX_FLOATS + 1]}, ${b.v[i * VERTEX_FLOATS + 2]})`);
    return `var<private> CUBE: array<vec3f, 36> = array<vec3f, 36>(${out.join(', ')});`;
}

const WGSL = /* wgsl */`
const CELL: f32 = ${CELL}.0;

struct Frame {
    viewProj: mat4x4f,
    cam: vec4f,         // camera in origin space, w = time
    fwd: vec4f,         // w = near
    right: vec4f,       // w = tan(fov/2) * aspect
    up: vec4f,          // w = tan(fov/2)
    sun: vec4f,         // sun in origin space, w = radians per pixel
    sky: vec4f,         // atmosphere colour, w = star visibility
    misc: vec4f,        // exposure, sun intensity
};
struct Origin { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f };
struct Material { albedo: vec4f, emissive: vec4f, params: vec4f };
struct Instance { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f, tint: vec4f };
struct Body { center: vec4f, shape: vec4f, color: vec4f, atmo: vec4f };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> origin: Origin;
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(3) var<storage, read> instances: array<Instance>;
@group(0) @binding(4) var<storage, read> bodies: array<Body>;

${cubeWGSL()}

// ---- floating origin ----------------------------------------------------------------------------
// exact integer cell difference + small f32 remainder: precise near the origin at any world distance
fn relative(cell: vec3i, local: vec3f) -> vec3f {
    return vec3f(cell - origin.cell.xyz) * CELL + (local - origin.local.xyz);
}
fn toOrigin(v: vec3f) -> vec3f { return vec3f(dot(origin.ax.xyz, v), dot(origin.ay.xyz, v), dot(origin.az.xyz, v)); }
fn toWorldDir(d: vec3f) -> vec3f { return normalize(origin.ax.xyz * d.x + origin.ay.xyz * d.y + origin.az.xyz * d.z); }

// ---- noise / tone ------------------------------------------------------------------------------
${NoiseWGSL.hash13('hash3')}
${NoiseWGSL.value3('noise3', 'hash3')}
${NoiseWGSL.fbm('fbm', 'noise3', { dim: 3, octaves: 'param', shift: [1.7, 9.2, 3.1] })}
fn tone(c: vec3f) -> vec3f { return pow(vec3f(1.0) - exp(-c * frame.misc.x), vec3f(1.0 / 2.2)); }

// ---- sky ---------------------------------------------------------------------------------------
struct SkyOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f };

@vertex fn vsSky(@builtin(vertex_index) i: u32) -> SkyOut {
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    var o: SkyOut;
    o.clip = vec4f(xy, 0.0, 1.0);
    o.uv = xy;
    return o;
}

fn stars(d: vec3f) -> vec3f {
    var c = vec3f(0.0);
    for (var k = 0; k < 3; k++) {
        let s = 90.0 + f32(k) * 170.0;
        let p = d * s;
        let id = floor(p);
        let h = hash3(id + f32(k) * 17.0);
        if (h > 0.9) {
            let jitter = vec3f(hash3(id + 1.3), hash3(id + 2.7), hash3(id + 5.1)) - 0.5;
            let r = length(fract(p) - 0.5 - jitter * 0.6);
            let tint = mix(vec3f(0.65, 0.78, 1.0), vec3f(1.0, 0.82, 0.6), hash3(id + 9.0));
            c += tint * smoothstep(0.1, 0.0, r) * (h - 0.9) * 12.0 / (1.0 + f32(k));
        }
    }
    // faint galactic band, fixed in world space
    let band = exp(-abs(dot(d, normalize(vec3f(0.3, 0.9, 0.2)))) * 7.0);
    return c + vec3f(0.05, 0.05, 0.07) * band * (0.4 + fbm(d * 6.0, 4));
}

@fragment fn fsSky(v: SkyOut) -> @location(0) vec4f {
    let d = normalize(frame.fwd.xyz + frame.right.xyz * v.uv.x * frame.right.w + frame.up.xyz * v.uv.y * frame.up.w);
    let w = toWorldDir(d);
    return vec4f(tone(frame.sky.rgb + stars(w) * frame.sky.w), 1.0);
}

// ---- celestial bodies: exact ray / sphere per pixel -------------------------------------------------
// center.xyz origin space, center.w radius; shape = (altitude, surface, seed, halo); color.w emissive;
// atmo.w atmosphere height. The altitude comes from the CPU in doubles so the surface stays exact at 1 m.
struct BodyOut {
    @builtin(position) clip: vec4f,
    @location(0) ray: vec3f,
    @location(1) @interpolate(flat) bi: u32,
};
struct BodyFrag { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };

@vertex fn vsBody(@builtin(vertex_index) vi: u32, @builtin(instance_index) bi: u32) -> BodyOut {
    let b = bodies[bi];
    let dist = length(b.center.xyz - frame.cam.xyz);
    let half = max(b.center.w * max(b.shape.w, 1.02), dist * frame.sun.w * 8.0);
    let p = b.center.xyz + CUBE[vi] * half;
    var o: BodyOut;
    o.clip = frame.viewProj * vec4f(p, 1.0);
    o.ray = p - frame.cam.xyz;
    o.bi = bi;
    return o;
}

fn surfaceColor(b: Body, n: vec3f, t: f32) -> vec3f {
    let kind = u32(b.shape.y);
    let q = n + vec3f(b.shape.z);
    let base = b.color.rgb;
    let fine = clamp(1.0 - t / (b.center.w * 0.01), 0.0, 1.0);
    if (kind == 2u) {                                               // earth
        let h = fbm(q * 2.2, 6) + 0.06 * fbm(q * 40.0, 3);
        let land = smoothstep(0.52, 0.55, h);
        let landCol = mix(vec3f(0.1, 0.26, 0.07), vec3f(0.42, 0.36, 0.22), smoothstep(0.56, 0.75, h));
        var c = mix(vec3f(0.015, 0.06, 0.18), landCol, land);
        c = mix(c, vec3f(0.9), smoothstep(0.82, 0.9, abs(n.y) + 0.1 * h));
        let cloud = smoothstep(0.5, 0.72, fbm(q * 4.0 + vec3f(3.1), 5));
        return mix(c, vec3f(0.95), cloud * 0.85);
    }
    if (kind == 3u || kind == 4u) {                                 // gas / ice giant
        let w = fbm(q * vec3f(2.0, 10.0, 2.0), 5);
        let bands = select(12.0, 24.0, kind == 3u);
        let band = sin(n.y * bands + w * 4.0) * 0.5 + 0.5;
        var c = base * (0.72 + 0.4 * band);
        if (kind == 3u) { c = mix(c, base * vec3f(1.1, 0.75, 0.55), smoothstep(0.6, 0.8, w) * 0.6); }
        return c;
    }
    // rocky / mars: continents, then close-up detail that fades in near the camera
    let h = fbm(q * 3.0, 6);
    let d = (fbm(n * 2.0e4, 4) - 0.5) * 0.35 + (fbm(n * 3.0e5, 3) - 0.5) * 0.3 * fine;
    var c = base * (0.55 + 0.7 * h + d);
    if (kind == 5u) { c = mix(c, base * vec3f(0.45, 0.35, 0.3), smoothstep(0.55, 0.65, fbm(q * 5.0, 4))); }
    return c;
}

@fragment fn fsBody(v: BodyOut) -> BodyFrag {
    let b = bodies[v.bi];
    let dir = normalize(v.ray);
    let R = b.center.w;
    let oc = frame.cam.xyz - b.center.xyz;
    let bb = dot(oc, dir);
    let alt = b.shape.x;
    let c = alt * (alt + 2.0 * R);                  // |oc|^2 - R^2 without cancellation
    let disc = bb * bb - c;
    let near = frame.fwd.w;
    let fd = max(dot(dir, frame.fwd.xyz), 1e-6);
    var o: BodyFrag;
    if (disc >= 0.0 && c > 0.0 && bb < 0.0) {
        let t = c / (-bb + sqrt(disc));             // stable root: exact close to the surface
        let n = normalize(dir * t + oc);
        let p = frame.cam.xyz + dir * t;
        var col: vec3f;
        if (u32(b.shape.y) == 0u) {
            let g = fbm(toWorldDir(n) * 9.0 + vec3f(frame.cam.w * 0.01), 5);
            col = b.color.rgb * b.color.w * (0.7 + 0.6 * g) * (0.35 + 0.65 * pow(max(dot(n, -dir), 0.0), 0.35));
        } else {
            let alb = surfaceColor(b, toWorldDir(n), t);
            let L = normalize(frame.sun.xyz - p);
            let ndl = dot(n, L);
            col = alb * (max(ndl, 0.0) * frame.misc.y + 0.004);
            if (u32(b.shape.y) == 2u) { col += vec3f(0.6) * pow(max(dot(n, normalize(L - dir)), 0.0), 60.0) * max(ndl, 0.0) * 0.3; }
            if (b.atmo.w > 0.0) {
                let rim = pow(1.0 - max(dot(n, -dir), 0.0), 3.0);
                let day = smoothstep(-0.25, 0.35, ndl);
                col = mix(col, b.atmo.rgb * day * 0.5, 0.12 * day) + b.atmo.rgb * rim * day * 0.9;
            }
        }
        o.color = vec4f(tone(col), 1.0);
        o.depth = clamp(near / (t * fd), 0.0, 1.0);
        return o;
    }
    // missed: distant bodies still read as a dot, stars get a halo
    if (bb >= 0.0) { discard; }
    let dist = length(oc);
    let ang = length(oc - dir * bb) / dist;
    let angR = R / dist;
    let pix = frame.sun.w;
    let dotW = clamp((4.0 * pix - angR) / (3.0 * pix), 0.0, 1.0);
    let spot = exp(-pow(ang / (angR + 1.3 * pix), 2.0)) * dotW;
    var halo = 0.0;
    if (b.color.w > 0.0) { halo = exp(-max(ang - angR, 0.0) / (angR * 0.6 + pix * 3.0)) * 0.8; }
    let col = b.color.rgb * (spot * select(1.4, b.color.w, b.color.w > 0.0) + halo * 2.0);
    if (max(col.r, max(col.g, col.b)) < 0.004) { discard; }
    o.color = vec4f(tone(col), 1.0);
    o.depth = clamp(near / (dist * fd), 0.0, 1.0);
    return o;
}

// ---- entity instances ----------------------------------------------------------------------------
struct MeshOut {
    @builtin(position) clip: vec4f,
    @location(0) po: vec3f,
    @location(1) n: vec3f,
    @location(2) lp: vec3f,
    @location(3) onrm: vec3f,
    @location(4) @interpolate(flat) mat: u32,
    @location(5) @interpolate(flat) seed: f32,
    @location(6) tint: vec3f,
    @location(7) fade: f32,
};

@vertex fn vsMesh(@location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) mat: u32, @builtin(instance_index) ii: u32) -> MeshOut {
    let inst = instances[ii];
    let m = materials[mat];
    let center = toOrigin(relative(inst.cell.xyz, inst.local.xyz));
    var p = pos;
    var grow = 1.0;
    var fade = 1.0;
    if (u32(m.albedo.w) == 2u) {
        p = p * (0.72 + 0.56 * noise3(p * 1.9 + vec3f(inst.local.w * 7.31)));
        // sub-pixel rocks stay one pixel wide: distant fields read as dust instead of flickering
        let px = length(toOrigin(inst.ax.xyz)) / max(length(center - frame.cam.xyz) * frame.sun.w, 1e-30);
        if (px < 0.7) { grow = 0.7 / max(px, 1e-6); fade = sqrt(px / 0.7); }
    }
    let off = inst.ax.xyz * p.x + inst.ay.xyz * p.y + inst.az.xyz * p.z;
    let po = center + toOrigin(off) * grow;
    let nw = cross(inst.ay.xyz, inst.az.xyz) * nrm.x + cross(inst.az.xyz, inst.ax.xyz) * nrm.y + cross(inst.ax.xyz, inst.ay.xyz) * nrm.z;
    var o: MeshOut;
    o.clip = frame.viewProj * vec4f(po, 1.0);
    o.po = po;
    o.n = toOrigin(nw);
    o.lp = pos * vec3f(length(inst.ax.xyz), length(inst.ay.xyz), length(inst.az.xyz));
    o.onrm = nrm;
    o.mat = mat;
    o.seed = inst.local.w;
    o.tint = inst.tint.rgb;
    o.fade = fade;
    return o;
}

@fragment fn fsMesh(v: MeshOut) -> @location(0) vec4f {
    let faceN = cross(dpdx(v.po), dpdy(v.po));
    let m = materials[v.mat];
    let pat = u32(m.albedo.w);
    var n = normalize(v.n);
    if (pat == 2u) { n = normalize(faceN + vec3f(1e-20)); }
    let V = normalize(frame.cam.xyz - v.po);
    if (dot(n, V) < 0.0) { n = -n; }

    var alb = m.albedo.rgb * v.tint;
    var emi = m.emissive.rgb * m.emissive.w;
    // panel grid in object space (metres / scale); the axis along the normal draws no seams
    let an = abs(normalize(v.onrm));
    let g = v.lp / max(m.params.z, 1e-3);
    let q = abs(fract(g) - 0.5) * (vec3f(1.0) - step(vec3f(0.7), an));
    let seam = max(max(q.x, q.y), q.z);
    let line = smoothstep(0.45, 0.49, seam);
    let h = hash3(floor(g) * (vec3f(1.0) - step(vec3f(0.7), an)) + vec3f(v.seed * 3.0));
    switch pat {
        case 1u: { alb *= (0.84 + 0.16 * h) * mix(1.0, 0.45, line); emi *= 0.0; }
        case 2u, 7u: { alb *= 0.65 + 0.7 * fbm(v.lp * 0.6 + vec3f(v.seed * 11.0), 3); }
        case 3u: { emi *= smoothstep(0.55, 0.75, sin((frame.cam.w * m.params.w + v.seed) * 6.2832) * 0.5 + 0.5); }
        case 4u: {
            let lit = step(0.3, h) * (1.0 - smoothstep(0.26, 0.32, seam));
            alb *= mix(1.0, 0.45, line) * (1.0 - lit * 0.8);
            emi *= lit;
        }
        case 5u: { alb = mix(alb, vec3f(0.65), line); emi *= 0.0; }
        case 6u: { alb = select(vec3f(0.05), alb, fract(dot(v.lp, vec3f(1.0)) / max(m.params.z, 1e-3)) < 0.5); emi *= 0.0; }
        default: {}
    }

    let L = normalize(frame.sun.xyz - v.po);
    let diff = max(dot(n, L), 0.0);
    let H = normalize(L + V);
    let spec = m.params.x * pow(max(dot(n, H), 0.0), m.params.y) * diff;
    let amb = frame.sky.rgb * 0.25 + vec3f(0.016, 0.018, 0.024);
    let col = (alb * (diff * frame.misc.y + amb) + spec * frame.misc.y + emi) * v.fade;
    return vec4f(tone(col), 1.0);
}
`;

return { WGSL };
});
