'use strict';
// The portal's RendererExtension (the one Renderer, kits.gpu): pipelines, buffers and the draw of one frame.

Features.world('portal', (engine, kit) => {
const {
    AREA_FLOATS, MAX_DRAWS, DRAW_STRIDE, MAX_FOG_PORTALS, DRAW_FLOATS, MAX_LINE_VERTS, MAX_POLY_VERTS, POLY_FLOATS,
    DEPTH_FORMAT, STENCIL, portalWgsl, PORTAL_MODULES,
} = kit;
const { buildPipelines, RenderExtensions } = engine.kits.gpu;
const GLOBAL_BYTES = 240;           // the Globals uniform (render/shaders.js)

// The renderer: pipelines for the scene, sky, stencil marks, water, glass / fog veils and debug lines, and one render pass
// that executes a command list built by FrameBuilder, into the canvas or a view target (render(f, target), with its
// own MSAA colour and depth).
//
// Its depth-stencil target's bits are a StencilLayout (js/kits/gpu/stencil.js) with the slots of STENCIL
// (core/config.js): "portal.regions", one value per portal entry's region (FrameBuilder numbers them 1..capacity), and
// "portal.mark", the flag that marks an aperture while its child's region is written. The pipelines are a table
// (js/kits/gpu/pipelines.js) that names those slots; no stencil value or mask is written here.
//
// Everything else it draws comes from render extensions (js/kits/gpu/extensions.js), registered for 'portal' by any
// kit or part, those of the features on in its world (fx.features: extensions.portal), or added with extend() before
// init(): the GUI screens are one (features/screens/gui-pass.js). Besides name, stencil, init and pipelines, a portal
// extension may have
//   wgsl(lib, modules)  its WGSL: chunks of the renderer's library (render/shaders.js portalWgsl) defined, or replacing
//                     the core's stand-ins (the light through portals' throughLight); modules: { name: chunk names }, the
//                     modules made from it (world, sky, poly, lines: add one, or chunks to one)
//   overlay(o)        a command ({ op, ... }) for a visible object, emitted by FrameBuilder after its entry's objects
//                     (it gets chunk, slot, ref and rect: the object's geometry, draw slot, region and scissor)
//   info(o)           the object's draw slot info.z (a number), when the extension's shader reads it
//   prepare(f, enc, target)  passes of its own before the frame's pass (render targets its commands then sample)
//   commands: { op(c, x) }   draws its commands; x: the pass and helpers (see render())
// ctx (init / pipelines) carries the renderer's modules (world, sky, poly, lines), layouts (world: groups 0 + 1, base:
// group 0), bind group layouts (bgl0, bgl1), buffers, blends, and `region`, the slots a draw in its entry's region tests.

class RendererExtension {
    static key = 'interior';
    // what it draws with alone (Renderer.frameSpec): display values, standard depth, 4x MSAA; it can draw in reversed depth
    static frame = { display: 'display', depth: 'standard', depthFormat: DEPTH_FORMAT, samples: 4, near: 0.05,
        depths: ['standard', 'reversed'], formats: { standard: DEPTH_FORMAT, reversed: 'depth32float-stencil8' }, ranks: { sky: 1 } };
    // what it answers on the Renderer (Common.Composite)
    static exposes = ['H', 'W', 'bgl0', 'bgl1', 'depth', 'depthSample', 'device', 'format', 'fx', 'info', 'init',
        'onError', 'overlays', 'pipes', 'regions', 'render', 'resize', 'stencil', 'upload', 'viewFormat'];
    // fx: the feature context (the host's device and canvas target; see js/engine/host.js)
    constructor(renderer, fx) {
        this.renderer = renderer;
        this.fx = fx;
        this.onError = (msg) => console.error(msg);
        this.stencil = renderer.stencilLayout();
        for (const [name, spec] of Object.entries(STENCIL)) this.stencil.reserve(name, spec);
        this.regions = this.stencil.slot('portal.regions');
        this.targets = new Map();       // view target -> its MSAA colour and depth
        // (its render extensions: renderer.ext by name, renderer.extensions in order)
        this.handlers = new Map();      // command op -> its extension
        for (const make of RenderExtensions.for('portal', fx.features)) this.extend(make(this.renderer));
    }

    // a render extension (see above), before init()
    extend(ext) {
        if (this.stencil.resolved) throw new Error(`render extension "${ext.name}": added after init()`);
        if (this.renderer.ext[ext.name]) throw new Error(`render extension "${ext.name}": added twice`);
        for (const [name, spec] of Object.entries(ext.stencil || {})) this.stencil.reserve(name, spec);
        for (const op of Object.keys(ext.commands || {})) {
            if (this.handlers.has(op)) throw new Error(`render extension "${ext.name}": command "${op}" is "${this.handlers.get(op).name}"'s`);
            this.handlers.set(op, ext);
        }
        this.renderer.ext[ext.name] = ext;
        this.renderer.extensions.push(ext);
        return ext;
    }

    // the extensions FrameBuilder asks for overlay commands
    get overlays() { return this.renderer.extensions.filter(x => x.overlay); }

    // In a frame it shares with a kit that maps radiance to the canvas (frameSpec.shared), its scene draws into that
    // kit's targets: its pipelines at the frame's samples, its tone curve mapped on to that kit's radiance (TONEMAP:
    // G.scene.x, the reciprocal of that kit's exposure). Its view targets (CCTV, the phone camera: viewFormat) keep
    // pipelines of their own (display values, its own samples), in the frame's depth convention: two sets (sets.scene,
    // sets.view), each with the extensions' pipelines too (useSet)
    async init() {
        const device = this.device = this.fx.device, spec = this.renderer.frameSpec;
        this.shared = !!spec.shared;
        this.format = this.shared ? 'rgba16float' : this.fx.format;
        this.viewFormat = this.fx.format;
        this.depthFormat = this.renderer.sceneDepthFormat();

        const U = GPUBufferUsage;
        this.globalBuf = device.createBuffer({ size: GLOBAL_BYTES, usage: U.UNIFORM | U.COPY_DST });
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

        const base = {
            device, depthFormat: this.depthFormat, stencil: this.stencil, depth: spec.depth,
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
        // its shaders: the core's chunks, the extensions' over them, each module the chunks it names; the far depth the
        // frame's, the tone curve the set's
        const set = (format, samples, radiance) => {
            const wgsl = portalWgsl(radiance);
            if (spec.depth === 'reversed') wgsl.replace('DEPTH', 'const FAR_Z: f32 = 0.0;');
            const modules = Object.fromEntries(Object.entries(PORTAL_MODULES).map(([k, v]) => [k, [...v]]));
            this.renderer.each('wgsl', wgsl, modules);
            const mod = names => device.createShaderModule({ code: wgsl.code(...names) });
            return { format, samples, wgsl, ctx: { ...base, format, samples, modules: Object.fromEntries(Object.entries(modules).map(([k, names]) => [k, mod(names)])) } };
        };
        this.sets = { scene: set(this.format, spec.samples, this.shared) };
        this.sets.view = this.shared ? set(this.viewFormat, RendererExtension.frame.samples, false) : this.sets.scene;
        this.wgsl = this.sets.scene.wgsl;
        for (const x of this.renderer.extensions) await x.init?.(this.renderer, this.sets.scene.ctx);
        const R = ['portal.regions'], M = ['portal.mark'];
        // stencil mode draws inside its entry's region; scissor / none modes draw unmasked
        const masked = { stencil: { stencil: { test: R } }, plain: {} };
        const poly = fs => ({ layout: 'base', module: 'poly', vs: 'vs', fs, buffers: 'poly' });
        const lines = compare => ({ layout: 'base', module: 'lines', vs: 'vs', fs: 'fs', buffers: 'lines', topology: 'line-list', blend: 'alpha', depth: { compare } });
        const table = {
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
        };
        for (const S of new Set(Object.values(this.sets))) {
            S.pipes = buildPipelines(S.ctx, table);
            S.ext = new Map(this.renderer.extensions.filter(x => x.pipelines).map(x => [x, buildPipelines(S.ctx, x.pipelines(S.ctx))]));
        }
        this.useSet(this.sets.scene);
    }

    // the pipelines a call draws with (its own and its extensions'): the scene's, or a view target's (sets)
    useSet(S) {
        this.set = S;
        this.pipes = S.pipes;
        for (const [x, p] of S.ext) x.pipes = p;
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
        if (this.shared) return;
        this.msaa?.destroy(); this.depth?.destroy();
        const n = this.renderer.frameSpec.samples;
        this.msaa = this.device.createTexture({ size: [W, H], sampleCount: n, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        this.depth = this.device.createTexture({ size: [W, H], sampleCount: n, format: this.depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.depthSample = this.depth.createView({ aspect: 'depth-only' });
    }

    // a view target's MSAA colour and depth (its size, sampled by nobody)
    attachments(target) {
        let a = this.targets.get(target);
        if (!a) {
            const size = [target.width, target.height], U = GPUTextureUsage, n = this.sets.view.samples;
            a = {
                msaa: this.device.createTexture({ size, sampleCount: n, format: this.sets.view.format, usage: U.RENDER_ATTACHMENT }).createView(),
                depth: this.device.createTexture({ size, sampleCount: n, format: this.depthFormat, usage: U.RENDER_ATTACHMENT }).createView(),
            };
            this.targets.set(target, a);
        }
        return a;
    }

    // the draw slot info.z of an object: the first extension's that has one
    info(o) {
        for (const x of this.renderer.extensions) {
            const v = x.info?.(o);
            if (v !== undefined) return v;
        }
        return 0;
    }

    // the draw slot info.w: the first extension's that has one (a GUI screen's virtual width)
    infoW(o) {
        for (const x of this.renderer.extensions) {
            const v = x.infoW?.(o);
            if (v !== undefined) return v;
        }
        return 0;
    }

    // The per-call buffers of a frame: render() runs once per view target too (CCTV, the phone camera) and every queue
    // write lands before the frame's one submit, so each call of a frame writes a set of its own (the first one's are the
    // renderer's own buffers): globals, areas, draw slots, portal polygons, lines, and their bind groups
    callBuffers() {
        if (this.setsFrame !== this.renderer.frameId) { this.setsFrame = this.renderer.frameId; this.setsUsed = 0; }
        const i = this.setsUsed++;
        if (!i) return { global: this.globalBuf, area: this.areaBuf, draw: this.drawBuf, poly: this.polyBuf, line: this.lineBuf, bg0: this.bg0, drawBG: this.drawBG };
        const d = this.device, U = GPUBufferUsage;
        let b = (this.sets ??= [])[i - 1];
        if (!b) {
            b = this.sets[i - 1] = {
                global: d.createBuffer({ size: GLOBAL_BYTES, usage: U.UNIFORM | U.COPY_DST }),
                draw: d.createBuffer({ size: MAX_DRAWS * DRAW_STRIDE, usage: U.UNIFORM | U.COPY_DST }),
                line: d.createBuffer({ size: MAX_LINE_VERTS * 28, usage: U.VERTEX | U.COPY_DST }),
                poly: d.createBuffer({ size: MAX_POLY_VERTS * POLY_FLOATS * 4, usage: U.VERTEX | U.COPY_DST }),
            };
            b.drawBG = d.createBindGroup({ layout: this.bgl1, entries: [{ binding: 0, resource: { buffer: b.draw, size: DRAW_FLOATS * 4 } }] });
        }
        // (its areas follow the world's: upload() makes them anew)
        if (b.areaOf !== this.areaBuf) {
            b.area?.destroy();
            b.areaOf = this.areaBuf;
            b.area = d.createBuffer({ size: this.areaBuf.size, usage: U.STORAGE | U.COPY_DST });
            b.bg0 = d.createBindGroup({ layout: this.bgl0, entries: [
                { binding: 0, resource: { buffer: b.global } },
                { binding: 1, resource: { buffer: b.area } },
                { binding: 2, resource: { buffer: this.matBuf } },
            ] });
        }
        return b;
    }

    // fr.cmds: draw | sky | mark | glass | veil | water and the extensions' ops, executed in order (portal-tree DFS in
    // stencil mode)
    // fr.draws: one { o, fog } per draw slot; fog = the portals it is seen through, nearest first
    // target: a view target (js/kits/media/views.js) instead of the canvas
    // Its stages (Renderer.encode, into the frame encoder): compute (the extensions' prepare), then the scene pass:
    // indoor (the command list), late (the lines); in a shared frame the main view's in that frame's scene pass (bind),
    // a view target's in a pass of its own at once
    render(fr, target = null) {
        const d = this.device, q = d.queue, W = target ? target.width : this.W, H = target ? target.height : this.H;
        const B = this.callBuffers();
        q.writeBuffer(B.global, 0, fr.globals);
        q.writeBuffer(B.area, 0, fr.areas);
        const F = DRAW_STRIDE / 4, nSlots = Math.min(fr.draws.length, MAX_DRAWS), D = this.drawData;
        for (let i = 0; i < nSlots; i++) {
            const { o, fog } = fr.draws[i], k = i * F, n = Math.min(fog.length, MAX_FOG_PORTALS);
            D.set(o.model, k);
            D[k + 16] = o.lightArea; D[k + 17] = n; D[k + 18] = this.info(o); D[k + 19] = this.infoW(o);
            D[k + 20] = 1; D[k + 21] = 1; D[k + 22] = 1; D[k + 23] = 1;
            for (let j = 0; j < n; j++) {
                D.set(fog[j].plane, k + 24 + j * 4);
                D.set(fog[j].fog, k + 24 + (MAX_FOG_PORTALS + j) * 4);
            }
        }
        if (nSlots) q.writeBuffer(B.draw, 0, this.drawData, 0, nSlots * F);
        const polyVerts = Math.min(fr.polys.length / POLY_FLOATS, MAX_POLY_VERTS);
        if (polyVerts) q.writeBuffer(B.poly, 0, fr.polys, 0, polyVerts * POLY_FLOATS);
        const lineVerts = Math.min(fr.lines.length / 7, MAX_LINE_VERTS);
        if (lineVerts) q.writeBuffer(B.line, 0, fr.lines, 0, lineVerts * 7);
        this.renderer.encode({ fr, target, B, W, H, lineVerts });
    }

    compute(f) { this.renderer.each('prepare', f.fr, f.enc, f.target); }

    scene(f) {
        const { target } = f;
        const into = target ? { ...this.attachments(target), resolve: target.colorView } : { msaa: this.msaa.createView(), depth: this.depth.createView(), resolve: this.fx.target() };
        const pass = f.enc.beginRenderPass({
            colorAttachments: [{ view: into.msaa, resolveTarget: into.resolve,
                clearValue: { r: 0.004, g: 0.005, b: 0.007, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: into.depth, depthClearValue: this.renderer.frameSpec.depthClear, depthLoadOp: 'clear', depthStoreOp: 'store',
                stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
        });
        return this.bind(f, pass);
    }

    // its state on the scene pass (its own, or a shared frame's after another kit drew in it): the scissor and pipeline
    // helpers, its globals and index buffer
    bind(f, pass = f.pass) {
        const { W, H, B } = f;
        f.scissor = r => {
            const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1])), x1 = Math.min(W, Math.ceil(r[2])), y1 = Math.min(H, Math.ceil(r[3]));
            if (x1 <= x0 || y1 <= y0) return false;
            pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
            return true;
        };
        let pipe = null, vb = null;
        f.use = (p, buffer) => {
            if (p !== pipe) { pass.setPipeline(p); pipe = p; }
            if (buffer && buffer !== vb) { pass.setVertexBuffer(0, buffer); vb = buffer; }
        };
        pass.setBindGroup(0, B.bg0);
        pass.setIndexBuffer(this.ibuf, 'uint32');
        return pass;
    }

    // the command list (its sky: the frame's, in a frame it shares, already drawn where the outdoors is seen)
    indoor(f) {
        const { fr, target, B, pass, scissor, use } = f;
        this.useSet(target ? this.sets.view : this.sets.scene);
        const ownSky = !this.shared || !!target;
        const P = this.pipes, variant = fr.stencil ? 'stencil' : 'plain', L = this.stencil, R = this.regions;
        const worldPipe = P.world[variant], skyPipe = P.sky[variant];
        // what an extension's commands draw with: the pass, pipeline / vertex buffer switching, the mode's pipeline
        // variant, the stencil layout and region slot, the command's draw slot and an object's geometry, the target
        const x = {
            pass, use, variant, stencil: L, regions: R, target,
            drawSlot: slot => {
                if (slot >= MAX_DRAWS) return false;
                pass.setBindGroup(1, B.drawBG, [slot * DRAW_STRIDE]);
                return true;
            },
            drawChunk: (chunk, pipeline) => {
                use(pipeline, this.vbuf);
                pass.drawIndexed(chunk.count, 1, chunk.first, chunk.baseVertex, 0);
            },
        };
        for (const c of fr.cmds) {
            if (!scissor(c.rect)) continue;
            switch (c.op) {
                case 'draw':
                    if (c.slot >= MAX_DRAWS) break;
                    use(worldPipe, this.vbuf);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.setBindGroup(1, B.drawBG, [c.slot * DRAW_STRIDE]);
                    pass.drawIndexed(c.chunk.count, 1, c.chunk.first, c.chunk.baseVertex, 0);
                    break;
                case 'sky':
                    if (!ownSky) break;
                    use(skyPipe);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.draw(3);
                    break;
                case 'mark':
                    use(P.markA, B.poly); pass.setStencilReference(R.ref(c.parent)); pass.draw(c.count, 1, c.first);
                    use(P.markB); pass.setStencilReference(L.compose({ 'portal.mark': 1, 'portal.regions': c.child })); pass.draw(c.count, 1, c.first);
                    use(P.markC); pass.setStencilReference(L.compose({ 'portal.mark': 1 })); pass.draw(c.count, 1, c.first);
                    break;
                case 'water':
                    use(P.water[variant], B.poly);
                    pass.setStencilReference(R.ref(c.ref));
                    pass.draw(c.count, 1, c.first);
                    break;
                case 'glass':
                case 'veil':
                    use(c.op === 'glass' ? P.glass : P.veil, B.poly);
                    pass.draw(c.count, 1, c.first);
                    break;
                default:
                    this.handlers.get(c.op)?.commands[c.op](c, x);
            }
        }
    }

    // the lines (the inspector's frames), over everything
    late(f) {
        const { fr, pass, use, lineVerts, B, W, H } = f;
        if (!lineVerts) return;
        this.useSet(f.target ? this.sets.view : this.sets.scene);
        pass.setScissorRect(0, 0, W, H);
        const P = this.pipes, nd = Math.min(fr.lineDepthCount, lineVerts);
        if (nd) { use(P.lineDepth, B.line); pass.draw(nd, 1, 0); }
        if (lineVerts > nd) { use(P.lineOverlay, B.line); pass.draw(lineVerts - nd, 1, nd); }
    }
}

return { RendererExtension };
});
