'use strict';
// WGSL: the world, sky, portal polygons and debug lines.

Features.part('portal', (engine, feature) => {
const { MAX_LIGHTS, MAX_FOG_PORTALS } = feature;

// WGSL sources. The scene shader indexes the per-area lighting table and the material table (storage
// buffers) with the draw's area and each vertex's material id.

const WGSL_COMMON = /* wgsl */`
struct Globals {
    viewProj: mat4x4f, invViewProj: mat4x4f, eye: vec4f, sunDir: vec4f, sunColor: vec4f,
    skyTop: vec4f, skyHorizon: vec4f, params: vec4f,
};
struct Light { posRad: vec4f, color: vec4f };
struct Area { ambient: vec4f, fog: vec4f, info: vec4f, lights: array<Light, ${MAX_LIGHTS}> };
struct Material { albedo: vec4f, params: vec4f, emissive: vec4f };
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<storage, read> areas: array<Area>;
@group(0) @binding(2) var<storage, read> mats: array<Material>;

fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
    var s = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
    return s;
}
fn tonemap(c: vec3f) -> vec3f { return pow(vec3f(1.0) - exp(-c * 1.15), vec3f(1.0 / 2.2)); }
fn skyColor(dir: vec3f) -> vec3f {
    let t = dir.y;
    var col = mix(G.skyHorizon.rgb, G.skyTop.rgb, pow(max(t, 0.0), 0.6));
    if (t < 0.0) { col = mix(G.skyHorizon.rgb, G.skyHorizon.rgb * 0.5, min(-t * 4.0, 1.0)); }
    if (t > 0.01) {
        let uv = dir.xz / t * 0.6 + vec2f(G.params.x * 0.01, 0.0);
        let c = smoothstep(0.5, 0.8, fbm(uv));
        col = mix(col, vec3f(1.6), c * 0.6 * smoothstep(0.0, 0.25, t));
    }
    let sd = max(dot(dir, normalize(G.sunDir.xyz)), 0.0);
    return col + G.sunColor.rgb * (pow(sd, 900.0) * 8.0 + pow(sd, 10.0) * 0.25);
}
`;

const WGSL_WORLD = WGSL_COMMON + /* wgsl */`
// info: x = lighting area, y = number of fog portals.
// fogPlanes / fogColors: the portals this draw is seen through, nearest first, with the fog (rgb, density)
// of the area in front of each one
struct Draw {
    model: mat4x4f, info: vec4f, tint: vec4f,
    fogPlanes: array<vec4f, ${MAX_FOG_PORTALS}>, fogColors: array<vec4f, ${MAX_FOG_PORTALS}>,
};
@group(1) @binding(0) var<uniform> D: Draw;

// Fog along the view ray, split at the portals it passes through: each segment is fogged by the area it
// crosses, the last one (behind the deepest portal) by the surface's own area.
fn applyFog(c: vec3f, wpos: vec3f, own: vec4f) -> vec3f {
    let dist = length(wpos - G.eye.xyz);
    let n = u32(D.info.y);
    var t: array<f32, ${MAX_FOG_PORTALS + 1}>;      // fraction of the ray at each portal crossing
    t[0] = 0.0;
    for (var k = 0u; k < n; k++) {
        let pl = D.fogPlanes[k];
        let se = dot(pl.xyz, G.eye.xyz) + pl.w;
        let sp = dot(pl.xyz, wpos) + pl.w;
        var tk = 1.0;
        if (abs(se - sp) > 1e-6) { tk = clamp(se / (se - sp), 0.0, 1.0); }
        t[k + 1] = max(tk, t[k]);
    }
    var col = mix(c, own.rgb, 1.0 - exp(-dist * (1.0 - t[n]) * own.w));
    for (var k = i32(n) - 1; k >= 0; k--) {
        let f = D.fogColors[k];
        col = mix(col, f.rgb, 1.0 - exp(-dist * (t[k + 1] - t[k]) * f.w));
    }
    return col;
}

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) wpos: vec3f,
    @location(1) nrm: vec3f,
    @location(2) lpos: vec3f,
    @location(3) @interpolate(flat) mat: u32,
    @location(4) lnrm: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: u32) -> VOut {
    var o: VOut;
    let w = D.model * vec4f(p, 1.0);
    o.pos = G.viewProj * w;
    o.wpos = w.xyz;
    o.nrm = (D.model * vec4f(n, 0.0)).xyz;
    o.lpos = p;
    o.lnrm = n;
    o.mat = m;
    return o;
}

// procedural surface: rgb = albedo, a = emissive mask
fn surface(m: Material, lp: vec3f, n: vec3f) -> vec4f {
    let an = abs(n);
    var uv = lp.xy;
    if (an.y > an.x && an.y > an.z) { uv = lp.xz; } else if (an.x > an.z) { uv = lp.zy; }
    uv = uv * m.params.x;
    let base = m.albedo.rgb;
    let kind = i32(m.albedo.w + 0.5);
    var col = base;
    var em = 1.0;
    switch kind {
        case 1: {
            let g = abs(fract(uv) - 0.5);
            let line = smoothstep(0.44, 0.48, max(g.x, g.y));
            col = base * (0.9 + 0.12 * hash2(floor(uv))) * (1.0 - 0.45 * line);
        }
        case 2: {
            let g = abs(fract(uv) - 0.5); let e = max(g.x, g.y);
            let seam = smoothstep(0.46, 0.49, e); let bevel = smoothstep(0.40, 0.46, e) * 0.12;
            col = base * (0.95 + 0.1 * hash2(floor(uv))) * (1.0 - 0.55 * seam + bevel) * (0.92 + 0.12 * vnoise(uv * 6.0));
        }
        case 3: { col = base * (0.78 + 0.38 * fbm(uv * 3.0)); }
        case 4: {
            let n1 = fbm(uv * 2.0); let n2 = vnoise(uv * 23.0);
            col = mix(base * 0.7, base * vec3f(1.25, 1.15, 0.9), n1) * (0.85 + 0.25 * n2);
        }
        case 5: { col = mix(base, vec3f(0.04), step(0.5, fract(uv.x + uv.y))); }
        case 6: {
            let row = floor(uv.y * 4.0);
            let x = uv.x + hash2(vec2f(row, 3.0)) * 3.0;
            let seam = min(step(fract(uv.y * 4.0), 0.06) + step(fract(x * 0.5), 0.02), 1.0);
            let grain = 0.85 + 0.25 * vnoise(vec2f(x * 2.0, uv.y * 40.0));
            col = base * grain * (0.9 + 0.2 * hash2(vec2f(row, floor(x * 0.5)))) * (1.0 - 0.5 * seam);
        }
        case 7: {
            let r = floor(uv.y * 4.0);
            let x = uv.x * 2.0 + select(0.0, 0.5, (i32(r) & 1) == 1);
            let mortar = max(step(fract(x), 0.05), step(fract(uv.y * 4.0), 0.08));
            col = mix(base * (0.8 + 0.3 * hash2(vec2f(floor(x), r))), vec3f(0.55, 0.53, 0.5), mortar);
        }
        case 8: {
            let t = G.params.x;
            let scan = 0.7 + 0.3 * sin(uv.y * 140.0 - t * 8.0);
            let cell = floor(uv * vec2f(16.0, 9.0));
            let blocks = step(0.5, hash2(cell + vec2f(floor(t * 1.5), 0.0)));
            em = scan * (0.25 + 0.75 * blocks);
        }
        case 9: {
            // painted steel with vertical rust streaks and panel seams
            let streak = smoothstep(0.55, 0.95, vnoise(vec2f(uv.x * 9.0, uv.y * 0.6)) * fbm(uv * vec2f(2.0, 0.4)) * 1.8);
            let seam = smoothstep(0.47, 0.5, abs(fract(uv.x * 0.25) - 0.5)) * 0.35;
            col = mix(base * (0.85 + 0.2 * fbm(uv * 2.0)), vec3f(0.30, 0.13, 0.05), streak) * (1.0 - seam);
        }
        default: {}
    }
    return vec4f(col, em);
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    let m = mats[i.mat];
    let ai = u32(D.info.x);
    let N = normalize(i.nrm);
    let s = surface(m, i.lpos, normalize(i.lnrm));
    let albedo = s.rgb * D.tint.rgb;
    let V = normalize(G.eye.xyz - i.wpos);
    var col = albedo * areas[ai].ambient.rgb * (0.7 + 0.3 * N.y);
    let sunAmt = areas[ai].info.x;
    if (sunAmt > 0.0) {
        let L = normalize(G.sunDir.xyz);
        let ndl = max(dot(N, L), 0.0);
        let H = normalize(L + V);
        col += (albedo + vec3f(pow(max(dot(N, H), 0.0), 48.0) * m.params.y)) * ndl * G.sunColor.rgb * sunAmt;
    }
    let count = u32(areas[ai].info.y);
    for (var k = 0u; k < count; k++) {
        let lp = areas[ai].lights[k].posRad;
        let lc = areas[ai].lights[k].color;
        let dv = lp.xyz - i.wpos;
        let dist = length(dv);
        let L = dv / max(dist, 1e-4);
        let att = pow(clamp(1.0 - dist / lp.w, 0.0, 1.0), 2.0);
        let ndl = max(dot(N, L), 0.0);
        let H = normalize(L + V);
        col += (albedo + vec3f(pow(max(dot(N, H), 0.0), 32.0) * m.params.y)) * ndl * lc.rgb * lc.w * att;
    }
    col += m.emissive.rgb * m.emissive.w * s.a;
    return vec4f(tonemap(applyFog(col, i.wpos, areas[ai].fog)), 1.0);
}
`;

const WGSL_SKY = WGSL_COMMON + /* wgsl */`
struct SOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> SOut {
    var o: SOut;
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    o.pos = vec4f(p, 1.0, 1.0);
    o.ndc = p;
    return o;
}
@fragment fn fs(i: SOut) -> @location(0) vec4f {
    let h = G.invViewProj * vec4f(i.ndc, 1.0, 1.0);
    return vec4f(tonemap(skyColor(normalize(h.xyz / h.w - G.eye.xyz))), 1.0);
}
`;

// portal polygons (stencil marks) and glass panes share one vertex layout: pos3 normal3 color4
const WGSL_POLY = WGSL_COMMON + /* wgsl */`
struct POut { @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) nrm: vec3f, @location(2) col: vec4f, @location(3) @interpolate(flat) area: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) a: f32) -> POut {
    var o: POut;
    o.pos = G.viewProj * vec4f(p, 1.0);
    o.wpos = p; o.nrm = n; o.col = c; o.area = a;
    return o;
}
// fog of the area in front of a portal, over the distance from the eye to the portal surface
fn portalFog(i: POut) -> vec4f {
    let ai = u32(i.area + 0.5);
    return vec4f(areas[ai].fog.rgb, 1.0 - exp(-length(G.eye.xyz - i.wpos) * areas[ai].fog.w));
}
// veil over an open portal: what is seen through it is fogged by the air in front of it (scissor / none
// modes only; in stencil mode the scene shader fogs through the portals itself)
@fragment fn fsVeil(i: POut) -> @location(0) vec4f {
    let f = portalFog(i);
    return vec4f(tonemap(f.rgb), f.a);
}
@fragment fn fsMark(i: POut) -> @location(0) vec4f { return vec4f(0.0); }
fn waveH(q: vec2f, t: f32) -> f32 {
    return fbm(q * 0.18 + vec2f(t * 0.03, t * 0.02)) + vnoise(q * 0.9 + vec2f(-t * 0.25, t * 0.18)) * 0.35 + vnoise(q * 2.3 + vec2f(t * 0.5, t * 0.1)) * 0.12;
}
@fragment fn fsWater(i: POut) -> @location(0) vec4f {
    let t = G.params.x;
    let p = i.wpos.xz;
    let e = 0.2;
    let hx = waveH(p + vec2f(e, 0.0), t) - waveH(p - vec2f(e, 0.0), t);
    let hz = waveH(p + vec2f(0.0, e), t) - waveH(p - vec2f(0.0, e), t);
    let N = normalize(vec3f(-hx * 1.2, 2.0 * e, -hz * 1.2));
    let toEye = G.eye.xyz - i.wpos;
    let dist = length(toEye);
    let V = toEye / dist;
    let fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    let R = reflect(-V, N);
    let refl = skyColor(vec3f(R.x, abs(R.y), R.z));
    let L = normalize(G.sunDir.xyz);
    let spec = pow(max(dot(R, L), 0.0), 350.0) * 6.0;
    let body = i.col.rgb * (0.35 + 0.65 * max(dot(N, L), 0.0)) * (G.sunColor.rgb * 0.5 + areas[0].ambient.rgb);
    var col = mix(body, refl, fres) + G.sunColor.rgb * spec;
    let fog = 1.0 - exp(-dist * areas[0].fog.w);
    col = mix(col, areas[0].fog.rgb, fog);
    return vec4f(tonemap(col), clamp(mix(i.col.a, 1.0, fres) + fog, 0.0, 1.0));
}
@fragment fn fsGlass(i: POut) -> @location(0) vec4f {
    let V = normalize(G.eye.xyz - i.wpos);
    var N = normalize(i.nrm);
    if (dot(N, V) < 0.0) { N = -N; }
    let ndv = clamp(dot(N, V), 0.0, 1.0);
    let fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    let refl = skyColor(reflect(-V, N)) * 0.55;
    let q = vec2f(i.wpos.x + i.wpos.z, i.wpos.y);
    let smudge = smoothstep(0.45, 0.9, fbm(q * 2.5)) * 0.35 + smoothstep(0.7, 1.0, vnoise(vec2f(q.x * 30.0, q.y * 1.5))) * 0.15;
    let col = mix(i.col.rgb * 0.35, refl, 0.35 + 0.65 * fres) + vec3f(smudge * 0.25);
    let a = clamp(i.col.a + fres * 0.55 + smudge * 0.25, 0.0, 0.92);
    let f = portalFog(i);
    // stencil mode (params.w = 1): what is behind the pane is already fogged along its whole ray by the
    // scene shader, so only the pane itself is fogged
    if (G.params.w > 0.5) { return vec4f(tonemap(mix(col, f.rgb, f.a)), a); }
    // otherwise fog in front of the pane covers both the glass and what is behind it:
    // out = mix(mix(dst, glass, a), fog, f)  ->  src = (glass*a*(1-f) + fog*f) / A,  A = a*(1-f) + f
    let A = a * (1.0 - f.a) + f.a;
    return vec4f(tonemap((col * a * (1.0 - f.a) + f.rgb * f.a) / max(A, 1e-4)), A);
}
`;

const WGSL_LINES = WGSL_COMMON + /* wgsl */`
struct LOut { @builtin(position) pos: vec4f, @location(0) col: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec4f) -> LOut {
    var o: LOut;
    o.pos = G.viewProj * vec4f(p, 1.0);
    o.col = c;
    return o;
}
@fragment fn fs(i: LOut) -> @location(0) vec4f { return i.col; }
`;

return { WGSL_WORLD, WGSL_SKY, WGSL_POLY, WGSL_LINES };
});
