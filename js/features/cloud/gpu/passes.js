'use strict';
// The compute passes: noise volumes, weather map, ground state, froxels and clouds.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { smoothstep, makeBuffer, bindLayout, bindGroup } = Common;
const {
    NOISE_SHAPE, NOISE_DETAIL, OCC_RES, CLOUD_TILE, WEATHER_RES, SHADOW_RES, GROUND_RES, FROXEL, fromHalf, FrameBlock,
    BindingSet, WGSL_MATH, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING,
    WGSL_OCCUPANCY, WGSL_NOISE, WGSL_WEATHER, WGSL_SHADOW, WGSL_GROUND, WGSL_FROXEL, WGSL_SKIP_SAMPLE, WGSL_TILES,
    WGSL_MARCH, WGSL_RESOLVE, WGSL_TERRAIN,
} = feature;

// GPU passes
// 3D noise volumes, baked once
class NoiseVolumes {
    constructor(device) {
        const U = GPUTextureUsage;
        const make = n => device.createTexture({ size: [n, n, n], dimension: '3d', format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.shape = make(NOISE_SHAPE);
        this.detail = make(NOISE_DETAIL);
        const layout = bindLayout(device, GPUShaderStage.COMPUTE, ['write3d:rgba8unorm', 'write3d:rgba8unorm']);
        const module = device.createShaderModule({ label: 'noise', code: WGSL_NOISE });
        const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const group = bindGroup(device, layout, [this.shape.createView({ dimension: '3d' }), this.detail.createView({ dimension: '3d' })], 'noise');
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, group);
        pass.setPipeline(device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'genShape' } }));
        pass.dispatchWorkgroups(NOISE_SHAPE / 4, NOISE_SHAPE / 4, NOISE_SHAPE / 4);
        pass.setPipeline(device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'genDetail' } }));
        pass.dispatchWorkgroups(NOISE_DETAIL / 4, NOISE_DETAIL / 4, NOISE_DETAIL / 4);
        pass.end();
        device.queue.submit([enc.finish()]);
        this.shapeView = this.shape.createView({ dimension: '3d' });
        this.detailView = this.detail.createView({ dimension: '3d' });
    }
}

// shader source for a pass: frame struct, helpers, bindings
const shaderSource = (set, ...parts) => FrameBlock.wgsl() + WGSL_MATH + set.wgsl + parts.join('\n');

function computePipeline(device, label, layouts, code, entryPoint) {
    return device.createComputePipeline({
        label, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
    });
}

// weather map, cloud shadow map and the camera probe read back for the HUD and near-field precipitation
class WeatherPass {
    constructor(r) {
        const d = r.device, U = GPUTextureUsage, C = GPUShaderStage.COMPUTE;
        this.device = d;
        this.weather = d.createTexture({ size: [WEATHER_RES, WEATHER_RES], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
        this.shadow = d.createTexture({ size: [SHADOW_RES, SHADOW_RES], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
        this.anvil = d.createTexture({ size: [WEATHER_RES, WEATHER_RES], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.weatherView = this.weather.createView();
        this.anvilView = this.anvil.createView();
        this.layerMap = d.createTexture({ size: [WEATHER_RES, WEATHER_RES], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.styleMap = d.createTexture({ size: [WEATHER_RES, WEATHER_RES], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.layerView = this.layerMap.createView();
        this.styleView = this.styleMap.createView();
        this.shadowView = this.shadow.createView();

        const wSet = new BindingSet(d, ['F', 'cells']);
        const wOut = bindLayout(d, C, ['write:rgba16float', 'write:rgba16float', 'write:rgba16float', 'write:rgba16float']);
        this.pWeather = computePipeline(d, 'weather', [wSet.layout, wOut], shaderSource(wSet, WGSL_WEATHER), 'weather');
        this.wGroup = wSet.group({ F: r.frameBuf, cells: r.cellBuf }, 'weather-in');
        this.wOutGroup = bindGroup(d, wOut, [this.weatherView, this.anvilView, this.layerView, this.styleView], 'weather-out');

        const sSet = new BindingSet(d, ['F', 'shapeTex', 'detailTex', 'weatherTex', 'anvilTex', 'layerTex', 'styleTex', 'repSamp', 'clampSamp']);
        const sOut = bindLayout(d, C, ['write:rgba16float']);
        this.pShadow = computePipeline(d, 'shadow', [sSet.layout, sOut], shaderSource(sSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SHADOW), 'shadow');
        this.sGroup = sSet.group({ F: r.frameBuf, shapeTex: r.noise.shapeView, detailTex: r.noise.detailView, weatherTex: this.weatherView, anvilTex: this.anvilView, layerTex: this.layerView, styleTex: this.styleView, repSamp: r.repSamp, clampSamp: r.clampSamp }, 'shadow-in');
        this.sOutGroup = bindGroup(d, sOut, [this.shadowView], 'shadow-out');

        // occupancy grid for the march's empty-space skipping
        this.occ = makeBuffer(d, OCC_RES * OCC_RES * 4, GPUBufferUsage.STORAGE);
        const oSet = new BindingSet(d, ['F', 'weatherTex', 'anvilTex', 'layerTex', 'styleTex']);
        const oOut = bindLayout(d, C, ['storage']);
        this.pOcc = computePipeline(d, 'occupancy', [oSet.layout, oOut], shaderSource(oSet, WGSL_OCCUPANCY), 'occupancy');
        this.oGroup = oSet.group({ F: r.frameBuf, weatherTex: this.weatherView, anvilTex: this.anvilView, layerTex: this.layerView, styleTex: this.styleView }, 'occupancy-in');
        this.oOutGroup = bindGroup(d, oOut, [this.occ], 'occupancy-out');

        this.probes = [0, 1, 2].map(() => ({ buf: d.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false }));
        this.probe = { coverage: 0, top: 0, precip: 0, virga: 0, cover: 0 };
    }

    encode(enc, probeTexel, prof, shadowSlices = 1) {
        const pass = enc.beginComputePass({ label: 'weather', timestampWrites: prof.writes('weather') });
        pass.setPipeline(this.pWeather);
        pass.setBindGroup(0, this.wGroup);
        pass.setBindGroup(1, this.wOutGroup);
        pass.dispatchWorkgroups(WEATHER_RES / 8, WEATHER_RES / 8);
        pass.setPipeline(this.pOcc);
        pass.setBindGroup(0, this.oGroup);
        pass.setBindGroup(1, this.oOutGroup);
        pass.dispatchWorkgroups(OCC_RES / 8, OCC_RES / 8);
        pass.setPipeline(this.pShadow);
        pass.setBindGroup(0, this.sGroup);
        pass.setBindGroup(1, this.sOutGroup);
        pass.dispatchWorkgroups(Math.ceil(SHADOW_RES / 8), Math.ceil(SHADOW_RES / shadowSlices / 8));
        pass.end();
        this.pending = null;
        const slot = this.probes.find(p => !p.busy);
        if (slot && probeTexel) {
            enc.copyTextureToBuffer({ texture: this.weather, origin: [probeTexel[0], probeTexel[1], 0] }, { buffer: slot.buf, bytesPerRow: 256 }, [1, 1, 1]);
            // the same place in the shadow map (same domain, coarser): the cloud above, for rainCover
            const st = probeTexel.map(t => Math.min(SHADOW_RES - 1, Math.floor((t + 0.5) * SHADOW_RES / WEATHER_RES)));
            enc.copyTextureToBuffer({ texture: this.shadow, origin: [st[0], st[1], 0] }, { buffer: slot.buf, offset: 256, bytesPerRow: 256 }, [1, 1, 1]);
            this.pending = slot;
        }
    }

    afterSubmit() {
        const slot = this.pending;
        if (!slot) return;
        slot.busy = true;
        slot.buf.mapAsync(GPUMapMode.READ).then(() => {
            const h = new Uint16Array(slot.buf.getMappedRange(0, 264));
            // cover: as rainCover in WGSL, from the shadow map's low cloud term
            const cover = smoothstep(0.03, 0.3, 1 - fromHalf(h[130]));
            this.probe = { coverage: fromHalf(h[0]), top: fromHalf(h[1]), precip: fromHalf(h[2]) * cover, virga: fromHalf(h[3]), cover };
            slot.buf.unmap();
            slot.busy = false;
        }).catch(() => { slot.busy = false; });
    }
}

// snow cover and wetness on the terrain
class GroundPass {
    constructor(r, world) {
        const d = r.device;
        this.n = GROUND_RES;
        const init = new Float32Array(this.n * this.n * 2), f = world.field, w = world.weather.cur;
        // start with snow wherever it is below freezing (mountain caps)
        for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
            const x = f.origin + (i + 0.5) / this.n * f.size, z = f.origin + (j + 0.5) / this.n * f.size;
            const temp = w.temperature - 0.0065 * f.sample(x, z);
            init[(j * this.n + i) * 2] = smoothstep(2, -3, temp);
        }
        this.buffer = makeBuffer(d, init.byteLength, GPUBufferUsage.STORAGE, init);
        const set = new BindingSet(d, ['F', 'weatherTex', 'shadowTex', 'heightTex', 'clampSamp']);
        const out = bindLayout(d, GPUShaderStage.COMPUTE, ['storage']);
        this.pipeline = computePipeline(d, 'ground', [set.layout, out], shaderSource(set, WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_GROUND), 'groundUpdate');
        this.group = set.group({ F: r.frameBuf, weatherTex: r.weatherPass.weatherView, shadowTex: r.weatherPass.shadowView, heightTex: r.heightView, clampSamp: r.clampSamp }, 'ground-in');
        this.outGroup = bindGroup(d, out, [this.buffer], 'ground-out');
    }

    encode(enc, prof) {
        const pass = enc.beginComputePass({ label: 'ground', timestampWrites: prof.writes('ground') });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.group);
        pass.setBindGroup(1, this.outGroup);
        pass.dispatchWorkgroups(this.n / 8, this.n / 8);
        pass.end();
    }

    destroy() { this.buffer.destroy(); }
}

// froxel lighting volume for the precipitation and haze, filled each frame before the march
class FroxelPass {
    constructor(r) {
        const d = r.device, U = GPUTextureUsage;
        this.r = r;
        this.tex = d.createTexture({ size: FROXEL, dimension: '3d', format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.view = this.tex.createView({ dimension: '3d' });
        const out = bindLayout(d, GPUShaderStage.COMPUTE, ['write3d:rgba16float']);
        this.pipeline = computePipeline(d, 'froxel', [r.worldSet.layout, out],
            shaderSource(r.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SHADOW_SAMPLE, WGSL_FROXEL), 'inject');
        this.group = bindGroup(d, out, [this.view], 'froxel-out');
    }

    encode(enc, prof) {
        const a = enc.beginComputePass({ label: 'froxel', timestampWrites: prof.writes('froxel') });
        a.setPipeline(this.pipeline);
        a.setBindGroup(0, this.r.worldGroup);
        a.setBindGroup(1, this.group);
        a.dispatchWorkgroups(...FROXEL.map(n => Math.ceil(n / 4)));
        a.end();
    }
}

// volumetric march at reduced resolution + temporal resolve into a ping-pong history
class CloudPass {
    constructor(r) {
        const d = r.device, C = GPUShaderStage.COMPUTE;
        this.r = r;
        this.marchOut = bindLayout(d, C, ['depth', 'write:rgba16float', 'write:r32float', 'tex3d', 'tex:uint']);
        this.resolveIO = bindLayout(d, C, ['tex', 'tex:unfilterable-float', 'tex', 'write:rgba16float']);
        const rSet = new BindingSet(d, ['F', 'clampSamp']);
        this.pMarch = computePipeline(d, 'march', [r.worldSet.layout, this.marchOut],
            shaderSource(r.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SHADOW_SAMPLE, WGSL_SKIP_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, WGSL_TERRAIN, WGSL_MARCH), 'march');
        this.tileOut = bindLayout(d, C, ['write:rg32uint']);
        this.pTiles = computePipeline(d, 'tiles', [r.worldSet.layout, this.tileOut],
            shaderSource(r.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_DENSITY, WGSL_SKIP_SAMPLE, WGSL_TILES), 'tiles');
        this.pResolve = computePipeline(d, 'resolve', [rSet.layout, this.resolveIO], shaderSource(rSet, WGSL_SKY, WGSL_RESOLVE), 'resolve');
        this.rGroup = rSet.group({ F: r.frameBuf, clampSamp: r.clampSamp }, 'resolve-in');
        this.cur = 0;
    }

    resize(w, h, depthView) {
        const d = this.r.device, U = GPUTextureUsage;
        for (const t of [this.color, this.depth, this.tiles, ...(this.hist || [])]) t?.destroy();
        this.w = w;
        this.h = h;
        this.color = d.createTexture({ size: [w, h], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.depth = d.createTexture({ size: [w, h], format: 'r32float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.hist = [0, 1].map(() => d.createTexture({ size: [w, h], format: 'rgba16float', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING }));
        const hv = this.hist.map(t => t.createView());
        this.tw = Math.ceil(w / CLOUD_TILE);
        this.th = Math.ceil(h / CLOUD_TILE);
        this.tiles = d.createTexture({ size: [this.tw, this.th], format: 'rg32uint', usage: U.TEXTURE_BINDING | U.STORAGE_BINDING });
        this.tileGroup = bindGroup(d, this.tileOut, [this.tiles.createView()], 'tiles-out');
        this.marchGroup = bindGroup(d, this.marchOut, [depthView, this.color.createView(), this.depth.createView(), this.r.froxelPass.view, this.tiles.createView()], 'march-out');
        // resolveGroups[k] reads history k and writes history 1 - k
        this.resolveGroups = [0, 1].map(k => bindGroup(d, this.resolveIO, [this.color.createView(), this.depth.createView(), hv[k], hv[1 - k]], `resolve-${k}`));
        this.histViews = hv;
    }

    // interleave: march 1 of every 1, 2 or 4 pixels (in turn, each frame); the resolve fills the rest from history
    // tiles: run the cloud tile pre-pass, so the march evaluates clouds only in the distance bins it found
    encode(enc, prof, interleave, tiles) {
        if (tiles) {
            const t = enc.beginComputePass({ label: 'tiles', timestampWrites: prof.writes('tiles') });
            t.setPipeline(this.pTiles);
            t.setBindGroup(0, this.r.worldGroup);
            t.setBindGroup(1, this.tileGroup);
            t.dispatchWorkgroups(Math.ceil(this.tw / 8), Math.ceil(this.th / 8));
            t.end();
        }
        const a = enc.beginComputePass({ label: 'march', timestampWrites: prof.writes('march') });
        a.setPipeline(this.pMarch);
        a.setBindGroup(0, this.r.worldGroup);
        a.setBindGroup(1, this.marchGroup);
        const mw = interleave >= 2 ? Math.ceil(this.w / 2) : this.w, mh = interleave >= 4 ? Math.ceil(this.h / 2) : this.h;
        a.dispatchWorkgroups(Math.ceil(mw / 8), Math.ceil(mh / 8));
        a.end();
        const b = enc.beginComputePass({ label: 'resolve', timestampWrites: prof.writes('resolve') });
        b.setPipeline(this.pResolve);
        b.setBindGroup(0, this.rGroup);
        b.setBindGroup(1, this.resolveGroups[this.cur]);
        b.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
        b.end();
        this.cur = 1 - this.cur;
        return this.cur;          // history index that now holds this frame
    }
}

return { NoiseVolumes, shaderSource, WeatherPass, GroundPass, FroxelPass, CloudPass };
});
