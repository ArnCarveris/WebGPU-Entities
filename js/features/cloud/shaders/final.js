'use strict';
// WGSL: the final composite, near-field precipitation, lightning, radar and bloom.

Features.part('cloud', (engine, feature) => {
const { SPLASH_RADIUS, SPLASH_GRID, SPLASH_PIECES, SPLASH_MIST, SPLASH_FADE, INTERIOR_DRAW, BLD_ID } = feature;

const WGSL_FINAL = /* wgsl */`
@group(1) @binding(0) var cloudTex: texture_2d<f32>;
@group(1) @binding(1) var hdrTex: texture_2d<f32>;                 // alpha: the rain surface code (WGSL_TERRAIN)
@group(1) @binding(2) var depthTex: texture_depth_2d;              // read-only in the final pass (the splashes look at it)
@group(1) @binding(3) var bloomTex: texture_2d<f32>;               // the bloom chain's top level (WGSL_BLOOM), half resolution

struct FsIn { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> FsIn {
    let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
    var o: FsIn;
    o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2f(p.x, 1.0 - p.y);
    return o;
}

// weather-radar style precipitation colours; snow in blues
fn radarColor(pr: f32, snow: bool) -> vec3f {
    if (snow) { return mix(vec3f(0.25, 0.45, 0.95), vec3f(0.92, 0.95, 1.0), sat(pr * 1.4)); }
    let a = vec3f(0.1, 0.75, 0.2);
    let b = vec3f(0.95, 0.9, 0.15);
    let c = vec3f(0.95, 0.45, 0.1);
    let d = vec3f(0.9, 0.1, 0.15);
    if (pr < 0.35) { return mix(a, b, pr / 0.35); }
    if (pr < 0.65) { return mix(b, c, (pr - 0.35) / 0.3); }
    return mix(c, d, sat((pr - 0.65) / 0.3));
}

fn radar(px: vec2f, col: vec3f) -> vec3f {
    let size = min(240.0, F.screen.y * 0.3);
    let origin = vec2f(F.screen.x - size - 16.0, max(16.0, F.post.z * F.screen.y));     // under the menu bar
    let q = (px - origin) / size;
    if (any(q < vec2f(0.0)) || any(q > vec2f(1.0))) { return col; }
    let range = 120000.0;
    let xz = F.cam.xz + (q - 0.5) * range;
    var w = weatherAt(xz);
    w.z *= rainCover(xz);
    let reach = sat(1.0 - virgaOf(w) * 1.25);
    var c = mix(vec3f(0.02, 0.04, 0.05), vec3f(0.22, 0.25, 0.27), sat(w.x));
    let snow = F.precip.x < F.misc.z + 150.0;
    if (w.z * reach > 0.04) { c = radarColor(w.z * reach, snow); }
    else if (w.z > 0.04) { c = mix(c, vec3f(0.35, 0.4, 0.55), 0.5); }   // virga aloft: not reaching the ground
    let d = length((q - 0.5) * range);
    let ring = abs(fract(d / 20000.0 + 0.5) - 0.5) * 20000.0;
    c = mix(c, vec3f(0.43, 0.86, 1.0), (1.0 - smoothstep(0.0, range / size * 1.2, ring)) * 0.35);
    let f = normalize(F.fwd.xz + vec2f(1e-5, 0.0));
    let rel = (q - 0.5) * range;
    let along = dot(rel, f);
    let across = abs(dot(rel, vec2f(-f.y, f.x)));
    if (along > 0.0 && along < 6000.0 && across < (6000.0 - along) * 0.4) { c = vec3f(1.0, 0.79, 0.29); }
    let edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)) * size;
    c = mix(vec3f(0.43, 0.86, 1.0), c, smoothstep(0.5, 1.5, edge));
    return mix(col, c, 0.88);
}

// volumetrics at i.uv, blurred on the lower quality settings: a 3x3 tent of bilinear taps, radius F.post.x volumetric
// texels. Taps are weighted down where their transmittance differs from the centre, so the march noise inside a
// cloud smooths out while cloud edges and the terrain's outline stay sharp. Applied here and not in the resolve, so
// the history does not blur further every frame.
fn cloudAt(uv: vec2f) -> vec4f {
    let c = textureSampleLevel(cloudTex, clampSamp, uv, 0.0);
    let r = F.post.x;
    if (r <= 0.0) { return c; }
    let texel = r / F.screen.zw;
    var sum = c * 4.0;
    var wsum = 4.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let s = textureSampleLevel(cloudTex, clampSamp, uv + vec2f(f32(x), f32(y)) * texel, 0.0);
            let dt = (s.a - c.a) / 0.12;
            let w = select(2.0, 1.0, x != 0 && y != 0) * exp(-dt * dt);
            sum += s * w;
            wsum += w;
        }
    }
    return sum / wsum;
}

@fragment fn fsComposite(i: FsIn) -> @location(0) vec4f {
    let hdr = textureLoad(hdrTex, vec2i(i.pos.xy), 0).rgb;
    let c = cloudAt(i.uv);
    var col = hdr * c.a + c.rgb;
    if (i32(F.ground.w) == 1) { col = hdr; }
    if (F.bloom.x > 0.0) { col += textureSampleLevel(bloomTex, clampSamp, i.uv, 0.0).rgb * F.bloom.x / F.bloom.w; }
    // a flash close by lights everything up and floods the eye: the dark storm scene goes near white for an instant
    let fv = F.ambient.w;
    col = col * (1.0 + 3.0 * fv) + FLASH_COLOR * fv * 1.5 / max(F.sunCol.w, 0.2);
    var o = tonemap(col);
    if (F.march.w > 0.5) { o = radar(i.pos.xy, o); }
    return vec4f(o, 1.0);
}

struct LineOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) uv: vec2f };

// screen-space quad from a to b (clip space), widthPx wide; corner = vertex 0..5
fn lineQuad(a: vec4f, b: vec4f, widthPx: f32, corner: u32, o: ptr<function, LineOut>) {
    let res = F.screen.xy;
    let sa = a.xy / a.w * res * 0.5;
    let sb = b.xy / b.w * res * 0.5;
    let ax = sb - sa;
    let len = length(ax);
    let d = select(vec2f(0.0, 1.0), ax / len, len > 1e-3);
    let n = vec2f(-d.y, d.x);
    var ends = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
    var sides = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
    let e = ends[corner];
    let sd = sides[corner];
    let w = mix(a.w, b.w, e);
    let z = mix(a.z, b.z, e);
    let sp = mix(sa, sb, e) + n * sd * widthPx * 0.5 + d * (e * 2.0 - 1.0) * widthPx * 0.5;
    (*o).pos = vec4f(sp / (res * 0.5) * w, z, w);
    (*o).uv = vec2f(e, sd);
}

// rain running off roof edges near the camera (F.dripEdges): drop k of the drip particles leaves a point on an edge and
// falls freely to the ground. The drops gather at spouts along the edge, where the water runs together.
fn drip(k: u32, vi: u32, o: ptr<function, LineOut>) {
    let rain = F.near.x - F.near.y;
    let pick = rnd(k * 7u + 11u);
    if (rain <= 0.02 || rnd(k * 7u + 12u) > sat(rain * 1.6)) { return; }
    var e = 0;
    for (var j = 0; j < i32(F.drips.x) - 1; j++) { if (pick > F.dripEdges[j * 3 + 2].x) { e = j + 1; } }
    let A = F.dripEdges[e * 3];
    let B = F.dripEdges[e * 3 + 1];
    let alongX = F.dripEdges[e * 3 + 2].y > 0.5;
    if (rnd(k * 7u + 19u) > F.dripEdges[e * 3 + 2].z) { return; }
    // a side of the rectangle (by length; only the two along local x for eaves), and a point on it within 30 m of the
    // camera's place along it, so the drops gather where they can be seen. They run off at spouts every 0.35 m, some
    // harder than others
    let side = select(u32(rnd(k * 7u + 13u) * 4.0), u32(rnd(k * 7u + 13u) * 2.0) * 2u, alongX);
    let onX = side % 2u == 0u;
    let half = select(A.w, A.z, onX);
    let r = F.cam.xz - A.xy;
    let cl = vec2f(r.x * B.x + r.y * B.y, -r.x * B.y + r.y * B.x);
    let span = min(30.0, half);
    let mid = clamp(select(cl.y, cl.x, onX), -half + span, half - span);
    if (!alongX && rnd(k * 7u + 17u) > half / max(A.z, A.w)) { return; }      // short sides get fewer drops
    let spout = floor((mid + (rnd(k * 7u + 14u) - 0.5) * 2.0 * span + half) / 0.35);
    if (rnd(u32(spout) * 3u + side * 100003u + u32(e) * 7919u) < 0.3) { return; }
    let t = (spout + 0.5 + (rnd(k * 7u + 18u) - 0.5) * 0.3) * 0.35 - half;
    let sg = select(-1.0, 1.0, side >= 2u);
    let lp = select(vec2f(sg * (A.z + 0.04), t), vec2f(t, sg * (A.w + 0.04)), onX);
    let top = vec3f(A.x + lp.x * B.x - lp.y * B.y, B.z, A.y + lp.x * B.y + lp.y * B.x);
    // free fall over the drop B.w: the phase cycles through it, so the stream keeps running
    let tFall = sqrt(2.0 * B.w / 9.81);
    let ph = fract(F.cam.w / tFall + rnd(k * 7u + 15u));
    let ts = ph * tFall;
    // the wind picks the drops up as they fall, so the stream leans downwind in a straight line
    let wind = vec3f(F.wind.x, 0.0, F.wind.y) * 0.08;
    let p = top + (wind - vec3f(0.0, 4.9, 0.0)) * ts * ts;
    let vel = (wind * 2.0 - vec3f(0.0, 9.81, 0.0)) * ts - vec3f(0.0, 0.4, 0.0);
    let dist = distance(p, F.cam.xyz);
    if (dist > 120.0 || inCabin(p)) { return; }
    let a = F.viewProj * vec4f(p, 1.0);
    let b = F.viewProj * vec4f(p - vel * 0.05, 1.0);
    if (a.w < 0.5 || b.w < 0.5) { return; }
    let focal = F.screen.y * 0.5 / length(F.up.xyz);
    lineQuad(a, b, clamp(0.005 * focal / a.w, 1.0, 4.0), vi, o);
    let lightc = F.ambient.rgb * 0.9 + F.sunCol.rgb * 0.05 + lampsOnDrop(p);
    let fade = sat(dist / 1.5) * sat(1.0 - dist / 120.0) * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.9, 1.0, ph));
    (*o).col = vec4f(lightc * 1.3, (0.25 + 0.25 * rnd(k * 7u + 16u)) * fade * sat(rain * 2.0));
    (*o).uv.x = 0.0;
}

// rain hitting the ground, roofs and decks near the camera. The splashes sit on a world grid of SPLASH_GRID^2 cells
// around the camera, snapped to the cells, so they stay put as the view turns: each cell takes a drop every life
// seconds at a hashed spot, and piece k of the splash particles is one of the SPLASH_PIECES droplets it throws up, or
// (the first SPLASH_MIST) a puff of the mist the splashes leave, which lingers longer: a soft sprite standing on the
// surface, densest at the bottom, so that many of them overlap into the smooth bright band at ground level. The
// spot is aimed at the terrain or the highest box top over it, then moved onto the surface the eye sees along the line
// to it (the depth buffer: the asphalt and paving laid over the terrain, kerbs, decks; nothing when a wall or a bus is
// in the way), and splashes as that surface does (its rain surface code, WGSL_TERRAIN, which is 0 where no rain lands):
// fields and grass soak most drops up, hard ground and asphalt throw a crown, puddles and open water a low wide crown
// and a jet straight up out of the crater. Big drops splash high and wide, drizzle hardly at all
fn splash(k: u32, vi: u32, o: ptr<function, LineOut>) {
    let rain = F.near.x;
    let size = F.rain.x;
    if (rain <= 0.02) { return; }
    let slot = k / ${SPLASH_PIECES}u;
    let piece = k % ${SPLASH_PIECES}u;
    let cs = ${(SPLASH_RADIUS * 2 / SPLASH_GRID).toFixed(5)};
    let cell = floor(F.cam.xz / cs) - ${SPLASH_GRID / 2}.0 + vec2f(f32(slot % ${SPLASH_GRID}u), f32(slot / ${SPLASH_GRID}u));
    let cid = (u32(i32(cell.x) + 0x20000000) * 73856093u) ^ (u32(i32(cell.y) + 0x20000000) * 19349663u);
    let mist = piece < ${SPLASH_MIST}u;
    // the droplets share their splash's cycle; each mist puff has its own, longer one
    let life = select(mix(0.25, 0.4, size), 1.4, mist);
    let salt = select(0u, 0x9e3779b9u * (piece + 1u), mist);
    let cyc = F.cam.w / life + rnd(cid ^ salt);
    let ph = fract(cyc);
    let id = pcg(cid ^ salt ^ (u32(floor(cyc)) * 83492791u));
    if (rnd(id + 7u) > sat(rain * 1.2) * mix(0.5, 1.0, size)) { return; }
    let xz = (cell + vec2f(rnd(id), rnd(id + 1u))) * cs;
    if (distance(xz, F.cam.xz) > ${SPLASH_RADIUS}.0) { return; }
    var p = vec3f(xz.x, meshHeight(xz), xz.y);
    if (nearStructures(p)) {
        let top = vec3f(p.x, F.blocks.z + 1.0, p.z);
        let m = blockCell(p);
        for (var w = 0u; w < 4u; w++) {
            var bits = m[w];
            while (bits != 0u) {
                let b = i32(w * 32u + countTrailingZeros(bits));
                bits &= bits - 1u;
                let s = blockerSpan(b, top, vec3f(0.0, -1.0, 0.0));
                if (s.x <= s.y && s.y > 0.0) { p.y = max(p.y, top.y - max(s.x, 0.0)); }
            }
        }
    }
    // the surface seen along the line to it (which does not turn with the view)
    let c0 = F.viewProj * vec4f(p, 1.0);
    if (c0.w < 0.3) { return; }
    let ndc = c0.xy / c0.w;
    if (any(abs(ndc) > vec2f(1.0))) { return; }
    let pix = vec2i(min((ndc * vec2f(0.5, -0.5) + 0.5) * F.screen.xy, F.screen.xy - 1.0));
    let z = textureLoad(depthTex, pix, 0);
    let code = textureLoad(hdrTex, pix, 0).a;
    let kind = rainKind(code);
    if (z <= 0.0 || kind < 0.5) { return; }
    let dir = normalize(p - F.cam.xyz);
    let sp = F.cam.xyz + dir * (F.fwd.w / z / dot(dir, F.fwd.xyz));
    if (abs(sp.y - p.y) > 0.6) { return; }
    let soak = kind < 1.5;
    if (soak && rnd(id + 8u) > select(0.3, 0.5, mist)) { return; }
    let pool = max(rainPuddle(code), select(0.0, 1.0, kind > 3.5));
    let lightc = sprayColor(shadowAt(sp)) + lampsOnDrop(sp) * 0.5;
    if (mist) {
        // a billboard turned to the eye about the vertical (so it does not turn with the view), its foot a little
        // below the surface so it meets it softly; it swells and rises a little through its life, and fades in and out
        let toEye = sp.xz - F.cam.xz;
        let side = normalize(vec3f(-toEye.y, 0.0, toEye.x) + vec3f(1e-5, 0.0, 0.0));
        let wide = mix(0.5, 1.2, size) * (0.7 + 0.6 * rnd(id + 40u)) * (0.6 + 0.4 * ph);
        let tall = mix(0.15, 0.35, size) * (0.7 + 0.6 * rnd(id + 41u)) * (0.7 + 0.5 * ph);
        var ends = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
        var sides = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
        let e = ends[vi];
        let sd = sides[vi];
        let wp = sp + side * sd * wide * 0.5 + vec3f(0.0, e * (tall + 0.1) - 0.1, 0.0);
        let dm = distance(sp, F.cam.xyz);
        (*o).pos = F.viewProj * vec4f(wp, 1.0);
        let fadeM = smoothstep(1.0, 3.0, dm) * (1.0 - smoothstep(${SPLASH_RADIUS * SPLASH_FADE}.0, ${SPLASH_RADIUS}.0, distance(sp.xz, F.cam.xz))) * sat(rain * 1.5);
        let soakM = select(1.0, 0.5, soak);
        (*o).col = vec4f(lightc, 0.11 * sin(3.1416 * ph) * fadeM * soakM * mix(0.45, 1.0, size));
        (*o).uv = vec2f(2.0 + e, sd);
        return;
    }
    // a droplet: free flight from the impact, gone when it lands again
    let jet = piece == 0u && pool > 0.5;
    var up = mix(0.4, 1.4, size) * (0.6 + 0.6 * rnd(id + 10u + piece));
    var out = mix(0.15, 0.7, size) * (0.5 + rnd(id + 20u + piece));
    if (soak) { up *= 0.45; out *= 0.5; }
    if (jet) { up = mix(0.5, 1.2, size) * (0.8 + 0.4 * rnd(id + 11u)); out = 0.02; }
    else if (pool > 0.5) { up *= 0.6; out *= 1.3; }
    let az = rnd(id + 30u + piece) * 6.2832;
    let v0 = vec3f(cos(az) * out, up, sin(az) * out);
    let ts = ph * life;
    let tLand = 2.0 * up / 9.81;
    if (ts > tLand) { return; }
    let q = sp + v0 * ts - vec3f(0.0, 4.905, 0.0) * ts * ts;
    let vel = v0 - vec3f(0.0, 9.81, 0.0) * ts;
    let a = F.viewProj * vec4f(q, 1.0);
    let b = F.viewProj * vec4f(q - vel * 0.02, 1.0);
    if (a.w < 0.3 || b.w < 0.3) { return; }
    let dist = distance(q, F.cam.xyz);
    let focal = F.screen.y * 0.5 / length(F.up.xyz);
    let wpx = 0.003 * focal / a.w;
    lineQuad(a, b, clamp(wpx, 1.0, 3.5), vi, o);
    // clear water: it shows the light around it, brighter than the dark wet ground; a sub-pixel droplet covers less
    // than the line it is drawn as
    let fade = sat(dist / 0.5) * (1.0 - smoothstep(${SPLASH_RADIUS * SPLASH_FADE}.0, ${SPLASH_RADIUS}.0, dist)) * sat(rain * 2.0);
    (*o).col = vec4f(lightc * 1.3, 0.6 * fade * sat(wpx + 0.4) * (1.0 - smoothstep(0.7, 1.0, ts / tLand)));
    (*o).uv.x = 0.0;
}

// near-field precipitation: drops and flakes in a box that wraps around the camera. The drops' size (F.rain.x) sets how
// they look: drizzle is a dense, slow mist of fine droplets in a small box, a downpour long, heavy, fast streaks.
// Instances from F.rain.w on are drops running off roof edges (drip), from F.drips.y on splashes (splash).
@vertex fn vsPrecip(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
    var o: LineOut;
    o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
    o.col = vec4f(0.0);
    if (f32(ii) >= F.drips.y) { splash(ii - u32(F.drips.y), vi, &o); return o; }
    if (f32(ii) >= F.rain.w) { drip(ii - u32(F.rain.w), vi, &o); return o; }
    let total = F.near.x + F.near.y;
    let size = F.rain.x;
    let isSnow = rnd(ii * 5u + 3u) < F.near.y / max(total, 1e-4);
    // fine droplets are many: drizzle shows as many drops as moderate rain, in a smaller box
    let count = select(total * 1.3 * mix(8.0, 1.0, size), total * 1.3, isSnow);
    if (rnd(ii * 5u + 4u) > sat(count)) { return o; }
    let seed = vec3f(rnd(ii * 5u), rnd(ii * 5u + 1u), rnd(ii * 5u + 2u));
    let box = select(mix(vec3f(40.0, 24.0, 40.0), vec3f(70.0, 50.0, 70.0), size), vec3f(36.0, 24.0, 36.0), isSnow);
    let t = F.cam.w;
    let fall = select(F.rain.y * (0.85 + 0.3 * seed.x), 1.0 + 0.7 * seed.y, isSnow);
    let vel = vec3f(F.wind.x * 0.8, -fall, F.wind.y * 0.8);
    var p = seed * box + vel * t;
    if (isSnow) { p += vec3f(sin(t * 1.3 + seed.x * 40.0), 0.0, cos(t * 1.1 + seed.z * 40.0)) * 0.8; }
    let rel = (fract((p - F.cam.xyz) / box + 0.5) - 0.5) * box;
    let wp = F.cam.xyz + rel;
    // none inside the bus
    if (inCabin(wp)) { return o; }
    // none under roofs and decks or in the lee of walls: the path back up against this drop's fall meets a structure
    if (nearStructures(wp)) {
        let back = normalize(-vel);
        let m = blockCell(wp);
        for (var w = 0u; w < 4u; w++) {
            var bits = m[w];
            while (bits != 0u) {
                let k = i32(w * 32u + countTrailingZeros(bits));
                if (blockerRain(k, wp, back)) { return o; }
                bits &= bits - 1u;
            }
        }
    }
    let dist = length(rel);
    let a = F.viewProj * vec4f(wp, 1.0);
    if (a.w < 0.5) { return o; }
    let lightc = F.ambient.rgb * 0.9 + F.sunCol.rgb * 0.05 + lampsOnDrop(wp);
    let fade = sat(dist / 2.0) * sat(1.0 - dist / (box.x * 0.5));
    if (isSnow) {
        // flakes: a soft dot, smeared a little along the fall (motion blur)
        let focal = F.screen.y * 0.5 / length(F.up.xyz);
        let sz = clamp((0.02 + 0.025 * seed.z) * focal / a.w, 1.8, 14.0);
        let b = F.viewProj * vec4f(wp - vel * 0.006, 1.0);
        if (b.w < 0.5) { return o; }
        lineQuad(a, b, sz, vi, &o);
        o.col = vec4f(lightc * 1.5, 0.9 * fade);
    } else {
        let b = F.viewProj * vec4f(wp - vel * 0.035, 1.0);
        if (b.w < 0.5) { return o; }
        lineQuad(a, b, mix(0.9, 1.7, size), vi, &o);
        // fine droplets are faint each; denser and brighter in a downpour
        o.col = vec4f(lightc * 1.2, (0.12 + 0.12 * seed.z) * fade * mix(0.9, 1.15, size) * sat(total * mix(10.0, 2.0, size)) * (1.0 + 0.8 * sat(total - 1.0)));
    }
    o.uv.x = select(0.0, 1.0, isSnow);    // shape flag for the fragment: streak or flake
    return o;
}

@fragment fn fsPrecip(i: LineOut) -> @location(0) vec4f {
    let across = 1.0 - abs(i.uv.y);
    var a = select(i.col.w * across, i.col.w * smoothstep(0.0, 0.6, across), i.uv.x > 0.5);
    // a splash's mist (uv.x 2 + height up it, uv.y across): a Gaussian across, densest at its foot, thinning upwards.
    // A soft particle: it fades out as it nears the surface behind it (the depth buffer), so where it meets the ground
    // it leaves no edge
    if (i.uv.x > 1.5) {
        let h = i.uv.x - 2.0;
        let zs = textureLoad(depthTex, vec2i(i.pos.xy), 0);
        let gap = select(1e3, F.fwd.w / zs, zs > 0.0) - F.fwd.w / i.pos.z;
        a = i.col.w * max(exp(-i.uv.y * i.uv.y * 3.0) - 0.05, 0.0) * (1.0 - h) * (1.0 - h) * smoothstep(0.0, 0.35, gap);
    }
    return vec4f(tonemap(i.col.rgb), a);
}

// the bus's windows, drawn over the composite (they write no depth, so the march and the particles see through them):
// a faint grey tint, the sky reflected at grazing angles, and rain drops on them while it rains, which the wind of the
// bus's speed streaks back along the side windows. O(1) per pixel: one hash per 2.5 cm cell
struct GlassOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) local: vec3f, @location(3) kind: f32 };

@vertex fn vsGlass(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> GlassOut {
    let q = busVertex(p, c.a);
    var o: GlassOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n, 0.0)).xyz;
    o.local = q;
    o.kind = f32(u32(c.a + 0.5) & 7u);
    o.pos = busU.mvp * vec4f(q, 1.0);
    return o;
}

@fragment fn fsGlass(i: GlassOut) -> @location(0) vec4f {
    let p = i.world;
    let v = normalize(F.cam.xyz - p);
    var n = normalize(i.n);
    if (dot(n, v) < 0.0) { n = -n; }
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let r = reflect(-v, n);
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, v)), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 600.0) * 6.0 + lampsAt(p + n * 0.02, n, v, 900.0, 0u).s;
    // drops: a hashed 2 cm cell holds one or not (more of them the harder it rains), 2-5 mm across; they come and go.
    // On the side windows the wind of the bus's speed draws them out backwards into thin streaks (cells up to 8 times
    // longer along the bus, the drop as long), and sweeps some away
    let rain = sat(F.near.x * 1.5);
    var drop = 0.0;
    var rim = 0.0;
    if (rain > 0.01) {
        let side = i.kind < 0.5;
        let u = select(i.local.z, i.local.x, side);
        let k = select(0.0, sat(busU.info.x / 15.0), side);
        let stretch = 1.0 + 7.0 * k;
        let g = vec2f(u / (0.02 * stretch), i.local.y / 0.02 + u * 3.0 * k);    // streaks run back and a little down
        let cell = floor(g);
        let cx = u32(cell.x + 100000.0);
        let cy = u32(cell.y + 1000.0);
        let life = floor(F.cam.w * mix(0.4, 1.5, k) + rnd(cx * 7919u + cy));
        let h = rnd((cx * 73856093u) ^ (cy * 19349663u) ^ (u32(life) * 83492791u));
        if (h < rain * mix(0.35, 0.2, k)) {
            let c = vec2f(rnd(u32(h * 1e6)), rnd(u32(h * 1e6) + 7u)) * 0.5 + 0.25;
            let d = length(fract(g) - c) / (0.12 + 0.12 * fract(h * 13.0));
            drop = 1.0 - smoothstep(0.6, 1.0, d);
            rim = smoothstep(0.25, 0.85, d);
        }
    }
    // a drop is a little lens: the dark ground below shows in its middle, the bright sky above in its rim
    let sky = F.ambient.rgb * sh.y;
    let dropCol = mix(sky * 0.25, sky * 2.2 + F.sunCol.rgb * sh.x * 0.05, rim);
    let a = sat(0.06 + fres * 0.85 + drop * 0.6);
    let col = (spec * fres * (1.0 - drop) + vec3f(0.02, 0.025, 0.03) * F.ambient.rgb + dropCol * drop * 0.6) / a;
    return vec4f(tonemap(col), a);
}

// a building's window glass (Buildings.add), drawn over the composite like the bus's: a faint tint, the sky
// reflected at grazing angles, rain drops on it where the rain reaches its outer side (one test per vertex). Towards
// INTERIOR_DRAW from the building it turns into the opaque pane fsPane draws beyond it, so the switch does not show
struct PaneOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) id: u32, @location(3) wet: f32 };

@vertex fn vsWindow(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> PaneOut {
    var o: PaneOut;
    o.world = p;
    o.n = n;                                                            // outward
    o.id = u32(c.a + 0.5) / ${BLD_ID}u;
    o.wet = rainReaches(p + n * 0.2);
    o.pos = F.viewProj * vec4f(p, 1.0);
    return o;
}

@fragment fn fsWindow(i: PaneOut) -> @location(0) vec4f {
    let b = bld(i.id);
    let dc = distance(F.cam.xyz, bldCentre(b));
    if (dc >= ${INTERIOR_DRAW}.0) { discard; }
    let p = i.world;
    let v = normalize(F.cam.xyz - p);
    let out = normalize(i.n);
    let n = select(-out, out, dot(out, v) >= 0.0);
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let r = reflect(-v, n);
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, v)), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 600.0) * 6.0 + lampsAt(p + n * 0.02, n, v, 900.0, 0u).s;
    // drops as on the bus's windows, but still: a hashed 2 cm cell holds one or not, and they come and go slowly
    let rain = sat(F.near.x * 1.5) * sat(i.wet);
    var drop = 0.0;
    var rim = 0.0;
    if (rain > 0.01) {
        let g = vec2f(dot(p.xz, vec2f(-out.z, out.x)), p.y) / 0.02;
        let cell = floor(g);
        let cx = u32(i32(cell.x) + 1000000);
        let cy = u32(i32(cell.y) + 1000000);
        let life = floor(F.cam.w * 0.25 + rnd(cx * 7919u + cy));
        let h = rnd((cx * 73856093u) ^ (cy * 19349663u) ^ (u32(life) * 83492791u));
        if (h < rain * 0.3) {
            let c = vec2f(rnd(u32(h * 1e6)), rnd(u32(h * 1e6) + 7u)) * 0.5 + 0.25;
            let d = length(fract(g) - c) / (0.12 + 0.12 * fract(h * 13.0));
            drop = 1.0 - smoothstep(0.6, 1.0, d);
            rim = smoothstep(0.25, 0.85, d);
        }
    }
    let sky = F.ambient.rgb * sh.y;
    let dropCol = mix(sky * 0.25, sky * 2.2 + F.sunCol.rgb * sh.x * 0.05, rim);
    var a = sat(0.06 + fres * 0.85 + drop * 0.6);
    var c = spec * fres * (1.0 - drop) + vec3f(0.02, 0.025, 0.03) * F.ambient.rgb + dropCol * drop * 0.6;
    // the opaque pane it becomes (shadeStruct's window, mat 5, and the glow of a lit room)
    let far = smoothstep(${INTERIOR_DRAW - 40}.0, ${INTERIOR_DRAW}.0, dc);
    let pane = vec3f(0.06, 0.08, 0.10) * (F.ambient.rgb * sh.y * 0.55 + F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x) + spec * fres * 0.8 + windowGlow(i.id, b, p.y);
    c = mix(c, pane, far);
    a = mix(a, 1.0, far);
    return vec4f(tonemap(c / a), a);
}

// lightning bolts: segment k = (bolts[2k] start + brightness, bolts[2k + 1] end + width in m)
@vertex fn vsBolt(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
    var o: LineOut;
    o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
    o.col = vec4f(0.0);
    let s0 = bolts[ii * 2u];
    let s1 = bolts[ii * 2u + 1u];
    if (s0.w <= 0.0) { return o; }
    let a = F.viewProj * vec4f(s0.xyz, 1.0);
    let b = F.viewProj * vec4f(s1.xyz, 1.0);
    if (a.w < 1.0 || b.w < 1.0) { return o; }
    let focal = F.screen.y * 0.5 / length(F.up.xyz);
    lineQuad(a, b, max(1.5, s1.w * focal / a.w), vi, &o);
    let haze = exp(-distance(s0.xyz, F.cam.xyz) * F.zenith.w * 0.6);
    o.col = vec4f(vec3f(0.8, 0.86, 1.0) * s0.w * haze, 1.0);
    return o;
}

@fragment fn fsBolt(i: LineOut) -> @location(0) vec4f {
    let core = pow(1.0 - abs(i.uv.y), 1.5);
    return vec4f(tonemap(i.col.rgb * core), core);
}

// the bolts into the bloom chain's top level (Renderer.encodeBloom) before it is filtered, added (blend one, one): their
// HDR light times F.post.w, so they glow far wider than their own pixels and the threshold would give. The chain is half
// resolution and has no depth attachment, so the depth test against the scene is done here (reversed z)
@fragment fn fsBoltGlow(i: LineOut) -> @location(0) vec4f {
    let pix = min(vec2i(i.pos.xy * 2.0), vec2i(F.screen.xy) - 1);
    if (i.pos.z < textureLoad(depthTex, pix, 0)) { discard; }
    let core = pow(1.0 - abs(i.uv.y), 1.5);
    return vec4f(i.col.rgb * core * F.post.w, 1.0);
}
`;

// Bloom (Renderer.encodeBloom): the composite's HDR colour (scene behind the volumetrics, as fsComposite adds them)
// above a soft threshold in exposed radiance goes into a mip chain at half resolution, is filtered down level by level
// with a 13-tap box filter (the first one averaging its groups by 1 / (1 + luma), so a single bright pixel, a sun glint
// or a lamp, cannot flicker as the view moves), then filtered back up with a 3x3 tent, each level adding onto the one
// above. fsComposite adds the top level (the sum of the levels) times F.bloom.x / levels before the tonemap. Group 1:
// the source level (the cloud history for the prefilter) and the scene's HDR colour.
const WGSL_BLOOM = /* wgsl */`
@group(1) @binding(0) var srcTex: texture_2d<f32>;
@group(1) @binding(1) var hdrTex: texture_2d<f32>;

struct FsIn { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vsBloom(@builtin(vertex_index) vi: u32) -> FsIn {
    let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
    var o: FsIn;
    o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2f(p.x, 1.0 - p.y);
    return o;
}

fn bloomLuma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// the composite's colour at uv, as fsComposite makes it before the bloom and the flash veil (clamped: no infinities)
fn compositeAt(uv: vec2f) -> vec3f {
    let hdr = textureSampleLevel(hdrTex, clampSamp, uv, 0.0).rgb;
    let c = textureSampleLevel(srcTex, clampSamp, uv, 0.0);
    let col = select(hdr * c.a + c.rgb, hdr, i32(F.ground.w) == 1);
    return min(col, vec3f(6.0e4));
}

// 13 bilinear taps around uv, d apart (one source texel): the centre 2x2 box at weight 0.5, the four corner boxes at
// 0.125 each. karis: each box weighted by 1 / (1 + luma) of its exposed colour
fn down13(uv: vec2f, d: vec2f, pre: bool) -> vec3f {
    var s: array<vec3f, 13>;
    let offs = array<vec2f, 13>(
        vec2f(-2.0, -2.0), vec2f(0.0, -2.0), vec2f(2.0, -2.0),
        vec2f(-2.0, 0.0), vec2f(0.0, 0.0), vec2f(2.0, 0.0),
        vec2f(-2.0, 2.0), vec2f(0.0, 2.0), vec2f(2.0, 2.0),
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
    for (var k = 0; k < 13; k++) {
        let u = uv + offs[k] * d;
        if (pre) { s[k] = compositeAt(u); } else { s[k] = textureSampleLevel(srcTex, clampSamp, u, 0.0).rgb; }
    }
    var boxes = array<vec3f, 5>(
        (s[9] + s[10] + s[11] + s[12]) * 0.25,
        (s[0] + s[1] + s[3] + s[4]) * 0.25,
        (s[1] + s[2] + s[4] + s[5]) * 0.25,
        (s[3] + s[4] + s[6] + s[7]) * 0.25,
        (s[4] + s[5] + s[7] + s[8]) * 0.25);
    var sum = vec3f(0.0);
    var wsum = 0.0;
    for (var k = 0; k < 5; k++) {
        var w = select(0.125, 0.5, k == 0);
        if (pre) { w /= 1.0 + bloomLuma(boxes[k]) * F.sunCol.w; }
        sum += boxes[k] * w;
        wsum += w;
    }
    return sum / wsum;
}

// full resolution composite into the top level, keeping what is brighter than the threshold (F.bloom.y, exposed) with a
// quadratic soft knee F.bloom.z wide
@fragment fn fsBloomPre(i: FsIn) -> @location(0) vec4f {
    let c = down13(i.uv, 1.0 / F.screen.xy, true);
    let br = max(c.r, max(c.g, c.b)) * F.sunCol.w;
    let th = F.bloom.y;
    let knee = max(F.bloom.z, 1e-4);
    var rq = clamp(br - th + knee, 0.0, 2.0 * knee);
    rq = rq * rq / (4.0 * knee);
    return vec4f(c * max(rq, br - th) / max(br, 1e-4), 1.0);
}

@fragment fn fsBloomDown(i: FsIn) -> @location(0) vec4f {
    return vec4f(down13(i.uv, 1.0 / vec2f(textureDimensions(srcTex, 0)), false), 1.0);
}

// the level below, a 3x3 tent of bilinear taps one of its texels apart, added onto this level (blend one, one)
@fragment fn fsBloomUp(i: FsIn) -> @location(0) vec4f {
    let d = 1.0 / vec2f(textureDimensions(srcTex, 0));
    var sum = vec3f(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let w = f32((2 - abs(x)) * (2 - abs(y)));
            sum += textureSampleLevel(srcTex, clampSamp, i.uv + vec2f(f32(x), f32(y)) * d, 0.0).rgb * w;
        }
    }
    return vec4f(sum / 16.0, 1.0);
}
`;

return { WGSL_FINAL, WGSL_BLOOM };
});
