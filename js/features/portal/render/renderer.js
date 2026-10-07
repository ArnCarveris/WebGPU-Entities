'use strict';
// The renderer: pipelines, buffers and the draw of one frame.

Features.part('portal', (engine, feature) => {
const {
    AREA_FLOATS, MAX_DRAWS, DRAW_STRIDE, MAX_FOG_PORTALS, DRAW_FLOATS, MAX_LINE_VERTS, MAX_POLY_VERTS, POLY_FLOATS,
    DEPTH_FORMAT, STENCIL, WGSL_WORLD, WGSL_SKY, WGSL_POLY, WGSL_LINES,
} = feature;
const { StencilLayout, buildPipelines, RenderExtensions } = engine.kits.gpu;

// Renderer: pipelines for the scene, sky, stencil marks, water, glass / fog veils and debug lines, and one render pass
// that executes a command list built by FrameBuilder, into the canvas or a view target (render(f, target), with its
// own MSAA colour and depth).
//
// Its depth-stencil target's bits are a StencilLayout (js/kits/gpu/stencil.js) with the slots of STENCIL
// (core/config.js): "portal.regions", one value per portal entry's region (FrameBuilder numbers them 1..capacity), and
// "portal.mark", the flag that marks an aperture while its child's region is written. The pipelines are a table
// (js/kits/gpu/pipelines.js) that names those slots; no stencil value or mask is written here.
//
// Everything else it draws comes from render extensions (js/kits/gpu/extensions.js), registered for 'portal' by any
// kit or part, or added with extend() before init(): the GUI screens are one (render/gui-pass.js). Besides name,
// stencil, init and pipelines, a portal extension may have
//   overlay(o)        a command ({ op, ... }) for a visible object, emitted by FrameBuilder after its entry's objects
//                     (it gets chunk, slot, ref and rect: the object's geometry, draw slot, region and scissor)
//   info(o)           the object's draw slot info.z (a number), when the extension's shader reads it
//   prepare(f, enc, target)  passes of its own before the frame's pass (render targets its commands then sample)
//   commands: { op(c, x) }   draws its commands; x: the pass and helpers (see render())
// ctx (init / pipelines) carries the renderer's modules (world, sky, poly, lines), layouts (world: groups 0 + 1, base:
// group 0), bind group layouts (bgl0, bgl1), buffers, blends, and `region`, the slots a draw in its entry's region tests.

class Renderer {
    // fx: the feature context (the host's device and canvas target; see js/engine/host.js)
    constructor(fx) {
        this.fx = fx;
        this.onError = (msg) => console.error(msg);
        this.stencil = new StencilLayout();
        for (const [name, spec] of Object.entries(STENCIL)) this.stencil.reserve(name, spec);
        this.regions = this.stencil.slot('portal.regions');
        this.targets = new Map();       // view target -> its MSAA colour and depth
        this.ext = {};                  // render extensions by name
        this.exts = [];
        this.handlers = new Map();      // command op -> its extension
        for (const make of RenderExtensions.for('portal')) this.extend(make(this));
    }

    // a render extension (see above), before init()
    extend(ext) {
        if (this.stencil.resolved) throw new Error(`render extension "${ext.name}": added after init()`);
        if (this.ext[ext.name]) throw new Error(`render extension "${ext.name}": added twice`);
        for (const [name, spec] of Object.entries(ext.stencil || {})) this.stencil.reserve(name, spec);
        for (const op of Object.keys(ext.commands || {})) {
            if (this.handlers.has(op)) throw new Error(`render extension "${ext.name}": command "${op}" is "${this.handlers.get(op).name}"'s`);
            this.handlers.set(op, ext);
        }
        this.ext[ext.name] = ext;
        this.exts.push(ext);
        return ext;
    }

    // the extensions FrameBuilder asks for overlay commands
    get overlays() { return this.exts.filter(x => x.overlay); }

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

        const mod = code => device.createShaderModule({ code });
        const ctx = {
            device, format: this.format, depthFormat: DEPTH_FORMAT, samples: 4, stencil: this.stencil,
            modules: { world: mod(WGSL_WORLD), sky: mod(WGSL_SKY), poly: mod(WGSL_POLY), lines: mod(WGSL_LINES) },
            layouts: {
                world: device.createPipelineLayout({ bindGroupLayouts: [this.bgl0, this.bgl1] }),
                base: device.createPipelineLayout({ bindGroupLayouts: [this.bgl0] }),
            },
            bgl0: this.bgl0, bgl1: this.bgl1, region: ['portal.regions'],
            buffers: {
                world: [{ arrayStride: 28, attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    { shaderLocation: 2, offset: 24, format: 'uint32' },
                ] }],
                poly: [{ arrayStride: POLY_FLOATS * 4, attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' },
                    { shaderLocation: 3, offset: 40, format: 'float32' },
                ] }],
                lines: [{ arrayStride: 28, attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' },
                ] }],
            },
            blends: { alpha: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } },
        };
        for (const x of this.exts) await x.init?.(this, ctx);
        const R = ['portal.regions'], M = ['portal.mark'];
        // stencil mode draws inside its entry's region; scissor / none modes draw unmasked
        const masked = { stencil: { stencil: { test: R } }, plain: {} };
        const poly = fs => ({ layout: 'base', module: 'poly', vs: 'vs', fs, buffers: 'poly' });
        const lines = compare => ({ layout: 'base', module: 'lines', vs: 'vs', fs: 'fs', buffers: 'lines', topology: 'line-list', blend: 'alpha', depth: { compare } });
        this.pipes = buildPipelines(ctx, {
            world: { layout: 'world', module: 'world', vs: 'vs', fs: 'fs', buffers: 'world', cull: 'back', depth: { write: true, compare: 'less' }, variants: masked },
            sky: { layout: 'base', module: 'sky', vs: 'vs', fs: 'fs', depth: { compare: 'less-equal' }, variants: masked },
            // three passes over the child's clipped portal polygon:
            //  A: where the parent's region is and the aperture is not hidden by nearer geometry, set the mark
            //  B: where the mark is, write the child's region
            //  C: clear the mark
            markA: { ...poly('fsMark'), colorWrite: false, depth: { compare: 'less-equal' }, stencil: { test: R, op: 'invert', write: M } },
            markB: { ...poly('fsMark'), colorWrite: false, depth: { compare: 'always' }, stencil: { test: M, op: 'replace', write: R } },
            markC: { ...poly('fsMark'), colorWrite: false, depth: { compare: 'always' }, stencil: { test: M, op: 'zero', write: M } },
            water: { ...poly('fsWater'), blend: 'alpha', depth: { compare: 'less-equal' }, variants: masked },
            veil: { ...poly('fsVeil'), blend: 'alpha', depth: { compare: 'less-equal' } },
            glass: { ...poly('fsGlass'), blend: 'alpha', depth: { compare: 'less-equal' } },
            lineDepth: lines('less-equal'),
            lineOverlay: lines('always'),
        });
        for (const x of this.exts) if (x.pipelines) x.pipes = buildPipelines(ctx, x.pipelines(ctx));
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

    // a view target's MSAA colour and depth (its size, sampled by nobody)
    attachments(target) {
        let a = this.targets.get(target);
        if (!a) {
            const size = [target.width, target.height], U = GPUTextureUsage;
            a = {
                msaa: this.device.createTexture({ size, sampleCount: 4, format: this.format, usage: U.RENDER_ATTACHMENT }).createView(),
                depth: this.device.createTexture({ size, sampleCount: 4, format: DEPTH_FORMAT, usage: U.RENDER_ATTACHMENT }).createView(),
            };
            this.targets.set(target, a);
        }
        return a;
    }

    // the draw slot info.z of an object: the first extension's that has one
    info(o) {
        for (const x of this.exts) {
            const v = x.info?.(o);
            if (v !== undefined) return v;
        }
        return 0;
    }

    // f.cmds: draw | sky | mark | glass | veil | water and the extensions' ops, executed in order (portal-tree DFS in
    // stencil mode)
    // f.draws: one { o, fog } per draw slot; fog = the portals it is seen through, nearest first
    // target: a view target (js/kits/gui/views.js) instead of the canvas
    render(f, target = null) {
        const d = this.device, q = d.queue, W = target ? target.width : this.W, H = target ? target.height : this.H;
        const into = target ? { ...this.attachments(target), resolve: target.colorView } : { msaa: this.msaa.createView(), depth: this.depth.createView(), resolve: this.fx.target() };
        q.writeBuffer(this.globalBuf, 0, f.globals);
        q.writeBuffer(this.areaBuf, 0, f.areas);
        const F = DRAW_STRIDE / 4, nSlots = Math.min(f.draws.length, MAX_DRAWS), D = this.drawData;
        for (let i = 0; i < nSlots; i++) {
            const { o, fog } = f.draws[i], k = i * F, n = Math.min(fog.length, MAX_FOG_PORTALS);
            D.set(o.model, k);
            D[k + 16] = o.lightArea; D[k + 17] = n; D[k + 18] = this.info(o); D[k + 19] = 0;
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
        for (const x of this.exts) x.prepare?.(f, enc, target);
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: into.msaa, resolveTarget: into.resolve,
                clearValue: { r: 0.004, g: 0.005, b: 0.007, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: into.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
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
        const P = this.pipes, variant = f.stencil ? 'stencil' : 'plain', L = this.stencil, R = this.regions;
        const worldPipe = P.world[variant], skyPipe = P.sky[variant];
        // what an extension's commands draw with: the pass, pipeline / vertex buffer switching, the mode's pipeline
        // variant, the stencil layout and region slot, the command's draw slot and an object's geometry, the target
        const x = {
            pass, use, variant, stencil: L, regions: R, target,
            drawSlot: slot => {
                if (slot >= MAX_DRAWS) return false;
                pass.setBindGroup(1, this.drawBG, [slot * DRAW_STRIDE]);
                return true;
            },
            drawChunk: (chunk, pipeline) => {
                use(pipeline, this.vbuf);
                pass.drawIndexed(chunk.count, 1, chunk.first, chunk.baseVertex, 0);
            },
        };
        for (const c of f.cmds) {
            if (!scissor(c.rect)) continue;
            switch (c.op) {
                case 'draw':
                    if (c.slot >= MAX_DRAWS) break;
                    use(worldPipe, this.vbuf);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.setBindGroup(1, this.drawBG, [c.slot * DRAW_STRIDE]);
                    pass.drawIndexed(c.chunk.count, 1, c.chunk.first, c.chunk.baseVertex, 0);
                    break;
                case 'sky':
                    use(skyPipe);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.draw(3);
                    break;
                case 'mark':
                    use(P.markA, this.polyBuf); pass.setStencilReference(R.ref(c.parent)); pass.draw(c.count, 1, c.first);
                    use(P.markB); pass.setStencilReference(L.compose({ 'portal.mark': 1, 'portal.regions': c.child })); pass.draw(c.count, 1, c.first);
                    use(P.markC); pass.setStencilReference(L.compose({ 'portal.mark': 1 })); pass.draw(c.count, 1, c.first);
                    break;
                case 'water':
                    use(P.water[variant], this.polyBuf);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.draw(c.count, 1, c.first);
                    break;
                case 'glass':
                case 'veil':
                    use(c.op === 'glass' ? P.glass : P.veil, this.polyBuf);
                    pass.draw(c.count, 1, c.first);
                    break;
                default:
                    this.handlers.get(c.op)?.commands[c.op](c, x);
            }
        }
        if (lineVerts) {
            pass.setScissorRect(0, 0, W, H);
            const nd = Math.min(f.lineDepthCount, lineVerts);
            if (nd) { use(P.lineDepth, this.lineBuf); pass.draw(nd, 1, 0); }
            if (lineVerts > nd) { use(P.lineOverlay, this.lineBuf); pass.draw(lineVerts - nd, 1, nd); }
        }
        pass.end();
        q.submit([enc.finish()]);
    }
}

return { Renderer };
});
