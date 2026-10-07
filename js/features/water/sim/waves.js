'use strict';
// Surface waves: wave layers and the cascade that follows the camera.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { clamp, makeBuffer, bindLayout, bindGroup } = Common;
const { MAX_LAYERS, WAVE_DEFAULTS, WGSL_WAVES, TU, BU, makeTex } = feature;

// wave cascades: each layer steps at its own rate so waves travel at `speed` m/s in every layer
class WaveLayer {
    constructor(device, shared, flow, cfg, waveCfg, index) {
        const U = TU(), res = cfg.resolution || 512;
        this.device = device;
        this.shared = shared;
        this.flow = flow;
        this.index = index;
        this.res = res;
        this.size = cfg.size;
        this.texel = cfg.size / res;
        this.heightScale = cfg.height ?? 0.1;
        this.hz = (waveCfg.speed || 5) / (0.7071 * this.texel);
        this.waveCfg = waveCfg;
        this.state = [0, 1].map(() => makeTex(device, res, res, 'rgba32float', U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_DST));
        this.disp = makeTex(device, res, res, 'rgba16float', U.TEXTURE_BINDING | U.STORAGE_BINDING, 2);
        this.dispView = this.disp.createView({ dimension: '2d-array' });
        this.uniform = new ArrayBuffer(80);
        this.buf = makeBuffer(device, 80, BU().UNIFORM | BU().COPY_DST);
        this.groups = new Map();
        this.cur = 0;
        this.slot = 0;
        this.stepCount = 0;
        this.acc = 0;
        this.origin = null;
        this.slotOrigin = [[0, 0], [0, 0]];
        this.newest = 0;
        this.splash = null;
    }

    group(a, slot) {
        const key = a * 2 + slot;
        if (!this.groups.has(key)) {
            const b = 1 - a, f = this.flow;
            this.groups.set(key, bindGroup(this.device, this.shared.layout, [this.buf, this.state[a].createView(), this.state[b].createView(),
                f.flow.createView(), this.shared.sampler, this.disp.createView({ dimension: '2d', baseArrayLayer: slot, arrayLayerCount: 1 })]));
        }
        return this.groups.get(key);
    }

    reset() {
        const z = new Float32Array(this.res * this.res * 4);
        for (const t of this.state) this.device.queue.writeTexture({ texture: t }, z, { bytesPerRow: this.res * 16, rowsPerImage: this.res }, [this.res, this.res]);
    }

    encode(enc, dt, cam, flowScale) {
        const period = 1 / this.hz;
        this.acc += dt;
        if (this.acc < period && this.origin) { this.lerpK = this.acc / period; return; }
        this.acc = clamp(this.acc - period, 0, period);
        this.lerpK = this.acc / period;
        const t = this.texel, f = this.flow.world.field;
        const o = [Math.floor((cam[0] - this.size / 2) / t) * t, Math.floor((cam[2] - this.size / 2) / t) * t];
        const shift = this.origin ? [(o[0] - this.origin[0]) / t, (o[1] - this.origin[1]) / t] : [0, 0];
        this.origin = o;
        const u = new Float32Array(this.uniform), ui = new Int32Array(this.uniform), uu = new Uint32Array(this.uniform), w = this.waveCfg;
        u.set([o[0], o[1], t]); ui[3] = this.res;
        u.set([shift[0], shift[1], period * flowScale, w.damping ?? 0.985], 4);
        u.set([f.origin, f.origin, f.size], 8); uu[11] = this.stepCount++;
        u.set([w.noise ?? 1, w.foam ?? 1, this.flow.cfg.minDepth, this.heightScale], 12);
        u.set(this.splash || [0, 0, 0, 0], 16);
        this.splash = null;
        this.device.queue.writeBuffer(this.buf, 0, this.uniform);
        const g = Math.ceil(this.res / 8), pass = enc.beginComputePass({ label: `waves ${this.index}` });
        pass.setPipeline(this.shared.pStep); pass.setBindGroup(0, this.group(this.cur, this.slot)); pass.dispatchWorkgroups(g, g);
        pass.setPipeline(this.shared.pDisplay); pass.setBindGroup(0, this.group(1 - this.cur, this.slot)); pass.dispatchWorkgroups(g, g);
        pass.end();
        this.cur = 1 - this.cur;
        this.slotOrigin[this.slot] = o;
        this.newest = this.slot;
        this.slot = 1 - this.slot;
    }
}

class WaveCascade {
    constructor(device, flow, cfg) {
        this.cfg = { ...WAVE_DEFAULTS, ...(cfg || {}) };
        const layout = bindLayout(device, GPUShaderStage.COMPUTE, ['uniform', 'tex:unfilterable-float', 'write:rgba32float', 'tex', 'sampler', 'write:rgba16float']);
        const module = device.createShaderModule({ label: 'waves', code: WGSL_WAVES });
        const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const shared = {
            layout,
            sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
            pStep: device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'waveStep' } }),
            pDisplay: device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'waveDisplay' } }),
        };
        this.layers = this.cfg.layers.slice(0, MAX_LAYERS).map((l, i) => new WaveLayer(device, shared, flow, l, this.cfg, i));
    }

    encode(enc, dt, cam, flowScale) { for (const l of this.layers) l.encode(enc, dt, cam, flowScale); }
    splash(s) { for (const l of this.layers) l.splash = s; }
    reset() { for (const l of this.layers) l.reset(); }
}

return { WaveCascade };
});
