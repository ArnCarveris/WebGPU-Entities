'use strict';
// The origin's RendererExtension (the one Renderer, kits.gpu): bodies and instances.

Features.world('origin', (engine, kit) => {
const { MAX_BODIES, ORIGIN_BYTES, BODY_FLOATS, FRAME_FLOATS, VERTEX_FLOATS, SAMPLES, WGSL } = kit;
const TONE = 'fn tone(c: vec3f) -> vec3f { return pow(vec3f(1.0) - exp(-c * frame.misc.x), vec3f(1.0 / 2.2)); }';
const TONE_RADIANCE = `fn tone(c: vec3f) -> vec3f {
    let y = clamp(vec3f(1.0) - exp(-c * frame.misc.x), vec3f(0.0), vec3f(0.985));
    let a = 2.51 - 2.43 * y;
    let b = 0.03 - 0.59 * y;
    let k = -0.14 * y;
    return (-b + sqrt(b * b - 4.0 * a * k)) / (2.0 * a) * frame.misc.w;
}`;
if (!WGSL.includes(TONE)) throw new Error('origin: its tone curve is not where the radiance variant expects it');

class RendererExtension {
    static key = 'origin';
    // what it draws with alone (Renderer.frameSpec): display values, reversed depth (its own scale), MSAA. In a frame it
    // shares (frameSpec.shared) its sky is the frame's over a kit's own (space), its bodies and meshes go into the
    // frame's scene at its samples and depth format, and its depth is in metres (the origin's scale folded into its
    // projection: AppExtension.writeFrame)
    static frame = { display: 'display', depth: 'reversed', depthFormat: 'depth32float', samples: SAMPLES, near: kit.NEAR, ranks: { sky: 2 } };
    // what it answers on the Renderer (Common.Composite)
    static exposes = ['bodyData', 'depth', 'depthView', 'device', 'draws', 'format', 'frameData', 'fx', 'height',
        'init', 'layout', 'render', 'resize', 'setWorld', 'width', 'writeOrigin'];
    // the host's device and canvas (fx: the feature context, see js/engine/host.js)
    constructor(renderer, fx) {
        this.renderer = renderer;
        this.fx = fx;
    }

    async init() {
        const device = this.device = this.fx.device, spec = this.renderer.frameSpec;
        this.shared = !!spec?.shared;
        this.radiance = this.shared && spec.display === 'radiance';
        this.format = this.radiance ? 'rgba16float' : this.fx.format;
        const samples = this.shared ? spec.samples : SAMPLES, depthFormat = this.shared ? spec.depthFormat : 'depth32float';

        // (radiance: its tone curve's display value taken back through that kit's ACES and exposure, frame.misc.w the
        // reciprocal of that exposure)
        const module = device.createShaderModule({ code: this.radiance ? WGSL.replace(TONE, TONE_RADIANCE) : WGSL });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter(m => m.type === 'error');
        if (errors.length) throw new Error(errors.map(m => `WGSL ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));

        const U = GPUBufferUsage;
        this.frameData = new Float32Array(FRAME_FLOATS);
        this.frameBuf = device.createBuffer({ size: FRAME_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
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
        const multisample = { count: samples };
        const targets = [{ format: this.format }];
        // stars' glow (fsBody) is alpha-blended over the sky; opaque bodies write alpha 1
        const glow = [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }];
        const depth = { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' };
        const [sky, body, mesh] = await Promise.all([
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsSky' },
                fragment: { module, entryPoint: 'fsSky', targets },
                depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
            }),
            device.createRenderPipelineAsync({
                layout, multisample,
                vertex: { module, entryPoint: 'vsBody' },
                fragment: { module, entryPoint: 'fsBody', targets: glow },
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
        if (this.shared) return;
        for (const t of [this.msaa, this.depth]) t && t.destroy();
        this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.msaaView = this.msaa.createView();
        this.depthView = this.depth.createView();
    }

    // one frame (Renderer.encode, into the frame encoder): the scene pass: sky, outdoor (the bodies, the instanced meshes)
    render(world, bodyCount) {
        const d = this.device;
        d.queue.writeBuffer(this.frameBuf, 0, this.frameData);
        if (bodyCount) d.queue.writeBuffer(this.bodyBuf, 0, this.bodyData, 0, bodyCount * BODY_FLOATS);
        this.renderer.encode({ world, bodyCount });
    }

    scene(f) {
        const pass = f.enc.beginRenderPass({
            colorAttachments: [{ view: this.msaaView, resolveTarget: this.fx.target(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        pass.setBindGroup(0, this.bindGroup);
        return pass;
    }

    // its bind group back on the scene pass after another kit drew in it (a shared frame: Renderer.encodeFrame)
    bind(f) { f.pass.setBindGroup(0, this.bindGroup); }

    sky(f) {
        f.pass.setPipeline(this.skyPipe);
        f.pass.draw(3);
    }

    // under another kit's sky (a frame it shares: the atmosphere's), space is the background it is drawn over: the stars,
    // the bodies, the instanced meshes
    background(f) {
        if (!this.shared || this.renderer.frameSpec.sky === RendererExtension.key) return;
        this.sky(f);
        this.draw(f);
    }

    outdoor(f) { if (!this.shared || this.renderer.frameSpec.sky === RendererExtension.key) this.draw(f); }

    draw(f) {
        const { pass, world, bodyCount } = f;
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
        this.draws = draws + 1 + (bodyCount ? 1 : 0);
    }
}

return { RendererExtension };
});
