'use strict';
// The imposter's RendererExtension (the one Renderer, kits.gpu): culling, meshes, imposters and the overlay (the sun's shadows: the shadows feature's).

Features.world('imposter', (engine, kit) => {
const { Common, kits } = engine;
const { v3, frustumPlanes } = Common;
const { ImposterGpu, MESH_BUFFERS, drawImposters } = kits.imposter;
const {
    MSAA, DEPTH_FORMAT, LISTS, GLOBAL_FLOATS, LOD_MODES, ATLAS_VIEWS, m4, TextureFactory, uploadImage, imposterWgsl, IMPOSTER_MODULES,
} = kit;

// The renderer. What the features on in its world add to it are its other extensions (their RendererExtensions,
// renderer.compose: new E(renderer), kept as renderer.ext[E.key]); each hook optional: wgsl(library, modules) (its
// chunks over the core's stand-ins; modules: each module's chunk names), globals() (its entries of bind group 0: {
// layout, resources }), init(ctx) (its resources and pipelines; ctx: the modules, layouts, vertex layout), frame(cam,
// env, st, aspect, casterTop) (its uniforms, before the frame's cull), passes(enc, archs, st, cam) (its passes after
// the cull, before the main one), gpuTimes(t, ms) (its share of the timestamp readout)
class RendererExtension {
    static key = 'imposter';
    // what it draws with alone (Renderer.frameSpec): display values, reversed depth with an infinite far plane, MSAA. In a
    // frame it shares (frameSpec.shared) with a kit whose post maps the frame, it draws its lists into that kit's scene
    // (with the frame's sky, not its own), in that kit's radiance (output), at the frame's samples (cutout at one)
    static frame = { display: 'display', depth: 'reversed', depthFormat: DEPTH_FORMAT, samples: MSAA, near: 0.1, ranks: { sky: 1 } };
    // what it answers on the Renderer (Common.Composite)
    static exposes = ['cascadePlanes', 'clampSampler', 'depthView', 'device', 'drawLists', 'format', 'fx', 'globalBG',
        'gpuTimes', 'height', 'impPipe', 'init', 'makeGlobalBG', 'matBgl', 'meshPipe', 'patternTexture', 'render',
        'repSampler', 'resize', 'stamps', 'viewBG', 'viewData', 'whiteTexture', 'width'];
    // fx: the feature context (the host's device, canvas size, target; see js/engine/host.js)
    constructor(renderer, fx) {
        this.renderer = renderer;
        this.fx = fx;
        renderer.compose(kits.gpu.extensionsOf(fx.features, 'renderer'));
        this.onError = msg => console.error(msg);
        this.globals = new Float32Array(GLOBAL_FLOATS);
        this.patterns = new Map();
        this.readBuf = null;
        this.readPending = false;
        this.queryPending = false;
        this.camPlanes = [];
        this.cascadePlanes = [];
        this.lastRead = -1;
    }

    async init() {
        // GPU pass timings for the HUD where the browser allows them
        const device = this.device = this.fx.device;
        const timing = device.features.has('timestamp-query');
        if (timing) {
            this.querySet = device.createQuerySet({ type: 'timestamp', count: 12 });
            this.queryBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            this.queryRead = device.createBuffer({ size: 96, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            this.gpuTimes = null;               // { cull, main, and the extensions' (shadow: [4]) } in ms
        }
        const spec = this.renderer.frameSpec;
        this.shared = !!spec?.shared;
        this.radiance = this.shared && spec.display === 'radiance';
        this.format = this.radiance ? 'rgba16float' : this.fx.format;
        this.samples = this.shared ? spec.samples : MSAA;
        this.depthFormat = this.shared ? spec.depthFormat : DEPTH_FORMAT;
        this.width = this.height = 0;

        const U = GPUBufferUsage, S = GPUShaderStage;
        this.globalBuf = device.createBuffer({ size: GLOBAL_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
        this.overlayBuf = device.createBuffer({ size: 64, usage: U.UNIFORM | U.COPY_DST });
        this.repSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
        this.clampSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.whiteTexture = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: this.whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        // the imposter kit's layouts: atlases, instance lists, LOD list culling (and its bakes)
        const imp = this.imposters = ImposterGpu.of(device);
        this.overlayBGs = new WeakMap();

        const tex = (binding, visibility = S.FRAGMENT) => ({ binding, visibility, texture: {} });
        const smp = binding => ({ binding, visibility: S.FRAGMENT, sampler: {} });
        this.globalsExt = this.renderer.extensions.map(x => x.globals?.()).filter(Boolean);
        this.bgl0 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, buffer: { type: 'uniform' } }, smp(1),
            ...this.globalsExt.flatMap(g => g.layout),
        ] });
        this.viewBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } }] });
        this.matBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, tex(1)] });
        this.ovBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, smp(1), tex(2), tex(3), tex(4), tex(5)] });
        this.viewBuf = device.createBuffer({ size: LISTS * 256, usage: U.UNIFORM | U.COPY_DST });
        this.viewData = new Float32Array(LISTS * 64);
        this.viewBG = device.createBindGroup({ layout: this.viewBgl, entries: [{ binding: 0, resource: { buffer: this.viewBuf, size: 96 } }] });
        this.globalBG = this.makeGlobalBG();

        const layout = (...bgls) => device.createPipelineLayout({ bindGroupLayouts: bgls });
        // its shaders: the core's chunks, the extensions' over them, each module the chunks it names
        this.wgsl = imposterWgsl(this.radiance, this.samples);
        const modules = Object.fromEntries(Object.entries(IMPOSTER_MODULES).map(([k, v]) => [k, [...v]]));
        this.renderer.each('wgsl', this.wgsl, modules);
        const M = Object.fromEntries(Object.entries(modules).map(([k, names]) => [k, device.createShaderModule({ code: this.wgsl.code(...names) })]));
        const vertexLayout = MESH_BUFFERS;          // the imposter kit's standard mesh: + per-vertex AO
        const mainDepth = (write, compare) => ({ format: this.depthFormat, depthWriteEnabled: write, depthCompare: compare });
        const target = [{ format: this.format }], ms = { count: this.samples };
        const a2c = this.samples > 1 ? { count: this.samples, alphaToCoverageEnabled: true } : ms;

        const meshMod = M.mesh, meshLayout = layout(this.bgl0, this.matBgl, imp.instanceLayout, this.viewBgl);
        const mesh = cullMode => device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: meshMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
            depthStencil: mainDepth(true, 'greater'), multisample: a2c,
        });
        this.meshPipe = mesh('back');
        this.meshTwoSided = mesh('none');

        const impMod = M.imposter, impLayout = layout(this.bgl0, imp.atlasLayout, imp.instanceLayout, this.viewBgl);
        this.impPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' },
            depthStencil: mainDepth(true, 'greater'), multisample: a2c,
        });

        const skyMod = M.sky;
        this.skyPipe = device.createRenderPipeline({
            layout: layout(this.bgl0),
            vertex: { module: skyMod, entryPoint: 'vs' }, fragment: { module: skyMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' }, depthStencil: mainDepth(false, 'always'), multisample: ms,
        });

        const ovMod = M.overlay;
        this.ovPipe = device.createRenderPipeline({
            layout: layout(this.ovBgl),
            vertex: { module: ovMod, entryPoint: 'vs' }, fragment: { module: ovMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' }, depthStencil: mainDepth(false, 'always'), multisample: ms,
        });

        const cullMod = M.cull;
        this.cullPipe = device.createComputePipeline({ layout: layout(this.bgl0, imp.listsLayout), compute: { module: cullMod, entryPoint: 'cull' } });
        for (const x of this.renderer.extensions) await x.init?.({ modules: M, meshLayout, impLayout, vertexLayout });

        this.resize();
    }

    // bind group 0: the globals, the repeat sampler and the extensions' entries (`extra`: one extension's own, for its
    // passes: the shadow passes' stand-in map)
    makeGlobalBG(extra = null) {
        return this.device.createBindGroup({ layout: this.bgl0, entries: [
            { binding: 0, resource: { buffer: this.globalBuf } }, { binding: 1, resource: this.repSampler },
            ...this.globalsExt.flatMap(g => (extra?.of === g ? extra.resources : g.resources())),
        ] });
    }

    patternTexture(def) {
        const key = JSON.stringify([def.pattern, def.colors, def.seed, def.size, def.alphaCutoff]);
        let t = this.patterns.get(key);
        if (!t) this.patterns.set(key, t = uploadImage(this.device, TextureFactory.canvas(def), def.alphaCutoff || 0));
        return t;
    }

    resize() {
        const [w, h] = this.fx.size();
        if (this.shared) { this.width = w; this.height = h; return; }
        if (this.msaaTex && this.width === w && this.height === h) return;
        this.width = w; this.height = h;
        this.msaaTex?.destroy(); this.depthTex?.destroy();
        const U = GPUTextureUsage.RENDER_ATTACHMENT;
        this.msaaTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: MSAA, usage: U });
        // sampled too: a composition reads it (js/engine/compositor.js)
        this.depthTex = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, sampleCount: MSAA, usage: U | GPUTextureUsage.TEXTURE_BINDING });
        this.msaaView = this.msaaTex.createView();
        this.depthView = this.depthTex.createView();
    }

    // scale: its radiance into the frame's (a shared frame: the reciprocal of its post kit's exposure, G.light.y)
    writeGlobals(cam, env, st, time, scale = 1) {
        const g = this.globals, W = this.width, H = this.height;
        const vp = m4.mul(m4.reversedInfinite(cam.fov, W / H, this.renderer.frameSpec?.near ?? 0.1), cam.viewMatrix());
        g.set(vp, 0);
        g.set([...cam.pos, time], 16);
        g.set([...env.sunDir, env.exposure], 20);
        g.set([...env.sunColor, env.sunIntensity], 24);
        g.set([...env.skyTop, 0], 28);
        g.set([...env.skyHorizon, 0], 32);
        g.set([...env.ambientSky, 0], 36);
        g.set([...env.ambientGround, env.ambientStrength], 40);
        g.set([...env.fogColor, env.fogDensity], 44);
        this.camPlanes = frustumPlanes(vp, { reversed: true });
        this.camPlanes.forEach((p, i) => g.set(p, 48 + i * 4));
        g.set([st.lodDistance, st.fade, st.far, LOD_MODES.indexOf(st.lodMode)], 72);
        g.set([st.blend ? 1 : 0, st.parallax ? 1 : 0, st.depthOffset ? 1 : 0, st.tint ? 1 : 0], 76);
        g.set(m4.invert(vp), 80);
        g.set([W, H, 1 / W, 1 / H], 96);
        g.set([env.emission, scale, 0, 0], 100);
        g.set([...cam.basis().fwd, 0], 104);
        this.device.queue.writeBuffer(this.globalBuf, 0, g);
        this.viewData.set(vp, 0);
        this.viewData.set([...cam.pos, 1, ...cam.basis().fwd, 0], 16);
    }

    // the atlas overlay's bind group for an atlas (its layers through the kit's ImposterAtlas.views)
    overlayBG(atlas) {
        let bg = this.overlayBGs.get(atlas);
        if (!bg) this.overlayBGs.set(atlas, bg = this.device.createBindGroup({ layout: this.ovBgl, entries: [
            { binding: 0, resource: { buffer: this.overlayBuf } }, { binding: 1, resource: this.clampSampler }, ...atlas.views.map((v, i) => ({ binding: i + 2, resource: v })),
        ] }));
        return bg;
    }

    stamps(i) { return this.querySet ? { querySet: this.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } : undefined; }

    // is a static archetype's bounding sphere inside list `list`'s volume (camera frustum + far, or a cascade box)
    sees(a, list, st, cam) {
        const planes = list ? this.cascadePlanes[list - 1] : this.camPlanes, c = a.sphere[0], r = a.sphere[1];
        if (!list && v3.len(v3.sub(c, cam.pos)) - r > st.far) return false;
        return planes.every(p => p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] >= -r);
    }

    // draw every archetype's list `list` (0: camera, 1 + c: cascade c); meshPipe(material) picks the mesh pipeline.
    // GPU-culled archetypes draw indirect; static ones (terrain chunks) are culled here and drawn directly,
    // which spares the browser's per-draw validation of hundreds of indirect draws.
    drawLists(pass, archs, list, meshPipe, impPipe, shadow, st, cam) {
        let cur = null;
        for (const a of archs) {
            if (!a.count || (shadow && !a.asset.castShadows)) continue;
            if (a.static) {
                const seen = this.sees(a, list, st, cam);
                if (list) a.cpuCasters += seen ? 1 : 0; else a.visible[0] = seen ? 1 : 0;
                if (!seen) continue;
            }
            const gm = a.asset.gpu(this.renderer), L = a.lists;
            pass.setVertexBuffer(0, gm.vbuf);
            pass.setVertexBuffer(1, gm.aoBuf);
            pass.setIndexBuffer(gm.ibuf, 'uint32');
            pass.setBindGroup(2, a.static ? L.srcBG : L.meshBG[list]);
            a.asset.mesh.submeshes.forEach((s, i) => {
                const p = meshPipe(s.material);
                if (p !== cur) { pass.setPipeline(p); cur = p; }
                pass.setBindGroup(1, s.material.bindGroup(this.renderer));
                if (a.static) pass.drawIndexed(s.count, a.count, s.first, 0, 0);
                else pass.drawIndexedIndirect(L.args, L.meshArgs(list, i));
            });
        }
        pass.setPipeline(impPipe);
        for (const a of archs) {
            if (!a.count || a.static || !a.asset.atlas || (shadow && !a.asset.castShadows)) continue;
            drawImposters(pass, a.asset.atlas, a.lists.impBG[list], a.lists.args, a.lists.impArgs(list));
        }
    }

    // one frame: cull (compute: camera + cascades) -> counts into the indirect args -> shadow cascades ->
    // sky, meshes, imposters, atlas overlay. Its stages (Renderer.encode, into the frame encoder): compute (the cull,
    // the counts' readback copy, the extensions' passes), the scene pass: sky, outdoor (the lists), late (the atlas
    // overlay); final (its timestamps; it has no final pass of its own); the readbacks map once the frame is submitted
    render(world, cam, st, time, overlay, env, scale) {
        this.resize();
        const d = this.device, archs = world ? world.list : [];
        this.writeGlobals(cam, env, st, time, scale);
        this.renderer.each('frame', cam, env, st, this.width / this.height, world?.casterTop ?? 0);
        for (let k = 0; k < LISTS; k++) d.queue.writeBuffer(this.viewBuf, k * 256, this.viewData, k * 64, 24);
        this.renderer.encode({ archs, cam, st, time, overlay });
    }

    compute(f) {
        const d = this.device, enc = f.enc, { archs, st, cam, time } = f;
        for (const a of archs) a.upload(this.renderer);
        if (archs.length) {
            const cp = enc.beginComputePass({ timestampWrites: this.stamps(0) });
            cp.setPipeline(this.cullPipe);
            cp.setBindGroup(0, this.globalBG);
            for (const a of archs) if (a.count && !a.static) { cp.setBindGroup(1, a.lists.cullBG); cp.dispatchWorkgroups(Math.ceil(a.count / 64)); }
            cp.end();
        }
        // a few times a second: copy the indirect args back for the HUD's counts
        const doRead = f.doRead = archs.length > 0 && !this.readPending && time - this.lastRead > 0.25;
        const offsets = f.offsets = [];
        let readBytes = 0;
        for (const a of archs) { offsets.push(readBytes); readBytes += a.static ? 0 : a.lists.setStride * LISTS; }
        f.readBytes = readBytes;
        if (doRead) {
            if (!this.readBuf || this.readBuf.size < readBytes) {
                this.readBuf?.destroy();
                this.readBuf = d.createBuffer({ size: readBytes * 2, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            }
            archs.forEach((a, i) => { if (!a.static) enc.copyBufferToBuffer(a.lists.args, 0, this.readBuf, offsets[i], a.lists.setStride * LISTS); });
        }
        this.renderer.each('passes', enc, archs, st, cam);
    }

    scene(f) {
        return f.enc.beginRenderPass({
            timestampWrites: this.stamps(10),
            colorAttachments: [{ view: this.msaaView, resolveTarget: this.fx.target(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
    }

    // its globals back on the scene pass after another kit drew in it (a shared frame: Renderer.encodeFrame)
    bind(f) { f.pass.setBindGroup(0, this.globalBG); }

    sky(f) {
        f.pass.setPipeline(this.skyPipe);
        f.pass.setBindGroup(0, this.globalBG);
        f.pass.draw(3);
    }

    outdoor(f) {
        const { pass, archs, st, cam } = f;
        pass.setBindGroup(3, this.viewBG, [0]);
        this.drawLists(pass, archs, 0, m => (m.doubleSided ? this.meshTwoSided : this.meshPipe), this.impPipe, false, st, cam);
        for (const a of archs) if (a.static) { a.casters[0] = st.shadows ? a.cpuCasters : 0; a.cpuCasters = 0; }
    }

    // the selected model's atlas, bottom right, left of the control panel when that is showing
    late(f) {
        const overlay = f.overlay, pass = f.pass;
        if (!overlay) return;
        const W = this.width, H = this.height, dpr = W / Math.max(1, this.fx.canvas.clientWidth), m = 12 * dpr;
        const right = (overlay.rightInset || 0) * dpr + m, px = Math.max(64, Math.min(H * 0.42, (W - right) * 0.45, 440 * dpr));
        const s = overlay.sel, x0 = W - right - px, y0 = H - m - px;
        this.device.queue.writeBuffer(this.overlayBuf, 0, new Float32Array([
            x0 / W * 2 - 1, 1 - y0 / H * 2, (x0 + px) / W * 2 - 1, 1 - (y0 + px) / H * 2,
            ...s.cells[0], ...s.cells[1], ...s.cells[2], overlay.atlas.grid, ATLAS_VIEWS.indexOf(overlay.view), ...s.w, 0,
        ]));
        pass.setPipeline(this.ovPipe);
        pass.setBindGroup(0, this.overlayBG(overlay.atlas));
        pass.draw(6);
    }

    // its GPU timestamps resolved, and the readbacks (timestamps, the HUD's counts) mapped once the frame is submitted
    final(f) {
        const enc = f.enc, { archs, st, doRead, offsets, readBytes, time } = f;
        const doTime = this.querySet && !this.queryPending && doRead;
        if (doTime) {
            enc.resolveQuerySet(this.querySet, 0, 12, this.queryBuf, 0);
            enc.copyBufferToBuffer(this.queryBuf, 0, this.queryRead, 0, 96);
            this.queryPending = true;
            const parts = this.renderer.extensions.filter(x => x.gpuTimes).map(x => [x, x.timed?.(st, archs)]);
            this.renderer.afterSubmit(() => this.queryRead.mapAsync(GPUMapMode.READ).then(() => {
                const t = new BigUint64Array(this.queryRead.getMappedRange()), ms = k => Math.max(0, Number(t[k + 1] - t[k])) / 1e6;
                this.gpuTimes = { cull: ms(0), shadow: null, main: ms(10) };
                for (const [x, on] of parts) Object.assign(this.gpuTimes, x.gpuTimes(on, ms));
                this.queryRead.unmap();
                this.queryPending = false;
            }).catch(() => { this.queryPending = false; }));
        }
        if (doRead) {
            this.readPending = true;
            this.lastRead = time;
            const list = archs.slice(), buf = this.readBuf, n = readBytes;
            this.renderer.afterSubmit(() => buf.mapAsync(GPUMapMode.READ, 0, n).then(() => {
                const u = new Uint32Array(buf.getMappedRange(0, n));
                list.forEach((a, i) => {
                    if (a.static) return;
                    const count = (k, mesh) => a.lists.counted(u, offsets[i] / 4, k, mesh);
                    a.visible[0] = count(0, true);
                    a.visible[1] = count(0, false);
                    a.casters = [0, 0];
                    for (let c = 1; c < LISTS; c++) { a.casters[0] += count(c, true); a.casters[1] += count(c, false); }
                });
                buf.unmap();
                this.readPending = false;
            }).catch(() => { this.readPending = false; }));
        }
    }
}

return { RendererExtension };
});
