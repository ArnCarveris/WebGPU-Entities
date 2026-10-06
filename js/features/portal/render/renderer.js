'use strict';
// The renderer: pipelines, buffers and the draw of one frame.

Features.part('portal', (engine, feature) => {
const {
    AREA_FLOATS, MAX_DRAWS, DRAW_STRIDE, MAX_FOG_PORTALS, DRAW_FLOATS, MAX_LINE_VERTS, MAX_POLY_VERTS, POLY_FLOATS,
    DEPTH_FORMAT, WGSL_WORLD, WGSL_SKY, WGSL_POLY, WGSL_LINES,
} = feature;

// Renderer: pipelines for the scene, sky, stencil marks, water, glass / fog veils and debug lines, and one
// render pass that executes a command list built by FrameBuilder.

function depthState(o) {
    const face = { compare: o.sCompare || 'always', failOp: 'keep', depthFailOp: 'keep', passOp: o.sPass || 'keep' };
    return {
        format: DEPTH_FORMAT, depthWriteEnabled: !!o.write, depthCompare: o.compare || 'less',
        stencilFront: face, stencilBack: face, stencilReadMask: o.read ?? 0xFF, stencilWriteMask: o.writeMask ?? 0,
    };
}

class Renderer {
    // fx: the feature context (the host's device and canvas target; see js/engine/host.js)
    constructor(fx) { this.fx = fx; this.onError = (msg) => console.error(msg); }

    async init() {
        const device = this.device = this.fx.device;
        this.format = this.fx.format;

        const U = GPUBufferUsage;
        this.globalBuf = device.createBuffer({ size: 224, usage: U.UNIFORM | U.COPY_DST });
        this.drawBuf = device.createBuffer({ size: MAX_DRAWS * DRAW_STRIDE, usage: U.UNIFORM | U.COPY_DST });
        this.lineBuf = device.createBuffer({ size: MAX_LINE_VERTS * 28, usage: U.VERTEX | U.COPY_DST });
        this.polyBuf = device.createBuffer({ size: MAX_POLY_VERTS * POLY_FLOATS * 4, usage: U.VERTEX | U.COPY_DST });
        this.drawData = new Float32Array(MAX_DRAWS * DRAW_STRIDE / 4);

        const S = GPUShaderStage;
        this.bgl0 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: S.FRAGMENT, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ] });
        this.bgl1 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_FLOATS * 4 } },
        ] });
        this.drawBG = device.createBindGroup({ layout: this.bgl1, entries: [{ binding: 0, resource: { buffer: this.drawBuf, size: DRAW_FLOATS * 4 } }] });
        const worldLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl0, this.bgl1] });
        const baseLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl0] });
        const ms = { count: 4 };
        const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

        const worldMod = device.createShaderModule({ code: WGSL_WORLD });
        const world = stencil => device.createRenderPipeline({
            layout: worldLayout,
            vertex: { module: worldMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'uint32' },
            ] }] },
            fragment: { module: worldMod, entryPoint: 'fs', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: depthState({ write: true, compare: 'less', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.worldStencil = world(true);
        this.worldPlain = world(false);

        const skyMod = device.createShaderModule({ code: WGSL_SKY });
        const sky = stencil => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: skyMod, entryPoint: 'vs' },
            fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: depthState({ compare: 'less-equal', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.skyStencil = sky(true);
        this.skyPlain = sky(false);

        const polyMod = device.createShaderModule({ code: WGSL_POLY });
        const polyVB = [{ arrayStride: POLY_FLOATS * 4, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' },
            { shaderLocation: 3, offset: 40, format: 'float32' },
        ] }];
        const mark = ds => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsMark', targets: [{ format: this.format, writeMask: 0 }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState(ds),
            multisample: ms,
        });
        // three passes over the child's clipped portal polygon:
        //  A: where stencil == parent and the aperture is not hidden by nearer geometry, set bit 7
        //  B: where bit 7 is set, write the child's ref into bits 0..6
        //  C: clear bit 7
        this.markA = mark({ compare: 'less-equal', sCompare: 'equal', sPass: 'invert', read: 0x7F, writeMask: 0x80 });
        this.markB = mark({ compare: 'always', sCompare: 'equal', sPass: 'replace', read: 0x80, writeMask: 0x7F });
        this.markC = mark({ compare: 'always', sCompare: 'equal', sPass: 'zero', read: 0x80, writeMask: 0x80 });
        const water = stencil => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsWater', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.waterStencil = water(true);
        this.waterPlain = water(false);
        this.veilPipe = device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsVeil', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal' }),
            multisample: ms,
        });
        this.glassPipe = device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsGlass', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal' }),
            multisample: ms,
        });

        const lineMod = device.createShaderModule({ code: WGSL_LINES });
        const lines = compare => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: lineMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ] }] },
            fragment: { module: lineMod, entryPoint: 'fs', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'line-list' },
            depthStencil: depthState({ compare }),
            multisample: ms,
        });
        this.lineDepthPipe = lines('less-equal');
        this.lineOverlayPipe = lines('always');
    }

    upload(world) {
        const d = this.device, U = GPUBufferUsage;
        for (const b of [this.vbuf, this.ibuf, this.matBuf, this.areaBuf]) b?.destroy();
        const { vertices, indices } = world.pool.arrays();
        this.vbuf = d.createBuffer({ size: Math.max(16, vertices.byteLength), usage: U.VERTEX | U.COPY_DST });
        this.ibuf = d.createBuffer({ size: Math.max(16, indices.byteLength), usage: U.INDEX | U.COPY_DST });
        d.queue.writeBuffer(this.vbuf, 0, vertices);
        d.queue.writeBuffer(this.ibuf, 0, indices);
        this.matBuf = d.createBuffer({ size: world.materials.data.byteLength, usage: U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.matBuf, 0, world.materials.data);
        this.areaBuf = d.createBuffer({ size: world.areas.length * AREA_FLOATS * 4, usage: U.STORAGE | U.COPY_DST });
        this.bg0 = d.createBindGroup({ layout: this.bgl0, entries: [
            { binding: 0, resource: { buffer: this.globalBuf } },
            { binding: 1, resource: { buffer: this.areaBuf } },
            { binding: 2, resource: { buffer: this.matBuf } },
        ] });
    }

    resize(W, H) {
        if (this.W === W && this.H === H) return;
        this.W = W; this.H = H;
        this.msaa?.destroy(); this.depth?.destroy();
        this.msaa = this.device.createTexture({ size: [W, H], sampleCount: 4, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        // sampled too: a composition reads its depth (js/engine/compositor.js)
        this.depth = this.device.createTexture({ size: [W, H], sampleCount: 4, format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.depthSample = this.depth.createView({ aspect: 'depth-only' });
    }

    // f.cmds: draw | sky | mark | glass | veil | water, executed in order (portal-tree DFS in stencil mode)
    // f.draws: one { o, fog } per draw slot; fog = the portals it is seen through, nearest first
    render(f) {
        const d = this.device, q = d.queue, W = this.W, H = this.H;
        q.writeBuffer(this.globalBuf, 0, f.globals);
        q.writeBuffer(this.areaBuf, 0, f.areas);
        const F = DRAW_STRIDE / 4, nSlots = Math.min(f.draws.length, MAX_DRAWS), D = this.drawData;
        for (let i = 0; i < nSlots; i++) {
            const { o, fog } = f.draws[i], k = i * F, n = Math.min(fog.length, MAX_FOG_PORTALS);
            D.set(o.model, k);
            D[k + 16] = o.lightArea; D[k + 17] = n;
            D[k + 20] = 1; D[k + 21] = 1; D[k + 22] = 1; D[k + 23] = 1;
            for (let j = 0; j < n; j++) {
                D.set(fog[j].plane, k + 24 + j * 4);
                D.set(fog[j].fog, k + 24 + (MAX_FOG_PORTALS + j) * 4);
            }
        }
        if (nSlots) q.writeBuffer(this.drawBuf, 0, this.drawData, 0, nSlots * F);
        const polyVerts = Math.min(f.polys.length / POLY_FLOATS, MAX_POLY_VERTS);
        if (polyVerts) q.writeBuffer(this.polyBuf, 0, f.polys, 0, polyVerts * POLY_FLOATS);
        const lineVerts = Math.min(f.lines.length / 7, MAX_LINE_VERTS);
        if (lineVerts) q.writeBuffer(this.lineBuf, 0, f.lines, 0, lineVerts * 7);

        const enc = d.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.fx.target(),
                clearValue: { r: 0.004, g: 0.005, b: 0.007, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
                stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
        });
        const scissor = r => {
            const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1])), x1 = Math.min(W, Math.ceil(r[2])), y1 = Math.min(H, Math.ceil(r[3]));
            if (x1 <= x0 || y1 <= y0) return false;
            pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
            return true;
        };
        let pipe = null, vb = null;
        const use = (p, buffer) => {
            if (p !== pipe) { pass.setPipeline(p); pipe = p; }
            if (buffer && buffer !== vb) { pass.setVertexBuffer(0, buffer); vb = buffer; }
        };
        pass.setBindGroup(0, this.bg0);
        pass.setIndexBuffer(this.ibuf, 'uint32');
        const worldPipe = f.stencil ? this.worldStencil : this.worldPlain, skyPipe = f.stencil ? this.skyStencil : this.skyPlain;
        for (const c of f.cmds) {
            if (!scissor(c.rect)) continue;
            switch (c.op) {
                case 'draw':
                    if (c.slot >= MAX_DRAWS) break;
                    use(worldPipe, this.vbuf);
                    pass.setStencilReference(c.ref);
                    pass.setBindGroup(1, this.drawBG, [c.slot * DRAW_STRIDE]);
                    pass.drawIndexed(c.chunk.count, 1, c.chunk.first, c.chunk.baseVertex, 0);
                    break;
                case 'sky':
                    use(skyPipe);
                    pass.setStencilReference(c.ref);
                    pass.draw(3);
                    break;
                case 'mark':
                    use(this.markA, this.polyBuf); pass.setStencilReference(c.parent); pass.draw(c.count, 1, c.first);
                    use(this.markB); pass.setStencilReference(0x80 | c.child); pass.draw(c.count, 1, c.first);
                    use(this.markC); pass.setStencilReference(0x80); pass.draw(c.count, 1, c.first);
                    break;
                case 'water':
                    use(f.stencil ? this.waterStencil : this.waterPlain, this.polyBuf);
                    pass.setStencilReference(c.ref);
                    pass.draw(c.count, 1, c.first);
                    break;
                case 'glass':
                case 'veil':
                    use(c.op === 'glass' ? this.glassPipe : this.veilPipe, this.polyBuf);
                    pass.draw(c.count, 1, c.first);
                    break;
            }
        }
        if (lineVerts) {
            pass.setScissorRect(0, 0, W, H);
            const nd = Math.min(f.lineDepthCount, lineVerts);
            if (nd) { use(this.lineDepthPipe, this.lineBuf); pass.draw(nd, 1, 0); }
            if (lineVerts > nd) { use(this.lineOverlayPipe, this.lineBuf); pass.draw(lineVerts - nd, 1, nd); }
        }
        pass.end();
        q.submit([enc.finish()]);
    }
}

return { Renderer };
});
