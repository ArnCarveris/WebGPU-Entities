'use strict';
// WGSL: the scene: sky and terrain (the structures and the buses are their features', in their WGSL).

Features.kit('atmosphere', (engine, kit) => {
const { LIGHT_CABIN, LIGHT_ROOM, POOL_ALBEDO, FAR_LAMP_PITCH, TOWN_BLOCK, FAR_LAMP_SIDE, FAR_LAMP_H } = kit;
const { TERRAIN_PATCH, DETAIL_OCTAVES, TERRAIN_EASE, BEACH, SHORE_BLEND } = engine.kits.terrain;

// needs F, heightTex, clampSamp: the terrain's height and normal at xz (beyond the heightfield it flattens to the base).
// heightTex: the height as two half floats (r + g), the normal's x and z
const WGSL_TERRAIN = /* wgsl */`
fn terrainHeight(xz: vec2f) -> vec4f {
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    let s = textureSampleLevel(heightTex, clampSamp, uv, 0.0);
    let out = max(max(abs(uv.x - 0.5), abs(uv.y - 0.5)) - 0.5, 0.0) * F.tdomain.z;
    let k = exp(-out / 4000.0);
    let n = vec3f(s.z, sqrt(max(1.0 - s.z * s.z - s.w * s.w, 0.0)), s.w);
    return vec4f(mix(F.misc.z, s.x + s.y, k), normalize(mix(vec3f(0.0, 1.0, 0.0), n, k * k * k)));
}

// The terrain as drawn (LandField.surface, term for term): the heights interpolated bicubically (Catmull-Rom, through
// the data), plus where it is rough (F.tdetail.x) octaves of value noise (DETAIL_OCTAVES), kept off roads and
// buildings (smoothTex), the shore and open water, stronger on steep ground. sp: the spacing (m) the result is sampled
// at (vertices, a pixel's footprint): octaves shorter than 4 sp are left out, so nothing aliases. x height, yz gradient
fn detailHash(ix: i32, iz: i32, s: u32) -> f32 {
    var h = (bitcast<u32>(ix) * 0x8da6b343u) ^ (bitcast<u32>(iz) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    h = h ^ (h >> 16u);
    return f32(h) * (2.0 / 4294967296.0) - 1.0;
}

// value noise at p (lattice units): value, d/dx, d/dz
fn detailNoise(p: vec2f, s: u32) -> vec3f {
    let i = floor(p);
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f - 1.0) * (f - 1.0);
    let ix = i32(i.x);
    let iz = i32(i.y);
    let a = detailHash(ix, iz, s);
    let b = detailHash(ix + 1, iz, s);
    let c = detailHash(ix, iz + 1, s);
    let d = detailHash(ix + 1, iz + 1, s);
    let k = a - b - c + d;
    return vec3f(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du.x * (b - a + k * u.y), du.y * (c - a + k * u.x));
}

fn cubicW(t: f32) -> vec4f {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4f(-t3 + 2.0 * t2 - t, 3.0 * t3 - 5.0 * t2 + 2.0, -3.0 * t3 + 4.0 * t2 + t, t3 - t2) * 0.5;
}
fn cubicD(t: f32) -> vec4f {
    let t2 = t * t;
    return vec4f(-3.0 * t2 + 4.0 * t - 1.0, 9.0 * t2 - 10.0 * t, -9.0 * t2 + 8.0 * t + 1.0, 3.0 * t2 - 2.0 * t) * 0.5;
}

// the bicubic heights at xz: height, gradient (beyond the map easing back to the base)
fn terrainCubic(xz: vec2f) -> vec3f {
    let n = i32(F.tdomain.w);
    let cell = F.tdomain.z / F.tdomain.w;
    let g = clamp((xz - F.tdomain.xy) / cell - 0.5, vec2f(0.0), vec2f(f32(n - 1)));
    let i = vec2i(floor(g));
    let t = g - floor(g);
    let wx = cubicW(t.x);
    let wz = cubicW(t.y);
    let dx = cubicD(t.x);
    let dz = cubicD(t.y);
    var v = 0.0;
    var gx = 0.0;
    var gz = 0.0;
    for (var b = 0; b < 4; b++) {
        let row = clamp(i.y + b - 1, 0, n - 1);
        var hs = vec4f(0.0);
        for (var a = 0; a < 4; a++) {
            let s = textureLoad(heightTex, vec2i(clamp(i.x + a - 1, 0, n - 1), row), 0);
            hs[a] = s.x + s.y;
        }
        let r = dot(wx, hs);
        v += wz[b] * r;
        gx += wz[b] * dot(dx, hs);
        gz += dz[b] * r;
    }
    let out = max(max(abs(xz.x - F.tdomain.x - F.tdomain.z * 0.5), abs(xz.y - F.tdomain.y - F.tdomain.z * 0.5)) - F.tdomain.z * 0.5, 0.0);
    let k = exp(-out / ${TERRAIN_EASE}.0);
    return vec3f(mix(F.misc.z, v, k), vec2f(gx, gz) / cell * k);
}

// the smooth heights for spacing sp: bicubic where the samples are a data cell or less apart, the filtered texture
// (bilinear, its normals) two cells apart or more (coarser samples gain nothing from bicubic), blended between
fn terrainSmooth(xz: vec2f, sp: f32) -> vec3f {
    let t = sat(sp / (F.tdomain.z / F.tdomain.w) - 1.0);
    var lin = vec3f(0.0);
    if (t > 0.0) {
        let b = terrainHeight(xz);
        lin = vec3f(b.x, -b.yw / max(b.z, 0.05));
        if (t >= 1.0) { return lin; }
    }
    return mix(terrainCubic(xz), lin, t);
}

// the coast's signed distance (m, + on land) at xz and its gradient: smoothTex's g read texel by texel, bilinear
// (LandField.coastAt); F.tdetail.y its band (0: no coastline, far inland everywhere)
fn coastAt(xz: vec2f) -> vec3f {
    let B = F.tdetail.y;
    if (B <= 0.0) { return vec3f(1e9, 0.0, 0.0); }
    let M = i32(textureDimensions(smoothTex).x);
    let cell = F.tdomain.z / f32(M);
    let g = clamp((xz - F.tdomain.xy) / cell - 0.5, vec2f(0.0), vec2f(f32(M - 1)));
    let i = min(vec2i(floor(g)), vec2i(M - 2));
    let t = g - vec2f(i);
    let a = (textureLoad(smoothTex, i, 0).y * 2.0 - 1.0) * B;
    let b = (textureLoad(smoothTex, i + vec2i(1, 0), 0).y * 2.0 - 1.0) * B;
    let c = (textureLoad(smoothTex, i + vec2i(0, 1), 0).y * 2.0 - 1.0) * B;
    let d = (textureLoad(smoothTex, i + vec2i(1, 1), 0).y * 2.0 - 1.0) * B;
    return vec3f(mix(mix(a, b, t.x), mix(c, d, t.x), t.y), mix(b - a, d - c, t.y) / cell, mix(c - a, d - b, t.x) / cell);
}

// the ground near the coast (LandField.shore, term for term): the sea's level on the sea side; on land a beach rising
// ${BEACH} m per m from it, giving way to the heights c (kept over the beach line) within ${SHORE_BLEND} m
fn terrainShore(xz: vec2f, c: vec3f) -> vec3f {
    if (F.tdetail.y <= 0.0) { return c; }
    // (most of the ground is far inland or out at sea: one filtered read tells, before the four texels)
    let g = textureSampleLevel(smoothTex, clampSamp, (xz - F.tdomain.xy) / F.tdomain.z, 0.0).y;
    if (g > 0.995) { return c; }
    if (g < 0.49) { return vec3f(F.misc.z, 0.0, 0.0); }
    let cd = coastAt(xz);
    let d = cd.x;
    let s = F.misc.z;
    if (d >= F.tdetail.y * 0.99) { return c; }
    if (d <= 0.0) { return vec3f(s, 0.0, 0.0); }
    var h = c;
    let fl = s + min(${BEACH} * d, 0.6);
    if (h.x < fl) { h = vec3f(fl, select(0.0, ${BEACH}, ${BEACH} * d < 0.6) * cd.yz); }
    let t = min(d / ${SHORE_BLEND}.0, 1.0);
    let k = t * t * (3.0 - 2.0 * t);
    let dk = 6.0 * t * (1.0 - t) / ${SHORE_BLEND}.0;
    let e = h.x - s - ${BEACH} * d;
    return vec3f(s + ${BEACH} * d + k * e, mix(${BEACH} * cd.yz, h.yz, k) + dk * e * cd.yz);
}

fn terrainSurface(xz: vec2f, sp: f32) -> vec3f {
    let c = terrainShore(xz, terrainSmooth(xz, sp));
    if (F.tdetail.x <= 0.0) { return c; }
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    let water = sat(textureSampleLevel(landTex, clampSamp, uv, 0.0).z);
    let m = (1.0 - textureSampleLevel(smoothTex, clampSamp, uv, 0.0).x) * sat((c.x - 1.0) / 3.0) * (1.0 - water);
    if (m <= 0.0) { return c; }
    var d = vec3f(0.0);
${DETAIL_OCTAVES.map(([l, a], k) => `    let w${k} = sat(${l} / (2.0 * sp) - 1.0);
    if (w${k} > 0.0) { d += w${k} * ${a} * detailNoise(xz / ${l}, ${k + 1}u) * vec3f(1.0, vec2f(1.0 / ${l})); }`).join('\n')}
    let amp = F.tdetail.x * m * (0.25 + min(length(c.yz), 2.0));
    return c + d * amp;
}

// the height of the terrain as drawn near the eye (its finest lod, 1 m apart by default)
fn meshHeight(xz: vec2f) -> f32 { return terrainSurface(xz, 1.0).x; }

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

fn skyAt(ndc: vec2f) -> vec4f {
    let d = rayDir(ndc);
    var c = skyColor(d);
    let mu = dot(d, F.sunDir.xyz);
    if (F.sunDir.w > 0.0) { c += moonDisc(d, mu) + moonGlow(mu) + stars(d); }
    else { c += F.sunCol.rgb * 30.0 * smoothstep(0.99990, 0.99996, mu); }
    return vec4f(c, 0.0);
}

@fragment fn fsSky(i: SkyOut) -> @location(0) vec4f { return skyAt(i.ndc); }

// how far along dir the view ray leaves its air (F.shell; stably: no difference of two planet-sized numbers)
fn airOut(dir: vec3f) -> f32 {
    if (F.shell.x > 0.5) {
        let b = F.shell.y * dir.y;
        let s = sqrt(max(b * b + F.shell.z, 0.0));
        return select(-b + s, F.shell.z / (b + s), b > 0.0);
    }
    return select(3.0e38, F.shell.w / dir.y, dir.y > 0.0);
}

// The sky in a frame it shares with space (drawn first: stars, bodies, the planet it stands on): where its daytime sky
// hides what lies beyond its air (F.shellInfo.x), at the depth where the air ends, so what is nearer (the planet's
// ground round its map) stays and what is beyond goes; else only where nothing is drawn (depth 0: the stars it has
// itself)
struct SkyOver { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
@fragment fn fsSkyOver(i: SkyOut) -> SkyOver {
    var o: SkyOver;
    o.c = skyAt(i.ndc);
    o.d = 0.0;
    if (F.shellInfo.x > 0.5) {
        let d = rayDir(i.ndc);
        o.d = clamp(F.fwd.w / max(airOut(d) * dot(d, normalize(F.fwd.xyz)), F.fwd.w), 0.0, 1.0);
    }
    return o;
}

// the moon by night (at F.sunDir): a disc lit from one side by its phase (F.sunDir.w its lit fraction), with darker
// maria, and a little earthshine on its dark side; none where the moon is a body in space, drawn there (F.shellInfo.z)
fn moonDisc(d: vec3f, mu: f32) -> vec3f {
    if (mu < 0.9998 || F.shellInfo.z > 0.5) { return vec3f(0.0); }
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

// the glow round the moon by night where it is a body in space (F.shellInfo.z; drawn there, its own disc's brightness
// the eye's): a bright aureole hugging the disc and a wide faint one, the sky a little lighter round it; weaker as it
// wanes (its brightness falls off faster than its lit fraction)
fn moonGlow(mu: f32) -> vec3f {
    if (F.shellInfo.z < 0.5) { return vec3f(0.0); }
    let a = sqrt(max(2.0 * (1.0 - mu), 0.0));                  // the angle from it (radians)
    let k = F.sunDir.w * F.sunDir.w;
    return F.sunCol.rgb * k * (0.08 * exp(-a / 0.012) + 0.03 * exp(-a / 0.06) + 0.02 * exp(-a / 0.25));
}

// the stars: one in some of the cells of a grid of directions, few bright and many faint, twinkling a little; they sink
// into the haze at the horizon and fade under a bright moon. Clouds cover them as they cover the sky
fn stars(d: vec3f) -> vec3f {
    let up = curveSkyward(d);                                   // (over the horizon as drawn)
    if (up <= 0.0) { return vec3f(0.0); }
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
    return tint * b * exp(-x * x) * min(1.0, 0.12 / rad) * smoothstep(0.0, 0.12, up) * (1.0 - 0.6 * F.sunDir.w) * 1.5 / F.sunCol.w;
}

// The terrain: a CDLOD node per instance (TerrainLod: x0, z0, size, lod), each the same patch of ${TERRAIN_PATCH}^2 cells.
// Over the last 25% of its lod's range (F.geo.z * 2^lod) a vertex slides onto the next lod's grid (the odd rows and
// columns onto the even ones), by its distance from the eye, so neighbouring lods meet without cracks or popping. The
// surface's gradient (terrainSurface) goes with each vertex, for the normal: no surface evaluated per pixel. The far
// forest's canopy is drawn over it on the same patches (vsCanopy: the canopy carpet)
struct TerrOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) grad: vec2f };

// vertex vi of a node's patch: where it stands (x, z) and the surface there (height, gradient)
struct TerrVert { xz: vec2f, s: vec3f };
fn terrainVertex(vi: u32, node: vec4f) -> TerrVert {
    let P = ${TERRAIN_PATCH}.0;
    let g = vec2f(f32(vi % ${TERRAIN_PATCH + 1}u), f32(vi / ${TERRAIN_PATCH + 1}u));
    let xz0 = node.xy + g / P * node.z;
    let r = F.geo.z * exp2(node.w);
    let k = sat((distance(F.cam.xyz, vec3f(xz0.x, terrainHeight(xz0).x, xz0.y)) - 0.75 * r) / (0.2 * r));
    let xz = node.xy + (g - fract(g * 0.5) * 2.0 * k) / P * node.z;
    return TerrVert(xz, terrainSurface(xz, node.z / P * (1.0 + k)));
}

@vertex fn vsTerrain(@builtin(vertex_index) vi: u32, @location(0) node: vec4f) -> TerrOut {
    let t = terrainVertex(vi, node);
    var o: TerrOut;
    o.world = vec3f(t.xz.x, t.s.x, t.xz.y);
    o.grad = t.s.yz;
    o.pos = F.viewProj * vec4f(curveToRender(o.world), 1.0);
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

// the slope (dh/dx, dh/dz) of a wind-blown sea at xz: three wave trains (value noise stretched across the wind) and a
// fine chop, fading where a pixel (px, m) is too big for them
fn seaSlope(xz: vec2f, px: f32) -> vec2f {
    let w = normalize(F.wind.xy + vec2f(1e-3, 0.0));
    let q = vec2f(dot(xz, w), dot(xz, vec2f(-w.y, w.x)));
    let t = F.cam.w;
    var g = vec2f(0.0);
    let e = 0.5;
    for (var k = 0; k < 3; k++) {
        let s = vec2f(60.0, 140.0) / pow(2.6, f32(k));
        let a = (q + vec2f(t * 3.0 / (1.0 + f32(k)), 0.0)) / s;
        let gx = (vnoise2(a + vec2f(e, 0.0)) - vnoise2(a - vec2f(e, 0.0))) / (2.0 * e * s.x);
        let gy = (vnoise2(a + vec2f(0.0, e)) - vnoise2(a - vec2f(0.0, e))) / (2.0 * e * s.y);
        g += vec2f(gx, gy) * s.x * 0.12 * (1.0 - smoothstep(s.x * 0.05, s.x * 0.4, px));
    }
    return (w * g.x + vec2f(-w.y, w.x) * g.y);
}

// a real place's open ground (F.geo.x): grass and scrub, greener up the slopes and in the wetter patches, drier and
// browner low down, with bare earth here and there; no farm sections (its land cover says where the woods are)
fn naturalColor(xz: vec2f, px: f32, y: f32) -> vec3f {
    let detail = sat(40.0 / max(px, 1.0));
    let moist = sat(vnoise2(xz / 3000.0) * 0.9 + vnoise2(xz / 800.0) * 0.3 + smoothstep(80.0, 450.0, y - F.misc.z) * 0.6 - 0.75 + F.geo.w);
    var c = mix(vec3f(0.30, 0.26, 0.15), vec3f(0.12, 0.20, 0.07), moist);
    c = mix(c, vec3f(0.33, 0.25, 0.17), smoothstep(0.72, 0.9, vnoise2(xz / 260.0 + 17.0)) * (1.0 - moist) * 0.7);
    return c * (0.85 + 0.3 * mix(0.5, vnoise2(xz / 35.0), detail) + 0.1 * (vnoise2(xz / 1500.0) - 0.5));
}

// a real place's built-up ground (F.geo.x): yards and lawns between pavement, no street grid (its roads are its own)
fn urbanColor(xz: vec2f, px: f32) -> vec3f {
    let detail = sat(20.0 / max(px, 1.0));
    let lawn = smoothstep(0.45, 0.65, mix(0.5, vnoise2(xz / 28.0), detail) * 0.7 + vnoise2(xz / 220.0) * 0.3);
    let paved = mix(vec3f(0.30, 0.29, 0.28), vec3f(0.42, 0.40, 0.37), vnoise2(xz / 60.0));
    return mix(paved, vec3f(0.15, 0.22, 0.09), lawn * 0.6) * (0.9 + 0.2 * mix(0.5, vnoise2(xz / 9.0), detail));
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

// The fake street lamps (FarLights): on townColor's street grid, one every ${FAR_LAMP_PITCH} m, 7 m up, kept by
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

// The ground's fine grain near the eye (detail mapping, procedural): octaves of value noise from 7 m down to a
// quarter metre, each faded out as a pixel (px, m) grows past a quarter of its wavelength, so far ground stays as it was
// and nothing shimmers. x albedo factor (about 1), yz a tilt for the normal (dh/dx, dh/dz)
fn groundGrain(xz: vec2f, px: f32, rough: f32) -> vec3f {
    var g = vec3f(0.0);
    let o = array<vec3f, 4>(vec3f(7.3, 0.11, 0.04), vec3f(2.3, 0.10, 0.05), vec3f(0.75, 0.08, 0.04), vec3f(0.24, 0.06, 0.03));
    for (var k = 0; k < 4; k++) {
        let w = sat(o[k].x / (4.0 * px) - 1.0);
        if (w <= 0.0) { break; }
        let nz = detailNoise(xz / o[k].x, u32(k) + 11u);
        g += w * vec3f(nz.x * o[k].y, nz.yz * o[k].z * mix(1.0, 3.0, rough));
    }
    return vec3f(1.0 + g.x, g.yz);
}

// noise for the ground near the eye, one fetch: a slice of the clouds' shape volume (Worley octaves) tiled every 300 m:
// y and z (features of some 75 and 37 m) move where the colour maps are read, w (some 19 m) the shoreline
fn groundNoise(xz: vec2f) -> vec4f { return textureSampleLevel(shapeTex, repSamp, vec3f(xz / 300.0, 0.31), 0.0) - 0.5; }


@fragment fn fsTerrain(i: TerrOut) -> @location(0) vec4f {
    let p = i.world;
    let px = max(length(fwidth(p.xz)), 0.05);
    let uv = (p.xz - F.tdomain.xy) / F.tdomain.z;
    let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0));
    // (beyond the map: the plain, the sea round a real island (F.geo.y 1), or no ground at all (-1): what lies behind
    // it shows: the planet it stands on, drawn before it in a frame it shares)
    if (!inside && F.geo.y < 0.0) { discard; }
    // ... and over the map's last F.outside.w m (terrain.edge) the map is dithered into it: toward the edge a growing
    // share of its pixels left out, at the edge all of them. Where the fade starts wanders by a third of its width
    var fade = 0.0;
    if (F.outside.w > 0.0) {
        let e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * F.tdomain.z;
        fade = 1.0 - smoothstep(0.0, F.outside.w, e + F.outside.w * (0.67 * vnoise2(p.xz / 5300.0) + 0.33 * vnoise2(p.xz / 1700.0) - 0.5) * 0.66);
        if (ign(i.pos.xy) < smoothstep(0.35, 1.0, fade)) { discard; }
    }
    let n = normalize(vec3f(-i.grad.x, 1.0, -i.grad.y));
    let land4 = select(vec4f(0.0, 0.0, max(F.geo.y, 0.0), 0.0), textureSampleLevel(landTex, clampSamp, uv, 0.0), inside);
    let natural = F.geo.x > 0.5;
    // a real place's coastline (geoCoast): the distance to it per pixel (m, + on land), wandering a little finer than
    // its 18 m grid; the sea is what lies off it (the land use's water only inland, its cells being coarser)
    let near = natural && inside && px < 12.0;
    let gn = select(vec4f(0.0), groundNoise(p.xz), near);
    let coast = F.tdetail.y > 0.0 && inside;
    var cd = 1e9;
    if (coast) { cd = (textureSampleLevel(smoothTex, clampSamp, uv, 0.0).y * 2.0 - 1.0) * F.tdetail.y + gn.w * 9.0; }
    let aa = max(px * 0.6, 0.3);
    let sea = 1.0 - smoothstep(-aa, aa, cd);
    var land = land4.xyz;
    if (coast) { land.z = max(sea, land.z * smoothstep(20.0, 50.0, cd)); }
    // (the colour maps read through a little noise, about a data cell, where a pixel is small enough to see their cells:
    // the edges of the town and the woods wander instead of following the bilinear diamonds)
    var warp = vec2f(0.0);
    if (near) {
        warp = gn.yz * (F.tdomain.z / F.tdomain.w) * 2.6 * (1.0 - smoothstep(6.0, 12.0, px));
        land = vec3f(textureSampleLevel(landTex, clampSamp, (p.xz + warp - F.tdomain.xy) / F.tdomain.z, 0.0).xy, land.z);
    }
    var alb = select(fieldColor(p.xz, px), naturalColor(p.xz, px, p.y), natural);
    alb = mix(alb, select(townColor(p.xz, px), urbanColor(p.xz, px), natural), sat(land.x * (0.6 + 0.8 * vnoise2(p.xz / 700.0)) * 1.4 - 0.2));
    // a natural shore: sand just over the water's edge (a beach of wandering width along the coastline, darker where the
    // surf wets it, dark lava rock where the shore is steep; without a coastline, by height)
    // (all of it within 50 m of the coast: the rest of the ground skips it)
    var sand = 0.0;
    var shoreRock = 0.0;
    var wetSand = 1.0;
    if (natural) {
        if (!coast) {
            sand = (1.0 - smoothstep(1.5, 4.0, p.y - F.misc.z)) * (1.0 - land.x) * smoothstep(0.82, 0.95, n.y);
        } else if (cd < 50.0) {
            let wide = 14.0 + 34.0 * vnoise2(p.xz / 420.0);
            sand = (1.0 - smoothstep(wide * 0.55, wide, cd)) * smoothstep(0.78, 0.92, n.y) * (1.0 - smoothstep(0.5, 0.9, land.x));
            shoreRock = (1.0 - smoothstep(12.0, 45.0, cd)) * smoothstep(0.86, 0.66, n.y);
            if (cd < 9.0) { wetSand = mix(0.62, 1.0, smoothstep(0.5, 5.0 + 3.0 * vnoise2(p.xz / 40.0), cd)); }
        }
    }
    if (sand > 0.0) { alb = mix(alb, vec3f(0.62, 0.56, 0.44) * (0.9 + 0.2 * vnoise2(p.xz / 7.0)) * wetSand, sand); }
    if (shoreRock > 0.0) { alb = mix(alb, vec3f(0.19, 0.175, 0.16) * (0.8 + 0.4 * vnoise2(p.xz / 9.0)), shoreRock * 0.85); }
    // the forest floor: where crowns are a few pixels or more (plants, carpet), only under a canopy closed enough to
    // shade it; where they are smaller than a pixel, the canopy's whole cover (the crowns' colour, seen together)
    // (a canopy map: smoothed, and moved by half as much as the land use, its cells being half the size)
    var fc = forestCover(p.xz + warp * 0.5, land.y);
    if (F.tdetail.w > 1.5 && px < 2.5) { fc = sat(canopySmooth(p.xz + warp * 0.5) * 1.15); }
    let forest = mix(sat((fc - 0.35) * 1.6), fc, smoothstep(0.8, 3.0, px)) * (1.0 - 0.85 * sand);
    alb = mix(alb, vec3f(0.07, 0.11, 0.06) * (0.8 + 0.4 * vnoise2(p.xz / 40.0)), forest);
    // mountains: conifers, then rock above the tree line and on steep slopes
    let wild = smoothstep(150.0, 700.0, p.y - F.misc.z);
    let rock = sat(smoothstep(3300.0, 3700.0, p.y + 200.0 * vnoise2(p.xz / 500.0)) + smoothstep(0.82, 0.62, n.y));
    let mtn = mix(vec3f(0.09, 0.12, 0.07), vec3f(0.33, 0.31, 0.29), rock);
    alb = mix(alb, mtn, wild);
    // the fine grain near the eye (rougher on rock), on land
    var n2 = n;
    if (px < 1.8 && sea < 1.0) {
        let gr = groundGrain(p.xz, px, max(max(rock * wild, shoreRock), 1.0 - n.y));
        alb *= gr.x;
        n2 = normalize(vec3f(-i.grad.x - gr.y, 1.0, -i.grad.y - gr.z));
    }
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
    var rg = rainRipples(p.xz, px, rainNow) * max(pool, 0.25 * wet * paved);
    // a real place's sea (F.geo.x): swell and chop, drifting with the wind, smoothing out with distance
    if (natural && water > 0.5) { rg += seaSlope(p.xz, px) * water; }
    let nw = normalize(vec3f(-rg.x, 1.0, -rg.y));
    alb *= 1.0 - 0.4 * puddle;

    let v = normalize(F.cam.xyz - p);
    // the lights: a sharp highlight on puddles and water, a broad one on the wet film (the long streaks of a wet road)
    var lp = lampsAt(p + n * 0.05, nw, v, mix(60.0, 900.0, pool), 0u);
    let sg = streetGlow(p + n * 0.05, nw, v, mix(60.0, 900.0, pool), px, land4.w);
    lp.d += sg.d;
    lp.s += sg.s;
    var col = alb * (F.sunCol.rgb * max(dot(n2, s), 0.0) * sh.x * sl.x + F.ambient.rgb * sh.y * sl.z * (0.55 + 0.45 * n2.y) + FLASH_COLOR * flashLit(p) * 0.03 + lp.d);
    // wet ground and open water reflect the sky
    let r = reflect(-v, nw);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(nw, v), 0.0), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 400.0) * 4.0 + lp.s;
    // (a real place's sea is tropical blue-green, paler over the shallows by the shore)
    // (along a coastline: over the 60..120 m off it, wandering)
    var shallow = smoothstep(0.995, 0.6, water);
    if (coast && pool > 0.0) { shallow = 1.0 - smoothstep(0.0, 60.0 + 60.0 * vnoise2(p.xz / 350.0), -cd); }
    let body = select(vec3f(0.01, 0.02, 0.025), mix(vec3f(0.012, 0.045, 0.06), vec3f(0.03, 0.11, 0.10), shallow), natural);
    col = mix(col, body * F.ambient.rgb + spec * fres, pool);
    // the surf along a coastline: a wash of foam at the water's edge and broken lines of it rolling in over the first
    // metres, which melt into a pale band where a pixel is too big for them
    if (coast && natural && cd < 0.0 && cd > -40.0) {
        let off = -cd;
        let edge = (1.0 - smoothstep(0.0, 1.0 + 2.0 * vnoise2(p.xz / 11.0 + F.cam.w * 0.05), off)) * (0.55 + 0.45 * vnoise2(p.xz / 2.5));
        let roll = sat(sin(off * 0.45 - F.cam.w * 0.9 + vnoise2(p.xz / 45.0) * 9.0) * 0.5 + 0.5);
        let lines = smoothstep(0.82, 1.0, roll) * smoothstep(0.3, 0.8, vnoise2(p.xz / 9.0 + vec2f(F.cam.w * 0.3, 0.0))) * vnoise2(p.xz / 1.7) * (1.0 - smoothstep(4.0, 18.0 + 10.0 * vnoise2(p.xz / 300.0), off));
        let foam = mix(sat(max(edge, lines)), (1.0 - smoothstep(0.0, 10.0, off)) * 0.25, smoothstep(0.3, 2.0, px)) * sea;
        let lit = F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sl.x + F.ambient.rgb * sh.y * sl.z;
        col = mix(col, vec3f(0.85, 0.88, 0.88) * lit, foam * 0.7);
    }
    col += spec * fres * wet * 0.35 * (1.0 - pool);
    col += skyColor(r) * sh.y * length(rg) * 1.5;                         // the rings catch the sky at any angle
    let kind = select(select(select(1.0, 2.0, rock * wild > 0.5), 3.0, paved > 0.5), 4.0, water > 0.5);
    return vec4f(col, select(0.0, kind + 0.45 * puddle, rainNow > 0.0 && n.y > 0.7));
}
`;

// the ground's colour from afar (linear albedo), as fsTerrain draws it where a pixel spans many fields: fieldColor's
// average crop colour, or a real place's naturalColor at its moisture (terrain: the world's terrain entity). What shows
// of it from further still: the planet it stands on, as another site (its footprint's albedo)
const groundAlbedo = t => {
    if (t.style !== 'natural') return [0.30, 0.25, 0.17];
    const m = Math.min(Math.max((t.moisture ?? 0.5) - 0.15, 0), 1);
    return [0.30 + (0.12 - 0.30) * m, 0.26 + (0.20 - 0.26) * m, 0.15 + (0.07 - 0.15) * m];
};

return { WGSL_TERRAIN, WGSL_SCENE, groundAlbedo };
});
