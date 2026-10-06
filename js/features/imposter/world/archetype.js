'use strict';
// Archetypes: every instance of one model in a world, and its draw lists.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { LISTS, INSTANCE_FLOATS, INSTANCE_BYTES, quat } = feature;

// Archetype: every instance of one ModelAsset in a world, and the GPU side of drawing them: source
// instances, the culled mesh / imposter lists (LISTS of them: camera, then one per shadow cascade, each
// `seg` instances long) and their indirect draw arguments (per list, `setStride` bytes: 0..15 imposter draw,
// then one drawIndexedIndirect per submesh), whose instance counts the cull pass fills in.
class Archetype {
    constructor(asset) {
        this.asset = asset;
        this.name = asset.name;
        this.items = [];
        this.count = 0;
        this.visible = [0, 0];          // mesh / imposter instances drawn (read back a few times a second)
        this.casters = [0, 0];          // ... drawn into the shadow cascades (summed)
        // static: one forced-mesh instance that never moves (terrain chunks): culled on the CPU, drawn directly
        this.static = asset.kind === 'generated';
        this.cpuCasters = 0;
        this.dirty = null;              // [first, last] instance range to upload
        this.version = -1;
    }

    add(pos, q, scale, force = 0) {
        this.items.push(pos[0], pos[1], pos[2], scale, q[0], q[1], q[2], q[3], force, 0, 0, 0);
        return this.count++;
    }

    set(i, pos, q, scale) {
        const o = i * INSTANCE_FLOATS, a = this.data;
        a[o] = pos[0]; a[o + 1] = pos[1]; a[o + 2] = pos[2]; a[o + 3] = scale;
        a[o + 4] = q[0]; a[o + 5] = q[1]; a[o + 6] = q[2]; a[o + 7] = q[3];
        this.dirty = this.dirty ? [Math.min(this.dirty[0], i), Math.max(this.dirty[1], i)] : [i, i];
    }

    instance(i) {
        const o = i * INSTANCE_FLOATS, a = this.data;
        return { pos: [a[o], a[o + 1], a[o + 2]], scale: a[o + 3], rot: [a[o + 4], a[o + 5], a[o + 6], a[o + 7]], force: a[o + 8] };
    }

    create(r) {
        const d = r.device, U = GPUBufferUsage, bytes = Math.max(1, this.count) * INSTANCE_BYTES, subs = this.asset.mesh.submeshes;
        this.data = new Float32Array(this.items);
        this.items = null;
        this.seg = Math.max(16, Math.ceil(this.count / 16) * 16);      // 16 instances = 768 bytes: lists start 256-aligned
        const listBytes = this.seg * INSTANCE_BYTES;
        this.setStride = 16 + 20 * subs.length;
        this.src = d.createBuffer({ size: bytes, usage: U.STORAGE | U.COPY_DST });
        this.meshOut = d.createBuffer({ size: listBytes * LISTS, usage: U.STORAGE });
        this.impOut = d.createBuffer({ size: listBytes * LISTS, usage: U.STORAGE });
        this.args = d.createBuffer({ size: this.setStride * LISTS, usage: U.INDIRECT | U.STORAGE | U.COPY_SRC | U.COPY_DST });
        this.params = d.createBuffer({ size: 48, usage: U.UNIFORM | U.COPY_DST });
        const args = new Uint32Array(this.setStride / 4 * LISTS);
        for (let k = 0, o = 0; k < LISTS; k++, o += this.setStride / 4) {
            args[o] = 6;
            subs.forEach((s, i) => { args[o + 4 + 5 * i] = s.count; args[o + 4 + 5 * i + 2] = s.first; });
        }
        this.argsTemplate = args;          // instance counts 0; written back every frame before culling
        if (this.count) d.queue.writeBuffer(this.src, 0, this.data);
        this.cullBG = d.createBindGroup({ layout: r.cullBgl, entries: [
            { binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.src } },
            { binding: 2, resource: { buffer: this.meshOut } }, { binding: 3, resource: { buffer: this.impOut } },
            { binding: 4, resource: { buffer: this.args } },
        ] });
        const list = (buffer, k) => d.createBindGroup({ layout: r.instBgl, entries: [{ binding: 0, resource: { buffer, offset: k * listBytes, size: listBytes } }] });
        this.meshBG = Array.from({ length: LISTS }, (_, k) => list(this.meshOut, k));
        this.srcBG = d.createBindGroup({ layout: r.instBgl, entries: [{ binding: 0, resource: { buffer: this.src } }] });
        // world-space bounding sphere of a static archetype (its instances do not move)
        const m = this.asset.mesh, inst = this.count ? this.instance(0) : null;
        this.sphere = inst ? [v3.add(inst.pos, quat.rotate(inst.rot, v3.mul(m.center, inst.scale))), m.radius * inst.scale * (this.count > 1 ? 1e6 : 1)] : [[0, 0, 0], 0];
        this.impBG = Array.from({ length: LISTS }, (_, k) => list(this.impOut, k));
    }

    upload(r) {
        const d = r.device, a = this.asset;
        if (this.version !== a.version) {
            this.version = a.version;
            const m = a.mesh, R = m.radius * 1.02, buf = new ArrayBuffer(48), u = new Uint32Array(buf), f = new Float32Array(buf);
            u[0] = this.count; u[1] = a.atlas ? 1 : 0; f[2] = R; f[3] = R / 5 * a.lodBias;
            f.set(m.center, 4);
            u[8] = this.seg; u[9] = a.castShadows ? 1 : 0; u[10] = this.setStride / 4; u[11] = m.submeshes.length;
            d.queue.writeBuffer(this.params, 0, buf);
        }
        d.queue.writeBuffer(this.args, 0, this.argsTemplate);
        if (this.dirty) {
            const [i0, i1] = this.dirty;
            d.queue.writeBuffer(this.src, i0 * INSTANCE_BYTES, this.data, i0 * INSTANCE_FLOATS, (i1 - i0 + 1) * INSTANCE_FLOATS);
            this.dirty = null;
        }
    }

    destroy() { for (const b of [this.src, this.meshOut, this.impOut, this.args, this.params]) b?.destroy(); }
}

return { Archetype };
});
