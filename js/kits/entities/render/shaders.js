'use strict';
// WGSL: sky, celestial bodies and entity instances, relative to the floating origin.

Features.world('origin', (engine, kit) => {
const { kits } = engine;
const { NoiseWGSL } = kits.noise;
const { StormWGSL } = kits.weather;
const { CELL, VERTEX_FLOATS, MAX_COVERS, MAX_STORMS, CLOUD_TOP, MeshBuilder } = kit;

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
    misc: vec4f,        // exposure, sun intensity, covers
    eye: vec4f,         // x: the night-adapted eye's gain on sunlit bodies (1 by day and from space)
    clouds: vec4f,      // storms, the air of the worlds on the bodies (their own clouds about the eye), its reach, units per m
    cover: array<vec4f, ${MAX_COVERS * 3}>,   // the ground and cloud layer of worlds standing on the bodies (AppExtension.writeCovers)
    storm: array<vec4f, ${MAX_STORMS * 4}>,   // the storms in the bodies' clouds (AppExtension.writeStorms)
};
struct Origin { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f };
struct Material { albedo: vec4f, emissive: vec4f, params: vec4f };
struct Instance { cell: vec4i, local: vec4f, ax: vec4f, ay: vec4f, az: vec4f, tint: vec4f };
struct Body { center: vec4f, shape: vec4f, color: vec4f, atmo: vec4f, clouds: vec4f };

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
${NoiseWGSL.hash12('hash12')}
${NoiseWGSL.value2('vnoise2', 'hash12')}
${NoiseWGSL.fbm('fbm2', 'vnoise2', { octaves: 'param', shift: [17.1, -9.3], normalize: true })}
${StormWGSL}
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

// a pixel's dither (interleaved gradient noise): where the clouds' march starts within its first step
fn jitterAt(px: vec2f) -> f32 { return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715)))); }

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

// how much body bi's surface in world direction n takes the colour of the ground of a world standing on it there (rgb;
// a: all of it over that world's ground, easing back to the body's own colour over eight times its radius)
fn coverAt(bi: u32, n: vec3f) -> vec4f {
    var o = vec4f(0.0);
    for (var k = 0u; k < u32(frame.misc.z); k++) {
        let c = frame.cover[k * 3u];
        let d = frame.cover[k * 3u + 1u];
        if (u32(c.w) != bi) { continue; }
        let w = 1.0 - smoothstep(d.w, d.w * 8.0, length(n - c.xyz));
        if (w > o.a) { o = vec4f(d.rgb, w); }
    }
    return o;
}

fn surfaceColor(b: Body, bi: u32, n: vec3f, t: f32) -> vec3f {
    let kind = u32(b.shape.y);
    let cov = coverAt(bi, n);
    let q = n + vec3f(b.shape.z);
    let base = b.color.rgb;
    let fine = clamp(1.0 - t / (b.center.w * 0.01), 0.0, 1.0);
    if (kind == 2u) {                                               // earth
        let h = fbm(q * 2.2, 6) + 0.06 * fbm(q * 40.0, 3);
        let land = max(smoothstep(0.52, 0.55, h), cov.a);
        let landCol = mix(mix(vec3f(0.1, 0.26, 0.07), vec3f(0.42, 0.36, 0.22), smoothstep(0.56, 0.75, h)), cov.rgb, cov.a);
        // close up (from some 700 km in), the land's own patchwork of some kilometres and some hundreds of metres, about
        // its colour from afar
        // (each of them gone before it is finer than a pixel, px: the pixel's size on the unit sphere)
        let px = t * frame.sun.w / b.center.w;
        let near1 = (1.0 - smoothstep(b.center.w * 0.004, b.center.w * 0.12, t)) * (1.0 - smoothstep(0.08, 0.25, px * 2.0e3));
        let near2 = (1.0 - smoothstep(b.center.w * 0.0005, b.center.w * 0.006, t)) * (1.0 - smoothstep(0.1, 0.3, px * 2.0e4));
        // (lighter and darker, and in patches greener: crops and fallow seen from afar)
        let mottle = 1.0 + (fbm(n * 2.0e3, 2) - 0.5) * 1.6 * near1 + (fbm(n * 2.0e4, 3) - 0.5) * 0.8 * near2;
        let green = smoothstep(0.42, 0.62, fbm(n * 5.0e3 + vec3f(7.0), 2)) * near1 * (1.0 - smoothstep(0.08, 0.25, px * 5.0e3)) * 0.8;
        var c = mix(vec3f(0.015, 0.06, 0.18), mix(landCol, landCol * vec3f(0.72, 1.08, 0.66), green) * mottle, land);
        return mix(c, vec3f(0.9), smoothstep(0.82, 0.9, abs(n.y) + 0.1 * h));
    }
    if (kind == 3u || kind == 4u) {                                 // gas / ice giant
        let w = fbm(q * vec3f(2.0, 10.0, 2.0), 5);
        let bands = select(12.0, 24.0, kind == 3u);
        let band = sin(n.y * bands + w * 4.0) * 0.5 + 0.5;
        var c = base * (0.72 + 0.4 * band);
        if (kind == 3u) { c = mix(c, base * vec3f(1.1, 0.75, 0.55), smoothstep(0.6, 0.8, w) * 0.6); }
        return mix(c, cov.rgb, cov.a);
    }
    // rocky / mars: continents, then close-up detail that fades in near the camera
    let h = fbm(q * 3.0, 6);
    let d = (fbm(n * 2.0e4, 4) - 0.5) * 0.35 + (fbm(n * 3.0e5, 3) - 0.5) * 0.3 * fine;
    var c = base * (0.55 + 0.7 * h + d);
    if (kind == 5u) { c = mix(c, base * vec3f(0.45, 0.35, 0.3), smoothstep(0.55, 0.65, fbm(q * 5.0, 4))); }
    return mix(c, cov.rgb, cov.a);
}

// ---- a body's clouds: a shell of its cloud source's layer and storms, marched ---------------------------------------
// The clouds over body b (bi) at world direction n, on its ground (m): the coverage and top of its layer (b.clouds:
// coverage, base, top; about a world standing on it, that world's layer, its covers'), with the storms in it
// (frame.storm: the weather kit's shapes, which the atmosphere's weather map draws too), and an anvil sheet's cover and
// top (a cell's anvil, a hurricane's dense overcast). fine: how much of the fields finer than the continents shows
// (0 .. 1, gone before they are finer than a pixel)
struct CloudField { cov: f32, top: f32, anv: f32, anvTop: f32, base: f32 };

fn cloudField(b: Body, bi: u32, n: vec3f, fine: f32) -> CloudField {
    var layer = b.clouds.xyz;
    for (var k = 0u; k < u32(frame.misc.z); k++) {
        let c = frame.cover[k * 3u];
        let e = frame.cover[k * 3u + 2u];
        if (u32(c.w) != bi || e.w <= 0.0) { continue; }
        let r = frame.cover[k * 3u + 1u].w;
        layer = mix(layer, e.xyz, 1.0 - smoothstep(r, r * 8.0, length(n - c.xyz)));
    }
    let Rm = b.center.w / frame.clouds.w;
    // the layer: fields of cloud with gaps between them, broken up finer from some 3000 km in, finer still close by
    var deck = fbm((n + vec3f(b.shape.z)) * 4.0 + vec3f(3.1), 5) + (fbm(n * 90.0 + vec3f(5.3), 3) - 0.5) * 0.45;
    if (fine > 0.0) { deck += (fbm(n * 900.0, 2) - 0.5) * 0.35 * fine; }
    let lo = 0.62 - 0.25 * layer.x;
    var f: CloudField;
    f.base = layer.y;
    f.cov = smoothstep(lo, lo + 0.2, deck);
    f.top = mix(layer.y + 500.0, layer.z, smoothstep(lo, lo + 0.35, deck));
    f.anv = 0.0;
    f.anvTop = 0.0;
    for (var k = 0u; k < u32(frame.clouds.x); k++) {
        let s0 = frame.storm[k * 4u];
        let s1 = frame.storm[k * 4u + 1u];
        let s2 = frame.storm[k * 4u + 2u];
        let s3 = frame.storm[k * 4u + 3u];
        let hurricane = s1.x < 1.5;
        // (beyond its outer bands, or its anvil's reach: nothing of it)
        if (u32(s0.w) != bi || dot(n, s0.xyz) < cos(select(s1.y * 3.4, s2.w, hurricane) / Rm)) { continue; }
        // its ground plane about it (m)
        let e1 = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(s0.y) > 0.99), s0.xyz));
        let e2 = cross(s0.xyz, e1);
        let rel = vec2f(dot(n, e1), dot(n, e2)) * Rm;
        let xz = rel + vec2f(s1.w * 1000.0);
        if (hurricane) {
            let hs = hurricaneShape(xz, rel, vec4f(0.0, 0.0, s1.y, s1.z), s2, s3);
            f.cov = max(f.cov, max(hs.wall, hs.band * 0.9) * s1.z);
            f.top = max(f.top, max(mix(layer.z, s2.x, hs.wall * s1.z), mix(layer.z, s3.y, hs.band * s1.z * (0.7 + 0.6 * hs.bn))));
            f.anv = max(f.anv, hs.cdo * s1.z * 0.95);
            f.anvTop = max(f.anvTop, s2.x);
            let eye = hs.eye * s1.z;
            f.cov = mix(f.cov, s3.z * smoothstep(0.45, 0.75, deck + 0.2), eye);
            f.top = mix(f.top, layer.y + 900.0, eye);
            f.anv *= 1.0 - eye;
        } else {
            let wv = vec2f(dot(s2.yzw, e1), dot(s2.yzw, e2));
            let an = cellAnvil(xz, rel, length(rel), s1.y, s2.x, s1.z, s1.w, select(vec2f(1.0, 0.0), normalize(wv), length(wv) > 1e-12), layer.yz);
            if (an.x > 0.005) { f.anv = max(f.anv, an.x); f.anvTop = max(f.anvTop, an.y); }
            let gs = cellTower(xz, rel, s1.y, s1.w, vec2f(0.0)).x;
            f.cov = max(f.cov, gs * s1.z * 0.9);
            f.top = max(f.top, mix(layer.z, s2.x, pow(gs, 0.55) * clamp(s1.z * 3.0, 0.0, 1.0)));       // domed towers
        }
    }
    return f;
}

// how dense the clouds of field f are h m up (0 .. 1): a column filled up to its top where it is covered all over,
// domed at its edges (less of it the higher), from its base; an anvil sheet some 1.5 km thick under its top; detail:
// the billows' noise (0 .. 1)
fn cloudDensity(f: CloudField, h: f32, detail: f32) -> f32 {
    let hf = (h - f.base) / max(f.top - f.base, 100.0);
    let low = clamp((f.cov * (0.75 + 0.5 * detail) - 0.15 - 0.85 * hf) * 4.0, 0.0, 1.0) * smoothstep(f.base - 100.0, f.base + 300.0, h)
        * (1.0 - smoothstep(1.0, 1.15, hf));
    let sheet = clamp(f.anv * 2.0 - 0.2, 0.0, 1.0) * smoothstep(f.anvTop - 2000.0, f.anvTop - 1200.0, h) * (1.0 - smoothstep(f.anvTop - 300.0, f.anvTop, h));
    return max(low, sheet * (0.8 + 0.4 * detail));
}

fn mixField(a: CloudField, b: CloudField, x: f32) -> CloudField {
    var f: CloudField;
    f.cov = mix(a.cov, b.cov, x);
    f.top = mix(a.top, b.top, x);
    f.anv = mix(a.anv, b.anv, x);
    f.anvTop = mix(a.anvTop, b.anvTop, x);
    f.base = mix(a.base, b.base, x);
    return f;
}

// the clouds of body b (bi) on the ray from oc (the eye, from its centre) along dir, between ta and tb (origin units),
// lit by the sun along L: their light, what they let through, and where they are, to the eye, as a surface (where
// half the light is gone; tb if it never is: what lies behind them drawn over them shows there). The field at three
// points along the way (the costly part: it changes little across the shell), the march between them mixing theirs,
// only where they reach up and down to; its noise on top. Within the air of a world standing on it (frame.clouds.y),
// out to that world's own clouds' reach, it gives way to those
struct Clouds { light: vec3f, through: f32, front: f32 };

fn cloudMarch(b: Body, bi: u32, oc: vec3f, dir: vec3f, ta: f32, tb: f32, L: vec3f, jitter: f32) -> Clouds {
    let upm = frame.clouds.w;
    let R = b.center.w;
    var o = Clouds(vec3f(0.0), 1.0, tb);
    // (wholly within the air of a world standing on it: from where that world's own give way to them)
    let tn = max(ta, select(0.0, frame.clouds.z * 0.6, frame.clouds.y >= 0.999));
    if (tn >= tb) { return o; }
    let fine = 1.0 - smoothstep(0.1, 0.3, tn * frame.sun.w / R * 900.0);
    let f0 = cloudField(b, bi, toWorldDir(oc + dir * tn), fine);
    let f1 = cloudField(b, bi, toWorldDir(oc + dir * (tn + tb) * 0.5), fine);
    let f2 = cloudField(b, bi, toWorldDir(oc + dir * tb), fine);
    if (max(max(f0.cov, f1.cov), f2.cov) + max(max(f0.anv, f1.anv), f2.anv) < 0.02) { return o; }
    // between the highest of their tops and the lowest of their bases
    let hi = shellSpan(b, oc, dir, max(max(max(f0.top, f1.top), f2.top), max(max(f0.anvTop, f1.anvTop), f2.anvTop)) + 300.0);
    let lo = shellSpan(b, oc, dir, min(min(f0.base, f1.base), f2.base) - 150.0);
    let t0 = max(tn, hi.x);
    let t1 = min(min(tb, hi.y), select(tb, lo.x, lo.y > lo.x && lo.x > 0.0));
    if (t1 <= t0) { return o; }
    // what stands between the sun and the middle of the way: the field where the sun's ray from there reaches the
    // height of the storms' anvils (their sheets, and the towers rising to them, shade what is below them)
    let pm = oc + dir * (t0 + t1) * 0.5;
    let hm = (length(pm) - R) / upm;
    let fs = cloudField(b, bi, toWorldDir(normalize(pm + L * max(10000.0 - hm, 0.0) * upm / max(dot(normalize(pm), L), 0.08))), 0.0);
    // the billows: some 4 km across, gone before they are finer than a pixel
    let billow = R / upm / 4000.0;
    let fineD = 1.0 - smoothstep(0.15, 0.4, t0 * frame.sun.w * billow / R);
    let N = 14;
    let ds = (t1 - t0) / f32(N) / upm;          // m
    for (var i = 0; i < N; i++) {
        let t = mix(t0, t1, (f32(i) + jitter) / f32(N));
        let x = (t - tn) / (tb - tn);
        let p = oc + dir * t;
        let r = length(p);
        let nl = p / r;
        let h = (r - R) / upm;
        var f = mixField(f0, f1, x * 2.0);
        if (x >= 0.5) { f = mixField(f1, f2, x * 2.0 - 1.0); }
        let detail = mix(0.5, noise3(toWorldDir(nl) * billow), fineD);
        let near = 1.0 - frame.clouds.y * (1.0 - smoothstep(frame.clouds.z * 0.6, frame.clouds.z, t));
        let d = cloudDensity(f, h, detail) * near;
        if (d <= 0.002) { continue; }
        let a = 1.0 - exp(-0.004 * d * ds);
        // the sun through the column above it to its top (thinned: most of what it scatters goes on down), half of it
        // always getting through (scattered on), and the sky's
        let mu = dot(nl, L);
        let od = 0.0006 * max(max(f.top, f.anvTop) - h, 0.0) * max(f.cov, f.anv) / max(mu, 0.15);
        let shade = max(clamp(fs.anv * 1.5, 0.0, 1.0) * (1.0 - smoothstep(fs.anvTop - 2500.0, fs.anvTop - 1500.0, h)),
            fs.cov * smoothstep(9000.0, 10500.0, fs.top) * (1.0 - smoothstep(8000.0, 9500.0, h)));
        let light = 0.95 * frame.misc.y * (max(mu, 0.0) * (0.5 + 0.5 * exp(-od)) * (1.0 - 0.75 * shade) + 0.004) * frame.eye.x;
        o.light += o.through * a * vec3f(light);
        if (o.through >= 0.5 && o.through * (1.0 - a) < 0.5) { o.front = t; }
        o.through *= 1.0 - a;
        if (o.through < 0.01) { break; }
    }
    return o;
}

// where the ray from oc along dir (unit) passes through the sphere hm m over body b's ground: vec2f(in (0 from
// within), out), out < in for none (alt: the eye's altitude, exact, as in fsBody)
fn shellSpan(b: Body, oc: vec3f, dir: vec3f, hm: f32) -> vec2f {
    let R = b.center.w;
    let top = hm * frame.clouds.w;
    let alt = b.shape.x;
    let bb = dot(oc, dir);
    let c = (alt - top) * (alt + top + 2.0 * R);    // |oc|^2 - (R + top)^2 without cancellation
    let disc = bb * bb - c;
    if (disc < 0.0 || (c > 0.0 && bb >= 0.0)) { return vec2f(0.0, -1.0); }
    let s = sqrt(disc);
    return vec2f(select(0.0, c / (-bb + s), c > 0.0), -bb + s);
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
        var depthT = t;
        var col: vec3f;
        if (u32(b.shape.y) == 0u) {
            let g = fbm(toWorldDir(n) * 9.0 + vec3f(frame.cam.w * 0.01), 5);
            col = b.color.rgb * b.color.w * (0.7 + 0.6 * g) * (0.35 + 0.65 * pow(max(dot(n, -dir), 0.0), 0.35));
        } else {
            let alb = surfaceColor(b, v.bi, toWorldDir(n), t);
            let L = normalize(frame.sun.xyz - p);
            let ndl = dot(n, L);
            col = alb * (max(ndl, 0.0) * frame.misc.y + 0.004) * frame.eye.x;
            if (u32(b.shape.y) == 2u) { col += vec3f(0.6) * pow(max(dot(n, normalize(L - dir)), 0.0), 60.0) * max(ndl, 0.0) * 0.3; }
            if (b.clouds.w > 0.0) {
                // its clouds between the eye and the ground; where the ground shows through them, their shadow on it (the
                // field where the sun's ray meets their layer's middle, and where it meets the storms' anvils)
                let span = shellSpan(b, oc, dir, ${CLOUD_TOP}.0);
                let cl = cloudMarch(b, v.bi, oc, dir, span.x, min(span.y, t), L, jitterAt(v.clip.xy));
                if (cl.through > 0.05) {
                    let up = frame.clouds.w / max(ndl, 0.2);
                    let fl = cloudField(b, v.bi, toWorldDir(normalize(n * R + L * (b.clouds.y + b.clouds.z) * 0.5 * up)), 0.0);
                    let fa = cloudField(b, v.bi, toWorldDir(normalize(n * R + L * 10000.0 * up)), 0.0);
                    col *= mix(1.0, 0.35, clamp(max(max(fl.cov, fl.anv), fa.anv) * 1.3, 0.0, 1.0));
                }
                col = col * cl.through + cl.light;
                // (as deep as they are where they hide the ground: what other worlds draw of it stays under them)
                depthT = min(depthT, cl.front);
            }
            if (b.atmo.w > 0.0) {
                // the air between the eye and the ground: all of it from space; from within the air, only as much as the
                // way through it holds (t against its height), so the ground close by keeps its colour
                let rim = pow(1.0 - max(dot(n, -dir), 0.0), 3.0);
                let day = smoothstep(-0.25, 0.35, ndl) * (1.0 - exp(-t / b.atmo.w));
                col = mix(col, b.atmo.rgb * day * 0.5, 0.12 * day) + b.atmo.rgb * rim * day * 0.9;
            }
        }
        o.color = vec4f(tone(col), 1.0);
        o.depth = clamp(near / (depthT * fd), 0.0, 1.0);
        return o;
    }
    // missed: the clouds over its limb, blended over what lies behind (their light, as much as they hide)
    if (b.clouds.w > 0.0) {
        let span = shellSpan(b, oc, dir, ${CLOUD_TOP}.0);
        if (span.y > span.x) {
            let L = normalize(frame.sun.xyz - frame.cam.xyz - dir * span.x);
            let cl = cloudMarch(b, v.bi, oc, dir, span.x, span.y, L, jitterAt(v.clip.xy));
            if (cl.through < 0.996) {
                o.color = vec4f(tone(cl.light / (1.0 - cl.through)), 1.0 - cl.through);
                o.depth = clamp(near / (cl.front * fd), 0.0, 1.0);
                return o;
            }
        }
    }
    // missed: a body smaller than a pixel still reads as a dot, stars get a glare
    if (bb >= 0.0) { discard; }
    let dist = length(oc);
    let ang = length(oc - dir * bb) / dist;
    let angR = R / dist;
    let pix = frame.sun.w;
    // the dot: a pixel or so as bright as the disc would be, only while the disc is smaller than a pixel: one drawn
    // whole gets no ring of light round it
    let dotW = 1.0 - smoothstep(0.5 * pix, 1.5 * pix, angR);
    let spot = exp(-pow(ang / (0.8 * pix), 2.0)) * dotW;
    // how bright the disc is as a whole: a star its own light; else sunlit by its phase (a Lambert sphere: the disc's
    // mean of n.l, 2/3 full, none new)
    var lum = b.color.w;
    if (b.color.w <= 0.0) {
        let ca = clamp(dot(normalize(frame.sun.xyz - b.center.xyz), normalize(oc)), -1.0, 1.0);
        let a = acos(ca);
        lum = frame.misc.y * (2.0 / 3.0) * (sin(a) + (3.14159265 - a) * ca) / 3.14159265 * frame.eye.x;
    }
    var halo = 0.0;
    if (b.color.w > 0.0) {
        // a glare a few pixels wide round it (an eye's or a lens's, not the star's size); the billboard's edge: the glow
        // fades out before it, so the quad never shows as a box
        let angQ = max(R * max(b.shape.w, 1.02) / dist, pix * 8.0);
        halo = exp(-max(ang - angR, 0.0) / (angR * 0.1 + pix * 1.5)) * 0.6 * (1.0 - smoothstep(0.5, 1.0, (ang - angR) / max(angQ - angR, 1e-9)));
    }
    let col = b.color.rgb * (spot * lum + halo * 1.2);
    // the glow is blended over the sky (alpha = its brightness), not painted over it: a dark box round every star
    let t = tone(col);
    let a = max(t.r, max(t.g, t.b));
    if (a < 0.004) { discard; }
    o.color = vec4f(t / a, clamp(a, 0.0, 1.0));
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
