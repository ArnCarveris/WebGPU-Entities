'use strict';
// WGSL shared by the passes: math, sky, weather map sampling, cloud density and the cloud shadow lookups.

Features.part('cloud', (engine, feature) => {
const { kits } = engine;
const { NoiseWGSL } = kits.noise;
const { MAX_LAYERS, MAX_FLASHES } = feature;

// WGSL

// no bindings
const WGSL_MATH = /* wgsl */`
const PI = 3.14159265;
struct Cell { a: vec4f, b: vec4f, c: vec4f, d: vec4f };
// a: x, z, radius, top   b: coverage, precip, seed, virga   c: core, core offset x, z, -   d: shelf, laminar, green, wall cloud (m)

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn remap(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (x - a) / (b - a) * (d - c); }
fn hg(mu: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
${NoiseWGSL.hash12('hash12')}
${NoiseWGSL.pcg('pcg', 'rnd')}
${NoiseWGSL.ign('ign')}
${NoiseWGSL.value2('vnoise2', 'hash12')}
${NoiseWGSL.fbm('fbm2', 'vnoise2', { octaves: 'param', shift: [17.1, -9.3], normalize: true })}
fn aces(x: vec3f) -> vec3f {
    let a = x * (2.51 * x + 0.03);
    let b = x * (2.43 * x + 0.59) + 0.14;
    return clamp(a / b, vec3f(0.0), vec3f(1.0));
}
`;

// needs F
const WGSL_SKY = /* wgsl */`
fn rayDir(ndc: vec2f) -> vec3f { return normalize(F.fwd.xyz + F.right.xyz * ndc.x + F.up.xyz * ndc.y); }

// interleaved march (F.lod.x): 1 every pixel; 2 a checkerboard, alternating; 4 one pixel of each 2x2 block, cycling
// diagonally first so consecutive frames are far apart. marchCorner: the 2x2 block's marched pixel this frame
fn marchCorner() -> vec2u {
    let k = u32(F.right.w) & 3u;
    return vec2u(select(0u, 1u, k == 1u || k == 2u), select(0u, 1u, k == 1u || k == 3u));
}
fn marchedNow(q: vec2i) -> bool {
    let n = i32(F.lod.x);
    if (n >= 4) { return all((vec2u(q) & vec2u(1u)) == marchCorner()); }
    if (n >= 2) { return ((q.x + q.y + i32(F.right.w)) & 1) == 0; }
    return true;
}
// by night (F.sunDir.w, the moon) the eye's rods take over: colours wash out towards a cold blue grey, less where a lamp
// lights the scene brightly enough for the cones (a lamp's colour shows in its pool)
fn tonemap(c: vec3f) -> vec3f {
    var x = c;
    if (F.sunDir.w > 0.0) {
        let y = dot(x, vec3f(0.25, 0.6, 0.15)) * F.sunCol.w;
        x = mix(x, dot(x, vec3f(0.25, 0.6, 0.15)) * vec3f(0.72, 0.86, 1.2), 0.65 * (1.0 - smoothstep(0.03, 0.3, y)));
    }
    return pow(aces(x * F.sunCol.w), vec3f(1.0 / 2.2));
}

fn skyColor(dir: vec3f) -> vec3f {
    let mu = dot(dir, F.sunDir.xyz);
    let t = pow(sat(dir.y + 0.02), 0.5);
    var c = mix(F.horizon.rgb, F.zenith.rgb, t);
    c = mix(c, F.horizon.rgb * 0.7, sat(-dir.y * 8.0));
    // (the moon's glow is as faint next to it as the night sky is)
    return c + F.sunCol.rgb * (hg(mu, 0.78) * 0.025 + hg(mu, 0.3) * 0.02 * (1.0 - t)) * select(1.0, 0.05, F.sunDir.w > 0.0);
}

const FLASH_COLOR = vec3f(0.75, 0.82, 1.0);

// Light pollution by night (World.buildFarLights): the light a town's lamps send up, off the ground and out of the
// fixtures, reaching p (the cloud base, the haze, the rain over it). Each dome is a disc of lamps of its radius on
// the ground, seen from p as one source at its centre softened by that radius. No shadows, no cloud in between.
const GLOW_COLOR = vec3f(1.0, 0.66, 0.36);
fn cityGlow(p: vec3f) -> vec3f {
    var e = 0.0;
    let h = max(p.y - F.misc.z, 0.0);
    for (var k = 0; k < i32(F.glowInfo.x); k++) {
        let g = F.glows[k];
        let d = p.xz - g.xy;
        e += g.w / (g.z * g.z + dot(d, d) + h * h);
    }
    return GLOW_COLOR * e * F.glowInfo.y;
}

`;

// needs F, weatherTex, clampSamp
const WGSL_WEATHER_SAMPLE = /* wgsl */`
// the shadow map's sun rays climb from the lowest cloud through the slab, no flatter than this (a lower sun would run
// them off the map)
fn shadowSunDir() -> vec3f { return normalize(vec3f(F.sunDir.x, max(F.sunDir.y, 0.08), F.sunDir.z)); }
// the shadow map splits each sun ray's optical depth at this height: just above the convective layer's top
fn sunSplit() -> f32 { return F.cloud.y + 300.0; }

// how much of the precipitation in weather sample w evaporates before the ground: its virga, which a downpour
// overwhelms (from intensity 0.6, gone by 1.4); the near-field rain on the CPU mirrors it (Surroundings.nearPrecip)
fn virgaOf(w: vec4f) -> f32 { return w.w * (1.0 - sat((w.z - 0.6) / 0.8)); }

// x coverage, y cloud top (m), z precipitation (0..2, past 1 in severe storms), w virga (0 reaches the ground .. 1 evaporates at the cloud base)
fn weatherAt(xz: vec2f) -> vec4f {
    let uv = (xz - F.wdomain.xy) / F.wdomain.z;
    let w = textureSampleLevel(weatherTex, clampSamp, uv, 0.0);
    let e = sat(min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 12.0);
    return mix(vec4f(F.cloud.w * 0.6, F.cloud.y, 0.0, 0.0), w, e);
}
// the cloud base precipitation falls from at xz: the layer's base, lowered under a mothership to the bottom of its
// plate stack (which hangs below the base) and back up across the stack's bell-shaped rim
fn precipBase(xz: vec2f) -> f32 {
    var b = F.cloud.x;
    for (var i = 0; i < i32(F.features.x); i++) {
        let A = F.ms[i * 3];
        let B = F.ms[i * 3 + 1];
        b = min(b, mix(B.x, F.cloud.x, smoothstep(A.z * 0.6, A.z * 1.05, distance(xz, A.xy))));
    }
    return b;
}
`;

// needs F, shapeTex, detailTex, anvilTex, layerTex, styleTex, repSamp, clampSamp (+ weather sample)
const WGSL_DENSITY = /* wgsl */`
// added to every noise cloud's coverage: the tile pre-pass pads the clouds with it, so they reach a little further
var<private> covBoost: f32 = 0.0;

fn mapUV(xz: vec2f) -> vec2f { return (xz - F.wdomain.xy) / F.wdomain.z; }
fn mapFade(uv: vec2f) -> f32 { return sat(min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 12.0); }
fn windDir() -> vec2f { let wl = length(F.wind.xy); return select(vec2f(1.0, 0.0), F.wind.xy / wl, wl > 0.1); }

// x anvil coverage, y anvil top (m), z shelf cloud coverage, w shelf wedge (1 on the storm side, 0 at the leading edge)
fn anvilAt(xz: vec2f) -> vec4f {
    let uv = mapUV(xz);
    let f = mapFade(uv);
    return textureSampleLevel(anvilTex, clampSamp, uv, 0.0) * vec4f(f, 1.0, f, 1.0);
}
// coverage of each genus layer; beyond the map, a plain share of the state's coverage
fn layerCovAt(xz: vec2f) -> vec4f {
    let uv = mapUV(xz);
    let edge = vec4f(F.layers[0].z, F.layers[3].z, F.layers[6].z, F.layers[9].z) * 0.7;
    return mix(edge, textureSampleLevel(layerTex, clampSamp, uv, 0.0), mapFade(uv));
}
fn styleAt(xz: vec2f) -> vec4f { let uv = mapUV(xz); return textureSampleLevel(styleTex, clampSamp, uv, 0.0) * mapFade(uv); }

// cumulus layer and storm towers from the weather map, anvils, mothership plates and wall clouds (st = style sample)
fn convectiveDensity(p: vec3f, w: vec4f, an: vec4f, st: vec4f, detail: bool) -> f32 {
    let base0 = F.cloud.x;
    let base = base0 - st.z;                                                  // wall cloud: lowered base under the updraft
    if (p.y <= base) { return 0.0; }
    let top = max(w.y, base0 + 400.0);
    var cov = 0.0;
    var prof = 0.0;
    var h = 0.0;
    if (p.y < top && w.x >= 0.01) {
        h = (p.y - base) / (top - base);
        let tall = sat((top - base - 2500.0) / 6000.0);                       // cumulonimbus towers
        prof = sat(h / 0.025 + 0.15) * sat((1.0 - h) / mix(0.45, 0.14, tall)); // flat bases, rounded tops
        cov = min(sat(w.x * mix(1.0, 0.72, h)) * 0.94 + covBoost, 1.0);      // towers narrow upwards
    }
    if (p.y > base0 + 2500.0) {
        let band = 2800.0;
        if (an.x > 0.01 && p.y > an.y - band && p.y < an.y) {
            let ha = (p.y - (an.y - band)) / band;
            let pa = sat(ha / 0.35) * sat((1.0 - ha) / 0.2);
            if (an.x * pa > cov * prof) { cov = min(an.x + covBoost, 1.0); prof = pa; h = max(h, 0.85); }
        }
    }
    cov *= hurricaneKeep(p);                                                 // a hurricane's eye: billowy walls, not a cut
    if (cov <= 0.0 || prof <= 0.0) { return 0.0; }
    let wd = windDir();
    let q = vec3f(p.x - F.wind.z - wd.x * (p.y - base) * 0.25, p.y, p.z - F.wind.w - wd.y * (p.y - base) * 0.25);
    // smooth (F.look.x): a coarser mip, without the finest octaves, and the billows from the lowest Worley octave,
    // broad and rounded
    let s = textureSampleLevel(shapeTex, repSamp, q / F.noise.x, F.look.x * 2.0);
    let wf = mix(s.y * 0.625 + s.z * 0.25 + s.w * 0.125, s.y * 0.85 + s.z * 0.15, F.look.x);
    var d = sat(remap(s.x, wf - 1.0, 1.0, 0.0, 1.0)) * prof;
    // mothership: smooth stacked plates around the rotating updraft
    if (st.x > 0.01) {
        let plate = abs(fract(p.y / 950.0 + 0.3 * sin(p.x / 4200.0) + 0.3 * cos(p.z / 5100.0)) * 2.0 - 1.0);
        d = mix(d, d * (0.72 + 0.28 * smoothstep(0.05, 0.4, plate)) + 0.12 * prof, st.x);
    }
    d = sat(remap(d, 1.0 - cov, 1.0, 0.0, 1.0)) * cov;
    if (d <= 0.0) { return 0.0; }
    // smooth: no detail noise; within the detail distance it is trimmed by what the erosion takes on average, so the
    // near clouds keep the same mass without the fetch
    if (detail && F.look.x > 0.5) { d = sat(remap(d, F.noise.z * 0.5, 1.0, 0.0, 1.0)); }
    else if (detail) {
        let n = textureSampleLevel(detailTex, repSamp, q / F.noise.y + vec3f(0.0, F.up.w * 0.0004, 0.0), 0.0);
        let dw = n.x * 0.625 + n.y * 0.25 + n.z * 0.125;
        let e = mix(dw, 1.0 - dw, sat(h * 5.0));                     // wispy bases, billowy tops
        d = sat(remap(d, e * F.noise.z * (1.0 - 0.75 * st.x), 1.0, 0.0, 1.0));
    }
    return d * F.cloud.z;
}

// shelf cloud: a tiered wedge along a storm's gust front, low and dark underneath
fn shelfDensity(p: vec3f, an: vec4f) -> f32 {
    if (an.z < 0.01) { return 0.0; }
    let base = F.cloud.x;
    // lowest at the lip near the leading edge; the top slopes up into the storm's base behind it
    let lip = smoothstep(0.0, 0.3, an.w) * (1.0 - 0.55 * an.w);
    let bottom = base - 1100.0 * lip;
    let top = bottom + 250.0 + 1100.0 * an.w;
    if (p.y <= bottom || p.y >= top) { return 0.0; }
    let h = (p.y - bottom) / (top - bottom);
    let tiers = 0.5 + 0.5 * smoothstep(0.15, 0.6, abs(fract(h * 3.0 + 0.15 * sin(p.x / 1800.0 + p.z / 2300.0)) * 2.0 - 1.0));
    let s = textureSampleLevel(shapeTex, repSamp, vec3f(p.x - F.wind.z, p.y * 2.0, p.z - F.wind.w) / (F.noise.x * 0.6), 0.0);
    let prof = sat(h / 0.08) * sat((1.0 - h) / 0.35);
    let sc = min(an.z + covBoost, 1.0);
    var d = sat(remap((0.4 + 0.6 * s.x) * prof * tiers, 1.0 - sc, 1.0, 0.0, 1.0)) * sc;
    let dn = textureSampleLevel(detailTex, repSamp, vec3f(p.x - F.wind.z, p.y, p.z - F.wind.w) / 1100.0, 0.0);
    d = sat(remap(d, (dn.x * 0.625 + dn.y * 0.25 + dn.z * 0.125) * 0.55, 1.0, 0.0, 1.0));   // ragged scud underneath
    return d * F.cloud.z;
}

// genus layer i (stratus, nimbostratus, altostratus, altocumulus, ...) with coverage cov from the layer map
fn layerDensity(p: vec3f, i: i32, cov: f32, detail: bool) -> f32 {
    let A = F.layers[i * 3];
    let B = F.layers[i * 3 + 1];
    let C = F.layers[i * 3 + 2];
    if (cov < 0.01 || p.y <= A.x || p.y >= A.y) { return 0.0; }
    let h = (p.y - A.x) / (A.y - A.x);
    let wd = windDir();
    let rel = p.xz - F.wind.zw;
    let lp = vec3f(dot(rel, wd) / B.z, p.y, dot(rel, vec2f(-wd.y, wd.x)));   // stretched along the wind (B.z > 1) or across it
    let s = textureSampleLevel(shapeTex, repSamp, lp / B.y + C.w, 0.0);
    let kind = i32(C.x);
    var n = 0.0;
    var prof = 0.0;
    if (kind == 2) {            // cellular: separate puffs in rows (altocumulus)
        n = s.z * 0.75 + s.w * 0.25;
        prof = sat(h / 0.25) * sat((1.0 - h) / 0.35);
    } else if (kind == 1) {     // sheet: flat and featureless (stratus, altostratus, nimbostratus)
        n = 0.55 + 0.45 * s.x;
        prof = sat(h / 0.12) * sat((1.0 - h) / 0.18);
    } else {                    // heaped
        n = sat(remap(s.x, s.y * 0.625 + s.z * 0.25 + s.w * 0.125 - 1.0, 1.0, 0.0, 1.0));
        prof = sat(h / 0.05) * sat((1.0 - h) / 0.4);
    }
    let cv = min(cov + covBoost, 1.0);
    var d = sat(remap(n * prof, 1.0 - cv, 1.0, 0.0, 1.0)) * cv;
    if (d <= 0.0) { return 0.0; }
    if (detail && B.w > 0.0) {
        let dn = textureSampleLevel(detailTex, repSamp, lp / (B.y * 0.2) + C.w, 0.0);
        d = sat(remap(d, (dn.x * 0.625 + dn.y * 0.25 + dn.z * 0.125) * B.w, 1.0, 0.0, 1.0));
    }
    return d * A.w;
}

fn bez(a: vec2f, c: vec2f, b: vec2f, t: f32) -> vec2f { let u = 1.0 - t; return u * u * a + 2.0 * u * t * c + t * t * b; }

fn rot2(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * v.x - s * v.y, s * v.x + c * v.y); }

// mothership: a stack of striated plates turning around a supercell's updraft, with a wall cloud and scud under it.
// x extinction (1/m), y mask where the ordinary convective cloud gives way to it, z sky light (plate tops lit, lips dark)
// lod 0: eroded rims, grooves, scud   1: grooves, scud   2 (lighting, shadows): shape only
fn mothershipDensity(p: vec3f, i: i32, lod: i32) -> vec3f {
    let A = F.ms[i * 3];        // centre x, z, radius, spin (rad)
    let B = F.ms[i * 3 + 1];    // stack bottom, stack top, plates, twist (plates climbed per turn)
    let C = F.ms[i * 3 + 2];    // wall cloud drop, wall cloud radius (fraction), strength, seed
    let rel = p.xz - A.xy;
    let r = length(rel);
    if (r > A.z * 1.3 || p.y < B.x - C.x - 450.0 || p.y > B.y + 2500.0) { return vec3f(0.0); }
    // the ordinary cloud gives way inside the stack and comes back towards its top, so the tower grows out of it
    let mask = (1.0 - smoothstep(A.z * 0.95, A.z * 1.3, r)) * (1.0 - smoothstep(B.y - 500.0, B.y + 2500.0, p.y)) * C.z;
    if (p.y > B.y + 500.0) { return vec3f(0.0, mask, 1.0); }
    let rl = rot2(rel, -A.w);                                  // co-rotating frame: features turn with the updraft
    let a = atan2(rl.y, rl.x);
    // low-frequency warp: plates bend, thicken and thin; the outline bulges unevenly
    let wv = textureSampleLevel(shapeTex, repSamp, vec3f(rl.x, p.y * 1.6, rl.y) / 7000.0 + C.w, 0.0);
    let rw = r + (wv.z - 0.5) * 800.0 + (wv.w - 0.5) * 300.0;
    var d = 0.0;
    var sky = 0.2;
    if (p.y >= B.x) {
        let h = (p.y - B.x) / (B.y - B.x);
        let hw = h + (wv.y - 0.5) * 0.05;                           // plates undulate a little, stay readable
        // envelope: wide flat base, bulging low down, tapering into the tower above
        let env = A.z * (0.76 + 0.24 * sin(PI * sat(hw / 0.7))) * mix(1.0, 0.6, smoothstep(0.5, 1.0, hw));   // bell, not pagoda
        // plates: tiers with a rounded lip on their lower edge, in a slow helix
        let f = fract(hw * B.z + B.w * a / (2.0 * PI));
        let lip = smoothstep(0.0, 0.16, f) * pow(1.0 - f, 1.3);
        let R = env * (0.86 + 0.14 * lip);
        // soft rim, uneven inside
        d = pow(sat((R - rw) / 700.0), 0.7) * (0.6 + 0.4 * wv.x);
        d *= sat((p.y - B.x) / 150.0) * (1.0 - smoothstep(B.y - 1200.0, B.y + 500.0, p.y));
        sky = (0.22 + 0.55 * smoothstep(0.05, 0.9, f)) * (0.55 + 0.45 * h) * (0.8 + 0.4 * wv.x);
        if (lod <= 1 && d > 0.0) {
            d *= 0.88 + 0.12 * smoothstep(0.1, 0.9, abs(fract(hw * B.z * 2.0 + B.w * a / PI + wv.y * 0.5) * 2.0 - 1.0));
        }
        if (lod == 0 && d > 0.0) {
            // billowy, eroded rim; the core stays smooth
            let rim = 1.0 - sat((R - rw) / 1800.0);
            let n1 = textureSampleLevel(detailTex, repSamp, vec3f(rl.x, p.y, rl.y) / 1500.0 + C.w, 0.0);
            let n2 = textureSampleLevel(detailTex, repSamp, vec3f(rl.x, p.y, rl.y) / 700.0, 0.0).x;
            let e = (n1.x * 0.625 + n1.y * 0.25 + n1.z * 0.125) * 0.75 + n2 * 0.25;
            d = sat(remap(d, e * (0.08 + 0.4 * rim), 1.0, 0.0, 1.0));
        }
    } else {
        // wall cloud: a lowered drum under the updraft, narrowing downwards to a ragged bottom
        let k = (B.x - p.y) / C.x;
        let wr = A.z * C.y * (1.0 - 0.45 * k * k) * (1.0 + (wv.z - 0.5) * 0.5);
        let cut = 0.75 + 0.6 * (wv.y - 0.5);
        d = (1.0 - smoothstep(wr - 300.0, wr + 60.0, r)) * (1.0 - smoothstep(cut - 0.25, cut + 0.1, k));
        sky = 0.15;
        // scud: torn shreds hanging under the plates
        if (lod <= 1 && p.y > B.x - 450.0 && r < A.z * 0.95) {
            let n = textureSampleLevel(detailTex, repSamp, vec3f(rl.x, p.y * 2.0, rl.y) / 900.0 + C.w, 0.0);
            let sc = smoothstep(0.52, 0.8, n.x * 0.7 + n.y * 0.3 + (wv.x - 0.5) * 0.4) * (1.0 - (B.x - p.y) / 450.0) * 0.6;
            d = max(d, sc);
        }
    }
    return vec3f(d * C.z * F.cloud.z, mask, sky);
}

// shelf cloud along a squall line's gust front: stacked laminar wedges, lowest at the leading lip, their tops sloping
// up into the storm base behind; the lip wanders along the line, scud hangs under it.
// lod 0: eroded edges, striations, scud   1: striations, scud   2 (lighting, shadows): shape only
fn shelfLineDensity(p: vec3f, i: i32, lod: i32) -> vec2f {
    let A = F.shelves[i * 4];        // ends a (xy), b (zw)
    let B = F.shelves[i * 4 + 1];    // bow control point (xy), motion direction (zw)
    let C = F.shelves[i * 4 + 2];    // lip height above ground, depth, tiers, strength
    let D = F.shelves[i * 4 + 3];    // bounding box
    let lipY = F.misc.z + C.x;
    if (p.y < lipY - 600.0 || p.y > F.cloud.x + 300.0) { return vec2f(0.0); }
    if (p.x < D.x || p.z < D.y || p.x > D.z || p.z > D.w) { return vec2f(0.0); }
    let a = A.xy;
    let b = A.zw;
    let c = B.xy;
    let ab = b - a;
    let depth = C.y;
    // cheap reject against the chord before solving for the curve
    var bt = sat(dot(p.xz - a, ab) / max(dot(ab, ab), 1.0));
    if (distance(p.xz, a + ab * bt) > distance(c, (a + b) * 0.5) * 0.5 + depth + 2500.0) { return vec2f(0.0); }
    // nearest point on the bowed front: Newton steps on the quadratic Bezier
    for (var k = 0; k < 3; k++) {
        let q = bez(a, c, b, bt);
        let dq = 2.0 * (1.0 - bt) * (c - a) + 2.0 * bt * (b - c);
        let ddq = 2.0 * (a - 2.0 * c + b);
        bt = sat(bt - dot(q - p.xz, dq) / max(dot(dq, dq) + dot(q - p.xz, ddq), 1.0));
    }
    let bq = bez(a, c, b, bt);
    if (distance(p.xz, bq) > depth + 1500.0) { return vec2f(0.0); }
    let ends = smoothstep(0.0, 0.07, bt) * (1.0 - smoothstep(0.93, 1.0, bt));
    // warps: along the line the lip wanders and the tiers rise and dip; in 3D the surfaces bulge
    let lw = textureSampleLevel(shapeTex, repSamp, vec3f(bt * length(ab) / 14000.0, 0.31, f32(i) * 0.37 + 0.5), 0.0);
    let wv = textureSampleLevel(shapeTex, repSamp, vec3f(p.x - F.wind.z, p.y * 3.0, p.z - F.wind.w) / 9000.0, 0.0);
    let wob = wv.x - 0.5;
    let u = -dot(p.xz - bq, B.zw) + (lw.x - 0.5) * 1800.0 + (lw.z - 0.5) * 600.0 + wob * 700.0;   // distance behind the lip
    let lift = (lw.y - 0.5) * 350.0;
    let topSlope = (F.cloud.x + 250.0 - lipY) / depth;
    var d = 0.0;
    var sky = 0.2;
    for (var j = 0; j < i32(C.z); j++) {
        let fj = f32(j);
        let uj = u - fj * depth * 0.12;
        let yj = lipY + lift + fj * (380.0 + (lw.w - 0.5) * 160.0);
        let thick = 230.0 + fj * 60.0;
        var inside = 0.0;
        var v = 0.0;                // height within the tier: 0 underside, 1 top
        if (uj < 0.0) {             // the rounded nose of the tier
            inside = 1.0 - smoothstep(thick * 0.5 - 90.0, thick * 0.5 + 40.0, length(vec2f(uj, p.y - (yj + thick * 0.5))));
            v = sat((p.y - yj) / thick);
        } else {
            let yb = yj + uj * 0.025;                        // nearly flat underside
            let yt = yj + thick + uj * topSlope;             // top slopes up into the storm base
            inside = smoothstep(yb - 50.0, yb + 90.0, p.y) * (1.0 - smoothstep(yt - 120.0, yt + 40.0, p.y)) * (1.0 - smoothstep(depth * 0.8, depth, uj));
            v = sat((p.y - yb) / max(yt - yb, 1.0));
        }
        if (inside > d) { d = inside; sky = (0.1 + 0.8 * v * v) * (0.8 + 0.4 * wv.y); }
    }
    d *= 0.72 + 0.28 * wv.y;                                  // uneven inside
    if (lod <= 1 && d > 0.0) {
        // laminar striations parallel to the front
        d *= 0.6 + 0.4 * smoothstep(0.1, 0.6, abs(fract((p.y - lipY - max(u, 0.0) * topSlope * 0.5) / 140.0 + wob) * 2.0 - 1.0));
    }
    if (lod == 0 && d > 0.0) {
        let n = textureSampleLevel(detailTex, repSamp, vec3f(p.x - F.wind.z, p.y * 1.5, p.z - F.wind.w) / 800.0, 0.0);
        d = sat(remap(d, (n.x * 0.625 + n.y * 0.25 + n.z * 0.125) * 0.4, 1.0, 0.0, 1.0));
    }
    // scud: torn fragments under the shelf, behind the lip
    let yb0 = lipY + lift + max(u, 0.0) * 0.025;
    if (lod <= 1 && p.y < yb0 && p.y > yb0 - 380.0 && u > 200.0 && u < depth * 0.75) {
        let n = textureSampleLevel(detailTex, repSamp, vec3f(p.x - F.wind.z, p.y * 2.5, p.z - F.wind.w) / 750.0, 0.0);
        let sc = smoothstep(0.55, 0.82, n.x * 0.7 + n.y * 0.3 + wob * 0.3) * (1.0 - (yb0 - p.y) / 380.0) * 0.55;
        if (sc > d) { d = sc; sky = 0.12; }
    }
    return vec2f(d * ends * C.w * F.cloud.z, sky);
}

// every kind of cloud at p: x extinction (1/m), y ambient light scale, z green tint.
// lod: 0 full detail, 1 no detail erosion, 2 shape only (light march, shadow map). feat: bits of the analytic
// structures this ray can meet (0-3 motherships, 4-5 shelf lines)
fn cloudSample(p: vec3f, w: vec4f, lod: i32, feat: u32) -> vec3f { return cloudSampleN(p, w, lod, feat, true); }

// noise: false skips the noise clouds (convective layer, anvils, shelves, genus layers), where the occupancy grid
// proves there are none; the analytic structures are still evaluated
// how much noise cloud a hurricane's eye leaves at p: the eye widens with height (the stadium effect: the eyewall leans
// outwards), its edge a little uneven; the eye floor's low cloud stays
fn hurricaneKeep(p: vec3f) -> f32 {
    let H0 = F.hurricane[0];
    if (H0.w <= 0.001) { return 1.0; }
    let H1 = F.hurricane[1];
    let rel = p.xz - H0.xy;
    let r = length(rel);
    let hgt = sat((p.y - F.cloud.x) / max(H1.x - F.cloud.x, 1.0));
    if (r > H0.z * 2.2) { return 1.0; }
    let a = atan2(rel.y, rel.x);
    let re = H0.z * (0.92 + 1.0 * hgt * hgt) * (1.0 + 0.04 * sin(5.0 * a - H1.y * 2.0 + p.y / 1500.0) * F.hurricane[2].w * 4.0);
    // the tile pre-pass pads the eyewall inwards, as it pads every cloud's coverage
    let clear = 1.0 - smoothstep(re * 0.8, re * 1.02, r + covBoost * re * 2.0);
    let low = 1.0 - smoothstep(F.cloud.x + 700.0, F.cloud.x + 1500.0, p.y);
    return 1.0 - clear * H0.w * (1.0 - low);
}

fn cloudSampleN(p: vec3f, w: vec4f, lod: i32, feat: u32, noise: bool) -> vec3f {
    var d = 0.0;
    var amb = 0.0;
    var green = 0.0;
    let base = F.cloud.x;
    // analytic storm structures; motherships replace the noise cloud where they stand
    var mask = 0.0;
    for (var i = 0; i < i32(F.features.x); i++) {
        if ((feat & (1u << u32(i))) == 0u) { continue; }
        let m = mothershipDensity(p, i, lod);
        d += m.x;
        amb += m.x * m.z;
        mask = max(mask, m.y);
    }
    for (var i = 0; i < i32(F.features.y); i++) {
        if ((feat & (16u << u32(i))) == 0u) { continue; }
        let sl = shelfLineDensity(p, i, lod);
        d += sl.x;
        amb += sl.x * sl.y;
    }
    if (noise && p.y > base - 1300.0 && mask < 0.999) {
        // fetch the anvil / shelf map only where those can be (anvils high, cell shelves low) and the style map only
        // near storm cells (they lift the weather map's cloud top)
        var an = vec4f(0.0);
        if (p.y > base + 2500.0 || p.y < base + 450.0) { an = anvilAt(p.xz); }
        var st = vec4f(0.0);
        if (w.y > F.cloud.y + 30.0) { st = styleAt(p.xz); }
        let dc = convectiveDensity(p, w, an, st, lod == 0) * (1.0 - mask);
        var ds = 0.0;
        if (an.z > 0.01) { ds = shelfDensity(p, an) * hurricaneKeep(p); }
        d += dc + ds;
        amb += dc + ds * 0.5;
        green = st.y * sat((base + 3500.0 - p.y) / 3000.0);
    }
    if (noise && p.y > F.layerInfo.x && p.y < F.layerInfo.y) {
        let lc = layerCovAt(p.xz);
        for (var i = 0; i < ${MAX_LAYERS}; i++) {
            let dl = layerDensity(p, i, lc[i], lod == 0);
            d += dl;
            amb += dl * F.layers[i * 3 + 2].y;
        }
    }
    return vec3f(d, amb / max(d, 1e-9), green);
}

// shape-only extinction, for light marches and the shadow map
fn cloudDensity(p: vec3f, w: vec4f) -> f32 { return cloudSample(p, w, 2, 0xffffffffu).x; }

// rain (x) and snow (y) extinction (1/m) at p; w is the weather it fell from (precipSourceAt)
fn precipDensity(p: vec3f, w: vec4f) -> vec2f {
    let e = precipEnvelope(p, w);
    if (e.x + e.y <= 0.0) { return e; }
    let heavy = sat((w.z - 0.6) / 0.8);                               // storm cores: the curtains merge into a wall
    let q = vec3f(p.x - F.wind.z, p.y + F.misc.y, p.z - F.wind.w);       // curtains travel with the clouds
    let streak = textureSampleLevel(detailTex, repSamp, vec3f(q.x / 420.0, q.y / 4200.0, q.z / 420.0), 0.0);
    let clump = textureSampleLevel(shapeTex, repSamp, vec3f(q.x / 6000.0, q.y / 24000.0, q.z / 6000.0), 0.0).x;
    let curtain = smoothstep(0.38, 0.9, (streak.x * 0.7 + streak.y * 0.3) * 0.6 + clump * 0.6);
    return e * mix(0.12 + 0.88 * curtain, 0.7 + 0.3 * curtain, heavy);
}

// the shaft without its streaky curtains: precipitation, virga and the cloud base shape it, the freezing level splits
// it into rain (x) and snow (y)
fn precipEnvelope(p: vec3f, w: vec4f) -> vec2f {
    if (w.z < 0.003) { return vec2f(0.0); }
    let base = precipBase(p.xz);
    let v = virgaOf(w);
    let bottom = mix(F.misc.z - 300.0, base, v);                      // virga: evaporated below here
    let low = smoothstep(bottom, bottom + max(250.0, (base - bottom) * 0.7 * v + 250.0), p.y);
    let high = sat((base + 700.0 - p.y) / 900.0);                     // shafts start inside the cloud
    let snow = smoothstep(F.precip.x - 250.0, F.precip.x + 250.0, p.y);
    var rate = w.z * (1.0 + 0.8 * sat((w.z - 0.6) / 0.8));               // heavy precipitation is disproportionately dense
    // a tornado's updraft keeps a rain-free slot open round it
    if (F.tornado[3].x > 0.001) {
        let r0 = max(F.tornado[1].y, F.tornado[2].z) * 2.5 + 800.0;
        rate *= 1.0 - 0.9 * F.tornado[3].x * (1.0 - smoothstep(r0, r0 * 2.5, distance(p.xz, F.tornado[0].xy)));
    }
    return rate * low * high * vec2f((1.0 - snow) * F.precip.z, snow * F.precip.w);
}
`;

// needs F, shadowTex, clampSamp
const WGSL_SHADOW_SAMPLE = /* wgsl */`
// optical depth of the clouds between p and the sun, from the shadow map: the sun ray through p crosses the lowest
// cloud's height at one texel, which holds the ray's whole optical depth and the part below sunSplit(); what lies
// below p is taken off, assuming the cloud spread evenly over each part's height. Cloud lights use it for the sun
// ray beyond their own short march, so a low sun cannot light the underside of a deck it would have to cross
fn sunDepthAbove(p: vec3f) -> f32 {
    let s = shadowSunDir();
    let base = F.layerInfo.z;
    let top = F.noise.w;
    if (p.y >= top) { return 0.0; }
    let uv = (p.xz - s.xz * (max(p.y, base) - base) / s.y - F.wdomain.xy) / F.wdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
    let t = textureSampleLevel(shadowTex, clampSamp, uv, 0.0);
    let total = -log(max(t.x, 1e-6));
    let low = min(t.w, total);
    let split = sunSplit();
    var below = low * sat((p.y - base) / max(split - base, 1.0));
    if (p.y > split) { below = mix(low, total, sat((p.y - split) / max(top - split, 1.0))); }
    return max(total - below, 0.0);
}

// x: sun transmittance through the cloud slab, y: sky light left under the cloud column above p
fn shadowAt(p: vec3f) -> vec2f {
    let s = F.sunDir.xyz;
    let base = F.layerInfo.z;
    let lift = max(base - p.y, 0.0);
    let xz = p.xz + s.xz * lift / max(s.y, 0.08);
    let ua = (xz - F.wdomain.xy) / F.wdomain.z;
    let ub = (p.xz - F.wdomain.xy) / F.wdomain.z;
    let a = textureSampleLevel(shadowTex, clampSamp, ua, 0.0).x;
    let b = 0.12 + 0.88 * textureSampleLevel(shadowTex, clampSamp, ub, 0.0).y;
    // beyond the map: no cloud shadows instead of its edge texels smeared outwards
    let ea = sat(min(min(ua.x, 1.0 - ua.x), min(ua.y, 1.0 - ua.y)) * 12.0);
    let eb = sat(min(min(ub.x, 1.0 - ub.x), min(ub.y, 1.0 - ub.y)) * 12.0);
    // inside the slab the map's march from its base overstates the cloud toward the sun; that only starts at the real
    // cloud base (the lowest layer or the convective base), not at layerInfo.z, which is padded down for wall clouds and
    // shelf lips and can lie below the ground (which then got a tenth of the sun under a full overcast)
    let cb = min(F.layerInfo.x, F.cloud.x);
    let above = sat((p.y - cb) / max(F.noise.w - cb, 1.0));
    return vec2f(mix(mix(1.0, a, ea), 1.0, above), mix(mix(1.0, b, eb), 1.0, above));
}

// Diffuse light inside a cloud: sky light reaching p through the cloud above it, from the shadow map's column (its
// optical depth, with the cloud taken as spread evenly from the lowest cloud up to top) and the column's sun
// transmittance (for light the sunlit ground bounces up). x sky, y sun on the ground below.
// Light scattered many times, mostly forward, gets through a thick cloud far better than a straight beam does:
// diffusion gives a transmittance of about 1 / (1 + 0.75 (1 - g) tau), with g = 0.85 for cloud droplets
fn cloudAbove(p: vec3f, top: f32) -> vec2f {
    let uv = (p.xz - F.wdomain.xy) / F.wdomain.z;
    let e = sat(min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 12.0);
    let c = textureSampleLevel(shadowTex, clampSamp, uv, 0.0);
    let frac = sat((top - p.y) / max(top - F.layerInfo.z, 1.0));
    let od = -log(max(c.y, 1e-6)) / 0.03 * frac;                      // optical depth above p
    return mix(vec2f(1.0), vec2f(1.0 / (1.0 + 0.11 * od), c.x), e);
}
// The diffuse field flows downward (light enters through the tops, the ground sends little back), so it is brighter
// looking up than down, more so the more cloud lies above: radiance seen along a ray of direction dir, with sky the
// light left after the cloud above (1 open sky .. 0 deep in a storm)
fn diffuseLook(sky: f32, dirY: f32) -> f32 { return 1.0 + 0.6 * (1.0 - sky) * dirY; }

// Lightning at p, seen through the storm: a flash fires inside the cloud, so its light diffuses out through the cloud
// between it and p (diffusion transmittance, as in cloudAbove). The cloud is that of the flash's column (shadow map
// optical depth over its height, from the lowest cloud to its top) spread evenly; the part of the flash-to-p segment
// within those heights crosses it. So the cloud around a flash glows, its base and the rain and ground below get a
// dimmed, spread-out light, and air beside the storm is lit only by what leaves the cloud
const FLASH_GAIN = 10.0;
fn flashLit(p: vec3f) -> f32 {
    var l = 0.0;
    for (var k = 0; k < ${MAX_FLASHES}; k++) {
        let f = F.flash[k];
        if (f.w <= 0.0) { continue; }
        let d = distance(p, f.xyz);
        let uv = (f.xz - F.wdomain.xy) / F.wdomain.z;
        let base = F.layerInfo.z;
        let top = max(weatherAt(f.xz).y, base + 400.0);
        let colOD = -log(max(textureSampleLevel(shadowTex, clampSamp, uv, 0.0).y, 1e-6)) / 0.03;
        let sigma = colOD / (top - base);                               // mean extinction of the storm column (1/m)
        let y0 = min(p.y, f.y);
        let y1 = max(p.y, f.y);
        var inside = select(0.0, 1.0, p.y > base && p.y < top);         // a level segment: in cloud or not
        if (y1 - y0 > 1.0) { inside = max(min(y1, top) - max(y0, base), 0.0) / (y1 - y0); }
        // FLASH_GAIN: a flash outshines the sky by orders of magnitude, so even the few percent that diffuses out of
        // a storm lights it up
        l += FLASH_GAIN * f.w / (1.0 + d * d * 4e-7) / (1.0 + 0.11 * sigma * d * inside);
    }
    return l;
}

// share of precipitation that can leave the cloud base at xz: rain needs cloud above it. A storm's rain core sits on
// its flank and the wind carries the shaft further, so without this some of it would fall from clear sky beside the
// cloud. The shadow map's z term measures the low cloud above (1 clear .. 0 thick): an anvil overhead does not count
fn rainCover(xz: vec2f) -> f32 {
    let low = textureSampleLevel(shadowTex, clampSamp, (xz - F.wdomain.xy) / F.wdomain.z, 0.0).z;
    return smoothstep(0.03, 0.3, 1.0 - low);
}
// the weather precipitation at p fell from. Storms move with the wind aloft and the slower air below holds the falling
// precipitation back, so a shaft trails behind its cloud: what reaches p left the cloud base downwind of it, and the
// longer the fall the further. Its rate is cut where no cloud hangs above that point
fn precipSourceAt(p: vec3f) -> vec4f {
    let xz = p.xz + F.wind.xy * max(precipBase(p.xz) - p.y, 0.0) * F.precip.y;
    var w = weatherAt(xz);
    w.z *= rainCover(xz);
    return w;
}
`;

return { WGSL_MATH, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SHADOW_SAMPLE };
});
