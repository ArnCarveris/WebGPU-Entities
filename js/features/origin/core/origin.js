'use strict';
// The floating origin: the coordinate frame everything is drawn relative to.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { ORIGIN_BYTES, quat, WorldPos } = feature;

// The floating origin: a coordinate frame with translation (WorldPos), rotation (quaternion) and uniform
// scale (metres per origin unit). World -> origin space is  p' = R^T (p - T) / s.
class Origin {
    constructor() {
        this.pos = new WorldPos();
        this.q = quat.id();
        this.scale = 1;
        this.axes = quat.axes(this.q);      // origin X / Y / Z in world space
        this.gpu = new ArrayBuffer(ORIGIN_BYTES);
        this.i32 = new Int32Array(this.gpu);
        this.f32 = new Float32Array(this.gpu);
    }

    get up() { return this.axes[1]; }

    set(pos, q, scale) {
        // snap the local part to f32 so CPU (double) and GPU (f32) agree exactly on where the origin is
        this.pos = new WorldPos(pos.c, pos.l.map(Math.fround));
        this.q = quat.norm(q);
        this.scale = scale;
        this.axes = quat.axes(this.q);
        this.pack();
    }

    vecToLocal(d) { const a = this.axes, k = 1 / this.scale; return [v3.dot(a[0], d) * k, v3.dot(a[1], d) * k, v3.dot(a[2], d) * k]; }
    toLocal(wp) { return this.vecToLocal(wp.sub(this.pos)); }

    // 80 bytes: cell (i32 x3), local (f32 x3), rows of R^T / s
    pack() {
        const p = this.pos, a = this.axes, k = 1 / this.scale, i = this.i32, f = this.f32;
        i[0] = p.c[0]; i[1] = p.c[1]; i[2] = p.c[2]; i[3] = 0;
        f[4] = p.l[0]; f[5] = p.l[1]; f[6] = p.l[2]; f[7] = 0;
        for (let r = 0; r < 3; r++) { f[8 + r * 4] = a[r][0] * k; f[9 + r * 4] = a[r][1] * k; f[10 + r * 4] = a[r][2] * k; f[11 + r * 4] = 0; }
    }
}

return { Origin };
});
