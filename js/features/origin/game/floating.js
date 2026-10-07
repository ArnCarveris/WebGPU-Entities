'use strict';
// The rebase policy: when the origin follows the camera.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3 } = Common;
const { ORIGIN_BYTES, quat, WorldPos, Origin } = feature;

// Rebase policy. Each part of the origin matrix follows the camera on its own rule; any change is one
// 80-byte upload, whatever the number of instances.
//   T  translation snaps to the camera once it is `distance` origin units away
//   R  rotation keeps origin +Y on the local vertical of the dominant body (minimal twist)
//   S  scale = metres per origin unit, a power of two that follows the distance to the nearest thing
class FloatingOrigin {
    constructor(cfg, renderer) {
        this.cfg = { distance: 512, angle: 0.25, scaleBase: 64, frameRange: 3, maxScaleExp: 44, ...cfg };
        this.renderer = renderer;
        this.origin = new Origin();
        this.translate = true;
        this.rotate = true;
        this.scale = true;
        this.everyFrame = false;
        this.stats = { count: 0, reason: '-', ms: 0, bytes: 0 };
        this.force = true;
    }

    update(camPos, world) {
        const o = this.origin, c = this.cfg, prox = world.proximity(camPos);
        let why = '';

        let s = o.scale;
        if (this.scale) {
            const exact = Math.log2(Math.max(prox.dist / c.scaleBase, 1)), cur = Math.log2(s);
            if (Math.abs(exact - cur) > 0.75) s = 2 ** clamp(Math.round(exact), 0, c.maxScaleExp);
        } else s = 1;
        if (s !== o.scale) why += 'S';

        let q = o.q;
        if (this.rotate) {
            const b = prox.body;
            if (b && prox.alt < b.radius * c.frameRange) {
                const up = v3.norm(camPos.sub(b.pos));
                if (v3.dot(up, o.up) < Math.cos(c.angle * DEG)) { q = quat.mul(quat.fromTo(o.up, up), o.q); why += 'R'; }
            }
        } else if (q[3] !== 1) { q = quat.identity(); why += 'R'; }

        let pos = o.pos;
        if (this.translate) {
            if (why || this.everyFrame || this.force || v3.len(camPos.sub(o.pos)) / s > c.distance) { pos = camPos.clone(); why += 'T'; }
        } else if (!o.pos.isZero()) { pos = new WorldPos(); why += 'T'; }

        if (this.everyFrame && !why) why = 'O';
        if (why || this.force) {
            const t0 = performance.now();
            o.set(pos, q, s);
            this.renderer.writeOrigin(o);
            this.stats.ms = performance.now() - t0;
            this.stats.count++;
            this.stats.reason = why || 'init';
            this.stats.bytes = ORIGIN_BYTES;
            this.force = false;
        }
        return prox;
    }
}

return { FloatingOrigin };
});
