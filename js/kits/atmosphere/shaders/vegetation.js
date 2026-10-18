'use strict';
// WGSL: the vegetation. A compute pass scatters plants each frame on a fixed lattice about the eye (vegScatter), from the
// land-use map and the terrain; the scene pass draws them (vsVeg / fsVeg), full meshes near, low-poly ones out to
// VEG_FAR, where they fade into the forest canopy raised on the terrain (canopyLift).

Features.kit('atmosphere', (engine, kit) => {

const VEG_CELL = 6;                 // m: the lattice; at most one plant a cell
const VEG_NEAR = 250;               // m: full meshes within this, low-poly beyond
const VEG_FADE = 1150;              // m: from here to VEG_FAR the plants dither out and the canopy rises in their place
const VEG_FAR = 1500;
const VEG_N = 2 * Math.ceil(VEG_FAR / VEG_CELL);        // lattice cells a side of the window about the eye
const VEG_SPECIES = 4;              // 0 broadleaf, 1 dry umbrella tree (kiawe), 2 coconut palm, 3 shrub
const VEG_CAP = [8192, 49152];      // instances per species, near and far
const VEG_SLOT = VEG_CAP[0] + VEG_CAP[1];
const CANOPY = 11;                  // m: the canopy's height over the ground beyond the plants

// the forest cover the ground is shaded with (fsTerrain), the plants scattered by and the canopy raised over (0..1): the
// canopy map's where there is one (F.tdetail.w 2: geoCanopy), else the land use's woods, broken up a little
const WGSL_FOREST = /* wgsl */`
// the canopy map at xz: cover (0..1), mean height (m)
fn canopyAt(xz: vec2f) -> vec2f {
    let c = textureSampleLevel(canopyTex, clampSamp, (xz - F.tdomain.xy) / F.tdomain.z, 0.0).xy;
    return vec2f(c.x, c.y * 255.0);
}

fn forestCover(xz: vec2f, woods: f32) -> f32 {
    if (F.tdetail.w > 1.5) { return sat(canopyAt(xz).x * 1.15); }
    return sat(woods * (0.4 + vnoise2(xz / 300.0)) * 1.3);
}

// the canopy over the ground at xz, d m from the eye (in 3D, as the plants fade by): none within the plants' reach,
// rising as they fade out
fn canopyLift(xz: vec2f, d: f32) -> f32 {
    if (F.tdetail.w < 0.5 || d < ${VEG_FADE}.0) { return 0.0; }
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
    let land = textureSampleLevel(landTex, clampSamp, uv, 0.0);
    let keep = 1.0 - textureSampleLevel(smoothTex, clampSamp, uv, 0.0).x;
    // the canopy's own height where it is mapped (thinner cover, lower), else a typical forest's
    var top = forestCover(xz, land.y) * ${CANOPY}.0;
    if (F.tdetail.w > 1.5) { let c = canopyAt(xz); top = c.y * sat(c.x * 1.3); }
    return smoothstep(${VEG_FADE}.0, ${VEG_FAR}.0, d) * top * keep * (1.0 - sat(land.z * 2.0));
}
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
    let seed = pcg((bitcast<u32>(cell.x) * 0x9e3779b9u) ^ pcg(bitcast<u32>(cell.y) + 0x632be5abu));
    let xz = (vec2f(cell) + 0.15 + 0.7 * vec2f(rnd(seed), rnd(seed + 1u))) * ${VEG_CELL}.0;
    let d = distance(xz, F.cam.xz);
    if (d > ${VEG_FAR}.0) { return; }
    let uv = (xz - F.tdomain.xy) / F.tdomain.z;
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return; }
    let land = textureSampleLevel(landTex, clampSamp, uv, 0.0);
    if (land.z > 0.3 || textureSampleLevel(smoothTex, clampSamp, uv, 0.0).x > 0.25) { return; }  // water, roads, buildings
    let th = terrainHeight(xz);
    if (th.x < 0.8) { return; }
    // how likely a plant is here: the forest, else a few on open ground and in yards; fewer on cliffs
    let forest = forestCover(xz, land.y);
    // the shore: low ground with open water (the sea's painted in, like lakes) within some 60 m
    var wet = 0.0;
    for (var k = 0; k < 4; k++) {
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
    // near / far and the fade by the distance in 3D, as the canopy rises (canopyLift): from high up, the canopy alone
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
const WGSL_VEG = /* wgsl */`
@group(2) @binding(0) var<storage, read> vegInst: array<vec4f>;

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
    let leaves = array<vec3f, ${VEG_SPECIES}>(vec3f(0.04, 0.075, 0.028), vec3f(0.06, 0.08, 0.045), vec3f(0.09, 0.12, 0.045), vec3f(0.05, 0.08, 0.03));
    let wood = select(vec3f(0.09, 0.065, 0.045), vec3f(0.2, 0.17, 0.13), sp == 2u);
    let hue = vec3f(0.85 + 0.3 * b.y, 0.9 + 0.2 * fract(b.y * 7.0), 0.8 + 0.3 * fract(b.y * 13.0));
    o.col = select(wood, leaves[sp] * hue, attr.x > 0.5);
    o.ao = attr.y;
    o.fade = b.w;
    return o;
}

@fragment fn fsVeg(i: VegOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
    if (i.fade < 0.999 && fract(52.9829189 * fract(dot(i.pos.xy, vec2f(0.06711056, 0.00583715)))) > i.fade) { discard; }
    let p = i.world;
    let v = normalize(F.cam.xyz - p);
    var n = normalize(i.n);
    if (dot(n, v) < 0.0) { n = -n; }
    let s = F.sunDir.xyz;
    let sh = shadowAt(p);
    let gs = groundAt(p.xz);
    // foliage: wrapped diffuse (light through and round the leaves), the sun through it from behind; wet leaves darker
    let wrap = max(dot(n, s) * 0.6 + 0.4, 0.0);
    let back = pow(max(dot(-v, s), 0.0), 4.0) * 0.35;
    let alb = i.col * (1.0 - 0.3 * gs.y);
    var col = alb * (F.sunCol.rgb * sh.x * (wrap + back) + F.ambient.rgb * sh.y * (0.6 + 0.4 * n.y) +FLASH_COLOR * flashLit(p) * 0.03);
    col *= 0.35 + 0.65 * i.ao;
    return vec4f(col, 0.0);
}
`;

return { VEG_CELL, VEG_NEAR, VEG_FADE, VEG_FAR, VEG_N, VEG_SPECIES, VEG_CAP, VEG_SLOT, WGSL_FOREST, WGSL_VEG_SCATTER, WGSL_VEG };
});
