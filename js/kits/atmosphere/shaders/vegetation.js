'use strict';
// WGSL: the vegetation. A compute pass scatters plants each frame on a fixed lattice about the eye (vegScatter), from the
// land-use map, the canopy map and the terrain; the scene pass draws them (vsVeg / fsVeg near, imposters out to VEG_FAR),
// and beyond them the canopy carpet (vsCanopy / fsCanopy): the same lattice's crowns ray-marched in a thin layer over
// the terrain, so the far forest is the same trees, handed over by a complementary dither.

Features.kit('atmosphere', (engine, kit) => {
const { TERRAIN_PATCH } = engine.kits.terrain;

const VEG_CELL = 6;                 // m: the lattice; at most one plant a cell
const VEG_NEAR = 250;               // m: full meshes within this, low-poly beyond
const VEG_FADE = 1150;              // m: from here to VEG_FAR the plants dither out and the canopy rises in their place
const VEG_FAR = 1500;
const VEG_N = 2 * Math.ceil(VEG_FAR / VEG_CELL);        // lattice cells a side of the window about the eye
const VEG_SPECIES = 4;              // 0 broadleaf, 1 dry umbrella tree (kiawe), 2 coconut palm, 3 shrub
const VEG_CAP = [8192, 49152];      // instances per species, near and far
const VEG_SLOT = VEG_CAP[0] + VEG_CAP[1];
const CANOPY = 11;                  // m: a forest's canopy height without a canopy map (the land use's woods)
const CARPET_STEPS = 40;            // the carpet's march: steps along a ray, before it takes the canopy as closed

// the forest cover the ground is shaded with (fsTerrain), the plants scattered by and the canopy raised over (0..1): the
// canopy map's where there is one (F.tdetail.w 2: geoCanopy), else the land use's woods, broken up a little
const WGSL_FOREST = /* wgsl */`
// the canopy map at xz: cover (0..1), mean height (m)
fn canopyAt(xz: vec2f) -> vec2f {
    let c = textureSampleLevel(canopyTex, clampSamp, (xz - F.tdomain.xy) / F.tdomain.z, 0.0).xy;
    return vec2f(c.x, c.y * 255.0);
}

// the canopy map's cover at xz as the ground is shaded by it: a cubic B-spline over its texels (four bilinear taps), so
// the 18 m cells round off into blobs instead of bilinear squares and diamonds
fn canopySmooth(xz: vec2f) -> f32 {
    let sz = vec2f(textureDimensions(canopyTex));
    let c = (xz - F.tdomain.xy) / F.tdomain.z * sz - 0.5;
    let f = fract(c);
    let i = c - f;
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1;
    let g1 = w2 + w3;
    let h0 = (i - 0.5 + w1 / g0) / sz;
    let h1 = (i + 1.5 + w3 / g1) / sz;
    let a = textureSampleLevel(canopyTex, clampSamp, h0, 0.0).x;
    let b = textureSampleLevel(canopyTex, clampSamp, vec2f(h1.x, h0.y), 0.0).x;
    let d = textureSampleLevel(canopyTex, clampSamp, vec2f(h0.x, h1.y), 0.0).x;
    let e = textureSampleLevel(canopyTex, clampSamp, h1, 0.0).x;
    return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * d + g1.x * e);
}

fn forestCover(xz: vec2f, woods: f32) -> f32 {
    if (F.tdetail.w > 1.5) { return sat(canopyAt(xz).x * 1.15); }
    return sat(woods * (0.4 + vnoise2(xz / 300.0)) * 1.3);
}

// the canopy at xz as the plants see it: cover (0..1), height (m); the canopy map's, else the woods' at a forest's
// height. None off the map, on water, roads and buildings
fn canopyField(xz: vec2f) -> vec2f {
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec2f(0.0); }
    let land = textureSampleLevel(landTex, clampSamp, uv, 0.0);
    let cs = coastAt(xz).x;
    if (cs < 3.0 || select(land.z, land.z * smoothstep(20.0, 50.0, cs), F.tdetail.y > 0.0) > 0.3 || textureSampleLevel(smoothTex, clampSamp, uv, 0.0).x > 0.25) { return vec2f(0.0); }
    if (F.tdetail.w > 1.5) { return canopyAt(xz); }
    return vec2f(forestCover(xz, land.y), ${CANOPY}.0);
}

// a lattice cell's plant: its seed (every choice about it draws on this), and where in the cell it stands
fn vegSeed(cell: vec2i) -> u32 { return pcg((bitcast<u32>(cell.x) * 0x9e3779b9u) ^ pcg(bitcast<u32>(cell.y) + 0x632be5abu)); }
fn vegSite(cell: vec2i, seed: u32) -> vec2f { return (vec2f(cell) + 0.15 + 0.7 * vec2f(rnd(seed), rnd(seed + 1u))) * ${VEG_CELL}.0; }
`;

// The scatter: one thread per lattice cell of the window about the eye. A cell's plant (its place, kind, size) depends
// only on the cell, so it stays put as the eye moves. Instances: two vec4f each, (x, y, z, scale) (yaw, hue, lean, fade),
// written to their species' near or far slot, counted in args (drawIndirect: vertices, instances, first vertex, 0)
const WGSL_VEG_SCATTER = /* wgsl */`
@group(1) @binding(0) var<storage, read_write> vegOut: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> vegArgs: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn vegScatter(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= ${VEG_N}u || gid.y >= ${VEG_N}u) { return; }
    let cell = vec2i(floor(F.cam.xz / ${VEG_CELL}.0)) - ${VEG_N / 2} + vec2i(gid.xy);
    let seed = vegSeed(cell);
    let xz = vegSite(cell, seed);
    let d = distance(xz, F.cam.xz);
    if (d > ${VEG_FAR}.0) { return; }
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return; }
    let land = textureSampleLevel(landTex, clampSamp, uv, 0.0);
    // (along a coastline, geoCoast: none within 3 m of it or off it; the land use's water only inland)
    let cs = coastAt(xz).x;
    let lake = select(land.z, land.z * smoothstep(20.0, 50.0, cs), F.tdetail.y > 0.0);
    if (cs < 3.0 || lake > 0.3 || textureSampleLevel(smoothTex, clampSamp, uv, 0.0).x > 0.25) { return; }  // water, roads, buildings
    let th = terrainHeight(xz);
    if (th.x < 0.8) { return; }
    // how likely a plant is here: the forest, else a few on open ground and in yards; fewer on cliffs
    let forest = forestCover(xz, land.y);
    // the shore: low ground with open water (the sea's painted in, like lakes) within some 60 m
    var wet = select(0.0, 1.0 - smoothstep(30.0, 80.0, cs), F.tdetail.y > 0.0);
    for (var k = 0; k < 4 && F.tdetail.y <= 0.0; k++) {
        let o = vec2f(f32(k % 2) * 2.0 - 1.0, f32(k / 2) * 2.0 - 1.0) * 60.0 / F.tdomain.z;
        wet = max(wet, textureSampleLevel(landTex, clampSamp, uv + o, 0.0).z);
    }
    let coast = th.x < 6.0 && wet > 0.5;
    // with a canopy map: as much as it covers (and a few palms on the shore), its height setting the plants' size
    let mapped = F.tdetail.w > 1.5;
    let cn = select(vec2f(0.0), canopyAt(xz), mapped);
    var p = forest * 0.9 + (1.0 - forest) * (0.035 + 0.05 * land.x + select(0.0, 0.06, coast));
    if (mapped) { p = cn.x * 0.95 + (1.0 - cn.x) * select(0.008, 0.05, coast); }
    else { p *= select(1.0, 0.5, th.z < 0.55); }
    if (rnd(seed + 2u) > p) { return; }
    // what grows: palms on the shore and in town, kiawe and scrub on the dry lowland, broadleaf forest above
    let r = rnd(seed + 3u);
    var sp = 0u;
    if (coast && forest < 0.5) { sp = select(3u, 2u, r < 0.7); }
    else if (land.x > 0.3) { sp = select(0u, 2u, r < 0.35); }
    else if (forest > 0.3) { sp = select(select(0u, 1u, th.x < 150.0 && forest < 0.7), 3u, r < 0.18); }
    else { sp = select(select(0u, 3u, r < 0.5), select(3u, 1u, r < 0.6), th.x < 250.0); }
    if (mapped && cn.y < 3.5 && sp != 2u) { sp = 3u; }       // low canopy: scrub
    let sizes = array<vec2f, ${VEG_SPECIES}>(vec2f(0.8, 1.5), vec2f(0.7, 1.3), vec2f(0.75, 1.25), vec2f(0.6, 1.4));
    var scale = mix(sizes[sp].x, sizes[sp].y, rnd(seed + 4u)) * select(1.0, 0.8, th.z < 0.55);
    if (mapped && cn.y > 0.5) {
        // the meshes' heights at scale 1: broadleaf, kiawe, palm, shrub
        let tall = array<f32, ${VEG_SPECIES}>(9.1, 5.1, 12.0, 1.8);
        scale = clamp(cn.y * (0.8 + 0.4 * rnd(seed + 4u)) / tall[sp], 0.4, select(3.0, 1.6, sp == 3u));
    }
    // on the terrain as drawn there (its lod's vertex spacing), sunk a little so no root floats
    let spacing = F.tdetail.z * max(1.0, 2.0 * d / F.geo.z);
    let y = terrainSurface(xz, spacing).x - 0.3 * scale;
    // near / far and the fade by the distance in 3D, as the canopy carpet takes over (fsCanopy): from high up, the carpet alone
    let d3 = distance(vec3f(xz.x, y, xz.y), F.cam.xyz);
    if (d3 > ${VEG_FAR}.0) { return; }
    // the eye's frustum, the plant as a sphere
    let rad = 9.0 * scale;
    let c = F.viewProj * vec4f(curveToRender(vec3f(xz.x, y + 6.0 * scale, xz.y)), 1.0);
    let mx = rad / length(F.right.xyz);
    let my = rad / length(F.up.xyz);
    if (c.w < -rad || abs(c.x) > c.w + mx || abs(c.y) > c.w + my) { return; }
    let lod = select(1u, 0u, d3 < ${VEG_NEAR}.0);
    let slot = sp * 2u + lod;
    let i = atomicAdd(&vegArgs[slot * 4u + 1u], 1u);
    if (i >= select(${VEG_CAP[1]}u, ${VEG_CAP[0]}u, lod == 0u)) { return; }
    let k = (sp * ${VEG_SLOT}u + select(${VEG_CAP[0]}u, 0u, lod == 0u) + i) * 2u;
    vegOut[k] = vec4f(xz.x, y, xz.y, scale);
    vegOut[k + 1u] = vec4f(rnd(seed + 5u) * 6.2831853, rnd(seed + 6u), rnd(seed + 7u) - 0.5, 1.0 - smoothstep(${VEG_FADE}.0, ${VEG_FAR}.0, d3));
}

// the counts past a slot's capacity (atomicAdd went on counting) back to it
@compute @workgroup_size(${VEG_SPECIES * 2})
fn vegClamp(@builtin(local_invocation_index) s: u32) {
    let cap = select(${VEG_CAP[1]}u, ${VEG_CAP[0]}u, s % 2u == 0u);
    atomicMin(&vegArgs[s * 4u + 1u], cap);
}
`;

// The plants, drawn in the scene pass (group 2: the instances). A mesh vertex: position and normal in the plant's own
// frame (base at the origin, metres at scale 1), part (0 wood, 1 foliage), ambient occlusion (0 deep inside, 1 open),
// slot (species * 2 + lod)
// a plant part's albedo (linear): wood, or the species' foliage (part 1). No bindings: the bake shares it
const WGSL_VEG_ALBEDO = /* wgsl */`
fn vegAlbedo(sp: u32, part: f32) -> vec3f {
    let leaves = array<vec3f, ${VEG_SPECIES}>(vec3f(0.04, 0.075, 0.028), vec3f(0.06, 0.08, 0.045), vec3f(0.09, 0.12, 0.045), vec3f(0.05, 0.08, 0.03));
    let wood = select(vec3f(0.09, 0.065, 0.045), vec3f(0.2, 0.17, 0.13), sp == 2u);
    return select(wood, leaves[sp], part > 0.5);
}

// a plant's variation in hue (its instance's hue, 0..1)
fn vegHue(h: f32) -> vec3f { return vec3f(0.85 + 0.3 * h, 0.9 + 0.2 * fract(h * 7.0), 0.8 + 0.3 * fract(h * 13.0)); }
`;

const WGSL_VEG = /* wgsl */`
@group(2) @binding(0) var<storage, read> vegInst: array<vec4f>;

// the dither a plant fades out by (fade 1: all of it)
fn vegFaded(pos: vec2f, fade: f32) -> bool { return fade < 0.999 && fract(52.9829189 * fract(dot(pos, vec2f(0.06711056, 0.00583715)))) > fade; }

// foliage lit: wrapped diffuse (light through and round the leaves), the sun through it from behind; wet leaves darker
fn vegLight(p: vec3f, nIn: vec3f, albIn: vec3f, ao: f32) -> vec3f {
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }
    let s = F.sunDir.xyz;
    let sh = shadowAt(p);
    let gs = groundAt(p.xz);
    let wrap = max(dot(n, s) * 0.6 + 0.4, 0.0);
    let back = pow(max(dot(-v, s), 0.0), 4.0) * 0.35;
    let alb = albIn * (1.0 - 0.3 * gs.y);
    let col = alb * (F.sunCol.rgb * sh.x * (wrap + back) + F.ambient.rgb * sh.y * (0.6 + 0.4 * n.y) + FLASH_COLOR * flashLit(p) * 0.03);
    return col * (0.35 + 0.65 * ao);
}

struct VegOut {
    @builtin(position) pos: vec4f,
    @location(0) world: vec3f,
    @location(1) n: vec3f,
    @location(2) col: vec3f,
    @location(3) ao: f32,
    @location(4) fade: f32,
};

@vertex fn vsVeg(@location(0) lp: vec3f, @location(1) ln: vec3f, @location(2) attr: vec4f, @builtin(instance_index) ii: u32) -> VegOut {
    let slot = u32(attr.z + 0.5);
    let sp = slot / 2u;
    let k = (sp * ${VEG_SLOT}u + select(${VEG_CAP[0]}u, 0u, slot % 2u == 0u) + ii) * 2u;
    let a = vegInst[k];
    let b = vegInst[k + 1u];
    let cs = vec2f(cos(b.x), sin(b.x));
    var q = lp * a.w;
    q = vec3f(q.x * cs.x - q.z * cs.y, q.y, q.x * cs.y + q.z * cs.x);
    // a lean, and the foliage swaying in the wind, more the higher it is
    let w = F.wind.xy;
    let sway = sin(F.cam.w * (1.3 + b.y) + b.x * 7.0) * (0.02 + 0.004 * length(w)) * attr.x * q.y * 0.15;
    q += vec3f(b.z * 0.08 * q.y + sway + w.x * 0.002 * q.y * attr.x, 0.0, sway * 0.6 + w.y * 0.002 * q.y * attr.x);
    var o: VegOut;
    o.world = a.xyz + q;
    o.pos = F.viewProj * vec4f(curveToRender(o.world), 1.0);
    o.n = vec3f(ln.x * cs.x - ln.z * cs.y, ln.y, ln.x * cs.y + ln.z * cs.x);
    // colour: wood, or the species' foliage, varied plant to plant
    o.col = vegAlbedo(sp, attr.x) * select(vec3f(1.0), vegHue(b.y), attr.x > 0.5);
    o.ao = attr.y;
    o.fade = b.w;
    return o;
}

@fragment fn fsVeg(i: VegOut) -> @location(0) vec4f {
    if (vegFaded(i.pos.xy, i.fade)) { discard; }
    return vec4f(vegLight(i.world, i.n, i.col, i.ao), 0.0);
}
`;

// The bake of a plant's mesh into its imposter atlas (the imposter kit: after its WGSL_BAKE_FRAME and WGSL_VEG_ALBEDO):
// the same vertices as vsVeg, unlit, normals turned toward the frame's viewer (the meshes are two-sided)
const WGSL_VEG_BAKE = /* wgsl */`
struct VegBakeOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) lp: vec3f, @location(2) attr: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) attr: vec4f) -> VegBakeOut {
    var o: VegBakeOut;
    o.pos = bake.viewProj * vec4f(p, 1.0);
    o.n = n;
    o.lp = p;
    o.attr = attr;
    return o;
}
@fragment fn fs(v: VegBakeOut) -> BakeOut {
    var n = normalize(v.n);
    if (dot(n, bake.dir.xyz) < 0.0) { n = -n; }
    return bakeOut(vegAlbedo(u32(v.attr.z + 0.5) / 2u, v.attr.x), n, v.lp, vec4f(v.attr.y, 0.04, 0.2, 0.4), vec3f(0.0));
}
`;

// The far plants as imposters (after WGSL_VEG and the imposter kit's imposterWGSL at group 3: one species' atlas; group 2
// its far slot alone, from index 0): a quad over each facing the eye through its centre (near its trunk: no depth is
// written per pixel, which would cost the early depth test over the overlapping crowns), the surface rebuilt per pixel
// from the atlas's nearest view (its coverage read first, so the empty part of the quad costs little), lit as the
// meshes are
const WGSL_VEG_IMP = /* wgsl */`
struct VegImpOut {
    @builtin(position) pos: vec4f,
    @location(0) wp: vec3f,
    @location(1) @interpolate(flat) c: vec4f,         // centre, radius
    @location(2) @interpolate(flat) yhf: vec3f,       // yaw, hue, fade
    @location(3) @interpolate(flat) cellsA: vec4f,
    @location(4) @interpolate(flat) cell2: vec2f,
    @location(5) @interpolate(flat) w: vec3f,
};

fn vegYaw(v: vec3f, cs: vec2f) -> vec3f { return vec3f(v.x * cs.x - v.z * cs.y, v.y, v.x * cs.y + v.z * cs.x); }

@vertex fn vsVegImp(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VegImpOut {
    let a = vegInst[ii * 2u];
    let b = vegInst[ii * 2u + 1u];
    let cs = vec2f(cos(b.x), sin(b.x));
    let c = a.xyz + vegYaw(impAtlas.bound.xyz * a.w, cs);
    let R = impAtlas.bound.w * a.w;
    let K = impCorner(c, R, vec4f(F.cam.xyz, 1.0), F.fwd.xyz, IMP_QUAD[vi]);
    let fr = impFrames(vegYaw(K.toView, vec2f(cs.x, -cs.y)), false);
    var o: VegImpOut;
    o.pos = F.viewProj * vec4f(curveToRender(K.wp), 1.0);
    o.wp = K.wp;
    o.c = vec4f(c, R);
    o.yhf = vec3f(b.x, b.y, b.w);
    o.cellsA = fr.cellsA;
    o.cell2 = fr.cell2;
    o.w = fr.w;
    return o;
}

@fragment fn fsVegImp(i: VegImpOut) -> @location(0) vec4f {
    let cs = vec2f(cos(i.yhf.x), sin(i.yhf.x));
    let inv = vec2f(cs.x, -cs.y);
    let ro = vegYaw(F.cam.xyz - i.c.xyz, inv) / i.c.w;
    let rd = vegYaw(normalize(i.wp - F.cam.xyz), inv);
    // the nearest view alone (impFrames without blending), its coverage first: the empty part of the quad goes no further
    let cell = i.cellsA.xy;
    let d = impCellDir(cell);
    let r = octRight(d);
    let h = ro + rd * (-dot(ro, d) / min(dot(rd, d), -1e-4));
    let uv = vec2f(dot(h, r), -dot(h, cross(d, r))) * 0.5 + 0.5;
    let gx = dpdx(uv) * impAtlas.grid.z;
    let gy = dpdy(uv) * impAtlas.grid.z;
    let auv = impAtlasUV(cell, uv);
    let alb = textureSampleGrad(impAlbedo, impSampler, auv, gx, gy);
    if (alb.a < 0.5 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || vegFaded(i.pos.xy, i.yhf.z)) { discard; }
    let nrm = textureSampleGrad(impNormal, impSampler, auv, gx, gy);
    let ao = textureSampleGrad(impSurface, impSampler, auv, gx, gy).x / alb.a;
    let n = normalize(nrm.xyz / alb.a * 2.0 - 1.0);
    let p = i.c.xyz + vegYaw(h * i.c.w, cs);
    return vec4f(vegLight(p, vegYaw(n, cs), alb.rgb / alb.a * vegHue(i.yhf.y), ao), 0.0);
}
`;

// The canopy carpet (after WGSL_VEG): the far forest as the plants' own crowns. A shell over
// the terrain's patches, raised to the canopy's top (vsCanopy), where each pixel marches its view ray down through the
// canopy layer (fsCanopy): at each step the crowns of the four nearest lattice cells, chosen as vegScatter chooses them
// (the cell's seed against the canopy's cover, its site, its height from the canopy's), each an ellipsoid shaped like
// the plant's mesh, until the ray meets one or the ground. A plant's crown is where the imposter drew it, in its hue, lit
// alike; it takes the pixels the plants' dither leaves (vegFaded with the same fade), so they cross over pixel by pixel.
// Far off, where a step outgrows a crown, each step takes the crowns it passes as a share instead (the canopy's cover
// over a crown's breadth, Beer-Lambert), so the far forest keeps its density; the carpet is blended over the ground by
// what it covered (premultiplied). It writes no depth.
const WGSL_VEG_CARPET = /* wgsl */`
struct CanopyOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) top: f32 };

// the shell needs no precise ground (it only has to be over the canopy): the filtered heights, the patch's own grid
// morphed as the terrain's is (no cracks); a patch wholly within the plants' reach (in 3D, as they fade: its farthest
// corner, the eye's height over the ground at its centre less a margin for the relief within it) is dropped (degenerate)
@vertex fn vsCanopy(@builtin(vertex_index) vi: u32, @location(0) node: vec4f) -> CanopyOut {
    var o: CanopyOut;
    let far = length(abs(F.cam.xz - (node.xy + node.z * 0.5)) + node.z * 0.5);
    let dy = max(abs(F.cam.y - terrainHeight(node.xy + node.z * 0.5).x) - 100.0, 0.0);
    if (F.tdetail.w < 0.5 || length(vec2f(far, dy)) < ${VEG_FADE - 150}.0) { o.pos = vec4f(0.0); return o; }
    let P = ${TERRAIN_PATCH}.0;
    let g = vec2f(f32(vi % ${TERRAIN_PATCH + 1}u), f32(vi / ${TERRAIN_PATCH + 1}u));
    let xz0 = node.xy + g / P * node.z;
    let r = F.geo.z * exp2(node.w);
    let h0 = terrainHeight(xz0).x;
    let k = sat((distance(F.cam.xyz, vec3f(xz0.x, h0, xz0.y)) - 0.75 * r) / (0.2 * r));
    let xz = node.xy + (g - fract(g * 0.5) * 2.0 * k) / P * node.z;
    let cf = select(canopyField(xz), canopyAt(xz), F.tdetail.w > 1.5);
    o.top = select(0.0, cf.y * 1.25 + 0.5, cf.x > 0.02);
    o.world = vec3f(xz.x, terrainHeight(xz).x + o.top, xz.y);
    o.pos = F.viewProj * vec4f(curveToRender(o.world), 1.0);
    return o;
}

@fragment fn fsCanopy(i: CanopyOut) -> @location(0) vec4f {
    if (i.top < 1.0) { discard; }
    let toP = i.world - F.cam.xyz;
    let dist = length(toP);
    let rd = toP / dist;
    // the plants have everything nearer than VEG_FADE: a ray that cannot get that far inside the layer is theirs
    if (dist + i.top * 1.3 / max(abs(rd.y), 0.03) < ${VEG_FADE}.0) { discard; }
    let stepL = clamp(dist * 0.0035, 1.5, 20.0);
    // the crowns lie between about 0.4 and 0.95 of the canopy's height: start the ray at their top (the shell stands
    // 1.25 x over the ground), and below their bottom it is through them. The jump down to their top, as over flat
    // ground, is kept where it lands still over them; toward a slope that faces the eye it would pass into the hill, and
    // is cut to the gap itself
    let gap = (i.top - 0.5) * 0.3 / 1.25;
    var skip = 0.0;
    if (rd.y < 0.0) {
        skip = gap / max(-rd.y, 0.05);
        let l = i.world + rd * skip;
        if (l.y - terrainHeight(l.xz).x < (i.top - 0.5) / 1.25 * 0.95) { skip = min(skip, gap); }
    }
    var t = skip + stepL * rnd(pcg(u32(i.pos.x) + u32(i.pos.y) * 7919u + (u32(F.right.w) & 7u) * 104729u));
    // what the ray gathers: its transmittance, and the surface it met, weighted by how much of it it met
    var T = 1.0;
    var sumAlb = vec3f(0.0);
    var sumN = vec3f(0.0);
    var sumP = vec3f(0.0);
    var sumAo = 0.0;
    var exact = false;
    for (var k = 0; k < ${CARPET_STEPS}; k++) {
        let q = i.world + rd * t;
        let g = terrainHeight(q.xz).x;
        if (q.y < g) { break; }
        // the canopy map alone per step (water, roads and buildings are checked at a hit: canopyField)
        let cf = select(canopyField(q.xz), canopyAt(q.xz), F.tdetail.w > 1.5);
        let a = q.y - g;
        if (a > cf.y * 1.25 + 1.0 && rd.y >= 0.0) { break; }
        if (rd.y < 0.0 && cf.y >= 3.5 && a < cf.y * 0.35) { break; }
        if (cf.x > 0.02 && a < cf.y * 1.25) {
            let low = cf.y < 3.5;
            // the crowns themselves, where the steps are short enough to find them
            let bc = vec2i(floor(q.xz / ${VEG_CELL}.0 - 0.5));
            for (var j = 0; j < 4; j++) {
                let cell = bc + vec2i(j % 2, j / 2);
                let s = vegSeed(cell);
                if (rnd(s + 2u) > cf.x * 0.95) { continue; }
                let site = vegSite(cell, s);
                let H = cf.y * (0.8 + 0.4 * rnd(s + 4u));
                let rH = min(select(0.36, 0.55, low) * H, 5.0);
                let rV = rH * select(0.75, 0.8, low);
                let c = vec3f(site.x, g + H * select(0.68, 0.5, low), site.y);
                let e = vec3f((q.x - c.x) / rH, (q.y - c.y) / rV, (q.z - c.z) / rH);
                if (dot(e, e) < 1.0 && canopyField(site).x > 0.0) {
                    // the crown's normal, broken up like foliage; lower and inner leaves darker (PlantMesh.blob)
                    let n = normalize(e) + (vec3f(vnoise2(q.xz * 0.9 + q.y), vnoise2(q.zy * 0.9 + 3.1), vnoise2(q.xy * 0.9 - 7.7)) - 0.5) * 0.6;
                    sumAlb += T * vegAlbedo(select(0u, 3u, low), 1.0) * vegHue(rnd(s + 6u));
                    sumN += T * normalize(n);
                    sumP += T * q;
                    sumAo += T * sat(0.45 + 0.4 * (e.y * 0.5 + 0.5) + 0.25 * length(e.xz));
                    T = 0.0;
                    exact = true;
                    break;
                }
            }
            if (exact) { break; }
            // where a step is longer than a crown (far off), the crowns it passes, as a share of it: the canopy's cover
            // over a crown's breadth, the more the longer the step (Beer-Lambert), dappled by the cells' hues
            let rT = max(min(select(0.36, 0.55, low) * cf.y, 5.0), 0.5);
            let share = sat(stepL / (2.0 * rT) - 0.5);
            if (share > 0.0) {
                let w = (1.0 - exp(-cf.x * 0.95 * stepL / (2.0 * rT))) * share;
                let s = vegSeed(vec2i(floor(q.xz / ${VEG_CELL}.0)));
                sumAlb += T * w * vegAlbedo(select(0u, 3u, low), 1.0) * vegHue(rnd(s + 6u));
                sumN += T * w * vec3f(0.0, 1.0, 0.0);           // broken up once, at the gathered surface
                sumP += T * w * q;
                sumAo += T * w * sat(0.45 + 0.4 * sat((a - 0.4 * cf.y) / max(0.55 * cf.y, 0.5)));
                T *= 1.0 - w;
                if (T < 0.02) { break; }
            }
        }
        t += stepL;
    }
    let cov = 1.0 - T;
    if (cov < 0.004) { discard; }
    let p = sumP / cov;
    // a crown within the plants' reach is theirs where their dither keeps them (they were drawn there)
    if (exact && !vegFaded(i.pos.xy, 1.0 - smoothstep(${VEG_FADE}.0, ${VEG_FAR}.0, distance(p, F.cam.xyz)))) { discard; }
    // lit once, at the gathered surface (the far share's normal broken up there, like a canopy's); premultiplied by its
    // coverage (blended over the ground, its alpha untouched)
    var n = sumN / cov;
    if (!exact) { n += (vec3f(vnoise2(p.xz * 0.35), vnoise2(p.zx * 0.35 + 5.3), vnoise2(p.xz * 0.35 - 2.1)) - 0.5) * 1.4; }
    return vec4f(vegLight(p, n, sumAlb / cov, sumAo / cov) * cov, cov);
}
`;

return { VEG_CELL, VEG_NEAR, VEG_FADE, VEG_FAR, VEG_N, VEG_SPECIES, VEG_CAP, VEG_SLOT, WGSL_FOREST, WGSL_VEG_SCATTER, WGSL_VEG_ALBEDO, WGSL_VEG, WGSL_VEG_BAKE, WGSL_VEG_IMP, WGSL_VEG_CARPET };
});
