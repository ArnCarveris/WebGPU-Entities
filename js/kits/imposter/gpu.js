'use strict';
// ImposterGpu: what the kit keeps per GPU device: samplers, the bind group layouts its shaders declare, and its
// pipelines (made on first use).

Features.kit('imposter', (engine, kit) => {
const { EMISSIVE_FORMAT, BAKE_MSAA, BAKE_DEPTH_FORMAT, atlasLayers, MESH_BUFFERS, WGSL_BAKE, WGSL_AO, WGSL_MIP } = kit;

const perDevice = new WeakMap();

class ImposterGpu {
    // one per device, shared by everything that bakes or draws imposters on it
    static of(device) {
        let g = perDevice.get(device);
        if (!g) perDevice.set(device, g = new ImposterGpu(device));
        return g;
    }

    constructor(device) {
        const d = this.device = device, S = GPUShaderStage;
        this.clampSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.repSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
        this.blackTexture = d.createTexture({ size: [1, 1], format: EMISSIVE_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        d.queue.writeTexture({ texture: this.blackTexture }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);

        const tex = binding => ({ binding, visibility: S.FRAGMENT, texture: {} });
        const smp = binding => ({ binding, visibility: S.FRAGMENT, sampler: {} });
        const layout = (...entries) => d.createBindGroupLayout({ entries });
        // bakes: group 0, the frame (WGSL_BAKE_FRAME: one 256-byte slot per frame, dynamic offset; the source's sampler)
        this.frameLayout = layout({ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } }, smp(1));
        // the standard mesh's material (WGSL_BAKE's group 1: the Mat uniform, its texture)
        this.materialLayout = layout({ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, tex(1));
        // draws: an atlas (imposterWGSL's group: ImpAtlas, 4 layers, sampler; ImposterAtlas.bg)
        this.atlasLayout = layout({ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, tex(1), tex(2), tex(3), tex(4), smp(5));
        // draws: an instance list (one read-only storage buffer, LodLists' lists and sources)
        this.instanceLayout = layout({ binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } });
        // culling: lodListsWGSL's group (LodLists.cullBG)
        this.listsLayout = layout(
            { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } }, { binding: 1, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.COMPUTE, buffer: { type: 'storage' } }, { binding: 3, visibility: S.COMPUTE, buffer: { type: 'storage' } },
            { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        );
        this.mipLayout = layout({ binding: 0, visibility: S.FRAGMENT, texture: {} }, smp(1));
        this.aoLayout = layout(
            { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } }, { binding: 1, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: S.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
            { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        );
        this.cache = new Map();
    }

    once(key, make) {
        let v = this.cache.get(key);
        if (v === undefined) this.cache.set(key, v = make());
        return v;
    }

    module(code) { return this.once(code, () => this.device.createShaderModule({ code })); }

    // a pipeline rendering a source's own shader into the atlas: its module (WGSL_BAKE_FRAME + its code), vertex /
    // fragment entry points, vertex buffers, the bind group layouts of its groups 1.., cull mode, and whether the
    // atlas has the emissive layer. Cached by `key` when given.
    bakePipeline({ key, module, vertex = 'vs', fragment = 'fs', buffers = [], layouts = [], cullMode = 'back', emissive = false }) {
        const make = () => this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, ...layouts] }),
            vertex: { module, entryPoint: vertex, buffers },
            fragment: { module, entryPoint: fragment, targets: atlasLayers(emissive).map(([, format]) => ({ format })) },
            primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
            depthStencil: { format: BAKE_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' }, multisample: { count: BAKE_MSAA },
        });
        return key ? this.once(`bake:${key}:${cullMode}:${emissive}`, make) : make();
    }

    // the standard mesh's bake pipeline (meshSource)
    meshBakePipe(emissive, doubleSided) {
        return this.bakePipeline({ key: 'mesh', module: this.module(WGSL_BAKE), buffers: MESH_BUFFERS, layouts: [this.materialLayout], cullMode: doubleSided ? 'none' : 'back', emissive });
    }

    // the standard mesh's depth from one direction (bakeVertexAO)
    get aoDepthPipe() {
        return this.once('aoDepth', () => this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout] }),
            vertex: { module: this.module(WGSL_BAKE), entryPoint: 'vs', buffers: MESH_BUFFERS },
            fragment: { module: this.module(WGSL_BAKE), entryPoint: 'fsDepth', targets: [] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        }));
    }

    get aoPipe() {
        return this.once('ao', () => this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.aoLayout] }), compute: { module: this.module(WGSL_AO), entryPoint: 'main' },
        }));
    }

    // box-filter downsampling into one mip level of `format`
    mipPipe(format) {
        return this.once(`mip:${format}`, () => this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.mipLayout] }),
            vertex: { module: this.module(WGSL_MIP), entryPoint: 'vs' }, fragment: { module: this.module(WGSL_MIP), entryPoint: 'fs', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        }));
    }
}

return { ImposterGpu };
});
