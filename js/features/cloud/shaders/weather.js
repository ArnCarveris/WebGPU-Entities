'use strict';
// WGSL: the weather map, the cloud shadow map and the ground state (snow, wetness).

Features.part('cloud', (engine, feature) => {
const { MAX_LAYERS, CLEAR_WIDE } = feature;

// weather map: layer coverage from large-scale noise advected by the wind, plus every storm cell
const WGSL_WEATHER = /* wgsl */`
// the genus layers' precipitation scale (x) and cover scale (y) at xz: the state's (F.rain.z, 1), or along the bus route
// in mixed rain the zones' (RainZones): a Gaussian-weighted mean of the route points near xz, faded in by their summed
// weight. A clear stretch (cover 0) opens the decks: a flat-topped hole around each of its points, F.zoneInfo.w along
// the route (short of the next stretch's rain) and CLEAR_WIDE times that across it, so the sky over it is open.
fn zoneAt(xz: vec2f) -> vec2f {
    let n = u32(F.zoneInfo.x);
    if (n == 0u) { return vec2f(F.rain.z, 1.0); }
    var w = 0.0;
    var v = 0.0;
    var hole = 0.0;
    for (var i = 0u; i < n; i++) {
        let z = F.rainZones[i];
        let dist = length(xz - z.xy);
        let d = dist / F.zoneInfo.z;
        if (d < 3.0) { let g = exp(-d * d); w += g; v += g * z.w; }
        if (z.z < 1.0 && dist < F.zoneInfo.w * ${CLEAR_WIDE * 2}.0) {
            let dv = F.zoneDirs[i / 2u];
            let t = select(dv.xy, dv.zw, (i & 1u) == 1u);
            let off = xz - z.xy;
            let h = length(vec2f(dot(off, t), dot(off, vec2f(-t.y, t.x)) / ${CLEAR_WIDE}.0)) / F.zoneInfo.w;
            let h3 = h * h * h;
            hole = max(hole, (1.0 - z.z) * exp(-h3 * h3));
        }
    }
    return vec2f(mix(F.rain.z, v / max(w, 1e-4), sat(w) * F.zoneInfo.y), 1.0 - hole * F.zoneInfo.y);
}

@group(1) @binding(0) var weatherOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var anvilOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var layerOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var styleOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn weather(@builtin(global_invocation_id) g: vec3u) {
    // time slicing, as the shadow map: this frame refreshes every S-th row, starting at the slice index (the map drifts
    // a fraction of a texel per frame)
    let gid = vec3u(g.x, g.y * u32(max(F.lod.y, 1.0)) + u32(F.lod.z), 0u);
    let n = u32(F.wdomain.w);
    if (gid.x >= n || gid.y >= n) { return; }
    let xz = F.wdomain.xy + (vec2f(gid.xy) + 0.5) / f32(n) * F.wdomain.z;
    let lf = fbm2((xz - F.wind.zw) / 16000.0, 5);
    let covParam = F.cloud.w;
    let zone = zoneAt(xz);
    var cov = sat(covParam * (0.5 + 2.0 * (lf - 0.5)) + covParam * covParam * 0.35) * mix(0.35, 1.0, zone.y);
    var top = F.cloud.y;
    var pr = F.cirrus.w * smoothstep(0.5, 0.9, cov) * (0.4 + lf);      // drizzle / snow from the layer itself
    var vw = 0.0;
    var vs = 1e-4;
    var anvCov = 0.0;
    var anvTop = 0.0;
    var shelfCov = 0.0;
    var shelfW = 0.0;
    var style = vec4f(0.0);
    // genus layers: a coverage map each, drifting with the wind; some drizzle or rain (stratus, nimbostratus), scaled by
    // the state's rain (F.rain.z): past 1 a deck pours (a downpour), as a severe storm's core does
    var lcov = vec4f(0.0);
    var pour = 0.0;
    for (var k = 0; k < ${MAX_LAYERS}; k++) {
        let A = F.layers[k * 3];
        let B = F.layers[k * 3 + 1];
        let C = F.layers[k * 3 + 2];
        if (A.z <= 0.0) { continue; }
        let ln = fbm2((xz - F.wind.zw * 0.8) / B.x + C.w * 17.0, 4);
        let lc = sat(A.z * (0.45 + 2.2 * (ln - 0.5)) + A.z * A.z * 0.6) * zone.y;
        lcov[k] = lc;
        let lp = C.z * smoothstep(0.35, 0.85, lc) * zone.x;
        pr = 1.0 - (1.0 - pr) * (1.0 - sat(lp));
        pour = max(pour, lp - 1.0);
    }
    pr += pour;
    let wl = length(F.wind.xy);
    let wd = select(vec2f(1.0, 0.0), F.wind.xy / wl, wl > 0.1);
    for (var i = 0u; i < u32(F.near.w); i++) {
        let c = cells[i];
        let dist = length(xz - c.a.xy);
        if (dist > c.a.z * 3.4) { continue; }                          // beyond every footprint of this cell (anvil reach)
        // anvil: tall cells spread a sheet downwind under the tropopause
        let tall = sat((c.a.w - F.cloud.y - 2500.0) / 4000.0) * sat(c.b.x * 2.0);
        if (tall > 0.0) {
            let ad = xz - c.a.xy - wd * c.a.z * 0.8;
            let along = dot(ad, wd);
            let ra = length(vec2f(along * 0.6, dot(ad, vec2f(-wd.y, wd.x)))) / (c.a.z * 1.6) * (0.8 + 0.4 * fbm2(xz / 5000.0 + c.b.z * 7.0, 3));
            let ga = sat(1.0 - ra);
            let a = ga * ga * (3.0 - 2.0 * ga) * tall * 0.85;
            if (a > 0.005) { anvCov = max(anvCov, a); anvTop = max(anvTop, c.a.w); }
        }
        if (dist > c.a.z * 1.45) { continue; }                         // the rest (body, shelf, rain core) is closer in
        let d = xz - c.a.xy;
        let outline = fbm2((xz - F.wind.zw * 0.5) / (c.a.z * 0.7) + c.b.z * 31.0, 3);
        let r = length(d) / c.a.z * (0.75 + 0.5 * outline);
        let g = sat(1.0 - r);
        let gs = g * g * (3.0 - 2.0 * g);
        // shelf cloud: a wedge band on the leading (downwind) edge, along the gust front
        if (c.d.x > 0.0) {
            let len = max(length(d), 1.0);
            let front = smoothstep(0.35, 0.85, dot(d, wd) / len);
            let rs = len / c.a.z * (0.9 + 0.2 * outline);
            let wedge = sat((1.25 - rs) / 0.45);
            let sc = c.d.x * front * smoothstep(0.75, 0.85, rs) * smoothstep(0.0, 0.15, wedge) * sat(c.b.x * 2.0);
            if (sc > shelfCov) { shelfCov = sc; shelfW = wedge; }
        }
        // supercell style: laminar plates, green tint, wall cloud under the updraft (opposite the rain core)
        style.x = max(style.x, gs * c.d.y);
        style.y = max(style.y, gs * c.d.z * sat(c.b.y * 2.0));
        let wr = sat(1.0 - length(d + c.c.yz * 0.6) / (c.a.z * 0.3));
        style.z = max(style.z, c.d.w * wr * wr * (3.0 - 2.0 * wr) * sat(c.b.x * 2.0));
        cov = max(cov, gs * c.b.x * 0.9);
        top = max(top, mix(F.cloud.y, c.a.w, pow(gs, 0.55) * sat(c.b.x * 3.0)));      // domed towers
        // precipitation core: c.c.x of the radius, offset towards the forward flank
        let rp = length(d - c.c.yz) / c.a.z * (0.75 + 0.5 * outline);
        if (c.b.y <= 0.0 || rp > c.c.x * 1.5) { continue; }           // no precipitation core here
        let streaks = fbm2(xz / 900.0 + c.b.z * 17.0, 3);
        let pc = sat((1.0 - rp / max(c.c.x, 0.05)) * 1.8 + (streaks - 0.5) * 0.4);   // flat-topped: the whole middle pours
        let pv = c.b.y * pc * pc * (3.0 - 2.0 * pc);
        vw += c.b.w * pv;
        vs += pv;
        pr += pv * (1.0 - sat(pr));                                   // adds up to the strongest core, past 1 in severe storms
    }
    // hurricane: the eyewall ring, spiral rain bands wound in towards it, the central dense overcast above; the eye
    // clears all of it but a scatter of low cloud on its floor
    let H0 = F.hurricane[0];
    if (H0.w > 0.001) {
        let H1 = F.hurricane[1];
        let H2 = F.hurricane[2];
        let rel = xz - H0.xy;
        let r = length(rel);
        let a = atan2(rel.y, rel.x);
        let re = H0.z;
        let rag = fbm2(xz / 7000.0 - H1.y * 3.0, 3) - 0.5;
        let rn = r * (1.0 + rag * H2.w);
        let wall = smoothstep(re * 0.9, re * 1.1, rn) * (1.0 - smoothstep(re * 2.0, re * 3.2, rn));
        // log spiral: inwards the bands turn the way the storm does; bands fray and break up
        let ph = a - H1.y + log(max(r, re) / re) * 2.4;
        let bn = fbm2(xz / 9000.0 + H1.y * 2.0, 4);
        let band = smoothstep(0.4, 0.85, 0.5 + 0.5 * cos(H1.z * ph) + (bn - 0.5) * 0.7)
            * smoothstep(re * 1.6, re * 2.6, r) * (1.0 - smoothstep(H1.w * 0.55, H1.w, r)) * (0.55 + 0.45 * sat(1.0 - r / H1.w));
        let hc = max(wall, band * 0.9) * H0.w;
        cov = max(cov, hc);
        top = max(top, max(mix(F.cloud.y, H1.x, wall * H0.w), mix(F.cloud.y, H2.y, band * H0.w * (0.7 + 0.6 * bn))));
        let streaks = fbm2(xz / 1500.0 - H1.y * 5.0, 3);
        let hp = H2.x * (wall * (0.8 + 0.4 * streaks) + band * 0.65 * smoothstep(0.35, 0.7, streaks + 0.15)) * H0.w;
        pr += hp * (1.0 - sat(pr * 0.5));
        vs += hp;
        // central dense overcast: the outflow sheet spreading from the eyewall top
        let cdo = (1.0 - smoothstep(H1.w * 0.25, H1.w * 0.55, rn)) * smoothstep(re * 1.0, re * 1.6, rn) * H0.w;
        if (cdo > anvCov) { anvCov = cdo * 0.95; anvTop = max(anvTop, H1.x); }
        // the eye
        let eye = (1.0 - smoothstep(re * 0.8, re * 1.0, rn)) * H0.w;
        let eyeFloor = H2.z * smoothstep(0.45, 0.75, lf + 0.2);
        cov = mix(cov, eyeFloor, eye);
        top = mix(top, F.cloud.x + 900.0, eye);
        pr *= 1.0 - eye;
        vw *= 1.0 - eye;
        anvCov *= 1.0 - eye;
        lcov *= 1.0 - eye;
        style *= 1.0 - eye;
        shelfCov *= 1.0 - eye;
    }
    textureStore(weatherOut, gid.xy, vec4f(cov, top, pr, vw / vs));
    textureStore(anvilOut, gid.xy, vec4f(anvCov, anvTop, shelfCov, shelfW));
    textureStore(layerOut, gid.xy, lcov);
    textureStore(styleOut, gid.xy, style);
}
`;

// cloud shadow map: sun transmittance from the cloud base plane up through the slab, sky occlusion of the column, the
// transmittance of the low cloud (lowest 1.5 km above the base), which decides where precipitation can fall, and the
// optical depth of the sun ray's part below sunSplit(), for sunDepthAbove()
const WGSL_SHADOW = /* wgsl */`
@group(1) @binding(0) var shadowOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn shadow(@builtin(global_invocation_id) gid: vec3u) {
    // time slicing: this frame refreshes every S-th row, starting at the slice index
    let dim = textureDimensions(shadowOut);
    let S = u32(max(F.lod.y, 1.0));
    let tex = vec2u(gid.x, gid.y * S + u32(F.lod.z));
    if (tex.x >= dim.x || tex.y >= dim.y) { return; }
    let xz = F.wdomain.xy + (vec2f(tex) + 0.5) / vec2f(dim) * F.wdomain.z;
    let s = shadowSunDir();
    let base = F.layerInfo.z;
    let top = F.noise.w;
    let N = 24;
    let ds = (top - base) / s.y / f32(N);
    var od = 0.0;
    var odLow = 0.0;                                                  // the part below sunSplit()
    for (var i = 0; i < N; i++) {
        let p = vec3f(xz.x, base, xz.y) + s * (f32(i) + 0.5) * ds;
        let d = cloudDensity(p, weatherAt(p.xz)) * ds;
        od += d;
        if (p.y < sunSplit()) { odLow += d; }
        if (od > 12.0) { break; }
    }
    let w = weatherAt(xz);
    var ov = 0.0;
    let M = 10;
    let dv = (max(max(max(w.y, anvilAt(xz).y), F.layerInfo.y), base + 400.0) - base) / f32(M);
    for (var i = 0; i < M; i++) {
        ov += cloudDensity(vec3f(xz.x, base + (f32(i) + 0.5) * dv, xz.y), w) * dv;
    }
    // low cloud only, up to 1.5 km above the base: where precipitation leaves the cloud (not anvils or high layers)
    var ol = 0.0;
    let dl = (F.cloud.x + 1500.0 - base) / 6.0;
    for (var i = 0; i < 6; i++) {
        ol += cloudDensity(vec3f(xz.x, base + (f32(i) + 0.5) * dl, xz.y), w) * dl;
    }
    textureStore(shadowOut, tex, vec4f(exp(-od), exp(-ov * 0.03), exp(-ol * 0.03), odLow));
}
`;

// ground state: snow cover (x) and wetness (y) on the terrain grid
const WGSL_GROUND = /* wgsl */`
@group(1) @binding(0) var<storage, read_write> groundRW: array<vec2f>;

@compute @workgroup_size(8, 8)
fn groundUpdate(@builtin(global_invocation_id) gid: vec3u) {
    let n = u32(F.ground.z);
    if (gid.x >= n || gid.y >= n) { return; }
    let uv = (vec2f(gid.xy) + 0.5) / f32(n);
    let xz = F.tdomain.xy + uv * F.tdomain.z;
    let h = textureSampleLevel(heightTex, clampSamp, uv, 0.0).x;
    let w = precipSourceAt(vec3f(xz.x, h, xz.y));                     // where the slanted shafts land
    let reach = sat(1.0 - virgaOf(w) * 1.25);                         // virga never lands
    let pr = w.z * reach;
    let temp = F.misc.x - 0.0065 * h;
    let dt = F.misc.w;
    let idx = gid.y * n + gid.x;
    var g = groundRW[idx];
    if (temp < 1.0) { g.x += pr * dt / 1500.0; } else { g.y += pr * dt / 400.0; }
    g.x -= max(temp, 0.0) * dt / 9000.0;
    g.y -= dt / 2400.0 * (0.4 + 0.1 * max(temp, 0.0)) * (1.0 - pr);
    groundRW[idx] = clamp(g, vec2f(0.0), vec2f(1.0, 1.0));
}
`;

return { WGSL_WEATHER, WGSL_SHADOW, WGSL_GROUND };
});
