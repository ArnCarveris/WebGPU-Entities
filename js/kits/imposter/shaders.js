'use strict';
// WGSL: baking atlases (the frame a source renders into, the standard mesh's bake, per-vertex ambient occlusion, mips)
// and drawing from them (imposterWGSL: the atlas's bindings and the billboard, frame selection and reconstruction
// functions a renderer's own imposter shader calls).

Features.kit('imposter', (engine, kit) => {
const { EMISSIVE_RANGE, WGSL_OCT } = kit;

// the standard mesh (meshSource, bakeVertexAO): vertex floats position 3, normal 3, uv 2, colour 3, plus a second
// vertex buffer of one f32 per vertex, its ambient occlusion (1 where not baked)
const MESH_VF = 11;
const MESH_BUFFERS = [{ arrayStride: MESH_VF * 4, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' },
] }, { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }] }];

// The frame a bake renders: group 0 of every bake pipeline (ImposterGpu.frameLayout). bake: the frame's orthographic
// viewProj (depth 0..1 front to back), its direction (toward the viewer) and 1 / radius, the bound's centre;
// bakeSampler: a repeating, anisotropic sampler for the source's textures. A source's fragment stage returns
// bakeOut(...): the unlit surface only, so the atlas works under any lighting.
const WGSL_BAKE_FRAME = /* wgsl */`
struct Bake { viewProj: mat4x4f, dir: vec4f, center: vec4f };
@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var bakeSampler: sampler;

struct BakeOut { @location(0) albedo: vec4f, @location(1) normal: vec4f, @location(2) surface: vec4f, @location(3) emissive: vec4f };
// albedo (linear), unit normal (object space), the point (object space), surface: ambient occlusion, specular,
// gloss (0 rough .. 1 mirror), translucency (wrap); emission (linear; written only where the atlas has the layer)
fn bakeOut(albedo: vec3f, n: vec3f, lp: vec3f, surface: vec4f, emissive: vec3f) -> BakeOut {
    let depth = dot(lp - bake.center.xyz, bake.dir.xyz) * bake.dir.w;   // -1..1, toward the viewer
    var o: BakeOut;
    o.albedo = vec4f(albedo, 1.0);
    o.normal = vec4f(n * 0.5 + 0.5, depth * 0.5 + 0.5);
    o.surface = surface;
    o.emissive = vec4f(emissive / ${EMISSIVE_RANGE}.0, 1.0);
    return o;
}
`;

// The standard mesh's bake: MESH_BUFFERS, its material at group 1 (ImposterGpu.materialLayout: the Mat uniform below
// and one texture). fsDepth: the ambient occlusion bake's depth pass.
const WGSL_BAKE = WGSL_BAKE_FRAME + /* wgsl */`
// params: alpha cutoff, wrap, uv scale, flip backface normals; surf: specular, gloss; emissive: linear, x strength
struct Mat { color: vec4f, params: vec4f, surf: vec4f, emissive: vec4f };
@group(1) @binding(0) var<uniform> M: Mat;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) lp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) col: vec3f, @location(4) ao: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) col: vec3f, @location(4) ao: f32) -> VOut {
    var o: VOut;
    o.ao = ao;
    o.pos = bake.viewProj * vec4f(p, 1.0);
    o.lp = p;
    o.n = n;
    o.uv = uv * M.params.z;
    o.col = col;
    return o;
}
@fragment fn fsDepth(v: VOut) {
    let t = textureSample(tex, bakeSampler, v.uv);
    if (t.a * M.color.a < M.params.x) { discard; }
}
@fragment fn fs(v: VOut, @builtin(front_facing) ff: bool) -> BakeOut {
    let t = textureSample(tex, bakeSampler, v.uv);
    if (t.a * M.color.a < M.params.x) { discard; }
    var n = normalize(v.n);
    if (!ff && M.params.w > 0.5) { n = -n; }
    return bakeOut(t.rgb * v.col * M.color.rgb, n, v.lp, vec4f(v.ao, M.surf.x, M.surf.y, M.params.y), M.emissive.rgb);
}
`;

// Per-vertex ambient occlusion: the model's depth seen from AO_DIRS directions around it; a vertex sees a
// direction if nothing is in front of it there. Cosine-weighted around its normal. Geometry only, no light.
const WGSL_AO = /* wgsl */`
struct Frame { viewProj: mat4x4f, dir: vec4f, center: vec4f, pad: array<vec4f, 10> };
struct Params { count: u32, dirs: u32, bias: f32, strength: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> verts: array<f32>;
@group(0) @binding(2) var<storage, read> frames: array<Frame>;
@group(0) @binding(3) var depths: texture_depth_2d_array;
@group(0) @binding(4) var<storage, read_write> ao: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
    let i = id.x;
    if (i >= P.count) { return; }
    let o = i * ${MESH_VF}u;
    let n = normalize(vec3f(verts[o + 3u], verts[o + 4u], verts[o + 5u]));
    let p = vec3f(verts[o], verts[o + 1u], verts[o + 2u]) + n * P.bias;
    let dims = vec2f(textureDimensions(depths));
    var seen = 0.0;
    var total = 0.0;
    for (var k = 0u; k < P.dirs; k++) {
        let F = frames[k];
        let w = max(dot(n, F.dir.xyz), 0.0);
        if (w <= 0.0) { continue; }
        total += w;
        let cp = F.viewProj * vec4f(p, 1.0);
        let px = vec2i(clamp(vec2f(cp.x * 0.5 + 0.5, 0.5 - cp.y * 0.5) * dims, vec2f(0.0), dims - 1.0));
        if (cp.z <= textureLoad(depths, px, i32(k), 0) + P.bias * F.dir.w) { seen += w; }
    }
    ao[i] = mix(1.0, select(1.0, seen / total, total > 0.0), P.strength);
}
`;

const WGSL_MIP = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    var o: VO;
    o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2f(p.x, 1.0 - p.y);
    return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f { return textureSampleLevel(src, smp, v.uv, 0.0); }
`;

// Drawing from an atlas: its bindings at @group(group) (ImposterGpu.atlasLayout, ImposterAtlas.bg) and the functions
// an imposter shader is made of. A draw is IMPOSTER_VERTICES vertices per instance, a quad (IMP_QUAD[vertex_index]):
//   vertex:   impCorner (the quad corner over the bound, facing the view) and impFrames (the three frames around the
//             view direction in the instance's own space, their weights), passed on flat
//   fragment: impReconstruct (the pixel's view ray, in the instance's space in units of the bound's radius, against
//             each frame, with depth parallax, blended; premultiplied by coverage), impResolve (back to a surface),
//             impSharpen (coverage -> alpha to coverage); impCoverage: one frame's coverage, for cheap shadow casters
// The instance format, its rotation, the lighting and the depth written are the renderer's own.
const imposterWGSL = ({ group = 1 } = {}) => WGSL_OCT + /* wgsl */`
struct ImpAtlas { bound: vec4f, grid: vec4f };      // bound: centre, radius; grid: frames per side, full, 1 / frames, uv inset
@group(${group}) @binding(0) var<uniform> impAtlas: ImpAtlas;
@group(${group}) @binding(1) var impAlbedo: texture_2d<f32>;
@group(${group}) @binding(2) var impNormal: texture_2d<f32>;
@group(${group}) @binding(3) var impSurface: texture_2d<f32>;
@group(${group}) @binding(4) var impEmissive: texture_2d<f32>;      // 1 x 1 black when the source has no emission
@group(${group}) @binding(5) var impSampler: sampler;

var<private> IMP_QUAD: array<vec2f, 6> = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

fn impCellDir(c: vec2f) -> vec3f { return octDecode(c / (impAtlas.grid.x - 1.0) * 2.0 - 1.0, impAtlas.grid.y > 0.5); }
fn impAtlasUV(c: vec2f, uv: vec2f) -> vec2f { return (c + clamp(uv, vec2f(impAtlas.grid.w), vec2f(1.0 - impAtlas.grid.w))) * impAtlas.grid.z; }

// corner q of a quad covering the sphere (centre c, radius R) as seen from a view: eye.w 1, perspective from eye.xyz
// (sized to the sphere's silhouette cone, cut by the plane through its centre); else orthographic along dir.
// toView: the unit direction toward the viewer
struct ImpCorner { wp: vec3f, toView: vec3f };
fn impCorner(c: vec3f, R: f32, eye: vec4f, dir: vec3f, q: vec2f) -> ImpCorner {
    var v = -dir;
    var ext = R;
    if (eye.w > 0.5) {
        let toCam = eye.xyz - c;
        let dist = max(length(toCam), 1e-4);
        v = toCam / dist;
        ext = select(R * 4.0, R * dist / sqrt(max(dist * dist - R * R, 1e-6)), dist > R * 1.05);
    }
    var right = vec3f(1.0, 0.0, 0.0);
    if (abs(v.y) < 0.9999) { right = normalize(cross(vec3f(0.0, 1.0, 0.0), v)); }
    let up = cross(v, right);
    return ImpCorner(c + (right * q.x + up * q.y) * ext, v);
}

// the frames around a view direction v (the instance's own space, toward the viewer): cells of the grid triangle and
// their barycentric weights; blend false: the nearest frame alone
struct ImpFrames { cellsA: vec4f, cell2: vec2f, w: vec3f };     // cellsA: frames 0 and 1 (x, y)
fn impFrames(v: vec3f, blend: bool) -> ImpFrames {
    let N = impAtlas.grid.x;
    let g = clamp((octEncode(v, impAtlas.grid.y > 0.5) * 0.5 + 0.5) * (N - 1.0), vec2f(0.0), vec2f(N - 1.0));
    var o: ImpFrames;
    if (blend) {
        let b = min(floor(g), vec2f(N - 2.0));
        let f = g - b;
        if (f.x > f.y) {
            o.cellsA = vec4f(b, b + vec2f(1.0, 0.0));
            o.w = vec3f(1.0 - f.x, f.x - f.y, f.y);
        } else {
            o.cellsA = vec4f(b, b + vec2f(0.0, 1.0));
            o.w = vec3f(1.0 - f.y, f.y - f.x, f.x);
        }
        o.cell2 = b + 1.0;
    } else {
        let r = round(g);
        o.cellsA = vec4f(r, r);
        o.cell2 = r;
        o.w = vec3f(1.0, 0.0, 0.0);
    }
    return o;
}

// the blended surface along a view ray (ro + t rd: the instance's space, in units of the bound's radius, ro about its
// centre), premultiplied by coverage (albedo.a); hit: the surface point; full: every layer (else albedo, normal, hit)
struct ImpSample { albedo: vec4f, normal: vec4f, surface: vec4f, emissive: vec3f, hit: vec3f };
fn impReconstruct(ro: vec3f, rd: vec3f, F: ImpFrames, parallax: bool, full: bool) -> ImpSample {
    var cells = array<vec2f, 3>(F.cellsA.xy, F.cellsA.zw, F.cell2);
    var ws = F.w;
    var o = ImpSample(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec3f(0.0), vec3f(0.0));
    for (var k = 0; k < 3; k++) {
        let cell = cells[k];
        let d = impCellDir(cell);
        let r = octRight(d);
        let u = cross(d, r);
        let den = min(dot(rd, d), -1e-4);
        var h = ro + rd * (-dot(ro, d) / den);                   // hit on the frame's plane through the centre
        let uv0 = vec2f(dot(h, r), -dot(h, u)) * 0.5 + 0.5;
        let gx = dpdx(uv0) * impAtlas.grid.z;
        let gy = dpdy(uv0) * impAtlas.grid.z;
        var uv = uv0;
        if (parallax) {
            let a0 = textureSampleGrad(impAlbedo, impSampler, impAtlasUV(cell, uv0), gx, gy).a;
            let d0 = textureSampleGrad(impNormal, impSampler, impAtlasUV(cell, uv0), gx, gy).a;
            if (a0 > 0.02) {                                        // move to the baked surface depth and reproject
                h = ro + rd * ((d0 / a0 * 2.0 - 1.0 - dot(ro, d)) / den);
                uv = vec2f(dot(h, r), -dot(h, u)) * 0.5 + 0.5;
            }
        }
        let inside = select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
        let auv = impAtlasUV(cell, uv);
        let wk = ws[k] * inside;
        let ca = textureSampleGrad(impAlbedo, impSampler, auv, gx, gy);
        o.albedo += ca * wk;
        o.normal += textureSampleGrad(impNormal, impSampler, auv, gx, gy) * wk;
        o.hit += h * (ca.a * wk);
        if (full) {
            o.surface += textureSampleGrad(impSurface, impSampler, auv, gx, gy) * wk;
            o.emissive += textureSampleGrad(impEmissive, impSampler, auv, gx, gy).rgb * wk;
        }
    }
    return o;
}

// a reconstruction divided by its coverage (s.albedo.a > 0): albedo, unit normal (the instance's space), surface
// (ambient occlusion, specular, gloss, translucency), emission (linear), the surface point (radius units)
struct ImpSurface { albedo: vec3f, n: vec3f, surface: vec4f, emissive: vec3f, hit: vec3f };
fn impResolve(s: ImpSample) -> ImpSurface {
    let a = s.albedo.a;
    return ImpSurface(s.albedo.rgb / a, normalize((s.normal.xyz / a) * 2.0 - 1.0), s.surface / a, s.emissive / a * ${EMISSIVE_RANGE}.0, s.hit / a);
}

// coverage sharpened to about one pixel (alpha to coverage: antialiased edges without sorting)
fn impSharpen(a: f32) -> f32 { return (a - 0.5) / max(fwidth(a), 1e-4) + 0.5; }

// one frame's coverage where the ray meets its plane, 0 off the frame (far shadow casters: no parallax, no blend)
fn impCoverage(ro: vec3f, rd: vec3f, cell: vec2f) -> f32 {
    let d = impCellDir(cell);
    let r = octRight(d);
    let h = ro + rd * (-dot(ro, d) / min(dot(rd, d), -1e-4));
    let uv = vec2f(dot(h, r), -dot(h, cross(d, r))) * 0.5 + 0.5;
    let a = textureSampleGrad(impAlbedo, impSampler, impAtlasUV(cell, uv), dpdx(uv) * impAtlas.grid.z, dpdy(uv) * impAtlas.grid.z).a;
    return select(a, 0.0, any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)));
}
`;

return { MESH_VF, MESH_BUFFERS, WGSL_BAKE_FRAME, WGSL_BAKE, WGSL_AO, WGSL_MIP, imposterWGSL };
});
