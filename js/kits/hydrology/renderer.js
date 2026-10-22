'use strict';
// The water's RendererExtension (the one Renderer, kits.gpu): terrain, water and debris.

Features.world('water', (engine, kit) => {
const { Common } = engine;
const { makeBuffer, gridIndices, bindLayout, bindGroup } = Common;
const { FRAME_FLOATS, waterWgsl, TU, BU, makeTex } = kit;

// The renderer. What the features on in its world add to it are its other extensions (their RendererExtensions,
// renderer.compose: new E(renderer), kept as renderer.ext[E.key]); each hook optional: wgsl(library, modules) (its
// chunks over the core's stubs; modules: the scene and surface modules' chunk names), pipelines(ctx) (ctx { scene,
// surface, layoutA, layoutB, pipe }), surface(pass) (its draws in the surface pass, after the water)
class RendererExtension {
    static key = 'water';
    // what it draws with alone (Renderer.frameSpec): radiance (its surface pass maps it), reversed depth, no MSAA. In a frame
    // it shares (frameSpec.shared) with a kit whose post maps the frame, it draws its terrain into that kit's scene (with
    // the frame's sky, not its own), its surface over it in radiance (refracting a copy of it), then its surface's depth
    static frame = { display: 'radiance', depth: 'reversed', depthFormat: 'depth32float', samples: 1, near: kit.NEAR, ranks: { sky: 1 } };
    // what it answers on the Renderer (Common.Composite)
    static exposes = ['createPipelines', 'debrisCount', 'depth', 'depthView', 'device', 'format',
        'frameData', 'fx', 'height', 'init', 'modules', 'render', 'resize', 'sampler', 'setSim', 'width'];
    // the host's device and canvas (fx: the world context, see js/engine/host.js; fx.features: the features on in its world)
    constructor(renderer, fx) {
        this.renderer = renderer;
        this.fx = fx;
        renderer.compose(engine.kits.gpu.extensionsOf(fx.features, 'renderer'));
    }

    async init() {
        this.device = this.fx.device;
        this.shared = !!this.renderer.frameSpec?.shared;
        this.format = this.shared ? 'rgba16float' : this.fx.format;
        this.depthFormat = this.shared ? this.renderer.frameSpec.depthFormat : 'depth32float';
        this.frameData = new Float32Array(FRAME_FLOATS);
        this.frameBuf = makeBuffer(this.device, FRAME_FLOATS * 4, BU().UNIFORM | BU().COPY_DST);
        this.createPipelines();
        this.width = this.height = 0;
    }

    createPipelines() {
        const d = this.device, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.worldLayout = bindLayout(d, VF, ['uniform', 'tex:unfilterable-float', 'tex:unfilterable-float', 'tex', 'sampler', 'array', 'array', 'array', 'array', 'read', 'read']);
        this.screenLayout = bindLayout(d, GPUShaderStage.FRAGMENT, ['tex', 'tex:depth']);
        this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        const U = TU();
        this.dummyArray = makeTex(d, 1, 1, 'rgba16float', U.TEXTURE_BINDING, 2).createView({ dimension: '2d-array' });
        // its shaders: the core's chunks, the features' over them
        this.wgsl = waterWgsl(this.shared);
        this.modules = { scene: ['COMMON', 'SCENE'], surface: ['COMMON', 'SURFACE'] };
        this.renderer.each('wgsl', this.wgsl, this.modules);
        const scene = d.createShaderModule({ label: 'scene', code: this.wgsl.code(...this.modules.scene) });
        const surface = d.createShaderModule({ label: 'surface', code: this.wgsl.code(...this.modules.surface) });
        const layoutA = d.createPipelineLayout({ bindGroupLayouts: [this.worldLayout] });
        const layoutB = d.createPipelineLayout({ bindGroupLayouts: [this.worldLayout, this.screenLayout] });
        const pipe = (layout, module, vs, fs, format, depth, extra = {}) => d.createRenderPipeline({
            label: vs, layout,
            vertex: { module, entryPoint: vs },
            fragment: { module, entryPoint: fs, targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: extra.cull || 'none' },
            depthStencil: { format: this.depthFormat, depthWriteEnabled: depth.write, depthCompare: depth.compare },
        });
        this.pSky = pipe(layoutA, scene, 'vsSky', 'fsSky', 'rgba16float', { write: false, compare: 'always' });
        this.pTerrain = pipe(layoutA, scene, 'vsTerrain', 'fsTerrain', 'rgba16float', { write: true, compare: 'greater' });
        this.pComposite = pipe(layoutB, surface, 'vsComposite', 'fsComposite', this.format, { write: false, compare: 'always' });
        this.pWater = pipe(layoutB, surface, 'vsWater', 'fsWater', this.format, { write: false, compare: 'greater' });
        // a shared frame's depth: the water surface over the terrain's (dry cells sink under the terrain in vsWater), with
        // its world group only (the depth it writes is the one the surface pass samples)
        if (this.shared) this.pWaterDepth = d.createRenderPipeline({
            label: 'water depth', layout: layoutA,
            vertex: { module: surface, entryPoint: 'vsWater' },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: this.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        });
        // (its storage buffers' stand-ins: no debris)
        this.noParticles = makeBuffer(d, 64, BU().STORAGE);
        this.renderer.each('pipelines', { scene, surface, layoutA, layoutB, pipe });
    }

    setSim(world, flow, waves, debris) {
        const d = this.device, n = world.field.n, U = BU();
        this.sim = { flow, waves, debris };
        this.terrainIndex?.destroy();
        this.waterIndex?.destroy();
        const ti = gridIndices(n + 2), wi = gridIndices(n);
        this.terrainIndex = makeBuffer(d, ti.byteLength, U.INDEX, ti);
        this.terrainCount = ti.length;
        this.waterIndex = makeBuffer(d, wi.byteLength, U.INDEX, wi);
        this.waterCount = wi.length;
        const disp = [0, 1, 2, 3].map(i => waves.layers[i] ? waves.layers[i].dispView : this.dummyArray);
        this.worldGroup = bindGroup(d, this.worldLayout, [this.frameBuf, flow.terrain.createView(), flow.surf.createView(), flow.flow.createView(),
            this.sampler, ...disp, debris.particles || this.noParticles, debris.emitters || this.noParticles], 'world');
        this.debrisCount = debris.count;
    }

    resize() {
        if (this.shared) return this.resizeShared();
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height) return;
        this.width = w;
        this.height = h;
        const U = TU();
        this.hdr?.destroy();
        this.depth?.destroy();
        this.hdr = makeTex(this.device, w, h, 'rgba16float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING);
        this.depth = makeTex(this.device, w, h, 'depth32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC);
        this.hdrView = this.hdr.createView();
        this.depthView = this.depth.createView();
        this.screenGroup = bindGroup(this.device, this.screenLayout, [this.hdrView, this.depthView], 'screen');
    }

    // in a shared frame: a copy of the scene to refract, and the scene's depth to sample (its screen group)
    resizeShared() {
        const T = this.renderer.sceneTargets();
        if (!T || (T.width === this.width && T.height === this.height && T.depthSample === this.screenDepth)) return;
        if (T.width !== this.width || T.height !== this.height) {
            this.width = T.width;
            this.height = T.height;
            this.sceneCopy?.destroy();
            this.sceneCopy = makeTex(this.device, T.width, T.height, 'rgba16float', TU().TEXTURE_BINDING | TU().COPY_DST);
            this.sceneCopyView = this.sceneCopy.createView();
        }
        this.screenDepth = T.depthSample;
        this.screenGroup = bindGroup(this.device, this.screenLayout, [this.sceneCopyView, T.depthSample], 'screen');
    }

    // its world group back on the scene pass after another kit drew in it (a shared frame: Renderer.encodeFrame)
    bind(f) { f.pass.setBindGroup(0, this.worldGroup); }

    // one frame (Renderer.encode: its stages, into the frame encoder): f { sim: this frame's simulation step { steps, dt,
    // eye, flowScale, time } or null (paused), uniforms() (its frame uniform's data, once the simulation has run) }
    render(f) { this.renderer.encode(f); }

    // the river: flow steps, the wave cascades, the debris
    compute(f) {
        const s = f.sim, { flow, waves, debris } = this.sim;
        if (s) {
            flow.encode(f.enc, s.steps);
            waves.encode(f.enc, s.dt, s.eye, s.flowScale);
            debris.encode(f.enc, s.dt * s.flowScale, s.time);
        }
        f.uniforms?.();
        this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
    }

    scene(f) {
        const a = f.enc.beginRenderPass({
            label: 'scene',
            colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
        });
        a.setBindGroup(0, this.worldGroup);
        return a;
    }

    sky(f) {
        f.pass.setPipeline(this.pSky);
        f.pass.draw(3);
    }

    outdoor(f) {
        const a = f.pass;
        a.setPipeline(this.pTerrain);
        a.setIndexBuffer(this.terrainIndex, 'uint32');
        a.drawIndexed(this.terrainCount);
    }

    // the surface pass: the scene composited, the water over it, the features' (debris)
    translucent(f) {
        if (this.shared) return this.translucentShared(f);
        const enc = f.enc;
        const b = enc.beginRenderPass({
            label: 'surface',
            colorAttachments: [{ view: this.fx.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthReadOnly: true },
        });
        b.setBindGroup(0, this.worldGroup);
        b.setBindGroup(1, this.screenGroup);
        b.setPipeline(this.pComposite);
        b.draw(3);
        b.setPipeline(this.pWater);
        b.setIndexBuffer(this.waterIndex, 'uint32');
        b.drawIndexed(this.waterCount);
        this.renderer.each('surface', b);
        b.end();
    }

    // ... in a shared frame: the water (and the features') over the scene in radiance, refracting a copy of it; then the
    // surface into the scene's depth, for what comes after (the volumetrics)
    translucentShared(f) {
        const enc = f.enc, T = this.renderer.sceneTargets();
        this.resizeShared();
        enc.copyTextureToTexture({ texture: T.color }, { texture: this.sceneCopy }, [T.width, T.height]);
        const b = enc.beginRenderPass({
            label: 'surface',
            colorAttachments: [{ view: T.colorView, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: T.depthView, depthReadOnly: true, ...(T.stencil ? { stencilReadOnly: true } : {}) },
        });
        b.setBindGroup(0, this.worldGroup);
        b.setBindGroup(1, this.screenGroup);
        b.setPipeline(this.pWater);
        b.setIndexBuffer(this.waterIndex, 'uint32');
        b.drawIndexed(this.waterCount);
        this.renderer.each('surface', b);
        b.end();
        const c = enc.beginRenderPass({ label: 'water depth', colorAttachments: [],
            depthStencilAttachment: { view: T.depthView, depthLoadOp: 'load', depthStoreOp: 'store', ...(T.stencil ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}) } });
        c.setBindGroup(0, this.worldGroup);
        c.setPipeline(this.pWaterDepth);
        c.setIndexBuffer(this.waterIndex, 'uint32');
        c.drawIndexed(this.waterCount);
        c.end();
    }
}

return { RendererExtension };
});
