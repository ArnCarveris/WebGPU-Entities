'use strict';
// Floating debris on the GPU.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { mulberry32, makeBuffer } = Common;
const { MAX_PARTICLES, WGSL_DEBRIS_SIM, BU, makeLayout, makeGroup } = feature;

class DebrisSystem {
    constructor(device, flow, world) {
        const B = BU(), em = world.emitters.slice(0, 64);
        this.device = device;
        let total = 0;
        const counts = em.map(e => { const c = Math.max(0, Math.min(e.count, MAX_PARTICLES - total)); total += c; return c; });
        this.count = total;
        const parts = new Float32Array(Math.max(1, total) * 8), rng = mulberry32(99);
        let k = 0;
        em.forEach((e, ei) => {
            for (let c = 0; c < counts[ei]; c++, k++) {
                const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * e.radius;
                // random age spreads the respawns out; a dry start respawns them within seconds
                parts.set([e.x + Math.cos(a) * r, 0, e.z + Math.sin(a) * r, rng() * e.life, rng() * 6.28, 3 + rng(), ei, rng()], k * 8);
            }
        });
        const emData = new Float32Array(Math.max(1, em.length) * 8);
        em.forEach((e, i) => emData.set([e.x, e.z, e.radius, e.life, ...e.color, e.size], i * 8));
        this.particles = makeBuffer(device, parts.byteLength, B.STORAGE | B.COPY_SRC, parts);
        this.emitters = makeBuffer(device, emData.byteLength, B.STORAGE, emData);
        this.uniform = new ArrayBuffer(32);
        this.buf = makeBuffer(device, 32, B.UNIFORM | B.COPY_DST);
        const layout = makeLayout(device, GPUShaderStage.COMPUTE, ['uniform', 'storage', 'read', 'tex', 'sampler', 'tex:unfilterable-float', 'tex:unfilterable-float']);
        const module = device.createShaderModule({ label: 'debris', code: WGSL_DEBRIS_SIM });
        this.pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'updateDebris' } });
        const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
        this.group = makeGroup(device, layout, [this.buf, this.particles, this.emitters, flow.flow.createView(), sampler, flow.surf.createView(), flow.terrain.createView()]);
        this.field = world.field;
        this.minDepth = flow.cfg.minDepth;
    }

    encode(enc, dt, time) {
        if (!this.count) return;
        const f = new Float32Array(this.uniform), u = new Uint32Array(this.uniform), i = new Int32Array(this.uniform);
        f[0] = dt; f[1] = time % 10000; u[2] = this.count; i[3] = this.field.n;
        f.set([this.field.origin, this.field.origin, this.field.cell, this.minDepth], 4);
        this.device.queue.writeBuffer(this.buf, 0, this.uniform);
        const pass = enc.beginComputePass({ label: 'debris' });
        pass.setPipeline(this.pipe); pass.setBindGroup(0, this.group); pass.dispatchWorkgroups(Math.ceil(this.count / 64));
        pass.end();
    }
}

return { DebrisSystem };
});
