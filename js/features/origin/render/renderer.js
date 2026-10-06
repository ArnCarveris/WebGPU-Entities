'use strict';
// The renderer: bodies and instances.

Features.part('origin', (engine, feature) => {
const { MAX_BODIES, ORIGIN_BYTES, BODY_FLOATS, FRAME_FLOATS, VERTEX_FLOATS, SAMPLES, WGSL } = feature;

class Renderer {
    // the host's device and canvas (fx: the feature context, see js/engine/host.js)
    constructor(fx) { this.fx = fx; }

    async init() {
        const device = this.device = this.fx.device;
        this.format = this.fx.format;

        const module = device.createShaderModule({ code: WGSL });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter(m => m.type === 'error');
        if (errors.length) throw new Error(errors.map(m => `WGSL ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));

        const U = GPUBufferUsage;
        this.frameData = new Float32Array(FRAME_FLOATS);
        this.frameBuf = device.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
        this.originBuf = device.createBuffer({ size: ORIGIN_BYTES, usage: U.UNIFORM | U.COPY_DST });
        this.bodyData = new Float32Array(MAX_BODIES * BODY_FLOATS);
        this.bodyBuf = device.createBuffer({ size: this.bodyData.byteLength, usage: U.STORAGE | U.COPY_DST });

        const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.layout = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
            { binding: 1, visibility: vf, buffer: { type: 'uniform' } },
            { binding: 2, visibility: vf, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: vf, buffer: { type: 'read-only-storage' } },
            { binding: 4, visibility: vf, buffer: { type: 'read-only-storage' } },
        ] });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
        const multisample = { count: SAMPLES };
        const targets = [{ format: this.format }];
        const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
        const [sky, body, mesh] = await Promise.all([
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsSky' },
                fragment: { module, entryPoint: 'fsSky', targets },
                depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
            }),
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsBody' },
                fragment: { module, entryPoint: 'fsBody', targets },
                primitive: { cullMode: 'front' },   // inner faces: works from inside the bounding cube too
                depthStencil: depth,
            }),
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsMesh', buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    { shaderLocation: 2, offset: 24, format: 'uint32' },
                ] }] },
                fragment: { module, entryPoint: 'fsMesh', targets },
                primitive: { cullMode: 'none' },
                depthStencil: depth,
            }),
        ]);
        this.skyPipe = sky;
        this.bodyPipe = body;
        this.meshPipe = mesh;
        this.width = this.height = 0;
    }

    // world geometry, materials and instances: uploaded once per world build
    setWorld(world) {
        const d = this.device, U = GPUBufferUsage;
        for (const b of [this.vb, this.ib, this.matBuf]) b && b.destroy();
        const g = world.geometry;
        this.vb = d.createBuffer({ size: Math.max(16, g.vertices.byteLength), usage: U.VERTEX | U.COPY_DST });
        this.ib = d.createBuffer({ size: Math.max(16, g.indices.byteLength), usage: U.INDEX | U.COPY_DST });
        this.matBuf = d.createBuffer({ size: world.materials.data.byteLength, usage: U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.vb, 0, g.vertices);
        d.queue.writeBuffer(this.ib, 0, g.indices);
        d.queue.writeBuffer(this.matBuf, 0, world.materials.data);
        this.bindGroup = d.createBindGroup({ layout: this.layout, entries: [
            { binding: 0, resource: { buffer: this.frameBuf } },
            { binding: 1, resource: { buffer: this.originBuf } },
            { binding: 2, resource: { buffer: this.matBuf } },
            { binding: 3, resource: { buffer: world.store.buffer } },
            { binding: 4, resource: { buffer: this.bodyBuf } },
        ] });
    }

    // the whole cost of a rebase
    writeOrigin(origin) { this.device.queue.writeBuffer(this.originBuf, 0, origin.gpu); }

    resize() {
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height) return;
        this.width = w;
        this.height = h;
        for (const t of [this.msaa, this.depth]) t && t.destroy();
        this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.msaaView = this.msaa.createView();
        this.depthView = this.depth.createView();
    }

    render(world, bodyCount) {
        const d = this.device;
        d.queue.writeBuffer(this.frameBuf, 0, this.frameData);
        if (bodyCount) d.queue.writeBuffer(this.bodyBuf, 0, this.bodyData, 0, bodyCount * BODY_FLOATS);
        const enc = d.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.msaaView, resolveTarget: this.fx.target(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        pass.setBindGroup(0, this.bindGroup);
        pass.setPipeline(this.skyPipe);
        pass.draw(3);
        if (bodyCount) { pass.setPipeline(this.bodyPipe); pass.draw(36, bodyCount); }
        pass.setPipeline(this.meshPipe);
        pass.setVertexBuffer(0, this.vb);
        pass.setIndexBuffer(this.ib, 'uint32');
        let draws = 0;
        for (const m of world.modelList) {
            if (!m.instances.length || !m.indexCount) continue;
            pass.drawIndexed(m.indexCount, m.instances.length, m.firstIndex, 0, m.first);
            draws++;
        }
        pass.end();
        d.queue.submit([enc.finish()]);
        this.draws = draws + 1 + (bodyCount ? 1 : 0);
    }
}

return { Renderer };
});
