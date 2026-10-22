'use strict';
// The atmosphere's RendererExtension (the one Renderer, kits.gpu): owns the GPU resources and encodes a frame: the sky, the terrain, the weather, the volumetrics, the
// precipitation, the bloom and the composite. What a world has beyond that (its structures, plants, buses...) the features
// on in it draw, as its extensions.

Features.kit('atmosphere', (engine, kit) => {
const { Common, kits } = engine;
const { makeBuffer, bindLayout, bindGroup, frustumPlanes } = Common;
const {
    MAX_CELLS, CELL_FLOATS, BLOOM_LEVELS, FrameBlock, WORLD_BINDINGS, BindingSet, BUS_UNIFORM, NoiseVolumes, shaderSource, atmosphereWgsl,
    WeatherPass, GroundPass, FroxelPass, CloudPass, SHADOW_NEAR,
} = kit;
const { MAX_BOLT_SEGS } = kits.weather;
const { GpuProfiler } = kits.gpu;
const { TerrainLod, TERRAIN_MAX_NODES, terrainPatchIndices } = kits.terrain;

// The renderer. What the features on in its world add to it are its other extensions (their RendererExtensions: classes
// built with the renderer, renderer.compose: new E(renderer), kept as renderer.ext[E.key]), in the features' order; each
// member optional:
//   frame                    its fields of the frame uniform (FrameBlock: [name, type] pairs, after the core's)
//   wgsl(library, modules)   its shader chunks, over the core's stubs, before any module is made; modules: the chunk
//                            names of the scene and final modules ({ scene, final }), to add its own to
//   pipelines(ctx)           its pipelines, after the core's: ctx { scene, final (modules), layoutA (world), layoutB
//                            (+ screen), layoutBus (+ object frame), layoutGlass, pipe(layout, module, vs, fs, format,
//                            depth, blend, buffers) }
//   init()                   its resources (async), after the pipelines
//   frames(world)            how many object frames (busData slots) it draws in; its first is frameBase
//   setWorld(world)          its buffers for a new world (before the world's bind group)
//   bindings(res)            its resources of the world bind group (res: the core's, by name; 'buildings')
//   prepare(enc)             before the frame's passes (its targets)
//   encode(enc, prof)        its compute passes, before the scene pass
//   outdoor(pass, ctx)       its draws of the outdoors in the scene pass (after the terrain; scissored to the portals the
//                            outdoors is seen through): ctx { drawPatches() (the terrain's patches again) }
//   indoor(pass)             its draws of what is inside, over the whole screen, after the outdoors
//   late(pass)               the outdoors after the indoors (scissored as outdoor's)
//   final(pass)              its draws in the final pass, after the composite and the precipitation
class RendererExtension {
    static key = 'atmosphere';
    // what it draws with alone (Renderer.frameSpec): radiance (its final pass maps it), reversed depth, no MSAA (the march
    // reads single-sample depth: a frame it shares is single-sample too, single); depth32float-stencil8 where the device
    // has it. In a frame it shares (Renderer.share) its sky is the frame's, and its targets the scene every kit draws in
    static frame = { display: 'radiance', depth: 'reversed', depthFormat: 'depth32float-stencil8', samples: 1, near: kit.NEAR,
        single: true, ranks: { sky: 3, post: 2 } };
    // what it answers on the Renderer (Common.Composite)
    static exposes = ['air', 'bloom', 'bloomViews', 'boltBuf', 'busData', 'busGroup', 'busLayout', 'cellBuf',
        'cellData', 'clampSamp', 'cloudPass', 'createPipelines', 'depth', 'depthFormat', 'depthSampleView', 'depthView',
        'device', 'encodeBloom', 'format', 'frame', 'frameBuf', 'froxelPass', 'fx',
        'height', 'heightView', 'init', 'lineLayer', 'modules', 'noise', 'outdoors', 'profiler', 'render', 'repSamp',
        'resize', 'scale', 'sceneModule', 'setWorld', 'stencilBits', 'terrainIndex', 'terrainLod', 'terrainNodes',
        'useFrames', 'vegetation', 'weatherPass', 'wgsl', 'width', 'worldGroup', 'worldSet'];
    // fx: the site's context (the host's device, canvas size, target, the features on in it (fx.features); see
    // js/engine/host.js)
    constructor(renderer, fx) {
        this.renderer = renderer;
        this.fx = fx;
        renderer.compose(kits.gpu.extensionsOf(fx.features, 'renderer'));
        this.outdoors = null;           // the outdoors seen from inside ({ seen, rect }: a feature's portal traversal), or all of it
    }

    async init() {
        this.device = this.fx.device;
        // the shaders: the core's chunks, the features' over them; the scene and final modules' chunks
        this.wgsl = atmosphereWgsl();
        this.modules = {
            scene: ['SKY', 'WEATHER_SAMPLE', 'SHADOW_SAMPLE', 'SHELTER', 'TERRAIN', 'FOREST', 'SCENE'],
            final: ['SKY', 'WEATHER_SAMPLE', 'SHADOW_SAMPLE', 'SHELTER', 'TERRAIN', 'FINAL'],
        };
        this.renderer.each('wgsl', this.wgsl, this.modules);
        this.profiler = new GpuProfiler(this.device, ['weather', 'ground', 'vegetation', 'scene', 'froxel', 'tiles', 'march', 'resolve', 'bloom', 'final']);
        this.format = this.fx.format;
        // the scene's depth: with a stencil when the device has one to share out (StencilLayout: the world-space GUIs'
        // masks), else depth only (the GUIs fall back to render targets)
        this.depthFormat = this.device.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float';
        this.stencilBits = this.depthFormat === 'depth32float' ? 0 : 8;
        const d = this.device, B = GPUBufferUsage;
        this.frame = new FrameBlock(this.renderer.extensions.flatMap(x => x.frame || []));
        this.frameBuf = makeBuffer(d, this.frame.data.byteLength, B.UNIFORM | B.COPY_DST);
        this.cellData = new Float32Array(MAX_CELLS * CELL_FLOATS);
        this.cellBuf = makeBuffer(d, this.cellData.byteLength, B.STORAGE | B.COPY_DST);
        this.boltBuf = makeBuffer(d, MAX_BOLT_SEGS * 32, B.STORAGE | B.COPY_DST);
        // the world bind group's 'buildings' when no feature binds its own (the structures' records)
        this.noBuildings = makeBuffer(d, 512, B.STORAGE);
        this.repSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
        this.clampSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        this.noise = new NoiseVolumes(d);
        this.weatherPass = new WeatherPass(this.renderer);
        this.worldSet = new BindingSet(d, WORLD_BINDINGS.map(b => b[0]));
        this.froxelPass = new FroxelPass(this.renderer);
        this.cloudPass = new CloudPass(this.renderer);
        this.createPipelines();
        for (const x of this.renderer.extensions) await x.init?.();
        this.width = this.height = 0;
        this.scale = 0.5;
    }

    createPipelines() {
        const d = this.device;
        this.screenLayout = bindLayout(d, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, ['tex', 'tex', 'depth', 'tex']);
        const scene = this.sceneModule = d.createShaderModule({ label: 'scene', code: shaderSource(this.renderer, this.worldSet, this.wgsl.code(...this.modules.scene)) });
        const final = d.createShaderModule({ label: 'final', code: shaderSource(this.renderer, this.worldSet, this.wgsl.code(...this.modules.final)) });
        const layoutA = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout] });
        const layoutB = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout, this.screenLayout] });
        // an object's frame (busData: wgslObject), at a dynamic offset per object: group 1 in the scene pass, group 2 in the
        // final one
        this.busLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 208 } }] });
        const layoutBus = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout, this.busLayout] });
        const layoutGlass = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout, this.screenLayout, this.busLayout] });
        const blendAlpha = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
        const blendAdd = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
        const pipe = (layout, module, vs, fs, format, depth, blend, buffers) => d.createRenderPipeline({
            label: vs, layout,
            vertex: { module, entryPoint: vs, buffers },
            fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: this.depthFormat, depthWriteEnabled: depth.write, depthCompare: depth.compare },
        });
        this.pSky = pipe(layoutA, scene, 'vsSky', 'fsSky', 'rgba16float', { write: false, compare: 'always' });
        // (a frame it shares: over what is drawn before it, space, by depth (fsSkyOver), and only as much as there is air
        // about the eye: the blend constant, AppExtension.airAt)
        const blendAir = { color: { srcFactor: 'constant', dstFactor: 'one-minus-constant' }, alpha: { srcFactor: 'one', dstFactor: 'zero' } };
        if (this.renderer.frameSpec?.shared) this.pSkyOver = pipe(layoutA, scene, 'vsSky', 'fsSkyOver', 'rgba16float', { write: false, compare: 'greater-equal' }, blendAir);
        // the terrain patch: vertex index -> patch corner; a node (x0, z0, size, lod) per instance
        this.pTerrain = pipe(layoutA, scene, 'vsTerrain', 'fsTerrain', 'rgba16float', { write: true, compare: 'greater' }, undefined, [{
            arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }]);
        this.pComposite = pipe(layoutB, final, 'vsFull', 'fsComposite', this.format, { write: false, compare: 'always' });
        this.pPrecip = pipe(layoutB, final, 'vsPrecip', 'fsPrecip', this.format, { write: false, compare: 'greater' }, blendAlpha);
        this.pBolt = pipe(layoutB, final, 'vsBolt', 'fsBolt', this.format, { write: false, compare: 'greater' }, blendAdd);
        // the sector and portal frames (the interior kit's VisInspector lines, about the eye), over the finished frame
        this.lineLayer = this.renderer.debugLines({ format: this.format, depth: { format: this.depthFormat, compare: 'greater' } });
        // bloom (WGSL_BLOOM): fullscreen passes into the levels of this.bloom, no depth
        this.bloomLayout = bindLayout(d, GPUShaderStage.FRAGMENT, ['tex', 'tex']);
        const bloom = d.createShaderModule({ label: 'bloom', code: shaderSource(this.renderer, this.worldSet, this.wgsl.code('BLOOM')) });
        const layoutBloom = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout, this.bloomLayout] });
        const bloomPipe = (fs, blend) => d.createRenderPipeline({
            label: fs, layout: layoutBloom,
            vertex: { module: bloom, entryPoint: 'vsBloom' },
            fragment: { module: bloom, entryPoint: fs, targets: [{ format: 'rgba16float', blend }] },
            primitive: { topology: 'triangle-list' },
        });
        this.pBloomPre = bloomPipe('fsBloomPre');
        this.pBloomDown = bloomPipe('fsBloomDown');
        const blendOne = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
        this.pBloomUp = bloomPipe('fsBloomUp', blendOne);
        // the bolts into its top level (fsBoltGlow)
        this.pBoltGlow = d.createRenderPipeline({
            label: 'fsBoltGlow', layout: layoutB,
            vertex: { module: final, entryPoint: 'vsBolt' },
            fragment: { module: final, entryPoint: 'fsBoltGlow', targets: [{ format: 'rgba16float', blend: blendOne }] },
            primitive: { topology: 'triangle-list' },
        });
        const ctx = { scene, final, layoutA, layoutB, layoutBus, layoutGlass, pipe, blendAlpha };
        this.renderer.each('pipelines', ctx);
    }

    setWorld(world) {
        const d = this.device, f = world.field, U = GPUTextureUsage;
        this.heightMap?.destroy();
        this.landMap?.destroy();
        this.groundPass?.destroy();
        this.heightMap = d.createTexture({ size: [f.n, f.n], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.COPY_DST });
        d.queue.writeTexture({ texture: this.heightMap }, f.packHeight(), { bytesPerRow: f.n * 8 }, [f.n, f.n]);
        this.landMap = d.createTexture({ size: [f.n, f.n], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST });
        d.queue.writeTexture({ texture: this.landMap }, f.packLand(), { bytesPerRow: f.n * 4 }, [f.n, f.n]);
        this.heightView = this.heightMap.createView();
        this.canopyMap?.destroy();
        const cp = f.packCanopy();
        this.canopyMap = d.createTexture({ size: [cp.n, cp.n], format: 'rg8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST });
        d.queue.writeTexture({ texture: this.canopyMap }, cp.bytes, { bytesPerRow: cp.n * 2 }, [cp.n, cp.n]);
        this.smoothMap?.destroy();
        this.smoothMap = d.createTexture({ size: [f.mres, f.mres], format: 'rg8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST });
        d.queue.writeTexture({ texture: this.smoothMap }, f.packSmooth(), { bytesPerRow: f.mres * 2 }, [f.mres, f.mres]);
        // the terrain: CDLOD nodes picked each frame (terrainDraws), each the same patch (vsTerrain), its node an instance
        this.terrainLod = new TerrainLod(f, { step: world.terrain.step, detail: world.terrain.detail });
        if (!this.terrainIndex) {
            const pi = terrainPatchIndices();
            this.terrainIndex = makeBuffer(d, pi.byteLength, GPUBufferUsage.INDEX, pi);
            this.terrainQuarter = pi.length / 4;
            this.terrainNodes = d.createBuffer({ size: TERRAIN_MAX_NODES * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.groundPass = new GroundPass(this.renderer, world);
        // the objects drawn in their own frames (busData, BUS_UNIFORM bytes each): each extension's frames(world) of
        // them from its frameBase; written each frame up to what they used (useFrames)
        let slots = 0;
        for (const x of this.renderer.extensions) { x.frameBase = slots; slots += x.frames?.(world) || 0; }
        this.busUBuf?.destroy();
        this.busData = new Float32Array(Math.max(slots, 1) * BUS_UNIFORM / 4);
        this.busUBuf = d.createBuffer({ size: this.busData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.busGroup = d.createBindGroup({ label: 'object frames', layout: this.busLayout, entries: [{ binding: 0, resource: { buffer: this.busUBuf, size: 208 } }] });
        this.framesUsed = 0;
        this.renderer.each('setWorld', world);
        const res = {
            F: this.frameBuf, shapeTex: this.noise.shapeView, detailTex: this.noise.detailView, weatherTex: this.weatherPass.weatherView,
            shadowTex: this.weatherPass.shadowView, heightTex: this.heightView, landTex: this.landMap.createView(), smoothTex: this.smoothMap.createView(), canopyTex: this.canopyMap.createView(), repSamp: this.repSamp,
            clampSamp: this.clampSamp, cells: this.cellBuf, ground: this.groundPass.buffer, bolts: this.boltBuf, anvilTex: this.weatherPass.anvilView,
            layerTex: this.weatherPass.layerView, styleTex: this.weatherPass.styleView, occ: this.weatherPass.occ, buildings: this.noBuildings,
        };
        this.renderer.each('bindings', res);
        this.worldRes = res;
        this.worldGroup = this.worldSet.group(res, 'world');
    }

    // an extension used its frames up to its count-th this frame (written to the GPU with the frame)
    useFrames(x, count) { if (count) this.framesUsed = Math.max(this.framesUsed, x.frameBase + count); }

    // the terrain's nodes for this frame's eye (TerrainLod.select), written to terrainNodes: [quadrant (0 the whole
    // patch, q + 1 its quarter q), first instance, instances]
    terrainDraws() {
        const F = this.frame.data, o = this.frame.offsets, L = this.terrainLod, planes = frustumPlanes(F.subarray(o.viewProj, o.viewProj + 16), { reversed: true });
        const n = L.select([F[o.cam], F[o.cam + 1], F[o.cam + 2]], planes, F[o.curve + 2], F[o.curve + 3] || 6371000);
        if (n) this.device.queue.writeBuffer(this.terrainNodes, 0, L.nodes, 0, n * 4);
        return L.draws;
    }

    // its scene targets, every kit's in a frame it shares (Renderer.sceneTargets)
    targets() {
        return { color: this.hdr, colorView: this.hdrView, depth: this.depth, depthView: this.depthView, depthSample: this.depthSampleView,
            stencil: this.stencilBits > 0, width: this.width, height: this.height };
    }

    // its world group back on the scene pass after another kit drew in it (a shared frame: Renderer.encodeFrame)
    bind(f) { f.pass.setBindGroup(0, this.worldGroup); }

    // a depth-stencil attachment's stencil ops (none on a depth-only target)
    stencilOps(load) { return this.stencilBits ? { stencilLoadOp: load, stencilStoreOp: 'store', stencilClearValue: 0 } : {}; }

    resize(scale) {
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height && scale === this.scale) return false;
        this.width = w;
        this.height = h;
        this.scale = scale;
        const U = GPUTextureUsage;
        this.hdr?.destroy();
        this.depth?.destroy();
        this.hdr = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC });
        this.depth = this.device.createTexture({ size: [w, h], format: this.depthFormat, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.hdrView = this.hdr.createView();
        this.depthView = this.depth.createView();                                     // (the attachment)
        this.depthSampleView = this.depth.createView({ aspect: 'depth-only' });      // (what the passes after it sample)
        this.cloudPass.resize(Math.max(1, Math.ceil(w * scale)), Math.max(1, Math.ceil(h * scale)), this.depthSampleView);
        // the bloom chain: half resolution down to no less than 4 texels a side
        const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
        const levels = Math.max(1, Math.min(BLOOM_LEVELS, Math.floor(Math.log2(Math.min(bw, bh) / 4)) + 1));
        this.bloom?.destroy();
        this.bloom = this.device.createTexture({ size: [bw, bh], mipLevelCount: levels, format: 'rgba16float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.bloomViews = Array.from({ length: levels }, (_, k) => this.bloom.createView({ baseMipLevel: k, mipLevelCount: 1 }));
        this.bloomGroups = this.bloomViews.map((v, k) => bindGroup(this.device, this.bloomLayout, [v, this.hdrView], `bloom-${k}`));
        this.bloomPreGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.bloomLayout, [hv, this.hdrView], `bloom-pre-${k}`));
        this.screenGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.screenLayout, [hv, this.hdrView, this.depthSampleView, this.bloomViews[0]], `screen-${k}`));
        // for the bolts drawn into level 0: any other view in the bloom slot (unread there)
        this.bloomSpare ??= this.device.createTexture({ size: [1, 1], format: 'rgba16float', usage: U.TEXTURE_BINDING });
        const spare = levels > 1 ? this.bloomViews[1] : this.bloomSpare.createView();
        this.boltGlowGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.screenLayout, [hv, this.hdrView, this.depthSampleView, spare], `bolt-glow-${k}`));
        return true;
    }

    // volumetrics false (render mode 'no volumetrics'): no froxel, march or resolve; the composite shows the scene only
    // bloom (WGSL_BLOOM): prefilter the composite into level 0 and add the lightning bolts (fsBoltGlow), filter down level
    // by level, then back up, each level adding onto the one above it
    encodeBloom(enc, hist, bolts) {
        const prof = this.profiler, n = this.bloomViews.length, passes = 2 * n - 1 + (bolts ? 1 : 0);
        let p = 0;
        const pass = (pipeline, group, k, load, count = 3, instances = 1) => {
            const r = enc.beginRenderPass({
                label: 'bloom', timestampWrites: prof.writes('bloom', p === 0, p === passes - 1),
                colorAttachments: [{ view: this.bloomViews[k], loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            });
            r.setBindGroup(0, this.worldGroup);
            r.setBindGroup(1, group);
            r.setPipeline(pipeline);
            r.draw(count, instances);
            r.end();
            p++;
        };
        pass(this.pBloomPre, this.bloomPreGroups[hist], 0, false);
        if (bolts) pass(this.pBoltGlow, this.boltGlowGroups[hist], 0, true, 6, bolts);
        for (let k = 1; k < n; k++) pass(this.pBloomDown, this.bloomGroups[k - 1], k, false);
        for (let k = n - 2; k >= 0; k--) pass(this.pBloomUp, this.bloomGroups[k + 1], k, true);
    }

    // one frame (Renderer.encode: its stages, into the frame encoder): o { probeTexel, particles, bolts, interleave,
    // shadowSlices, froxels, volumetrics, tiles, bloom, air (how much of its air there is about the eye: AppExtension.airAt;
    // at none, none of its scene) }
    render(o) {
        this.renderer.encode({ volumetrics: true, tiles: true, bloom: true, air: 1, ...o });
    }

    // the frame's uniforms, the weather and ground passes, the features' passes
    compute(f) {
        const q = this.device.queue, prof = this.profiler, enc = f.enc;
        const air = this.air;
        this.frame.set('shell', air ? air.shell : [0, 0, 0, 0]);
        this.frame.set('shellInfo', [air ? air.hides : 0, f.air <= 0 ? 1 : 0, 0, 0]);
        q.writeBuffer(this.frameBuf, 0, this.frame.data);
        q.writeBuffer(this.cellBuf, 0, this.cellData);
        if (this.framesUsed) q.writeBuffer(this.busUBuf, 0, this.busData, 0, this.framesUsed * BUS_UNIFORM / 4);
        this.framesUsed = 0;
        this.renderer.each('prepare', enc);
        // (the near shadow maps' slices: the fewest of the frame's sdomain[k].w, FrameWriter's)
        const sd = this.frame.data, so = this.frame.offsets.sdomain, nearSlices = Math.min(...SHADOW_NEAR.map((_, k) => sd[so + k * 4 + 3] || 1));
        this.weatherPass.encode(enc, f.probeTexel, prof, f.shadowSlices, nearSlices);
        this.groundPass.encode(enc, prof);
        this.renderer.each('encode', enc, prof);
    }

    // the scene pass; the outdoors (a feature's portal traversal, this.outdoors): from inside, only within the screen
    // rectangle of the portals it passed out to it, or not at all; what is inside after it over the whole screen
    scene(f) {
        const a = f.enc.beginRenderPass({
            label: 'scene', timestampWrites: this.profiler.writes('scene'),
            colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0, ...this.stencilOps('clear') },
        });
        a.setBindGroup(0, this.worldGroup);
        const od = f.od = this.outdoors || { seen: true, rect: null }, W = this.width, H = this.height;
        f.outdoor = on => { if (od.rect) on ? a.setScissorRect(od.rect[0], od.rect[1], od.rect[2] - od.rect[0], od.rect[3] - od.rect[1]) : a.setScissorRect(0, 0, W, H); };
        return a;
    }

    sky(f) {
        if (!f.od.seen || f.air <= 0) return;
        f.outdoor(true);
        if (this.pSkyOver) f.pass.setBlendConstant([f.air ?? 1, f.air ?? 1, f.air ?? 1, 1]);
        f.pass.setPipeline(this.pSkyOver || this.pSky);
        f.pass.draw(3);
    }

    // the terrain, then the features' outdoors (still within the outdoors' rectangle)
    outdoor(f) {
        if (!f.od.seen || f.air <= 0) return;
        const a = f.pass;
        a.setPipeline(this.pTerrain);
        a.setIndexBuffer(this.terrainIndex, 'uint32');
        a.setVertexBuffer(0, this.terrainNodes);
        const tDraws = this.terrainDraws();
        const drawPatches = () => {
            for (const [q, first, n] of tDraws) {
                if (q) a.drawIndexed(this.terrainQuarter, n, (q - 1) * this.terrainQuarter, 0, first);
                else a.drawIndexed(this.terrainQuarter * 4, n, 0, 0, first);
            }
        };
        drawPatches();
        this.renderer.each('outdoor', a, { drawPatches });
        f.outdoor(false);
    }

    indoor(f) { this.renderer.each('indoor', f.pass); }

    late(f) {
        if (!f.od.seen || f.air <= 0) return;
        f.outdoor(true);
        this.renderer.each('late', f.pass);
        f.outdoor(false);
    }


    volumetric(f) {
        if (f.froxels && f.volumetrics) this.froxelPass.encode(f.enc, this.profiler);
        f.hist = f.volumetrics ? this.cloudPass.encode(f.enc, this.profiler, f.interleave, f.tiles) : this.cloudPass.cur;
    }

    post(f) { if (f.bloom) this.encodeBloom(f.enc, f.hist, f.bolts); }

    final(f) {
        const b = f.enc.beginRenderPass({
            label: 'final', timestampWrites: this.profiler.writes('final'),
            colorAttachments: [{ view: this.fx.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthReadOnly: true, ...(this.stencilBits ? { stencilReadOnly: true } : {}) },
        });
        b.setBindGroup(0, this.worldGroup);
        b.setBindGroup(1, this.screenGroups[f.hist]);
        b.setPipeline(this.pComposite);
        b.draw(3);
        if (f.particles) { b.setPipeline(this.pPrecip); b.draw(6, f.particles); }
        this.renderer.each('final', b);
        if (f.bolts) { b.setPipeline(this.pBolt); b.draw(6, f.bolts); }
        this.lineLayer.draw(b);
        b.end();
        this.profiler.resolve(f.enc);
    }

}

return { RendererExtension };
});
