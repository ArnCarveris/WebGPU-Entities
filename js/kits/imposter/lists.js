'use strict';
// LOD lists: GPU culling of a model's instances into mesh and imposter lists that feed indirect draws (LodLists and
// lodListsWGSL), and drawImposters, one atlas's indirect imposter draw.

Features.kit('imposter', (engine, kit) => {
const { ImposterGpu } = kit;

const IMPOSTER_VERTICES = 6;                // an imposter draw: one quad (IMP_QUAD) per instance

// LodLists: one model's instances (`src`) and `lists` culled lists of them (say: the camera, then one per shadow
// cascade), each `seg` instances long, in two buffers: meshOut and impOut. A cull dispatch (a shader over
// lodListsWGSL, one thread per instance, bound with cullBG) appends instances with lodPush, counting straight into the
// indirect args: per list, `setStride` bytes: 0..15 the imposter drawIndirect (vertexCount IMPOSTER_VERTICES), then a
// drawIndexedIndirect per submesh. reset() rewrites them from a template (instance counts 0) before each cull, so
// there are no per-list copies or clears. Draws bind meshBG[list] / impBG[list] (ImposterGpu.instanceLayout) and read
// meshArgs(list, i) / impArgs(list); srcBG binds the unculled instances.
//
// opts: { count, instanceBytes, submeshes: [{ first, count }] (index ranges), lists }
class LodLists {
    constructor(device, { count, instanceBytes, submeshes, lists }) {
        const g = ImposterGpu.of(device), d = this.device = device, U = GPUBufferUsage;
        this.count = count;
        this.lists = lists;
        this.subs = submeshes.length;
        this.seg = Math.max(16, Math.ceil(count / 16) * 16);     // 16 instances of 48 bytes = 768: lists start 256-aligned
        const listBytes = this.seg * instanceBytes;
        this.setStride = 16 + 20 * submeshes.length;
        this.src = d.createBuffer({ size: Math.max(1, count) * instanceBytes, usage: U.STORAGE | U.COPY_DST });
        this.meshOut = d.createBuffer({ size: listBytes * lists, usage: U.STORAGE });
        this.impOut = d.createBuffer({ size: listBytes * lists, usage: U.STORAGE });
        this.args = d.createBuffer({ size: this.setStride * lists, usage: U.INDIRECT | U.STORAGE | U.COPY_SRC | U.COPY_DST });
        this.params = d.createBuffer({ size: 48, usage: U.UNIFORM | U.COPY_DST });
        const args = new Uint32Array(this.setStride / 4 * lists);
        for (let k = 0, o = 0; k < lists; k++, o += this.setStride / 4) {
            args[o] = IMPOSTER_VERTICES;
            submeshes.forEach((s, i) => { args[o + 4 + 5 * i] = s.count; args[o + 4 + 5 * i + 2] = s.first; });
        }
        this.argsTemplate = args;
        this.cullBG = d.createBindGroup({ layout: g.listsLayout, entries: [
            { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.src } },
            { binding: 2, resource: { buffer: this.meshOut } }, { binding: 3, resource: { buffer: this.impOut } },
            { binding: 4, resource: { buffer: this.args } },
        ] });
        const list = (buffer, k) => d.createBindGroup({ layout: g.instanceLayout, entries: [{ binding: 0, resource: { buffer, offset: k * listBytes, size: listBytes } }] });
        this.meshBG = Array.from({ length: lists }, (_, k) => list(this.meshOut, k));
        this.srcBG = d.createBindGroup({ layout: g.instanceLayout, entries: [{ binding: 0, resource: { buffer: this.src } }] });
        this.impBG = Array.from({ length: lists }, (_, k) => list(this.impOut, k));
    }

    // the cull's LodParams: hasImposter (else every instance is a mesh), the bound (radius, centre, object space),
    // lodScale (the model's factor on the LOD distance), casts (fill the lists after the first)
    writeParams({ hasImposter, radius, lodScale, center, casts }) {
        const buf = new ArrayBuffer(48), u = new Uint32Array(buf), f = new Float32Array(buf);
        u[0] = this.count; u[1] = hasImposter ? 1 : 0; f[2] = radius; f[3] = lodScale;
        f.set(center, 4);
        u[8] = this.seg; u[9] = casts ? 1 : 0; u[10] = this.setStride / 4; u[11] = this.subs;
        this.device.queue.writeBuffer(this.params, 0, buf);
    }

    reset() { this.device.queue.writeBuffer(this.args, 0, this.argsTemplate); }

    impArgs(list) { return list * this.setStride; }
    meshArgs(list, i) { return list * this.setStride + 16 + 20 * i; }

    // instances in list `list` (mesh or imposters) from the args read back as u32 words, starting at word `base`
    counted(u, base, list, mesh) { return u[base + list * this.setStride / 4 + (mesh ? 5 : 1)] * (mesh ? (this.subs ? 1 : 0) : 1); }

    destroy() { for (const b of [this.src, this.meshOut, this.impOut, this.args, this.params]) b.destroy(); }
}

// The cull shader's side of LodLists at @group(group) (ImposterGpu.listsLayout), over the renderer's instance struct
// `inst`: lodP (LodParams), lodSrc (the instances), lodPush(list, mesh, instance) (append to a list, counting into the
// args) and lodFade(mode, d, start, band) (the mesh's share at distance d: mode 0 auto, 1 mesh, 2 imposter; auto fades
// from 1 at `start` to 0 at start * (1 + band); the instances in between go to both lists, which dither
// complementary pixels by it)
const lodListsWGSL = ({ group = 1, inst = 'Inst' } = {}) => /* wgsl */`
struct LodParams { count: u32, hasImp: u32, radius: f32, lodScale: f32, center: vec4f, seg: u32, casts: u32, setWords: u32, subs: u32 };
@group(${group}) @binding(0) var<uniform> lodP: LodParams;
@group(${group}) @binding(1) var<storage, read> lodSrc: array<${inst}>;
@group(${group}) @binding(2) var<storage, read_write> lodMesh: array<${inst}>;
@group(${group}) @binding(3) var<storage, read_write> lodImp: array<${inst}>;
@group(${group}) @binding(4) var<storage, read_write> lodArgs: array<atomic<u32>>;

// the imposter draw's instanceCount counts imposters, the first submesh's counts meshes and the others follow it
fn lodPush(list: u32, mesh: bool, o: ${inst}) {
    let base = list * lodP.setWords;
    if (!mesh) {
        lodImp[list * lodP.seg + atomicAdd(&lodArgs[base + 1u], 1u)] = o;
    } else if (lodP.subs > 0u) {
        let k = atomicAdd(&lodArgs[base + 5u], 1u);
        lodMesh[list * lodP.seg + k] = o;
        for (var i = 1u; i < lodP.subs; i++) { atomicMax(&lodArgs[base + 5u + 5u * i], k + 1u); }
    }
}

fn lodFade(mode: u32, d: f32, start: f32, band: f32) -> f32 {
    if (mode == 2u) { return 0.0; }
    if (mode == 0u) { return 1.0 - clamp((d - start) / max(start * band, 1e-3), 0.0, 1.0); }
    return 1.0;
}
`;

// one atlas's imposters from an instance list: the imposter pipeline is set; args at offset hold its drawIndirect
// (vertexCount IMPOSTER_VERTICES, instanceCount filled by the GPU)
function drawImposters(pass, atlas, instances, args, offset = 0, { atlasGroup = 1, instanceGroup = 2 } = {}) {
    pass.setBindGroup(atlasGroup, atlas.bg);
    pass.setBindGroup(instanceGroup, instances);
    pass.drawIndirect(args, offset);
}

return { IMPOSTER_VERTICES, LodLists, lodListsWGSL, drawImposters };
});
