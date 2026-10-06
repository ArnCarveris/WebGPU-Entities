'use strict';
// The renderer: terrain, water and debris.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { makeBuffer, gridIndices } = Common;
const { FRAME_FLOATS, WGSL_COMMON, WGSL_SCENE, WGSL_SURFACE, TU, BU, makeLayout, makeGroup, makeTex } = feature;

// Renderer
class Renderer {
    // the host's device and canvas (fx: the feature context, see js/engine/host.js)
    constructor(fx) { this.fx = fx; }

    async init() {
        this.device = this.fx.device;
        this.format = this.fx.format;
        this.frameData = new Float32Array(FRAME_FLOATS);
        this.frameBuf = makeBuffer(this.device, FRAME_FLOATS * 4, BU().UNIFORM | BU().COPY_DST);
        this.createPipelines();
        this.width = this.height = 0;
    }

    createPipelines() {
        const d = this.device, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.worldLayout = makeLayout(d, VF, ['uniform', 'tex:unfilterable-float', 'tex:unfilterable-float', 'tex', 'sampler', 'array', 'array', 'array', 'array', 'read', 'read']);
        this.screenLayout = makeLayout(d, GPUShaderStage.FRAGMENT, ['tex', 'tex:depth']);
        this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        const U = TU();
        this.dummyArray = makeTex(d, 1, 1, 'rgba16float', U.TEXTURE_BINDING, 2).createView({ dimension: '2d-array' });
        const scene = d.createShaderModule({ label: 'scene', code: WGSL_COMMON + WGSL_SCENE });
        const surface = d.createShaderModule({ label: 'surface', code: WGSL_COMMON + WGSL_SURFACE });
        const layoutA = d.createPipelineLayout({ bindGroupLayouts: [this.worldLayout] });
        const layoutB = d.createPipelineLayout({ bindGroupLayouts: [this.worldLayout, this.screenLayout] });
        const pipe = (layout, module, vs, fs, format, depth, extra = {}) => d.createRenderPipeline({
            label: vs, layout,
            vertex: { module, entryPoint: vs },
            fragment: { module, entryPoint: fs, targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: extra.cull || 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: depth.write, depthCompare: depth.compare },
        });
        this.pSky = pipe(layoutA, scene, 'vsSky', 'fsSky', 'rgba16float', { write: false, compare: 'always' });
        this.pTerrain = pipe(layoutA, scene, 'vsTerrain', 'fsTerrain', 'rgba16float', { write: true, compare: 'greater' });
        this.pComposite = pipe(layoutB, surface, 'vsComposite', 'fsComposite', this.format, { write: false, compare: 'always' });
        this.pWater = pipe(layoutB, surface, 'vsWater', 'fsWater', this.format, { write: false, compare: 'greater' });
        this.pDebris = pipe(layoutB, surface, 'vsDebris', 'fsDebris', this.format, { write: false, compare: 'greater' }, { cull: 'back' });
        // a composition's depth: the terrain's plus the water surface (dry cells sink under the terrain in vsWater)
        this.pWaterDepth = d.createRenderPipeline({
            label: 'water depth', layout: layoutB,
            vertex: { module: surface, entryPoint: 'vsWater' },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        });
    }

    setSim(world, flow, waves, debris) {
        const d = this.device, n = world.field.n, U = BU();
        this.terrainIndex?.destroy();
        this.waterIndex?.destroy();
        const ti = gridIndices(n + 2), wi = gridIndices(n);
        this.terrainIndex = makeBuffer(d, ti.byteLength, U.INDEX, ti);
        this.terrainCount = ti.length;
        this.waterIndex = makeBuffer(d, wi.byteLength, U.INDEX, wi);
        this.waterCount = wi.length;
        const disp = [0, 1, 2, 3].map(i => waves.layers[i] ? waves.layers[i].dispView : this.dummyArray);
        this.worldGroup = makeGroup(d, this.worldLayout, [this.frameBuf, flow.terrain.createView(), flow.surf.createView(), flow.flow.createView(),
            this.sampler, ...disp, debris.particles, debris.emitters], 'world');
        this.debrisCount = debris.count;
    }

    resize() {
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height) return;
        this.width = w;
        this.height = h;
        const U = TU();
        this.hdr?.destroy();
        this.depth?.destroy();
        this.hdr = makeTex(this.device, w, h, 'rgba16float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING);
        this.depth = makeTex(this.device, w, h, 'depth32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC);
        this.depthC?.destroy();
        this.depthC = this.fx.composed ? makeTex(this.device, w, h, 'depth32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_DST) : null;
        this.depthCView = this.depthC?.createView();
        this.hdrView = this.hdr.createView();
        this.depthView = this.depth.createView();
        this.screenGroup = makeGroup(this.device, this.screenLayout, [this.hdrView, this.depthView], 'screen');
    }

    render(enc) {
        this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
        const a = enc.beginRenderPass({
            label: 'scene',
            colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
        });
        a.setBindGroup(0, this.worldGroup);
        a.setPipeline(this.pSky);
        a.draw(3);
        a.setPipeline(this.pTerrain);
        a.setIndexBuffer(this.terrainIndex, 'uint32');
        a.drawIndexed(this.terrainCount);
        a.end();

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
        if (this.debrisCount) { b.setPipeline(this.pDebris); b.draw(36, this.debrisCount); }
        b.end();
        if (this.depthC) {
            enc.copyTextureToTexture({ texture: this.depth }, { texture: this.depthC }, [this.width, this.height]);
            const c = enc.beginRenderPass({ label: 'water depth', colorAttachments: [],
                depthStencilAttachment: { view: this.depthCView, depthLoadOp: 'load', depthStoreOp: 'store' } });
            c.setBindGroup(0, this.worldGroup);
            c.setBindGroup(1, this.screenGroup);
            c.setPipeline(this.pWaterDepth);
            c.setIndexBuffer(this.waterIndex, 'uint32');
            c.drawIndexed(this.waterCount);
            c.end();
        }
    }
}

return { Renderer };
});
