'use strict';
// WGSL: the volumetrics: froxel lighting, cloud tiles, the ray march and the temporal resolve.

Features.part('cloud', (engine, feature) => {
const { SPLASH_RADIUS, SPRAY, SPRAY_LAYERS, SPRAY_MIST, SPLASH_FADE, OCC_RES, CLOUD_TILE, TILE_COVER_PAD } = feature;

// Froxel lighting volume: one cell per (screen x, screen y, exponential depth slice), at the cell centre:
// x sun transmittance (cloud shadow map times the shadow cast by the rain and snow shafts), y sky light left under the
// cloud column, z lightning. The march reads it with one trilinear fetch per step below the cloud base. Light changes
// slowly in space, so the coarse grid holds it; the densities stay per step, and the streaks keep their detail.
const WGSL_FROXEL = /* wgsl */`
@group(1) @binding(0) var froxelOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn inject(@builtin(global_invocation_id) gid: vec3u) {
    let n = textureDimensions(froxelOut);
    if (any(gid >= n)) { return; }
    let c = (vec3f(gid) + 0.5) / vec3f(n);
    let z = F.froxel.x * pow(F.froxel.y / F.froxel.x, c.z);          // view depth of the cell centre
    let p = F.cam.xyz + (F.fwd.xyz + F.right.xyz * (c.x * 2.0 - 1.0) + F.up.xyz * (c.y * 2.0 - 1.0)) * z;
    var sh = shadowAt(p);
    // the shafts shade what lies behind them: march their envelope toward the sun, up to where they start in the cloud
    let s = F.sunDir.xyz;
    let top = F.cloud.x + 700.0;
    if (p.y < top && s.y > 0.0 && sh.x > 0.01) {
        let ds = min((top - p.y) / max(s.y, 0.05), 12000.0) / 6.0;
        var od = 0.0;
        for (var j = 0; j < 6; j++) {
            let q = p + s * ds * (f32(j) + 0.5);
            let e = precipEnvelope(q, precipSourceAt(q));
            od += (e.x + e.y) * ds;
        }
        sh.x *= exp(-od * 0.5);                                       // 0.5: the curtains fill about half the shaft
    }
    textureStore(froxelOut, gid, vec4f(sh, min(flashLit(p), 60000.0), cityGlow(p).r));   // w: GLOW_COLOR.r is 1
}
`;

// needs F, occ
const WGSL_SKIP_SAMPLE = /* wgsl */`
// false where the occupancy grid proves there is no noise cloud at p
fn cloudPossible(p: vec3f) -> bool {
    let c = vec2i(floor((p.xz - F.wdomain.xy) / F.wdomain.z * f32(${OCC_RES})));
    if (any(c < vec2i(0)) || any(c >= vec2i(${OCC_RES}))) { return true; }
    let k = clamp(i32((p.y - F.layerInfo.z) / (F.features.z - F.layerInfo.z) * 32.0), 0, 31);
    return ((occ[c.y * ${OCC_RES} + c.x] >> u32(k)) & 1u) != 0u;
}

// distance bin of the tile pre-pass: 64 bins, square-root spaced out to the march distance (fine near, coarse far)
fn tileBin(t: f32) -> u32 { return min(u32(sqrt(max(t, 0.0) / F.march.z) * 64.0), 63u); }

// the march's clipping of a ray to the cloud slab, [t0, t1]; t1 < t0 when the ray misses it
fn slabSpan(ro: vec3f, dir: vec3f, tMax: f32) -> vec2f {
    var t0 = 0.0;
    var t1 = tMax;
    if (abs(dir.y) > 1e-5) {
        let ta = (F.noise.w - ro.y) / dir.y;
        let tb = (F.misc.z - 1500.0 - ro.y) / dir.y;
        t0 = max(t0, min(ta, tb));
        t1 = min(t1, max(ta, tb));
    } else if (ro.y > F.noise.w) { t1 = -1.0; }
    return vec2f(t0, t1);
}
`;

// Cloud tile pre-pass: one ray through the centre of each CLOUD_TILE^2 block of volumetric pixels, one shape sample
// (lod 1: no erosion, which only removes cloud; scud included) per distance bin, with the coverage padded. (Two samples
// per bin cost twice as much and skipped no less: the padding and the march's widening by a bin carry the margin.) Bit b of the
// 64-bit mask is set when cloud was found in bin b. The scene depth is ignored (a tile can straddle the horizon).
const WGSL_TILES = /* wgsl */`
@group(1) @binding(0) var tileOut: texture_storage_2d<rg32uint, write>;

@compute @workgroup_size(8, 8)
fn tiles(@builtin(global_invocation_id) gid: vec3u) {
    let n = textureDimensions(tileOut);
    if (any(gid.xy >= n)) { return; }
    let size = F.screen.zw;
    let uv = min((vec2f(gid.xy) + 0.5) * f32(${CLOUD_TILE}), size) / size;
    let dir = rayDir(vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0));
    let ro = F.cam.xyz;
    let span = slabSpan(ro, dir, F.march.z);
    covBoost = ${TILE_COVER_PAD};
    var m = vec2u(0u);
    if (span.y > span.x) {
        for (var b = tileBin(span.x); b <= tileBin(span.y); b++) {
            let f = (f32(b) + 0.5) / 64.0;
            let t = clamp(f * f * F.march.z, span.x, span.y);
            let p = ro + dir * t;
            if (p.y <= F.layerInfo.z || p.y >= F.features.z) { continue; }
            if (cloudSampleN(p, weatherAt(p.xz), 1, 0xffffffffu, cloudPossible(p)).x > 0.0) {
                if (b < 32u) { m.x |= 1u << b; } else { m.y |= 1u << (b - 32u); }
            }
        }
    }
    textureStore(tileOut, gid.xy, vec4u(m, 0u, 0u));
}
`;

const WGSL_MARCH = /* wgsl */`
const SPRAY = ${SPRAY.toFixed(4)};
@group(1) @binding(0) var depthTex: texture_depth_2d;
@group(1) @binding(1) var outColor: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var outDepth: texture_storage_2d<r32float, write>;
@group(1) @binding(3) var froxelTex: texture_3d<f32>;
@group(1) @binding(4) var tileTex: texture_2d<u32>;

// distance bins where the tile pre-pass found cloud, over this pixel's tile and its 8 neighbours (pixel jitter, rays
// between tile centres), widened by one bin each way
fn tileMask(px: vec2u) -> vec2u {
    let n = vec2i(textureDimensions(tileTex));
    let q = vec2i(px) / ${CLOUD_TILE};
    var m = vec2u(0u);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) { m |= textureLoad(tileTex, clamp(q + vec2i(x, y), vec2i(0), n - 1), 0).xy; }
    }
    let up = vec2u(m.x << 1u, (m.y << 1u) | (m.x >> 31u));
    let down = vec2u((m.x >> 1u) | (m.y << 31u), m.y >> 1u);
    return m | up | down;
}

// sun transmittance, sky light, lightning and the towns' glow (its strength, cityGlow / GLOW_COLOR) at p, from the froxel volume
fn froxelAt(p: vec3f) -> vec4f {
    let v = p - F.cam.xyz;
    let z = max(dot(v, F.fwd.xyz), F.froxel.x);
    let r = F.right.xyz;
    let u = F.up.xyz;
    let uvw = vec3f(dot(v, r) / (dot(r, r) * z) * 0.5 + 0.5, dot(v, u) / (dot(u, u) * z) * 0.5 + 0.5,
                    log(z / F.froxel.x) / log(F.froxel.y / F.froxel.x));
    return textureSampleLevel(froxelTex, clampSamp, uvw, 0.0);
}

fn hazeDensity(y: f32) -> f32 { return F.zenith.w * exp(-max(y - F.misc.z, 0.0) / F.horizon.w); }

// optical depth of the haze along a straight segment
fn hazeOD(y0: f32, y1: f32, len: f32) -> f32 {
    let H = F.horizon.w;
    let a = exp(-max(y0 - F.misc.z, 0.0) / H);
    let b = exp(-max(y1 - F.misc.z, 0.0) / H);
    let dy = y1 - y0;
    if (abs(dy) < 1.0) { return F.zenith.w * a * len; }
    return F.zenith.w * H * len * (a - b) / dy;
}

// tends to the horizon sky colour far away; sunlit haze adds forward scattering, so cloud shadows cut crepuscular rays
fn hazeLight(mu: f32, sh: vec2f) -> vec3f {
    let glow = hg(mu, 0.78) * 0.025 + hg(mu, 0.3) * 0.02;
    return F.horizon.rgb * (0.45 + 0.55 * sh.y) + F.sunCol.rgb * sh.x * (glow + hg(mu, 0.6) * 0.015);
}

// radiance scattered towards the eye by cloud at p
// lightSteps / stepScale: fewer, longer steps far from the camera (light LOD)
// dirY: the view ray's vertical direction, for the diffuse field's gradient (diffuseLook)
// side: 1 near a cloud surface the view ray reached through open air, which the sky lights from the side; 0 deep in
// cloud, where only the light that diffused down through the cloud above is left (marchSide)
fn cloudLight(p: vec3f, mu: f32, dirY: f32, w: vec4f, lightSteps: i32, stepScale: f32, ambScale: f32, side: f32) -> vec3f {
    let s = F.sunDir.xyz;
    var od = 0.0;
    var ls = 90.0 * stepScale;
    var t = 0.0;
    for (var j = 0; j < lightSteps; j++) {
        let q = p + s * (t + ls * 0.5);
        od += cloudDensity(q, weatherAt(q.xz)) * ls;
        t += ls;
        ls *= 1.9;
    }
    // the rest of the way to the sun, from the shadow map: a low sun crosses tens of km of cloud deck
    od += sunDepthAbove(p + s * t);
    // multiple scattering octaves (Wrenninge): each octave less extinction, less anisotropy
    var sun = 0.0; var a = 1.0; var b = 1.0; var c = 1.0;
    for (var k = 0; k < 3; k++) {
        sun += a * exp(-od * b) * mix(hg(mu, 0.8 * c), hg(mu, -0.25 * c), 0.3);
        a *= 0.55; b *= 0.35; c *= 0.6;
    }
    // sky light through the cloud above: deep in a storm only a few percent arrives; brighter looking up
    let base = F.cloud.x;
    let top = max(w.y, base + 400.0);
    let h = sat((p.y - base) / (top - base));
    let ca = cloudAbove(p, top);
    let deep = (0.05 + 0.95 * ca.x) * diffuseLook(ca.x, dirY);
    let tall = sat((top - base - 2500.0) / 6000.0);
    let surface = (0.3 + 0.7 * pow(h, 0.6)) * mix(1.0, 0.3, tall * (1.0 - h));   // open sky to the side, less under tall towers
    let amb = F.ambient.rgb * mix(deep, surface, side) * ambScale;
    // light the ground bounces up into the base, where the sun reaches the ground below
    let bounce = F.sunCol.rgb * max(F.sunDir.y, 0.0) * 0.03 * (1.0 - h) * mix(ca.y, 1.0, side);
    // by night the towns' light from below, into the base (the light pollution that tints overcast orange)
    var glow = vec3f(0.0);
    if (F.glowInfo.x > 0.0) { glow = cityGlow(p) * (1.0 - h) * (1.0 - h); }
    return F.sunCol.rgb * sun + amb + bounce + glow + FLASH_COLOR * flashLit(p) * 0.05;
}

// The spray rain throws up where it hits the ground (rain extinction, 1/m, over the march step [ta, tb] of the ray from
// ro along dir; p in it): the drops shatter into a mist that hangs over the wet ground in layers (SPRAY_LAYERS): a dense
// carpet in the lowest 30 cm, a metre of mist over it, a thin veil some ten metres deep that the gusts lift. Seen along
// the street it thickens into the whitish veil a downpour lays over everything at ground level. Each layer is
// exponential over the terrain, integrated over the step's height range, so a long step that crosses the thin layers at
// once still takes all of them. It scales with the rain reaching the ground below (precipEnvelope, so virga throws up
// none) and the drops' size: drizzle hardly splashes. lift: how far the surface this ray ends on stands above the
// terrain (paving, asphalt, decks laid over it), so the thin layers lie on that and not under it
fn rainSpray(p: vec3f, ro: vec3f, dir: vec3f, ta: f32, tb: f32, w: vec4f, lift: f32) -> f32 {
    let yLo = min(ro.y + dir.y * ta, ro.y + dir.y * tb);
    if (yLo - terrainHeight(p.xz).x > ${SPRAY_LAYERS[2][0] * 6 + 40}.0) { return 0.0; }    // the mesh is within metres of it
    let g = meshHeight(p.xz) + lift;
    let hA = max(ro.y + dir.y * ta - g, 0.0);
    let hB = max(ro.y + dir.y * tb - g, 0.0);
    if (min(hA, hB) > ${SPRAY_LAYERS[2][0] * 6}.0) { return 0.0; }
    let rate = precipEnvelope(vec3f(p.x, g + 1.0, p.z), w).x / max(F.precip.z, 1e-6);
    if (rate <= 0.0) { return 0.0; }
    let dh = hB - hA;
    var sum = 0.0;
    ${SPRAY_LAYERS.map(([H, k]) => `sum += ${k.toFixed(3)} * select(${H.toFixed(3)} * (exp(-hA / ${H.toFixed(3)}) - exp(-hB / ${H.toFixed(3)})) / dh, exp(-hA / ${H.toFixed(3)}), abs(dh) < 0.002);`).join('\n    ')}
    // the splashes' mist sprites fade out between SPLASH_FADE and 1 x SPLASH_RADIUS from the camera: over the same distances
    // a layer of their depth fades in, so the near mist and the far carpet meet without a step in brightness
    let far = smoothstep(${SPLASH_RADIUS * SPLASH_FADE}.0, ${SPLASH_RADIUS}.0, length(p.xz - F.cam.xz));
    sum += ${SPRAY_MIST[1].toFixed(3)} * far * select(${SPRAY_MIST[0].toFixed(3)} * (exp(-hA / ${SPRAY_MIST[0].toFixed(3)}) - exp(-hB / ${SPRAY_MIST[0].toFixed(3)})) / dh, exp(-hA / ${SPRAY_MIST[0].toFixed(3)}), abs(dh) < 0.002);
    let drops = mix(0.15, 1.0, F.rain.x);
    return SPRAY * rate * drops * sum * sat(rate * 2.0);
}

fn rayBox(ro: vec3f, rd: vec3f, lo: vec3f, hi: vec3f, t0: f32, t1: f32) -> bool {
    let inv = 1.0 / select(rd, vec3f(1e-6), abs(rd) < vec3f(1e-6));
    let a = (lo - ro) * inv;
    let b = (hi - ro) * inv;
    let tn = max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z));
    let tf = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
    return max(tn, t0) <= min(tf, t1);
}

// Tornado (F.tornado, one at most) under a supercell's wall cloud: a condensation funnel hanging from the wall cloud,
// reaching the ground or only part way (its condensed share), and the debris cloud it throws up where it touches
// down. It turns as one (spin, rad/s), its lower end trails off the axis (lean) and snakes. It is marched on its own
// over the stretch of the ray through its bounds (a rope a few tens of metres across falls between the cloud march's
// steps), and laid into the cloud march where the ray passes its axis.
fn tornadoAxis(y: f32) -> vec2f {
    let A = F.tornado[0];
    let h = sat((y - A.z) / (A.w - A.z));
    let snake = sin(y / 160.0 + F.cam.w * 0.6 + F.tornado[3].w) * F.tornado[1].x * 0.8 * sat((1.0 - h) * 3.0);
    let lean = F.tornado[2].xy;
    let side = select(vec2f(1.0, 0.0), normalize(vec2f(-lean.y, lean.x)), dot(lean, lean) > 1.0);
    return A.xy + lean * pow(1.0 - h, 1.5) + side * snake;
}

// bounding cylinder round the axis: centre xz, radius
fn tornadoBound() -> vec3f {
    let B = F.tornado[1];
    let C = F.tornado[2];
    return vec3f(F.tornado[0].xy + C.xy * 0.5, max(B.y, C.z) * 1.25 + length(C.xy) * 0.5 + B.x + 40.0);
}

// x funnel, y debris extinction (1/m)
fn tornadoDensity(p: vec3f) -> vec2f {
    let A = F.tornado[0];   // axis x, z at the top, ground height, top (in the wall cloud)
    let B = F.tornado[1];   // radius at the ground, at the top, condensed share of the height (from the top), flare
    let C = F.tornado[2];   // lean x, z (where the bottom trails, m), debris radius, debris height
    let D = F.tornado[3];   // strength, spin (rad/s), subvortices, seed
    let h = (p.y - A.z) / (A.w - A.z);
    if (h < -0.01 || h > 1.0) { return vec2f(0.0); }
    let rel = p.xz - tornadoAxis(p.y);
    let r = length(rel);
    if (r > max(B.y, C.z) * 1.25 + B.x) { return vec2f(0.0); }
    let a = atan2(rel.y, rel.x);
    let turn = F.cam.w * D.y;
    // once round the funnel per noise period (seamless), helical streaks climbing it, rising as it turns
    let u = fract(a / (2.0 * PI) - turn / (2.0 * PI));
    let R = mix(B.x, B.y, pow(sat(h), B.w));
    let n = textureSampleLevel(shapeTex, repSamp, vec3f(u, p.y / (B.x * 6.0 + 250.0) + u - turn * 0.25, r / (R * 3.0) + D.w), 0.0);
    // strong ones: lobes of subvortices turning faster than the parent
    let lobes = select(0.0, 0.16 * cos(D.z * (a - turn * 1.7)), D.z > 0.5);
    let Rn = R * (1.0 + (n.x - 0.5) * 0.45 + lobes);
    // the condensation reaches down to 1 - B.z, tapering to a ragged tip
    let cone = sat((h - (1.0 - B.z) - (n.y - 0.5) * 0.1) / 0.14);
    let Rc = Rn * sqrt(cone);
    var fun = sat((Rc - r) / max(Rc * 0.2, 4.0)) * (0.65 + 0.7 * n.z) * sqrt(cone);
    fun *= 1.0 - smoothstep(0.9, 1.0, h);                 // its upper end fades into the wall cloud
    // debris: a churning skirt round the base, flaring upwards, thinning with height
    var deb = 0.0;
    let hd = (p.y - A.z) / C.w;
    if (hd < 2.0 && C.z > 0.0) {
        let Rd = C.z * (0.5 + 0.5 * sat(hd));
        let nd = textureSampleLevel(detailTex, repSamp, vec3f(u, hd * 0.35 - F.cam.w * 0.3, r / C.z * 0.6 + D.w), 0.0);
        let rd = Rd * (0.8 + 0.45 * nd.y);
        deb = sat((rd - r) / (rd * 0.55)) * exp(-max(hd, 0.0) * 1.4) * smoothstep(0.25, 0.7, nd.x * 0.7 + nd.y * 0.3 + 0.1);
        deb *= sat((p.y - A.z + 5.0) / 15.0);
    }
    return vec2f(fun * 0.045, deb * 0.02) * D.x;
}

// [entry, exit] of the ray's stretch through the tornado's bounds, clipped to [0, tMax]; y < x where it misses
fn tornadoSpan(ro: vec3f, dir: vec3f, tMax: f32) -> vec2f {
    let A = F.tornado[0];
    let cb = tornadoBound();
    var ta = 0.0;
    var tb = tMax;
    // the vertical cylinder
    let o = ro.xz - cb.xy;
    let qa = dot(dir.xz, dir.xz);
    let qb = dot(o, dir.xz);
    let qc = dot(o, o) - cb.z * cb.z;
    if (qa > 1e-8) {
        let disc = qb * qb - qa * qc;
        if (disc < 0.0) { return vec2f(1.0, 0.0); }
        let sq = sqrt(disc);
        ta = max(ta, (-qb - sq) / qa);
        tb = min(tb, (-qb + sq) / qa);
    } else if (qc > 0.0) { return vec2f(1.0, 0.0); }
    // between the ground and the top
    if (abs(dir.y) > 1e-6) {
        let y0 = (A.z - 10.0 - ro.y) / dir.y;
        let y1 = (A.w - ro.y) / dir.y;
        ta = max(ta, min(y0, y1));
        tb = min(tb, max(y0, y1));
    } else if (ro.y < A.z - 10.0 || ro.y > A.w) { return vec2f(1.0, 0.0); }
    return vec2f(ta, tb);
}

// the tornado's light (rgb) and transmittance (a) over [ta, tb] of the ray
fn tornadoMarch(ro: vec3f, dir: vec3f, ta: f32, tb: f32, mu: f32, jitter: f32) -> vec4f {
    let n = 40;
    let dt = (tb - ta) / f32(n);
    var col = vec3f(0.0);
    var T = 1.0;
    let fl = flashLit(ro + dir * (ta + tb) * 0.5) * 0.05;
    let phase = mix(hg(mu, 0.6), hg(mu, 0.0), 0.5);
    for (var i = 0; i < n; i++) {
        let p = ro + dir * (ta + (f32(i) + jitter) * dt);
        let td = tornadoDensity(p);
        let s = td.x + td.y;
        if (s <= 1e-7) { continue; }
        let sh = shadowAt(p);
        // in the gloom under the storm: sky light from the side, little sun; the debris is soil and wreckage
        let amb = F.ambient.rgb * (0.1 + 0.55 * sh.y);
        let sun = F.sunCol.rgb * sh.x * phase * 0.5;
        let L = (td.x * (amb * 0.85 + sun) + td.y * (amb + sun * 0.7) * vec3f(0.6, 0.5, 0.38)) / s + FLASH_COLOR * fl;
        let tr = exp(-s * dt);
        col += T * L * (1.0 - tr);
        T *= tr;
        if (T < 0.005) { T = 0.0; break; }
    }
    return vec4f(col, T);
}

// which analytic structures this ray passes near (their bounding boxes): bits 0-3 motherships, 4-5 shelf lines
fn featureMask(ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> u32 {
    var m = 0u;
    for (var i = 0; i < i32(F.features.x); i++) {
        let A = F.ms[i * 3];
        let B = F.ms[i * 3 + 1];
        let C = F.ms[i * 3 + 2];
        let r = A.z * 1.3;
        if (rayBox(ro, rd, vec3f(A.x - r, B.x - C.x - 450.0, A.y - r), vec3f(A.x + r, B.y + 2500.0, A.y + r), t0, t1)) { m |= 1u << u32(i); }
    }
    for (var i = 0; i < i32(F.features.y); i++) {
        let D = F.shelves[i * 4 + 3];
        let lipY = F.misc.z + F.shelves[i * 4 + 2].x;
        if (rayBox(ro, rd, vec3f(D.x, lipY - 600.0, D.y), vec3f(D.z, F.cloud.x + 300.0, D.w), t0, t1)) { m |= 16u << u32(i); }
    }
    return m;
}

@compute @workgroup_size(8, 8)
fn march(@builtin(global_invocation_id) gid: vec3u) {
    let size = vec2u(F.screen.zw);
    let frame = F.right.w;
    // interleaved: this frame marches the pixels marchedNow() picks; the resolve fills the others
    var px = gid.xy;
    if (F.lod.x > 3.5) { px = gid.xy * 2u + marchCorner(); }
    else if (F.lod.x > 1.5) { px.x = gid.x * 2u + ((gid.y + u32(frame)) & 1u); }
    if (px.x >= size.x || px.y >= size.y) { return; }
    let jit = fract(vec2f(frame * 0.7548776662, frame * 0.5698402910));
    let uv = (vec2f(px) + jit) / vec2f(size);
    let dir = rayDir(vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0));
    let full = F.screen.xy;
    let dz = textureLoad(depthTex, vec2i(min(uv * full, full - 1.0)), 0);
    let sceneT = select(1e9, F.fwd.w / dz / max(dot(dir, F.fwd.xyz), 1e-3), dz > 0.0);

    let ro = F.cam.xyz;
    let mode = i32(F.ground.w);
    let doClouds = mode != 3;
    let doPrecip = mode != 2;
    let doHaze = mode == 0;
    let froxels = F.froxel.z > 0.5;
    let mu = dot(dir, F.sunDir.xyz);
    let base = F.cloud.x;

    let sp = slabSpan(ro, dir, min(sceneT, F.march.z));
    // the spray's layers lie on the drawn terrain (meshHeight), and on the paving and roads laid over it where this ray
    // ends on them (rainSpray); eased out where it ends high on a wall or a roof
    var lift = 0.0;
    if (sceneT < 1e8) {
        let e = ro + dir * sceneT;
        let d = e.y - meshHeight(e.xz);
        lift = d * (1.0 - smoothstep(0.8, 2.0, abs(d)));
    }
    let t0 = sp.x;
    let t1 = sp.y;

    var col = vec3f(0.0);
    var T = 1.0;
    var depthAcc = 0.0;
    var wsum = 0.0;
    // the lights' halos and beams in the air, up to the surface (they lie near the camera, in front of the rest)
    if (F.lightInfo.x > 0.5 && mode == 0) { col = lampScatter(ro, dir, sceneT, rnd(px.x * 4099u + px.y * 6151u + u32(frame) * 997u)); }
    // the tornado, marched on its own; laid in where the ray passes it (tornT)
    var torn = vec4f(0.0, 0.0, 0.0, 1.0);
    var tornT = 1e9;
    if (doClouds && F.tornado[3].x > 0.001) {
        let ts = tornadoSpan(ro, dir, min(sceneT, F.march.z));
        if (ts.y > ts.x) {
            torn = tornadoMarch(ro, dir, ts.x, ts.y, mu, rnd(px.x * 7919u + px.y * 104729u + u32(frame) * 3571u));
            if (torn.w < 0.999) { tornT = (ts.x + ts.y) * 0.5; }
        }
    }
    if (t1 > t0) {
        let span = t1 - t0;
        // step-count LOD: short segments (looking down at nearby ground) need fewer steps than long horizontal ones
        let N = max(24, i32(ceil(F.march.x * sqrt(min(span / 30000.0, 1.0)))));
        // per-pixel, per-frame step offset (hashed: interleaved gradient noise lines up into streaks at half resolution)
        let jitter = rnd(px.x * 1973u + px.y * 9277u + u32(frame) * 26699u);
        let feat = featureMask(ro, dir, t0, t1);
        let detailDist = F.lod.w;
        var emptyRun = 0;           // consecutive cloud-free samples: in empty air clouds are evaluated every other step
        // marchSide: how much open-air sky light reaches the medium at this step. The ray has to have come through
        // open air (a camera inside cloud or rain sees none), and it fades with the cloud and precipitation optical
        // depth crossed since: sky light from the side reaches only a few optical depths into the medium
        var airSeen = false;
        var odIn = 0.0;
        let tiles = F.post.y > 0.5;
        var tm = vec2u(0xffffffffu);
        if (tiles && doClouds) { tm = tileMask(px); }
        let rainPhase = mix(hg(mu, 0.75), hg(mu, 0.0), 0.45);
        // rays through the structures' bounds: no rain under their roofs and decks
        let sheltered = F.blocks.x > 0.5 && rayBox(ro, dir, vec3f(F.blockBox.x, F.blocks.y, F.blockBox.y), vec3f(F.blockBox.z, F.blocks.z, F.blockBox.w), t0, t1);
        // the stretch of the ray inside the bus's cabin (one box test per ray): no rain, snow or haze in there
        let cab = cabinSpan(ro, dir);
        let snowPhase = mix(hg(mu, 0.45), hg(mu, 0.0), 0.6);
        for (var i = 0; i < N; i++) {
            let fa = f32(i) / f32(N);
            let fb = f32(i + 1) / f32(N);
            let fs = (f32(i) + jitter) / f32(N);
            let ds = span * (fb * fb - fa * fa);
            let t = t0 + span * fs * fs;
            if (t >= tornT) {
                col += T * torn.rgb;
                let dT = T * (1.0 - torn.w);
                depthAcc += tornT * dT;
                wsum += dT;
                T *= torn.w;
                tornT = 1e9;
                if (T < 0.004) { T = 0.0; break; }
            }
            let p = ro + dir * t;
            var sigma = 0.0;
            var S = vec3f(0.0);
            let side = select(0.0, exp(-odIn * 0.35), airSeen);
            var medium = 0.0;       // cloud and precipitation extinction at this step (not haze)
            var cloudy = doClouds && p.y > F.layerInfo.z && p.y < F.features.z;
            // distance bins without cloud in the tile pre-pass
            if (cloudy && tiles) {
                let b = tileBin(t);
                // (odd: the first sample after a skipped stretch is evaluated, or where a sharp edge such as an eyewall
                // starts would depend on how many bins this tile row skipped, and show as bands)
                if (((select(tm.x, tm.y, b >= 32u) >> (b & 31u)) & 1u) == 0u) { cloudy = false; emptyRun = 1; }
            }
            // empty-space skipping: where the occupancy grid rules out noise cloud, only the analytic structures
            // this ray passes near are left to evaluate
            var noise = true;
            if (cloudy && !cloudPossible(p)) {
                noise = false;
                if (feat == 0u) { cloudy = false; emptyRun++; }
            }
            if (cloudy && emptyRun >= 2 && (emptyRun & 1) == 0) { emptyRun++; }
            else if (cloudy) {
                let w = weatherAt(p.xz);
                // LOD by distance: detail erosion near, fine structure mid, shape only far
                let lod = select(select(2, 1, t < detailDist * 2.5), 0, t < detailDist);
                let cs = cloudSampleN(p, w, lod, feat, noise);
                let dc = cs.x;
                if (dc > 0.0) {
                    let nl = i32(F.march.y);
                    let ls = select(select(nl, max(nl - 1, 2), t > detailDist), 2, t > detailDist * 2.5);
                    let tint = mix(vec3f(1.0), vec3f(0.62, 1.0, 0.72), cs.z);   // green storm light
                    S += dc * cloudLight(p, mu, dir.y, w, ls, clamp(t / detailDist, 1.0, 3.0), cs.y, side) * tint;
                    sigma += dc;
                    medium += dc;
                    emptyRun = 0;
                } else { emptyRun++; }
            }
            if (t > cab.x && t < cab.y) {
                // in the bus: sheltered, nothing to take
            } else if (p.y < base + 700.0) {
                // light from the froxel volume, or evaluated here (z < 0: lightning not looked up yet)
                var fx = vec4f(0.0, 0.0, -1.0, -1.0);
                if (froxels) { fx = froxelAt(p); } else { fx = vec4f(shadowAt(p), -1.0, -1.0); }
                let sh = fx.xy;
                var glow = vec3f(0.0);
                if (F.glowInfo.x > 0.0) { if (froxels) { glow = GLOW_COLOR * fx.w; } else { glow = cityGlow(p); } }
                if (doPrecip) {
                    let src = precipSourceAt(p);
                    var pd = precipDensity(p, src);
                    var sd = rainSpray(p, ro, dir, t0 + span * fa * fa, t0 + span * fb * fb, src, lift);
                    if (sheltered && pd.x + pd.y + sd > 0.0) { let k = rainReaches(p); pd *= k; sd *= k; }
                    if (pd.x + pd.y + sd > 0.0) {
                        // the diffuse light under the cloud: what the column lets through (sh.y), brighter looking up,
                        // and what the ground bounces up where the sun reaches it
                        // (deep in the rain), or with sky from the side near a shaft's edge seen from outside (side)
                        let deepAmb = sh.y * diffuseLook((sh.y - 0.12) / 0.88, dir.y);
                        let amb = F.ambient.rgb * mix(deepAmb, 0.25 + 0.75 * sh.y, side) + F.sunCol.rgb * max(F.sunDir.y, 0.0) * 0.02 * sh.x + glow;
                        S += pd.x * (F.sunCol.rgb * sh.x * rainPhase + amb * 0.85) * 0.9;
                        S += pd.y * (F.sunCol.rgb * sh.x * snowPhase * 0.6 + amb * 1.25) * 0.95;
                        // the spray: fine droplets, lit from all round, whiter than the falling rain
                        S += sd * sprayColor(sh);
                        var fl = fx.z;
                        if (fl < 0.0) { fl = flashLit(p); }
                        S += (pd.x + pd.y + sd) * FLASH_COLOR * fl * 0.05;
                        sigma += pd.x + pd.y + sd;
                        medium += pd.x + pd.y + sd;
                    }
                }
                if (doHaze) {
                    let hd = hazeDensity(p.y);
                    var fl = fx.z;
                    if (fl < 0.0) { fl = flashLit(p); }
                    S += hd * (hazeLight(mu, sh) + glow + FLASH_COLOR * fl * 0.05);   // the air under a storm lights up too
                    sigma += hd;
                }
            } else if (doHaze) {
                let hd = hazeDensity(p.y);
                S += hd * hazeLight(mu, vec2f(1.0));
                if (F.glowInfo.x > 0.0) { S += hd * cityGlow(p); }
                sigma += hd;
            }
            if (medium < 1e-5) { airSeen = true; odIn = 0.0; } else { odIn += medium * ds; }
            if (sigma > 1e-8) {
                let tr = exp(-sigma * ds);
                col += T * S / sigma * (1.0 - tr);
                let dT = T * (1.0 - tr);
                depthAcc += t * dT;
                wsum += dT;
                T *= tr;
                // opaque: what is left would only let the sky through, and the sun disc is bright enough to show
                if (T < 0.004) { T = 0.0; break; }
            }
        }
    }

    // the tornado beyond the cloud march (or on a ray that misses the cloud slab)
    if (tornT < 1e8) {
        col += T * torn.rgb;
        let dT = T * (1.0 - torn.w);
        depthAcc += tornT * dT;
        wsum += dT;
        T *= torn.w;
    }

    // haze beyond the march, up to the terrain
    if (doHaze && sceneT < 1e8 && sceneT > max(t1, 0.0)) {
        let a = max(t1, 0.0);
        let od = hazeOD(ro.y + dir.y * a, ro.y + dir.y * sceneT, sceneT - a);
        let tr = exp(-od);
        var glow = vec3f(0.0);
        if (F.glowInfo.x > 0.0) { glow = cityGlow(ro + dir * mix(a, sceneT, 0.5)); }   // the domes over the far towns
        col += T * (hazeLight(mu, vec2f(1.0)) + glow) * (1.0 - tr);
        T *= tr;
    }

    // cirrus sheet above everything
    if (doClouds && sceneT > 1e8 && dir.y > 0.0 && ro.y < F.cirrus.x && F.cirrus.y > 0.0) {
        let tc = (F.cirrus.x - ro.y) / dir.y;
        let c = ro + dir * tc;
        let wl = length(F.wind.xy);
        let wd = select(vec2f(1.0, 0.0), F.wind.xy / wl, wl > 0.1);
        let along = vec2f(dot(c.xz, wd), dot(c.xz, vec2f(-wd.y, wd.x)));
        let q = (along - vec2f(dot(F.wind.zw, wd) * 1.5, 0.0)) / F.cirrus.z;
        let n = textureSampleLevel(shapeTex, repSamp, vec3f(q.x * 0.35, q.y * 2.2, 0.37), 0.0);
        let streak = n.x * 0.6 + n.z * 0.4;
        let a = sat(remap(streak, 1.0 - F.cirrus.y * 0.8, 1.0, 0.0, 1.0)) * 0.55 * sat(1.0 - tc / 160000.0);
        let lc = F.sunCol.rgb * (hg(mu, 0.6) * 0.5 + 0.06) + F.ambient.rgb * 0.8;
        col += T * lc * a;
        T *= 1.0 - a;
    }

    textureStore(outColor, px, vec4f(col, T));
    textureStore(outDepth, px, vec4f(select(min(sceneT, F.march.z), depthAcc / wsum, wsum > 1e-3), 0.0, 0.0, 0.0));
}
`;

// temporal reprojection of the volumetrics, with neighbourhood clamping
const WGSL_RESOLVE = /* wgsl */`
@group(1) @binding(0) var curTex: texture_2d<f32>;
@group(1) @binding(1) var curDepth: texture_2d<f32>;
@group(1) @binding(2) var histTex: texture_2d<f32>;
@group(1) @binding(3) var histOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) gid: vec3u) {
    let size = vec2i(textureDimensions(curTex));
    let q = vec2i(gid.xy);
    if (q.x >= size.x || q.y >= size.y) { return; }
    let il = i32(F.lod.x);
    let fresh = marchedNow(q);                   // marched this frame
    // neighbourhood statistics over pixels marched this frame: within 1 pixel (every pixel: the 3x3; checkerboard: the
    // centre and diagonals, or the four direct neighbours), within 2 when one pixel in four is marched (4 to 9 of them)
    var m1 = vec4f(0.0);
    var m2 = vec4f(0.0);
    var n = 0.0;
    var dsum = 0.0;
    let r = select(1, 2, il >= 4);
    for (var y = -r; y <= r; y++) {
        for (var x = -r; x <= r; x++) {
            if (!marchedNow(q + vec2i(x, y))) { continue; }
            let o = clamp(q + vec2i(x, y), vec2i(0), size - 1);
            let c = textureLoad(curTex, o, 0);
            m1 += c;
            m2 += c * c;
            n += 1.0;
            dsum += textureLoad(curDepth, o, 0).x;
        }
    }
    let mean = m1 / n;
    let sigma = sqrt(max(m2 / n - mean * mean, vec4f(0.0)));
    let box = select(1.6, 1.25, fresh);
    let mn = mean - sigma * box;
    let mx = mean + sigma * box;
    let cur = select(mean, textureLoad(curTex, q, 0), fresh);
    let depth = select(dsum / n, textureLoad(curDepth, q, 0).x, fresh);
    let uv = (vec2f(q) + 0.5) / vec2f(size);
    let dir = rayDir(vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0));
    let pc = F.prevViewProj * vec4f(F.cam.xyz + dir * depth, 1.0);
    var o = cur;
    if (pc.w > 0.0 && F.near.z < 0.5) {
        let puv = vec2f(pc.x / pc.w * 0.5 + 0.5, 0.5 - pc.y / pc.w * 0.5);
        if (all(puv > vec2f(0.0)) && all(puv < vec2f(1.0))) {
            let hist = clamp(textureSampleLevel(histTex, clampSamp, puv, 0.0), mn, mx);
            o = mix(hist, cur, select(0.06, select(select(0.1, 0.18, il >= 2), 0.25, il >= 4), fresh));
        }
    }
    textureStore(histOut, q, o);
}
`;

return { WGSL_FROXEL, WGSL_SKIP_SAMPLE, WGSL_TILES, WGSL_MARCH, WGSL_RESOLVE };
});
