'use strict';
// The renderer: owns the GPU resources and encodes a frame.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { makeBuffer, gridIndices, bindLayout, bindGroup } = Common;
const {
    MAX_CELLS, CELL_FLOATS, MAX_BOLT_SEGS, FAR_FLOATS, MAX_FAR_DYN, FAR_LAMP_H, FAR_LAMP_REACH, MAX_POLES,
    STRUCT_FLOATS, GRID_N, BLOOM_LEVELS, BUILDING_FLOATS, FrameBlock, WORLD_BINDINGS, BindingSet, WGSL_SKY,
    WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, BUS_UNIFORM, wgslBus, WGSL_TERRAIN,
    WGSL_SCENE, WGSL_FINAL, WGSL_BLOOM, GroundFrame, STRUCT_COLORS, Structures, NoiseVolumes, shaderSource,
    WeatherPass, GroundPass, FroxelPass, CloudPass, GpuProfiler,
} = feature;

// Renderer
class Renderer {
    // fx: the feature context (the host's device, canvas size, target, and in a composition the other worlds to put
    // under the clouds: fx.inject; see js/engine/host.js)
    constructor(fx) { this.fx = fx; }

    async init() {
        this.device = this.fx.device;
        this.profiler = new GpuProfiler(this.device, ['weather', 'ground', 'scene', 'froxel', 'tiles', 'march', 'resolve', 'bloom', 'final']);
        this.format = this.fx.format;
        const d = this.device, B = GPUBufferUsage;
        this.frame = new FrameBlock();
        this.frameBuf = makeBuffer(d, this.frame.data.byteLength, B.UNIFORM | B.COPY_DST);
        this.cellData = new Float32Array(MAX_CELLS * CELL_FLOATS);
        this.cellBuf = makeBuffer(d, this.cellData.byteLength, B.STORAGE | B.COPY_DST);
        this.boltBuf = makeBuffer(d, MAX_BOLT_SEGS * 32, B.STORAGE | B.COPY_DST);
        this.repSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
        this.clampSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        this.noise = new NoiseVolumes(d);
        this.weatherPass = new WeatherPass(this);
        this.worldSet = new BindingSet(d, WORLD_BINDINGS.map(b => b[0]));
        this.froxelPass = new FroxelPass(this);
        this.cloudPass = new CloudPass(this);
        this.createPipelines();
        const gi = gridIndices(GRID_N);
        this.terrainIndex = makeBuffer(d, gi.byteLength, B.INDEX, gi);
        this.terrainCount = gi.length;
        this.width = this.height = 0;
        this.scale = 0.5;
    }

    createPipelines() {
        const d = this.device;
        this.screenLayout = bindLayout(d, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, ['tex', 'tex', 'depth', 'tex']);
        const scene = d.createShaderModule({ label: 'scene', code: shaderSource(this.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, WGSL_TERRAIN, wgslBus(1), WGSL_SCENE) });
        const final = d.createShaderModule({ label: 'final', code: shaderSource(this.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, WGSL_TERRAIN, wgslBus(2), WGSL_FINAL) });
        const layoutA = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout] });
        const layoutB = d.createPipelineLayout({ bindGroupLayouts: [this.worldSet.layout, this.screenLayout] });
        // one bus's uniforms (wgslBus), at a dynamic offset per bus: group 1 in the scene pass, group 2 in the final one
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
            depthStencil: { format: 'depth32float', depthWriteEnabled: depth.write, depthCompare: depth.compare },
        });
        this.pSky = pipe(layoutA, scene, 'vsSky', 'fsSky', 'rgba16float', { write: false, compare: 'always' });
        this.pTerrain = pipe(layoutA, scene, 'vsTerrain', 'fsTerrain', 'rgba16float', { write: true, compare: 'greater' });
        const structVerts = [{
            arrayStride: STRUCT_FLOATS * 4, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x4' }],
        }];
        this.pStruct = pipe(layoutA, scene, 'vsStruct', 'fsStruct', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        this.pBus = pipe(layoutBus, scene, 'vsBus', 'fsBus', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        // buildings (Buildings.add): interiors near them, door leaves, the opaque panes far off, the glass near
        this.pInterior = pipe(layoutA, scene, 'vsStruct', 'fsInterior', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        this.pDoor = pipe(layoutA, scene, 'vsStruct', 'fsDoor', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        this.pPane = pipe(layoutA, scene, 'vsStruct', 'fsPane', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        // the distant lights (vsFar): a quad per instance, added
        const farVerts = [{ arrayStride: FAR_FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map(k => ({ shaderLocation: k, offset: k * 16, format: 'float32x4' })) }];
        const blendSum = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
        this.pFar = pipe(layoutA, scene, 'vsFar', 'fsFar', 'rgba16float', { write: false, compare: 'greater' }, blendSum, farVerts);
        this.pFarPool = pipe(layoutA, scene, 'vsFarPool', 'fsFarPool', 'rgba16float', { write: false, compare: 'greater' }, blendSum, farVerts);
        const poleVerts = [structVerts[0], { arrayStride: 32, stepMode: 'instance', attributes: [3, 4].map((k, i) => ({ shaderLocation: k, offset: i * 16, format: 'float32x4' })) }];
        this.pFarPole = pipe(layoutA, scene, 'vsFarPole', 'fsStruct', 'rgba16float', { write: true, compare: 'greater' }, undefined, poleVerts);
        // one street lamp in its own frame (as Fixtures.lamp builds it, head FAR_LAMP_H up), for every fake one drawn
        const T = new Structures(null), f = new GroundFrame([0, 0], 0), h = FAR_LAMP_H + 0.3, reach = FAR_LAMP_REACH, C = STRUCT_COLORS;
        T.cur = [];
        T.prism(f, 0, 0, 0.08, 0.08, -0.3, h, C.metal, 4);
        T.prism(f, reach / 2, 0, reach / 2, 0.04, h - 0.07, h, C.metal, 4);
        T.prism(f, reach, 0, 0.34, 0.15, h - 0.14, h + 0.04, C.metal, 4);
        T.prism(f, reach, 0, 0.29, 0.12, h - 0.19, h - 0.14, [1, 1, 1], 7);
        const pm = new Float32Array(T.cur);
        this.poleMesh = { n: pm.length / STRUCT_FLOATS, buf: makeBuffer(d, pm.byteLength, GPUBufferUsage.VERTEX, pm) };
        this.poleBuf = makeBuffer(d, MAX_POLES * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this.poleCount = 0;
        this.pWindow = pipe(layoutB, final, 'vsWindow', 'fsWindow', this.format, { write: false, compare: 'greater' }, blendAlpha, structVerts);
        this.pComposite = pipe(layoutB, final, 'vsFull', 'fsComposite', this.format, { write: false, compare: 'always' });
        this.pGlass = pipe(layoutGlass, final, 'vsGlass', 'fsGlass', this.format, { write: false, compare: 'greater' }, blendAlpha, structVerts);
        this.pPrecip = pipe(layoutB, final, 'vsPrecip', 'fsPrecip', this.format, { write: false, compare: 'greater' }, blendAlpha);
        this.pBolt = pipe(layoutB, final, 'vsBolt', 'fsBolt', this.format, { write: false, compare: 'greater' }, blendAdd);
        // bloom (WGSL_BLOOM): fullscreen passes into the levels of this.bloom, no depth
        this.bloomLayout = bindLayout(d, GPUShaderStage.FRAGMENT, ['tex', 'tex']);
        const bloom = d.createShaderModule({ label: 'bloom', code: shaderSource(this.worldSet, WGSL_BLOOM) });
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
        this.groundPass = new GroundPass(this, world);
        this.structBuf?.destroy();
        const sv = new Float32Array(world.structures.v);
        this.structCount = sv.length / STRUCT_FLOATS;
        this.structBuf = this.structCount ? makeBuffer(d, sv.byteLength, GPUBufferUsage.VERTEX, sv) : null;
        // the buildings: their records (WGSL_BUILDING), interiors (one vertex range each, drawn near them: interiorDraws),
        // window glass and far panes, and the door leaves (rewritten when one moves: writeDoors)
        const S = world.structures, vb = arr => { const a = new Float32Array(arr); return { n: a.length / STRUCT_FLOATS, buf: a.length ? makeBuffer(d, a.byteLength, GPUBufferUsage.VERTEX, a) : null }; };
        for (const k of ['interior', 'glassV', 'paneV', 'doorV']) this[k]?.buf?.destroy();
        this.buildingBuf?.destroy();
        this.interior = vb(S.iv);
        this.glassV = vb(S.glass);
        this.paneV = vb(S.panes);
        const dm = S.doors.mesh();
        this.doorV = { n: dm.length / STRUCT_FLOATS, buf: dm.length ? makeBuffer(d, dm.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, new Float32Array(dm)) : null };
        const rec = new Float32Array(Math.max(1, S.buildings.list.length) * BUILDING_FLOATS);
        S.buildings.list.forEach((b, i) => rec.set(b.record, i * BUILDING_FLOATS));
        this.buildingBuf = makeBuffer(d, rec.byteLength, GPUBufferUsage.STORAGE, rec);
        this.interiorDraws = [];
        // the distant lights: the static ones (World.buildFarLights), then MAX_FAR_DYN slots for the buses' (LightWriter.writeFar)
        this.farBuf?.destroy();
        this.farStatic = world.farLights.length / FAR_FLOATS;
        this.farBuf = makeBuffer(d, (this.farStatic + MAX_FAR_DYN) * FAR_FLOATS * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        if (this.farStatic) d.queue.writeBuffer(this.farBuf, 0, world.farLights);
        this.farCount = 0;
        this.realFar = world.realFar;
        // the buses, each in its own frame: opaque mesh and glass, and its uniforms (busData, BUS_UNIFORM bytes each); the
        // app lists the ones to draw this frame in busDraws, nearest first
        for (const m of this.busMeshes || []) { m.buf?.destroy(); m.glass?.destroy(); }
        this.busMeshes = world.buses.map(b => {
            const bv = new Float32Array(b.mesh.v), gv = new Float32Array(b.mesh.glass);
            return { count: bv.length / STRUCT_FLOATS, glassCount: gv.length / STRUCT_FLOATS,
                buf: bv.length ? makeBuffer(d, bv.byteLength, GPUBufferUsage.VERTEX, bv) : null,
                glass: gv.length ? makeBuffer(d, gv.byteLength, GPUBufferUsage.VERTEX, gv) : null };
        });
        this.busUBuf?.destroy();
        this.busData = new Float32Array(Math.max(1, world.buses.length) * BUS_UNIFORM / 4);
        this.busUBuf = d.createBuffer({ size: this.busData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.busGroup = d.createBindGroup({ label: 'bus', layout: this.busLayout, entries: [{ binding: 0, resource: { buffer: this.busUBuf, size: 208 } }] });
        this.busDraws = [];
        this.worldGroup = this.worldSet.group({
            F: this.frameBuf, shapeTex: this.noise.shapeView, detailTex: this.noise.detailView, weatherTex: this.weatherPass.weatherView,
            shadowTex: this.weatherPass.shadowView, heightTex: this.heightView, landTex: this.landMap.createView(), repSamp: this.repSamp,
            clampSamp: this.clampSamp, cells: this.cellBuf, ground: this.groundPass.buffer, bolts: this.boltBuf, anvilTex: this.weatherPass.anvilView,
            layerTex: this.weatherPass.layerView, styleTex: this.weatherPass.styleView, occ: this.weatherPass.occ, buildings: this.buildingBuf,
        }, 'world');
    }

    // the door leaves as they stand now (Doors.mesh, same size every time)
    writeDoors(mesh) { if (this.doorV.buf) this.device.queue.writeBuffer(this.doorV.buf, 0, new Float32Array(mesh)); }

    resize(scale) {
        const [w, h] = this.fx.size();
        if (w === this.width && h === this.height && scale === this.scale) return false;
        this.width = w;
        this.height = h;
        this.scale = scale;
        const U = GPUTextureUsage;
        this.hdr?.destroy();
        this.depth?.destroy();
        this.hdr = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.hdrView = this.hdr.createView();
        this.depthView = this.depth.createView();
        this.cloudPass.resize(Math.max(1, Math.ceil(w * scale)), Math.max(1, Math.ceil(h * scale)), this.depthView);
        // the bloom chain: half resolution down to no less than 4 texels a side
        const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
        const levels = Math.max(1, Math.min(BLOOM_LEVELS, Math.floor(Math.log2(Math.min(bw, bh) / 4)) + 1));
        this.bloom?.destroy();
        this.bloom = this.device.createTexture({ size: [bw, bh], mipLevelCount: levels, format: 'rgba16float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.bloomViews = Array.from({ length: levels }, (_, k) => this.bloom.createView({ baseMipLevel: k, mipLevelCount: 1 }));
        this.bloomGroups = this.bloomViews.map((v, k) => bindGroup(this.device, this.bloomLayout, [v, this.hdrView], `bloom-${k}`));
        this.bloomPreGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.bloomLayout, [hv, this.hdrView], `bloom-pre-${k}`));
        this.screenGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.screenLayout, [hv, this.hdrView, this.depthView, this.bloomViews[0]], `screen-${k}`));
        // for the bolts drawn into level 0: any other view in the bloom slot (unread there)
        this.bloomSpare ??= this.device.createTexture({ size: [1, 1], format: 'rgba16float', usage: U.TEXTURE_BINDING });
        const spare = levels > 1 ? this.bloomViews[1] : this.bloomSpare.createView();
        this.boltGlowGroups = this.cloudPass.histViews.map((hv, k) => bindGroup(this.device, this.screenLayout, [hv, this.hdrView, this.depthView, spare], `bolt-glow-${k}`));
        return true;
    }

    // The other worlds of a composition (merged by js/engine/compositor.js: display colour + view depth in metres) into the
    // scene where they are nearer than its own surfaces: their depth into the depth buffer (reversed-Z, near / z), their
    // colour back to scene radiance through the inverse of this engine's display transform (gamma, ACES, exposure), so
    // after the clouds, haze, rain and tonemapping it shows as it was rendered, under this sky
    encodeInject(enc, inj) {
        const d = this.device;
        if (!this.pInject) {
            const module = d.createShaderModule({ label: 'inject', code: /* wgsl */`
                @group(0) @binding(0) var<uniform> P: vec4f;          // near, exposure
                @group(0) @binding(1) var injC: texture_2d<f32>;
                @group(0) @binding(2) var injZ: texture_2d<f32>;
                @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
                    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
                }
                struct O { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }
                @fragment fn fs(@builtin(position) fp: vec4f) -> O {
                    let q = vec2i(fp.xy);
                    let z = textureLoad(injZ, q, 0).x;
                    if (z >= 3.0e38) { discard; }
                    // y = aces(x): a x^2 + b x + c = 0
                    let y = clamp(pow(textureLoad(injC, q, 0).rgb, vec3f(2.2)), vec3f(0.0), vec3f(0.985));
                    let a = 2.51 - 2.43 * y;
                    let b = 0.03 - 0.59 * y;
                    let c = -0.14 * y;
                    let x = (-b + sqrt(b * b - 4.0 * a * c)) / (2.0 * a);
                    var o: O;
                    o.c = vec4f(x / max(P.y, 1e-4), 1.0);
                    o.d = clamp(P.x / max(z, P.x), 0.0, 1.0);
                    return o;
                }` });
            this.injectLayout = d.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            ] });
            this.pInject = d.createRenderPipeline({
                label: 'inject', layout: d.createPipelineLayout({ bindGroupLayouts: [this.injectLayout] }),
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
                depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
            });
            this.injectBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        if (this.injectKey !== inj.colorView) {
            this.injectGroup = d.createBindGroup({ layout: this.injectLayout, entries: [
                { binding: 0, resource: { buffer: this.injectBuf } }, { binding: 1, resource: inj.colorView }, { binding: 2, resource: inj.zView }] });
            this.injectKey = inj.colorView;
        }
        const F = this.frame.data, o = this.frame.offsets;
        d.queue.writeBuffer(this.injectBuf, 0, new Float32Array([F[o.fwd + 3], F[o.sunCol + 3], 0, 0]));
        const pass = enc.beginRenderPass({
            label: 'inject',
            colorAttachments: [{ view: this.hdrView, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: this.depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
        });
        pass.setPipeline(this.pInject);
        pass.setBindGroup(0, this.injectGroup);
        pass.draw(3);
        pass.end();
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

    render(enc, probeTexel, particles, bolts, interleave, shadowSlices, froxels, volumetrics = true, tiles = true, bloom = true) {
        const q = this.device.queue, prof = this.profiler;
        q.writeBuffer(this.frameBuf, 0, this.frame.data);
        q.writeBuffer(this.cellBuf, 0, this.cellData);
        if (this.busDraws.length) q.writeBuffer(this.busUBuf, 0, this.busData);
        this.weatherPass.encode(enc, probeTexel, prof, shadowSlices);
        this.groundPass.encode(enc, prof);

        const a = enc.beginRenderPass({
            label: 'scene', timestampWrites: prof.writes('scene'),
            colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
        });
        a.setBindGroup(0, this.worldGroup);
        a.setPipeline(this.pSky);
        a.draw(3);
        a.setPipeline(this.pTerrain);
        a.setIndexBuffer(this.terrainIndex, 'uint32');
        a.drawIndexed(this.terrainCount);
        if (this.structCount) {
            a.setPipeline(this.pStruct);
            a.setVertexBuffer(0, this.structBuf);
            a.draw(this.structCount);
        }
        if (this.busDraws.length) {
            a.setPipeline(this.pBus);
            for (const k of this.busDraws) {
                const m = this.busMeshes[k];
                if (!m.count) continue;
                a.setBindGroup(1, this.busGroup, [k * BUS_UNIFORM]);
                a.setVertexBuffer(0, m.buf);
                a.draw(m.count);
            }
        }
        // buildings: interiors within INTERIOR_DRAW (vertex ranges, nearest first), door leaves, and the panes of the
        // windows further off (fsPane drops those of the near ones)
        if (this.interiorDraws.length) {
            a.setPipeline(this.pInterior);
            a.setVertexBuffer(0, this.interior.buf);
            for (const [first, count] of this.interiorDraws) a.draw(count, 1, first);
        }
        if (this.doorV.n) { a.setPipeline(this.pDoor); a.setVertexBuffer(0, this.doorV.buf); a.draw(this.doorV.n); }
        if (this.paneV.n) { a.setPipeline(this.pPane); a.setVertexBuffer(0, this.paneV.buf); a.draw(this.paneV.n); }
        if (this.poleCount) {
            a.setPipeline(this.pFarPole);
            a.setVertexBuffer(0, this.poleMesh.buf);
            a.setVertexBuffer(1, this.poleBuf);
            a.draw(this.poleMesh.n, this.poleCount);
        }
        if (this.farCount) {
            a.setVertexBuffer(0, this.farBuf);
            if (this.realFar[1]) { a.setPipeline(this.pFarPool); a.draw(6, this.realFar[1], 0, this.realFar[0]); }
            a.setPipeline(this.pFar);
            a.draw(6, this.farCount);
        }
        a.end();

        // a composition's other worlds go into the scene here, so the volumetrics and the post cover them too
        if (this.fx.inject) this.encodeInject(enc, this.fx.inject);
        if (froxels && volumetrics) this.froxelPass.encode(enc, prof);
        const hist = volumetrics ? this.cloudPass.encode(enc, prof, interleave, tiles) : this.cloudPass.cur;
        if (bloom) this.encodeBloom(enc, hist, bolts);

        const b = enc.beginRenderPass({
            label: 'final', timestampWrites: prof.writes('final'),
            colorAttachments: [{ view: this.fx.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            depthStencilAttachment: { view: this.depthView, depthReadOnly: true },
        });
        b.setBindGroup(0, this.worldGroup);
        b.setBindGroup(1, this.screenGroups[hist]);
        b.setPipeline(this.pComposite);
        b.draw(3);
        if (particles) { b.setPipeline(this.pPrecip); b.draw(6, particles); }
        // the buildings' window glass after the rain (fsWindow drops the panes of buildings beyond INTERIOR_DRAW); then
        // the buses' windows after the rain outside them (seen from inside, the drops on the glass are in front of it),
        // furthest first
        if (this.glassV.n && this.interiorDraws.length) { b.setPipeline(this.pWindow); b.setVertexBuffer(0, this.glassV.buf); b.draw(this.glassV.n); }
        if (this.busDraws.length) {
            b.setPipeline(this.pGlass);
            for (let i = this.busDraws.length - 1; i >= 0; i--) {
                const k = this.busDraws[i], m = this.busMeshes[k];
                if (!m.glassCount) continue;
                b.setBindGroup(2, this.busGroup, [k * BUS_UNIFORM]);
                b.setVertexBuffer(0, m.glass);
                b.draw(m.glassCount);
            }
        }
        if (bolts) { b.setPipeline(this.pBolt); b.draw(6, bolts); }
        b.end();
        prof.resolve(enc);
    }
}

return { Renderer };
});
