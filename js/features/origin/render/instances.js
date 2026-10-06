'use strict';
// GPU instances: grid position and axes, one slot each.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { MAX_CELL, INSTANCE_FLOATS, quat, vec3Of, WorldPos } = feature;

// One GPU instance: grid position + world-space axes (rotation * scale). Written once at build time;
// only dynamic entities write their own slot again.
class Instance {
    constructor(model) {
        this.model = model;
        this.pos = new WorldPos();
        this.axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        this.tint = [1, 1, 1];
        this.seed = 0;
        this.slot = -1;
    }

    place(pos, q, scale) {
        const a = quat.axes(q), s = vec3Of(scale);
        this.pos = pos;
        this.axes = [v3.mul(a[0], s[0]), v3.mul(a[1], s[1]), v3.mul(a[2], s[2])];
    }

    write(i32, f32) {
        const o = this.slot * INSTANCE_FLOATS, p = this.pos, a = this.axes;
        i32[o] = p.c[0]; i32[o + 1] = p.c[1]; i32[o + 2] = p.c[2]; i32[o + 3] = 0;
        f32[o + 4] = p.l[0]; f32[o + 5] = p.l[1]; f32[o + 6] = p.l[2]; f32[o + 7] = this.seed;
        for (let k = 0; k < 3; k++) { f32[o + 8 + k * 4] = a[k][0]; f32[o + 9 + k * 4] = a[k][1]; f32[o + 10 + k * 4] = a[k][2]; f32[o + 11 + k * 4] = 0; }
        f32[o + 20] = this.tint[0]; f32[o + 21] = this.tint[1]; f32[o + 22] = this.tint[2]; f32[o + 23] = 0;
    }
}

class InstanceStore {
    constructor(device, models) {
        this.device = device;
        let n = 0;
        for (const m of models) {
            m.first = n;
            m.instances.forEach((inst, i) => { inst.slot = n + i; });
            n += m.instances.length;
        }
        this.count = n;
        this.data = new ArrayBuffer(Math.max(1, n) * INSTANCE_FLOATS * 4);
        this.i32 = new Int32Array(this.data);
        this.f32 = new Float32Array(this.data);
        this.outOfRange = 0;
        for (const m of models) for (const inst of m.instances) {
            if (inst.pos.c.some(c => Math.abs(c) > MAX_CELL)) this.outOfRange++;
            inst.write(this.i32, this.f32);
        }
        this.buffer = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(this.buffer, 0, this.data);
        this.dirty = new Set();
        this.bytes = 0;             // uploaded last frame
    }

    get byteLength() { return this.data.byteLength; }

    touch(inst) { inst.write(this.i32, this.f32); this.dirty.add(inst.slot); }

    flush() {
        const B = INSTANCE_FLOATS * 4;
        this.bytes = 0;
        for (const s of this.dirty) { this.device.queue.writeBuffer(this.buffer, s * B, this.data, s * B, B); this.bytes += B; }
        this.dirty.clear();
    }

    destroy() { this.buffer.destroy(); }
}

return { Instance, InstanceStore };
});
