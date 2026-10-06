'use strict';
// GPU timestamps per pass.

Features.part('cloud', (engine, feature) => {
// GPU time per pass from timestamp queries (when the adapter offers them), smoothed for the HUD
class GpuProfiler {
    constructor(device, names) {
        this.names = names;
        this.ms = Object.fromEntries(names.map(n => [n, 0]));
        this.ran = new Set();       // passes encoded this frame: a skipped pass reads 0, not its last timestamps
        this.enabled = device.features.has('timestamp-query');
        if (!this.enabled) return;
        const n = names.length * 2, B = GPUBufferUsage;
        this.set = device.createQuerySet({ type: 'timestamp', count: n });
        this.resolveBuf = device.createBuffer({ size: n * 8, usage: B.QUERY_RESOLVE | B.COPY_SRC });
        this.reads = [0, 1, 2].map(() => ({ buf: device.createBuffer({ size: n * 8, usage: B.COPY_DST | B.MAP_READ }), busy: false }));
    }

    // timestampWrites for a pass descriptor; a name spanning several passes passes first on its first one and last on its
    // last one (both on a single pass)
    writes(name, first = true, last = true) {
        if (!this.enabled || !(first || last)) return undefined;
        this.ran.add(name);
        const i = this.names.indexOf(name), w = { querySet: this.set };
        if (first) w.beginningOfPassWriteIndex = i * 2;
        if (last) w.endOfPassWriteIndex = i * 2 + 1;
        return w;
    }

    resolve(enc) {
        this.slot = this.enabled ? this.reads.find(r => !r.busy) : null;
        if (!this.slot) return;
        enc.resolveQuerySet(this.set, 0, this.names.length * 2, this.resolveBuf, 0);
        enc.copyBufferToBuffer(this.resolveBuf, 0, this.slot.buf, 0, this.names.length * 16);
    }

    afterSubmit() {
        const slot = this.slot, ran = this.ran;
        this.slot = null;
        this.ran = new Set();
        if (!slot) return;
        slot.busy = true;
        slot.buf.mapAsync(GPUMapMode.READ).then(() => {
            const t = new BigInt64Array(slot.buf.getMappedRange());
            this.names.forEach((n, i) => {
                const v = ran.has(n) ? Number(t[i * 2 + 1] - t[i * 2]) / 1e6 : 0;
                if (v >= 0 && v < 500) this.ms[n] = this.ms[n] * 0.9 + v * 0.1;
            });
            slot.buf.unmap();
            slot.busy = false;
        }).catch(() => { slot.busy = false; });
    }

    get total() { return Object.values(this.ms).reduce((a, b) => a + b, 0); }
}

return { GpuProfiler };
});
