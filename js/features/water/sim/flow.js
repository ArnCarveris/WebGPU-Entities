'use strict';
// The flow simulation on the GPU: its state textures and steps.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { makeBuffer } = Common;
const { MAX_SOURCES, SOURCE_FLOATS, SIM_DEFAULTS, WGSL_FLOW, TU, BU, makeLayout, makeGroup, makeTex } = feature;

// Simulation (GPU)
class FlowSim {
    constructor(device, world) {
        this.device = device;
        this.world = world;
        const f = world.field, n = f.n, U = TU(), B = BU();
        this.n = n;
        this.cfg = { ...SIM_DEFAULTS, ...(world.scenario.sim || {}) };
        this.edgeMode = world.seaLevel !== null ? 2 : this.cfg.edges === 'closed' ? 0 : 1;
        this.terrain = makeTex(device, n, n, 'r32float', U.TEXTURE_BINDING | U.COPY_DST);
        this.state = [0, 1].map(() => makeTex(device, n, n, 'rgba32float', U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_DST | U.COPY_SRC));
        this.surf = makeTex(device, n, n, 'rg32float', U.TEXTURE_BINDING | U.STORAGE_BINDING);
        this.flow = makeTex(device, n, n, 'rgba16float', U.TEXTURE_BINDING | U.STORAGE_BINDING);
        this.params = new ArrayBuffer(96);
        this.paramBuf = makeBuffer(device, 96, B.UNIFORM | B.COPY_DST);
        this.sourceData = new Float32Array(MAX_SOURCES * SOURCE_FLOATS);
        this.sourceBuf = makeBuffer(device, this.sourceData.byteLength, B.STORAGE | B.COPY_DST);
        this.statsBuf = makeBuffer(device, 16, B.STORAGE | B.COPY_SRC | B.COPY_DST);
        this.readBuf = makeBuffer(device, 16, B.MAP_READ | B.COPY_DST);
        this.stats = { volume: 0, wet: 0, maxSpeed: 0 };
        this.statsState = 'idle';

        const layout = makeLayout(device, GPUShaderStage.COMPUTE, ['uniform', 'tex:unfilterable-float', 'tex:unfilterable-float', 'write:rgba32float', 'read', 'write:rg32float', 'write:rgba16float', 'storage']);
        const module = device.createShaderModule({ label: 'flow', code: WGSL_FLOW });
        const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const pipe = entryPoint => device.createComputePipeline({ label: entryPoint, layout: pl, compute: { module, entryPoint } });
        this.pSim = pipe('simulate');
        this.pProp = pipe('propagate');
        this.pInfo = pipe('info');
        const grp = (a, b) => makeGroup(device, layout, [this.paramBuf, this.terrain.createView(), this.state[a].createView(), this.state[b].createView(), this.sourceBuf, this.surf.createView(), this.flow.createView(), this.statsBuf]);
        this.groups = [grp(0, 1), grp(1, 0)];
        this.uploadTerrain(true);
        this.reset();
    }

    get cell() { return this.world.field.cell; }
    // velocity is in cells per step, so gravity enters as g dt^2 / dx (RiverSim's free `acceleration` can override it)
    get acceleration() { return this.cfg.acceleration ?? this.cfg.gravity * this.cfg.stepTime ** 2 / this.cell; }
    get velScale() { return this.cell / this.cfg.stepTime; }

    uploadTerrain(full = false) {
        const f = this.world.field, n = this.n;
        const r = full ? { i0: 0, j0: 0, i1: n - 1, j1: n - 1 } : f.dirty;
        f.dirty = null;
        if (!r) return;
        this.device.queue.writeTexture({ texture: this.terrain, origin: [r.i0, r.j0] }, f.h,
            { offset: (r.j0 * n + r.i0) * 4, bytesPerRow: n * 4, rowsPerImage: n }, [r.i1 - r.i0 + 1, r.j1 - r.j0 + 1]);
    }

    reset() {
        const n = this.n, w = this.world.water, data = new Float32Array(n * n * 4);
        for (let k = 0; k < n * n; k++) { data[k * 4] = w[k]; data[k * 4 + 3] = w[k] > this.cfg.minDepth ? 1 : 0; }
        this.device.queue.writeTexture({ texture: this.state[0] }, data, { bytesPerRow: n * 16, rowsPerImage: n }, [n, n]);
        this.warmupLeft = this.cfg.warmup;
        this.steps = 0;
    }

    // water sources in m3/s (sim time) -> depth per step at the source centre
    writeParams(gathered, extra, frame) {
        const c = this.cfg, cell = this.cell, st = c.stepTime, list = [...gathered.list, ...extra].slice(0, MAX_SOURCES), sd = this.sourceData;
        list.forEach((s, k) => {
            const rc = Math.max(1.5, s.radius / cell), area = (s.flat ? Math.PI : 8 * Math.PI / 15) * (rc * cell) ** 2;
            sd.set([(s.x - this.world.field.origin) / cell - 0.5, (s.z - this.world.field.origin) / cell - 0.5, rc, s.rate * st / area, s.flat ? 1 : 0, 0, 0, 0], k * SOURCE_FLOATS);
        });
        if (list.length) this.device.queue.writeBuffer(this.sourceBuf, 0, sd, 0, list.length * SOURCE_FLOATS);
        const u = new Uint32Array(this.params), f = new Float32Array(this.params);
        const mmh = x => x / 3.6e6 * st;
        u[0] = this.n; u[1] = list.length; u[2] = this.edgeMode; u[3] = frame;
        f.set([cell, st, c.diffusion, this.acceleration, c.linDamping, c.sqrDamping, c.absorption, gathered.rain * st,
            c.frictionMinDepth, c.frictionMaxDepth, c.frictionAmount, this.world.seaLevel ?? 0,
            c.minDepth, c.wetDecay, mmh(c.evaporation), this.velScale, c.cfl, c.turbulenceSpeed], 4);
        this.device.queue.writeBuffer(this.paramBuf, 0, this.params);
        this.inflow = list.reduce((a, s) => a + Math.max(0, s.rate), 0) + gathered.rain * this.world.field.size ** 2;
    }

    encode(enc, steps) {
        const g = Math.ceil(this.n / 8);
        enc.clearBuffer(this.statsBuf);
        const pass = enc.beginComputePass({ label: 'flow' });
        for (let s = 0; s < steps; s++) {
            pass.setPipeline(this.pSim); pass.setBindGroup(0, this.groups[0]); pass.dispatchWorkgroups(g, g);
            pass.setPipeline(this.pProp); pass.setBindGroup(0, this.groups[1]); pass.dispatchWorkgroups(g, g);
        }
        pass.setPipeline(this.pInfo); pass.setBindGroup(0, this.groups[0]); pass.dispatchWorkgroups(g, g);
        pass.end();
        this.steps += steps;
        if (this.statsState === 'idle') { enc.copyBufferToBuffer(this.statsBuf, 0, this.readBuf, 0, 16); this.statsState = 'copied'; }
    }

    afterSubmit() {
        if (this.statsState !== 'copied') return;
        this.statsState = 'mapping';
        this.readBuf.mapAsync(GPUMapMode.READ).then(() => {
            const u = new Uint32Array(this.readBuf.getMappedRange().slice(0));
            this.readBuf.unmap();
            this.stats = { volume: u[0] / 10, wet: u[1], maxSpeed: new Float32Array(u.buffer)[2] };
            this.statsState = 'idle';
        }).catch(() => { this.statsState = 'idle'; });
    }
}

return { FlowSim };
});
