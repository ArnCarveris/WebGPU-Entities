'use strict';
// WGSL: baking atlases: the G-buffer frames, per-vertex ambient occlusion and mips.

Features.part('imposter', (engine, feature) => {
const { EMISSIVE_RANGE, VF } = feature;

// Bake: one orthographic frame of the atlas. Writes the unlit surface only (a small G-buffer): albedo +
// coverage, object-space normal + depth, AO / specular / gloss / translucency and (if any) emission, into
// 4x MSAA targets whose resolve gives values premultiplied by coverage. fsDepth: the AO bake's depth pass.
const WGSL_BAKE = /* wgsl */`
struct Bake { viewProj: mat4x4f, dir: vec4f, center: vec4f };     // dir: frame direction, 1 / radius
struct Mat { color: vec4f, params: vec4f, surf: vec4f, emissive: vec4f };
@group(0) @binding(0) var<uniform> B: Bake;
@group(0) @binding(1) var smp: sampler;
@group(1) @binding(0) var<uniform> M: Mat;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) lp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) col: vec3f, @location(4) ao: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) col: vec3f, @location(4) ao: f32) -> VOut {
    var o: VOut;
    o.ao = ao;
    o.pos = B.viewProj * vec4f(p, 1.0);
    o.lp = p;
    o.n = n;
    o.uv = uv * M.params.z;
    o.col = col;
    return o;
}
struct FOut { @location(0) albedo: vec4f, @location(1) normal: vec4f, @location(2) surface: vec4f, @location(3) emissive: vec4f };
@fragment fn fsDepth(v: VOut) {
    let t = textureSample(tex, smp, v.uv);
    if (t.a * M.color.a < M.params.x) { discard; }
}
@fragment fn fs(v: VOut, @builtin(front_facing) ff: bool) -> FOut {
    let t = textureSample(tex, smp, v.uv);
    if (t.a * M.color.a < M.params.x) { discard; }
    var n = normalize(v.n);
    if (!ff && M.params.w > 0.5) { n = -n; }
    let depth = dot(v.lp - B.center.xyz, B.dir.xyz) * B.dir.w;          // -1..1, toward the viewer
    var o: FOut;
    o.albedo = vec4f(t.rgb * v.col * M.color.rgb, 1.0);
    o.normal = vec4f(n * 0.5 + 0.5, depth * 0.5 + 0.5);
    o.surface = vec4f(v.ao, M.surf.x, M.surf.y, M.params.y);
    o.emissive = vec4f(M.emissive.rgb / ${EMISSIVE_RANGE}.0, 1.0);
    return o;
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
    let o = i * ${VF}u;
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

return { WGSL_BAKE, WGSL_AO, WGSL_MIP };
});
