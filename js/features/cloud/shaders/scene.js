'use strict';
// WGSL: the scene: terrain and structures.

Features.part('cloud', (engine, feature) => {
const {
    LIGHT_CABIN, POOL_ALBEDO, FAR_LAMP_PITCH, TOWN_BLOCK, FAR_LAMP_SIDE, FAR_LAMP_H, POLE_DRAW, GRID_N, BUS, BUS_IN,
    INTERIOR_DRAW, BLD_ID,
} = feature;

// needs F, heightTex, clampSamp: the terrain's height and normal at xz (beyond the heightfield it flattens to the base)
const WGSL_TERRAIN = /* wgsl */`
fn terrainHeight(xz: vec2f) -> vec4f {
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    let s = textureSampleLevel(heightTex, clampSamp, uv, 0.0);
    let out = max(max(abs(uv.x - 0.5), abs(uv.y - 0.5)) - 0.5, 0.0) * F.tdomain.z;
    let k = exp(-out / 4000.0);
    return vec4f(mix(F.misc.z, s.x, k), normalize(mix(vec3f(0.0, 1.0, 0.0), s.yzw, k * k * k)));
}

// the height of the terrain as drawn (vsTerrain), which between its vertices runs above or below terrainHeight (its
// vertices sample it, its triangles do not): over the heightfield the grid is linear (gridWarp's inner part), each cell
// two triangles split from vertex (i + 1, j) to (i, j + 1). Beyond it, the sampled height
fn meshHeight(xz: vec2f) -> f32 {
    let r0 = F.tdomain.z * 0.5;
    let c = F.tdomain.xy + r0;
    if (any(abs(xz - c) >= vec2f(r0))) { return terrainHeight(xz).x; }
    let n = f32(${GRID_N - 1});
    let g = ((xz - c) / r0 * 0.72 + 1.0) * 0.5 * n;
    let i = floor(g);
    let f = g - i;
    let vert = (i / n * 2.0 - 1.0) / 0.72 * r0 + c;
    let step = 2.0 / n / 0.72 * r0;
    let hb = terrainHeight(vert + vec2f(step, 0.0)).x;
    let hc = terrainHeight(vert + vec2f(0.0, step)).x;
    if (f.x + f.y <= 1.0) {
        let ha = terrainHeight(vert).x;
        return ha + (hb - ha) * f.x + (hc - ha) * f.y;
    }
    let hd = terrainHeight(vert + vec2f(step)).x;
    return hd + (hc - hd) * (1.0 - f.x) + (hb - hd) * (1.0 - f.y);
}

// The scene pass writes a rain surface code into the HDR target's alpha, for the splashes (splash): 0 where no rain lands
// (sky, walls, glass, interiors, the buses, under roofs, snow), else the kind of surface, an integer, plus 0.45 x its
// puddle (puddleAt). Kinds: 1 soaks the drops up (fields, grass, forest floor), 2 hard (paving, roofs, decks, metal,
// rock), 3 asphalt, 4 open water
// the light the spray off the ground scatters (the volumetric carpet, rainSpray, and the splashes' mist sprites, splash,
// alike, so the one passes into the other unseen), under sh (shadowAt: sun, sky light left)
fn sprayColor(sh: vec2f) -> vec3f { return F.ambient.rgb * (0.35 + 0.55 * sh.y) + F.sunCol.rgb * sh.x * 0.04; }

fn rainKind(code: f32) -> f32 { return floor(code + 0.01); }
fn rainPuddle(code: f32) -> f32 { return sat((code - floor(code + 0.01)) / 0.45); }

// a pixel's footprint (m) on a surface at p with normal n, seen along v (towards the eye)
fn pixelSize(p: vec3f, n: vec3f, v: vec3f) -> f32 {
    return distance(F.cam.xyz, p) * 2.0 * length(F.up.xyz) / F.screen.y / max(abs(dot(n, v)), 0.15);
}

// standing water on asphalt and paving: puddles in its dips (two octaves of noise, more of them the wetter it is), 0..1
fn puddleAt(xz: vec2f, wet: f32) -> f32 {
    let n = vnoise2(xz / 2.3) * 0.65 + vnoise2(xz / 0.7 + 7.1) * 0.35;
    return smoothstep(0.66 - 0.2 * wet, 0.70 - 0.2 * wet, n) * smoothstep(0.15, 0.45, wet);
}

// the rings rain drops make on standing water: each 0.3 m cell of three offset grids takes a drop now and then (more
// often the harder it rains, rain 0..1) at a hashed spot, whose ring runs out to 8 cm as it fades. The slope of the
// water (dh/dx, dh/dz). Where a pixel covers more than a centimetre or so (px, m) the ring widens with it, so it blurs
// instead of aliasing, and further off it fades out
fn rainRipples(xz: vec2f, px: f32, rain: f32) -> vec2f {
    let fade = (1.0 - smoothstep(0.05, 0.12, px)) * sat(rain * 3.0);
    let w2 = 1.0 / pow(max(0.011, px * 0.6), 2.0);
    let k = 6.2832 / max(0.024, px * 2.0);
    if (fade <= 0.0) { return vec2f(0.0); }
    var g = vec2f(0.0);
    for (var l = 0; l < 3; l++) {
        let q = xz / 0.3 + vec2f(0.37, 0.71) * f32(l);
        let cell = floor(q);
        let seed = cell + f32(l) * 17.3;
        let cyc = F.cam.w * 1.1 + hash12(seed);
        let k = floor(cyc);
        let ph = fract(cyc);
        if (hash12(seed + k * 3.7) > 0.25 + 0.75 * sat(rain)) { continue; }
        let c = cell + 0.3 + 0.4 * vec2f(hash12(seed + k * 1.3 + 5.0), hash12(seed + k * 2.9 + 9.0));
        let dv = (q - c) * 0.3;
        let d = length(dv);
        let x = d - ph * 0.08;
        let env = (1.0 - ph) * (1.0 - ph) * exp(-x * x * w2) * smoothstep(0.0, 0.05, ph);
        g += dv / max(d, 1e-4) * cos(x * k) * env;
    }
    return g * fade * 0.45;
}
`;

const WGSL_SCENE = /* wgsl */`
struct SkyOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };

@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
    let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
    var o: SkyOut;
    o.pos = vec4f(p, 0.0, 1.0);
    o.ndc = p;
    return o;
}

@fragment fn fsSky(i: SkyOut) -> @location(0) vec4f {
    let d = rayDir(i.ndc);
    var c = skyColor(d);
    let mu = dot(d, F.sunDir.xyz);
    if (F.sunDir.w > 0.0) { c += moonDisc(d, mu) + stars(d); }
    else { c += F.sunCol.rgb * 30.0 * smoothstep(0.99990, 0.99996, mu); }
    return vec4f(c, 0.0);
}

// the moon by night (at F.sunDir): a disc lit from one side by its phase (F.sunDir.w its lit fraction), with darker
// maria, and a little earthshine on its dark side
fn moonDisc(d: vec3f, mu: f32) -> vec3f {
    if (mu < 0.9998) { return vec3f(0.0); }
    let m = F.sunDir.xyz;
    let r = normalize(cross(m, vec3f(0.0, 1.0, 0.0)));
    let u = cross(r, m);
    let q = vec2f(dot(d, r), dot(d, u)) / 0.0125;
    let q2 = dot(q, q);
    let edge = 1.0 - smoothstep(0.9, 1.0, sqrt(q2));
    if (edge <= 0.0) { return vec3f(0.0); }
    let n = vec3f(q, sqrt(max(1.0 - q2, 0.0)));
    let ca = F.sunDir.w * 2.0 - 1.0;                    // cos of the phase angle: 1 full, -1 new
    let lit = smoothstep(-0.05, 0.05, dot(n, vec3f(sqrt(max(1.0 - ca * ca, 0.0)), 0.0, ca)));
    let maria = 1.0 - 0.4 * smoothstep(0.45, 0.7, fbm2(q * 1.7 + 3.0, 4));
    return F.sunCol.rgb * 0.22 * edge * maria * (lit + 0.012);
}

// the stars: one in some of the cells of a grid of directions, few bright and many faint, twinkling a little; they sink
// into the haze at the horizon and fade under a bright moon. Clouds cover them as they cover the sky
fn stars(d: vec3f) -> vec3f {
    if (d.y <= 0.0) { return vec3f(0.0); }
    let p = d * 200.0;
    let cell = floor(p);
    let h = hash12(cell.xy + cell.z * 37.17);
    if (h < 0.95) { return vec3f(0.0); }
    let j = vec3f(hash12(cell.xy + 1.7 + cell.z), hash12(cell.zx + 3.1), hash12(cell.yz + 5.3)) - 0.5;
    let o = normalize(cell + 0.5 + 0.3 * j) * 200.0;
    let px = 2.0 * length(F.up.xyz) / F.screen.y * 200.0;     // a pixel, in grid cells
    let rad = max(0.12, px * 0.6);
    let x = length(p - o) / rad;
    let b = pow((h - 0.95) / 0.05, 8.0) * 1.5 * (0.85 + 0.15 * sin(F.cam.w * 3.0 + h * 900.0));
    let tint = mix(vec3f(1.0, 0.82, 0.66), vec3f(0.72, 0.84, 1.0), hash12(cell.xz + 9.9));
    return tint * b * exp(-x * x) * min(1.0, 0.12 / rad) * smoothstep(0.0, 0.12, d.y) * (1.0 - 0.6 * F.sunDir.w) * 1.5 / F.sunCol.w;
}

// geometric grid: linear over the heightfield, then rings growing out to the horizon
fn gridWarp(u: f32) -> f32 {
    let a = abs(u);
    let r0 = F.tdomain.z * 0.5;
    let inner = 0.72;
    let r = select(r0 * exp((a - inner) / (1.0 - inner) * log(260000.0 / r0)), a / inner * r0, a < inner);
    return sign(u) * r;
}

struct TerrOut { @builtin(position) pos: vec4f, @location(0) world: vec3f };

@vertex fn vsTerrain(@builtin(vertex_index) vi: u32) -> TerrOut {
    let N = ${GRID_N}u;
    let i = vi % N;
    let j = vi / N;
    let u = f32(i) / f32(N - 1u) * 2.0 - 1.0;
    let v = f32(j) / f32(N - 1u) * 2.0 - 1.0;
    let xz = F.tdomain.xy + F.tdomain.z * 0.5 + vec2f(gridWarp(u), gridWarp(v));
    let h = terrainHeight(xz).x;
    var o: TerrOut;
    o.world = vec3f(xz.x, h, xz.y);
    o.pos = F.viewProj * vec4f(o.world, 1.0);
    return o;
}

fn groundAt(xz: vec2f) -> vec2f {
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec2f(0.0); }
    let n = i32(F.ground.z);
    let g = clamp((xz - F.tdomain.xy) / F.tdomain.z * f32(n) - 0.5, vec2f(0.0), vec2f(f32(n) - 1.001));
    let i = vec2i(floor(g));
    let f = fract(g);
    let a = ground[i.y * n + i.x];
    let b = ground[i.y * n + min(i.x + 1, n - 1)];
    let c = ground[min(i.y + 1, n - 1) * n + i.x];
    let d = ground[min(i.y + 1, n - 1) * n + min(i.x + 1, n - 1)];
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// farm sections on a mile grid: crops, fallow, centre pivots, section-line roads
fn fieldColor(xz: vec2f, px: f32) -> vec3f {
    let fs = F.ground.x;
    let g = xz / fs;
    let cell = floor(g);
    let f = fract(g);
    let h2 = hash12(cell + 71.3);
    var k = hash12(cell);
    if (h2 < 0.5) { k = hash12(cell * 2.0 + floor(f * 2.0) + 13.7); }
    else if (h2 < 0.7) { k = hash12(cell * 2.0 + vec2f(floor(f.x * 2.0), 0.0) + 5.2); }
    var pal = array<vec3f, 7>(
        vec3f(0.34, 0.26, 0.18), vec3f(0.25, 0.19, 0.13), vec3f(0.19, 0.25, 0.11), vec3f(0.46, 0.38, 0.24),
        vec3f(0.17, 0.14, 0.11), vec3f(0.40, 0.33, 0.24), vec3f(0.27, 0.27, 0.15));
    var c = pal[min(u32(k * 7.0), 6u)];
    if (hash12(cell + 5.1) < F.ground.y) {
        let r = length(f - 0.5) * fs;
        let ring = 1.0 - smoothstep(fs * 0.48 - px, fs * 0.48 + px, r);
        c = mix(c, select(vec3f(0.15, 0.24, 0.09), vec3f(0.36, 0.31, 0.21), h2 > 0.75), ring * (1.0 - smoothstep(0.05, 0.3, px / fs)));
    }
    c = mix(c, vec3f(0.30, 0.25, 0.17), smoothstep(0.08, 0.45, px / fs));     // far away: the average crop colour
    let detail = sat(40.0 / max(px, 1.0));
    c *= 0.88 + 0.24 * mix(0.5, vnoise2(xz / 70.0), detail) + 0.12 * (vnoise2(xz / 2400.0) - 0.5);
    let e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * fs;
    let road = (1.0 - smoothstep(4.0, 4.0 + px, e)) * sat(8.0 / max(px, 0.5));
    return mix(c, vec3f(0.44, 0.42, 0.39), road * 0.85);
}

fn townColor(xz: vec2f, px: f32) -> vec3f {
    let b = 120.0;
    let g = xz / b;
    let id = floor(g);
    let f = fract(g);
    var c = mix(vec3f(0.30, 0.29, 0.28), vec3f(0.46, 0.42, 0.38), hash12(id));
    c = mix(c, vec3f(0.17, 0.22, 0.12), step(0.78, hash12(id + 3.3)));
    c *= mix(1.0, 0.75 + 0.5 * hash12(floor(xz / 16.0)), sat(20.0 / max(px, 1.0)));
    let street = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * b;
    let s = (1.0 - smoothstep(6.0, 6.0 + px, street)) * sat(12.0 / max(px, 0.5));
    return mix(c, vec3f(0.36, 0.36, 0.35), s);
}

// The fake street lamps (World.buildFarLights): on townColor's street grid, one every ${FAR_LAMP_PITCH} m, 7 m up, kept by
// the same hash as there against the lamp share (landTex's alpha); a quarter of the districts have white LEDs
fn farLampKey(c: vec2i) -> u32 { return pcg(u32(c.x + 65536) * 196613u + u32(c.y + 65536)); }
fn farLampColor(xz: vec2f) -> vec3f {
    let d = vec2i(floor(xz / 600.0)) + 1000;
    if (f32(pcg(u32(d.x) * 4099u + u32(d.y))) / 4294967295.0 < 0.25) { return vec3f(0.90, 0.94, 1.0) * 55.0; }   // LAMPS.led
    return vec3f(1.0, 0.58, 0.24) * 85.0;                                                                         // LAMPS.sodium
}
// how much of fake lamp at q is a real light now (LightWriter.write takes the ones near the camera, nearest first, and
// fades them out toward the furthest taken, F.lightInfo.z): its pool here gives way by as much, so the switch cannot show
fn farLampReal(q: vec3f) -> f32 {
    let cut = F.lightInfo.z;
    return 1.0 - smoothstep(cut * 0.7, cut, max(distance(q, F.cam.xyz) - 34.0, 0.0));   // LAMPS.sodium.range
}
// the light of lamp c (grid point, in units of the pitch; its head off the street along side) at the ground point p,
// with normal n, seen along v: as lampsAt shades a real light (lightAt: windowed inverse square, softened by its size)
fn farLampPool(p: vec3f, n: vec3f, v: vec3f, shin: f32, c: vec2i, side: vec2f, share: f32) -> Lamps {
    var o = Lamps(vec3f(0.0), vec3f(0.0));
    if (f32(farLampKey(c)) / 4294967295.0 >= share) { return o; }
    let q = vec3f(vec2f(c) * ${FAR_LAMP_PITCH}.0 + side * ${FAR_LAMP_SIDE}.0, p.y + ${FAR_LAMP_H}.0).xzy;
    let d = q - p;
    let d2 = dot(d, d);
    let r2 = 34.0 * 34.0;                                          // LAMPS: range, size
    if (d2 >= r2) { return o; }
    let l = d * inverseSqrt(d2);
    let nl = dot(n, l);
    if (nl <= 0.0) { return o; }
    let x = d2 / r2;
    let win = sat(1.0 - x * x);
    let col = farLampColor(vec2f(c) * ${FAR_LAMP_PITCH}.0) * win * win / (d2 + 0.36) * nl * (1.0 - farLampReal(q));
    o.d = col;
    let h = normalize(l + v);
    o.s = col * pow(max(dot(n, h), 0.0), shin) * (shin + 8.0) / (8.0 * PI);
    return o;
}
// their light on the town's ground by night (adapted to the exposure as the lights are): the nearest lamps on the two
// streets nearest p, those not taken as real lights yet; far off, where a pixel spans several lamps, their mean
// (5 lamps per block). Heads alternate sides along a street: + on even lamps
fn streetGlow(p: vec3f, n: vec3f, v: vec3f, shin: f32, px: f32, share: f32) -> Lamps {
    var o = Lamps(vec3f(0.0), vec3f(0.0));
    if (F.lightInfo.y < 0.5 || share < 0.004) { return o; }
    let P = ${FAR_LAMP_PITCH}.0;
    let m = ${TOWN_BLOCK / FAR_LAMP_PITCH};
    let far = smoothstep(3.0, 20.0, px);
    if (far < 1.0) {
        let a = vec2i(i32(round(p.x / (P * f32(m)))) * m, i32(round(p.z / P)));     // along the nearest street along z
        let b = vec2i(i32(round(p.x / P)), i32(round(p.z / (P * f32(m)))) * m);     // along the nearest street along x
        for (var k = -1; k <= 1; k++) {
            let ca = a + vec2i(0, k);
            let la = farLampPool(p, n, v, shin, ca, vec2f(select(1.0, -1.0, (ca.y & 1) != 0), 0.0), share);
            o.d += la.d; o.s += la.s;
            let cb = b + vec2i(k, 0);
            if (cb.x % m != 0) {
                let lb = farLampPool(p, n, v, shin, cb, vec2f(0.0, select(1.0, -1.0, (cb.x & 1) != 0)), share);
                o.d += lb.d; o.s += lb.s;
            }
        }
    }
    let mean = farLampColor(p.xz) * share * ${(5 * 2 * Math.PI / (TOWN_BLOCK * TOWN_BLOCK)).toFixed(6)} * (1.0 - farLampReal(p + vec3f(0.0, ${FAR_LAMP_H}.0, 0.0)));
    let e = 1.0 / max(F.sunCol.w, 0.2);
    o.d = mix(o.d, mean, far) * e;
    o.s *= (1.0 - far) * e;
    return o;
}

@fragment fn fsTerrain(i: TerrOut) -> @location(0) vec4f {
    let p = i.world;
    let px = max(length(fwidth(p.xz)), 0.05);
    let uv = (p.xz - F.tdomain.xy) / F.tdomain.z;
    let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0));
    let th = terrainHeight(p.xz);
    let n = th.yzw;
    let land4 = select(vec4f(0.0), textureSampleLevel(landTex, clampSamp, uv, 0.0), inside);
    let land = land4.xyz;
    var alb = fieldColor(p.xz, px);
    alb = mix(alb, townColor(p.xz, px), sat(land.x * (0.6 + 0.8 * vnoise2(p.xz / 700.0)) * 1.4 - 0.2));
    let forest = sat(land.y * (0.4 + vnoise2(p.xz / 300.0)) * 1.3);
    alb = mix(alb, vec3f(0.07, 0.11, 0.06) * (0.8 + 0.4 * vnoise2(p.xz / 40.0)), forest);
    // mountains: conifers, then rock above the tree line and on steep slopes
    let wild = smoothstep(150.0, 700.0, p.y - F.misc.z);
    let rock = sat(smoothstep(3300.0, 3700.0, p.y + 200.0 * vnoise2(p.xz / 500.0)) + smoothstep(0.82, 0.62, n.y));
    let mtn = mix(vec3f(0.09, 0.12, 0.07), vec3f(0.33, 0.31, 0.29), rock);
    alb = mix(alb, mtn, wild);
    // weather on the ground
    // structures: their sun shadows, and dry ground where they keep the rain and snow off
    let gs = groundAt(p.xz);
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let sl = structureLight(p + vec3f(0.0, 0.05, 0.0), sh.x * dot(n, s) > 0.002, gs.x + gs.y > 0.002);
    let snow = sat(gs.x * 3.0) * smoothstep(0.45, 0.75, n.y) * sl.y;
    let wet = gs.y * (1.0 - snow) * sl.y;
    alb = mix(alb * (1.0 - 0.45 * wet), vec3f(0.85, 0.88, 0.92), snow);
    let water = land.z;
    // the town's paving puddles; rain rings on the puddles, on open water, faintly on the wet film elsewhere
    let paved = sat(land.x * 1.6 - 0.4) * (1.0 - wild);
    let puddle = puddleAt(p.xz, wet) * paved * (1.0 - water) * smoothstep(0.97, 0.995, n.y);
    let pool = max(water, puddle);
    let rainNow = sat(F.near.x * 1.5) * sl.y * (1.0 - snow);
    let rg = rainRipples(p.xz, px, rainNow) * max(pool, 0.25 * wet * paved);
    let nw = normalize(vec3f(-rg.x, 1.0, -rg.y));
    alb *= 1.0 - 0.4 * puddle;

    let v = normalize(F.cam.xyz - p);
    // the lights: a sharp highlight on puddles and water, a broad one on the wet film (the long streaks of a wet road)
    var lp = lampsAt(p + n * 0.05, nw, v, mix(60.0, 900.0, pool), 0u);
    let sg = streetGlow(p + n * 0.05, nw, v, mix(60.0, 900.0, pool), px, land4.w);
    lp.d += sg.d;
    lp.s += sg.s;
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sl.x + F.ambient.rgb * sh.y * sl.z * (0.55 + 0.45 * n.y) + FLASH_COLOR * flashLit(p) * 0.03 + lp.d);
    // wet ground and open water reflect the sky
    let r = reflect(-v, nw);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(nw, v), 0.0), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 400.0) * 4.0 + lp.s;
    col = mix(col, vec3f(0.01, 0.02, 0.025) * F.ambient.rgb + spec * fres, pool);
    col += spec * fres * wet * 0.35 * (1.0 - pool);
    col += skyColor(r) * sh.y * length(rg) * 1.5;                         // the rings catch the sky at any angle
    let kind = select(select(select(1.0, 2.0, rock * wild > 0.5), 3.0, paved > 0.5), 4.0, water > 0.5);
    return vec4f(col, select(0.0, kind + 0.45 * puddle, rainNow > 0.0 && n.y > 0.7));
}

// structures (houses, bus stop, bridges, roads): flat-shaded triangles, colour per vertex and a material
// (0 matte, 1 roof, 2 glass, 3 asphalt, 4 metal, 5 window, 6 water)
struct StructOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) col: vec4f };

@vertex fn vsStruct(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> StructOut {
    var o: StructOut;
    o.world = p;
    o.n = n;
    o.col = c;
    o.pos = F.viewProj * vec4f(p, 1.0);
    return o;
}

@fragment fn fsStruct(i: StructOut) -> @location(0) vec4f {
    let mat = i32(i.col.a + 0.5);
    if (mat == 7) { return vec4f(lampGlow(i.world, i.n, i.col.rgb), 0.0); }
    return shadeStruct(i.world, i.n, i.col.rgb, mat);
}

// a lamp's diffuser (material 7: street lamps, porch lights, the canopy's lights): glass lit like any by day, glowing by
// night (F.lightInfo.y), the eye adapted to it as to the lamps indoors
fn lampGlow(p: vec3f, n: vec3f, col: vec3f) -> vec3f {
    if (F.lightInfo.y < 0.5) { return shadeStruct(p, n, col, 2).rgb; }
    return col * 2.6 / max(F.sunCol.w, 0.2);
}

// a moving bus (BusLine): its mesh is in its own frame (busVertex), drawn with busU.mvp
@vertex fn vsBus(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> StructOut {
    let q = busVertex(p, c.a);
    var o: StructOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n, 0.0)).xyz;
    o.col = c;
    o.pos = busU.mvp * vec4f(q, 1.0);
    return o;
}

// the sun reaches q (in the bus's frame) through glass: where its ray d leaves the body, if that is in a side window (not a
// pillar), the windscreen or the rear window. O(1): one box exit
fn throughGlass(q: vec3f, d: vec3f) -> f32 {
    let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
    let t = max((vec3f(${-BUS.hl}, ${BUS.skirt}, ${-BUS.hw}) - q) * inv, (vec3f(${BUS.hl}, ${BUS.roof}, ${BUS.hw}) - q) * inv);
    let te = min(t.x, min(t.y, t.z));
    let e = q + d * te;
    if (te == t.z) {
        // side: the window band, or a door's glass (lower) on the right
        let k = (e.x - ${BUS.bay0}) / ${BUS.bay};
        let bay = floor(k);
        let inPane = abs(fract(k) - 0.5) * ${BUS.bay} < ${(BUS.bay - BUS.pillar) / 2} && bay >= 0.0 && bay < ${BUS.bays}.0;
        let door = d.z > 0.0 && (bay == ${BUS.doorBays[0]}.0 || bay == ${BUS.doorBays[1]}.0);
        let lo = select(${BUS.winLo}, ${BUS.floor + 0.35}, door);
        return select(0.0, 1.0, inPane && e.y > lo && e.y < ${BUS.winHi});
    }
    if (te == t.x) {
        if (d.x > 0.0) { return select(0.0, 1.0, e.y > 0.95 && e.y < 2.45); }
        return select(0.0, 1.0, e.y > 1.4 && e.y < 2.3 && abs(e.z) < 0.9);
    }
    return 0.0;                                                          // roof or floor
}

// inside the cabin: sky light that comes in through the windows (less low down, under them), the sun where it shines in
// through glass, and the ceiling lamps, whose light the eye adapts to (so they read the same at any exposure)
fn shadeCabin(p: vec3f, nIn: vec3f, colIn: vec3f, mat: i32) -> vec3f {
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let q = (busU.inv * vec4f(p + n * 0.02, 1.0)).xyz;
    let ls = (busU.inv * vec4f(s, 0.0)).xyz;
    var sun = 0.0;
    if (s.y > 0.0 && sh.x * dot(n, s) > 0.002) { sun = throughGlass(q, ls); }
    let out = structureLight(p, sun > 0.0, false);                     // a canopy over the bus shades it too
    let low = smoothstep(${BUS.floor}, ${BUS.winHi}, q.y);
    let sky = F.ambient.rgb * sh.y * out.z * (0.10 + 0.22 * low) * (0.7 + 0.3 * abs(n.y));
    let lamp = vec3f(1.0, 0.93, 0.80) * 0.16 / max(F.sunCol.w, 0.2) * (0.35 + 0.65 * sat(-n.y * 0.5 + 0.5));
    let alb = colIn * (0.92 + 0.16 * vnoise2(vec2f(q.x + q.z, q.y) * 9.0));
    // the lights outside, through the windows, and a flashlight aboard (not the cabin's own glow: that is the lamps here)
    let lp = lampsAt(p + n * 0.02, n, v, 40.0, ${LIGHT_CABIN}u);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sun * out.x + sky + lamp + lp.d);
    if (mat == 4) {
        let r = reflect(-v, n);
        col += (skyColor(r) * sh.y * 0.25 + lamp * 0.5 + lp.s) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)) * 0.3;
    }
    return col;
}

@fragment fn fsBus(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    let mat = i32(m & 7u);
    if (mat == 7) { return vec4f(i.col.rgb * 1.6 / max(F.sunCol.w, 0.2), 0.0); }   // lamps, lights, the destination display
    if ((m & ${BUS_IN}u) != 0u) { return vec4f(shadeCabin(i.world, i.n, i.col.rgb, mat), 0.0); }
    return vec4f(shadeStruct(i.world, i.n, i.col.rgb, mat).rgb, 0.0);          // no splashes on a moving bus
}

// inside building id (WGSL_BUILDING): no weather; sky light that comes in through the windows (more near the outer walls
// than deep in the room), the sun where its ray leaves through a window of the same storey and nothing outside shades
// it, the ceiling lamps of the storey if they are on (the eye adapts to them, as in the bus), a little of a flash
fn shadeInterior(p: vec3f, nIn: vec3f, colIn: vec3f, mat: u32, id: u32) -> vec3f {
    let b = bld(id);
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }
    let q = bldLocal(b, p + n * 0.02);
    let lit = storeyLit(id, b, bldStorey(b, q.y));
    let lampC = vec3f(1.0, 0.9, 0.74) / max(F.sunCol.w, 0.2);
    let sh = shadowAt(p);
    if (mat == 7u) { return colIn * mix(F.ambient.rgb * sh.y * 0.08, lampC * 1.6, lit); }        // the lamps themselves
    let s = F.sunDir.xyz;
    var sun = 0.0;
    if (s.y > 0.0 && dot(n, s) > 0.0 && sh.x > 0.002) {
        let w = throughWindow(b, q, bldDir(b, s));
        if (w.w > 0.0) {
            let e = bldWorld(b, w.xyz) + s * 0.1;
            sun = shadowAt(e).x * structureLight(e, true, false).x;
        }
    }
    let dw = min(b.b.x - abs(q.x), b.b.y - abs(q.z));
    let near = 1.0 - smoothstep(0.3, 5.0, dw);
    // and what the sunlit floors and walls bounce around the room (where the sun comes in at all)
    let sky = F.ambient.rgb * sh.y * (0.12 + 0.3 * near) * (0.75 + 0.25 * abs(n.y)) + F.sunCol.rgb * max(s.y, 0.0) * sh.x * (0.015 + 0.03 * near);
    let lamp = lampC * 0.13 * lit * (0.35 + 0.65 * sat(n.y * 0.5 + 0.5));
    let alb = colIn * (0.96 + 0.08 * vnoise2(vec2f(q.x + q.z, q.y) * 3.0));
    // the lights: the shell keeps the street's out (lightSeen), a flashlight carried in lights the room
    let lp = lampsAt(p + n * 0.02, n, v, 40.0, ${LIGHT_CABIN}u);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sun + sky + lamp + FLASH_COLOR * flashLit(p) * 0.004 * near + lp.d);
    if (mat == 4u) {
        let r = reflect(-v, n);
        col += (skyColor(r) * sh.y * 0.1 + lamp * 0.5 + lp.s) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)) * 0.3;
    }
    return col;
}

// a building's interior (drawn within INTERIOR_DRAW of it): walls' inner faces, floors, stairs, furniture, lamps
@fragment fn fsInterior(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    return vec4f(shadeInterior(i.world, i.n, i.col.rgb, m & 7u, m / ${BLD_ID}u), 0.0);
}

// a door leaf, open or shut: lit as the interior on its inner side, by the weather on its outer one
@fragment fn fsDoor(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    let id = m / ${BLD_ID}u;
    let b = bld(id);
    var n = normalize(i.n);
    if (dot(n, F.cam.xyz - i.world) < 0.0) { n = -n; }
    let q = bldLocal(b, i.world + n * 0.03);
    if (abs(q.x) < b.b.x - b.d.y + 0.01 && abs(q.z) < b.b.y - b.d.y + 0.01) { return vec4f(shadeInterior(i.world, n, i.col.rgb, m & 7u, id), 0.0); }
    return vec4f(shadeStruct(i.world, n, i.col.rgb, i32(m & 7u)).rgb, 0.0);
}

// a window seen from beyond INTERIOR_DRAW (its interior and its glass are not drawn there): an opaque pane that reflects
// the sky, glowing where the storey's lamps are on
@fragment fn fsPane(i: StructOut) -> @location(0) vec4f {
    let id = u32(i.col.a + 0.5) / ${BLD_ID}u;
    let b = bld(id);
    if (distance(F.cam.xyz, bldCentre(b)) < ${INTERIOR_DRAW}.0) { discard; }
    return vec4f(shadeStruct(i.world, i.n, i.col.rgb, 5).rgb + windowGlow(id, b, i.world.y), 0.0);
}

// a structure surface lit by the sky and the sun, under the cloud shadow, wet or snowy where the weather reaches it; alpha
// the rain surface code (WGSL_TERRAIN)
fn shadeStruct(p: vec3f, nIn: vec3f, colIn: vec3f, mat: i32) -> vec4f {
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }                                  // thin panels are seen from both sides
    // weather on it: snow settles on what faces up, rain wets what it reaches (walls less than roofs and roads)
    let gs = groundAt(p.xz);
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let sl = structureLight(p + n * 0.06, sh.x * dot(n, s) > 0.002, gs.x + gs.y > 0.002 && mat != 6);
    let snow = sat(gs.x * 3.0) * smoothstep(0.55, 0.85, n.y) * sl.y * select(1.0, 0.0, mat == 6);
    let wet = gs.y * sl.y * (0.35 + 0.65 * sat(n.y)) * (1.0 - snow);
    let glass = mat == 2 || mat == 5;
    // puddles on flat asphalt (and fewer on paving); rain rings on them, on open water, faintly on the wet film
    let flat = smoothstep(0.97, 0.995, n.y);
    let rainNow = sat(F.near.x * 1.5) * sl.y * (1.0 - snow);
    let puddle = puddleAt(p.xz, wet) * flat * select(select(0.0, 0.5, mat == 0), 1.0, mat == 3);
    let pool = select(puddle, 1.0, mat == 6);
    var rg = vec2f(0.0);
    if (!glass && rainNow > 0.0) { rg = rainRipples(p.xz, pixelSize(p, n, v), rainNow) * max(pool, 0.25 * wet * flat); }
    let nr = normalize(n + vec3f(-rg.x, 0.0, -rg.y));
    var alb = colIn * (0.9 + 0.2 * vnoise2(vec2f(p.x + p.z, p.y) * 1.7 + n.xz * 13.0));
    if (!glass) { alb *= (1.0 - select(0.35, 0.55, mat == 3) * wet) * (1.0 - 0.4 * puddle); }
    alb = mix(alb, vec3f(0.85, 0.88, 0.92), snow);
    // sky light from above, and light the ground bounces up into eaves, roof and deck undersides
    let bounce = (F.ambient.rgb * sh.y * 0.25 + F.sunCol.rgb * max(s.y, 0.0) * sh.x * 0.06) * sat(-n.y);
    var gloss = select(select(select(0.0, 0.04, mat == 1), 0.12, mat == 4), 0.8, glass);
    gloss = max(gloss, wet * select(0.3, 0.5, mat == 3));
    gloss = mix(gloss, 1.0, puddle);
    // the lights, with a highlight as sharp as the surface is glossy (open water as a puddle)
    let lp = lampsAt(p + n * 0.06, nr, v, mix(12.0, 900.0, select(gloss * gloss, 1.0, mat == 6)), 0u);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sl.x + F.ambient.rgb * sh.y * sl.z * (0.55 + 0.45 * n.y) + bounce + FLASH_COLOR * flashLit(p) * 0.03 + lp.d);
    // glass, metal and wet surfaces reflect the sky
    let r = reflect(-v, nr);
    let fres = 0.04 + 0.96 * pow(1.0 - max(dot(nr, v), 0.0), 5.0);
    let spec = skyColor(r) * sh.y * sl.z + F.sunCol.rgb * sh.x * sl.x * pow(max(dot(r, s), 0.0), 300.0) * 4.0 + lp.s;
    col += spec * fres * gloss + skyColor(r) * sh.y * sl.z * length(rg) * 1.5;   // the rings catch the sky at any angle
    if (mat == 6) {                                                     // open water, as on the terrain
        let fw = 0.02 + 0.98 * pow(1.0 - max(dot(nr, v), 0.0), 5.0);
        col = vec3f(0.01, 0.02, 0.025) * F.ambient.rgb * sl.z + spec * fw;
    }
    let kind = select(select(2.0, 3.0, mat == 3), 4.0, mat == 6);
    return vec4f(col, select(0.0, kind + 0.45 * puddle, rainNow > 0.0 && n.y > 0.7 && !glass));
}

// Distant lights by night (World.buildFarLights, FAR_FLOATS per instance): each lamp a point sprite added into the scene
// before the volumetrics, so the haze, rain and cloud in front dim it and the bloom spreads it. It carries the lamp's
// light reaching the eye (intensity over distance squared) spread over at least a pixel or so, so it fades with
// distance instead of flickering; near, the real lamp (its diffuser, its light) takes over as the sprite outgrows that.
// Lighting nothing, it costs one small quad per lamp.
struct FarOut { @builtin(position) pos: vec4f, @location(0) col: vec3f, @location(1) uv: vec2f };

@vertex fn vsFar(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) e: vec4f) -> FarOut {
    var o: FarOut;
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);                                 // dropped (behind the far plane of reversed Z)
    let clip = F.viewProj * vec4f(a.xyz, 1.0);
    if (clip.w < 1.0) { return o; }
    let v = a.xyz - F.cam.xyz;
    let d = length(v);
    let pxPerM = F.screen.y * 0.5 / (length(F.up.xyz) * clip.w);
    let rPhys = a.w * pxPerM;                                           // the lamp's glowing part, radius in pixels
    // near, the lamp shows itself (its diffuser, lampGlow; a fake one's within POLE_DRAW, vsFarPole) as it grows past a pixel
    var k = 1.0 - smoothstep(1.0, 2.5, rPhys);
    if (b.w > 0.5 && d > ${POLE_DRAW}.0) { k = 1.0; }
    // a narrow beam (headlights) glares inside its cone; outside it only the lamp's housing shows
    if (c.w > 0.5) { k *= mix(0.08, 1.0, smoothstep(c.w, 1.0, dot(-v / d, c.xyz))); }
    if (k <= 0.0) { return o; }
    // half-size R px, profile exp(-4 u^2) (u = 0 .. 1 over R), which sums to ~0.77 R^2 pixels
    let R = 2.0 * max(rPhys, 0.8);
    let pixSA = pow(2.0 * length(F.up.xyz) / F.screen.y, 2.0);         // solid angle of a pixel
    let L = b.rgb * k / (max(F.sunCol.w, 0.2) * d * d * 0.77 * R * R * pixSA);
    o.col = min(L, vec3f(60.0));
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    o.uv = corners[vi];
    o.pos = clip + vec4f(o.uv * R * 2.0 / F.screen.xy * clip.w, 0.0, 0.0);
    return o;
}

@fragment fn fsFar(i: FarOut) -> @location(0) vec4f {
    return vec4f(i.col * exp(-4.0 * dot(i.uv, i.uv)), 0.0);
}

// A real lamp's pool of light on the ground beyond the lights LightWriter.write takes (lampsAt): a decal over its reach,
// lit as lightAt lights the ground (window, softening, cone) on ground of POOL_ALBEDO, giving way by as much as its real
// light has come in (farLampReal: the same fade toward F.lightInfo.z), so the pool neither pops in nor doubles
struct PoolOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) col: vec3f, @location(2) @interpolate(flat) lamp: vec4f,
                 @location(3) @interpolate(flat) axis: vec4f, @location(4) @interpolate(flat) cone: vec2f };

@vertex fn vsFarPool(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) e: vec4f) -> PoolOut {
    var o: PoolOut;
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    let fade = smoothstep(F.lightInfo.z * 0.7, F.lightInfo.z, max(distance(a.xyz, F.cam.xyz) - e.y, 0.0));
    if (F.lightInfo.y < 0.5 || fade <= 0.0 || a.y - e.z > e.y) { return o; }
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    o.world = vec3f(a.x + corners[vi].x * e.y, e.z + 0.2, a.z + corners[vi].y * e.y);
    // drawn a little toward the eye (0.5% of the way), so roads lifted over the terrain and its bumps do not hide it
    o.pos = F.viewProj * vec4f(mix(o.world, F.cam.xyz, 0.005), 1.0);
    o.col = b.rgb * fade * vec3f(${POOL_ALBEDO}) / max(F.sunCol.w, 0.2);
    o.lamp = vec4f(a.xyz, e.y);
    o.axis = vec4f(c.xyz, c.w);
    o.cone = vec2f(e.x, a.w * a.w);
    return o;
}

@fragment fn fsFarPool(i: PoolOut) -> @location(0) vec4f {
    let d = i.lamp.xyz - i.world;
    let d2 = dot(d, d);
    let r2 = i.lamp.w * i.lamp.w;
    if (d2 >= r2) { discard; }
    let l = d * inverseSqrt(d2);
    let x = d2 / r2;
    let win = sat(1.0 - x * x);
    var k = win * win / (d2 + i.cone.y) * max(l.y, 0.0);
    if (i.axis.w > -1.5) { let cc = smoothstep(i.axis.w, i.cone.x, dot(-l, i.axis.xyz)); k *= cc * cc; }
    return vec4f(i.col * k, 0.0);
}

// a fake street lamp near the camera (World.nearPoles): the street lamp mesh (Renderer.poleMesh, as Fixtures.lamp builds
// one) per instance, at its pole's foot [x, ground, z, yaw], its diffuser (material 7) in the lamp's colour; shaded by fsStruct
@vertex fn vsFarPole(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) at: vec4f, @location(4) glow: vec4f) -> StructOut {
    let cs = cos(at.w);
    let sn = sin(at.w);
    var o: StructOut;
    o.world = vec3f(at.x + p.x * cs - p.z * sn, at.y + p.y, at.z + p.x * sn + p.z * cs);
    o.n = vec3f(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs);
    o.col = select(c, vec4f(glow.rgb, c.a), i32(c.a + 0.5) == 7);
    o.pos = F.viewProj * vec4f(o.world, 1.0);
    return o;
}
`;

return { WGSL_TERRAIN, WGSL_SCENE };
});
