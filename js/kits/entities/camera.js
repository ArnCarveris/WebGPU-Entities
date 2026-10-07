'use strict';
// Security cameras: viewpoints a CCTV system renders through.

Features.kit('entities', (engine, kit) => {
const { v3 } = engine.Common;

// A security camera entity over a feature's own entity base: at `pos` looking at `target`, panning `sweep` radians either
// way, its sine running at `speed` rad/s from `phase` (default pos[0], so cameras do not pan in step). It offers what the
// gui kit's CctvSystem reads: position, fwd, label, name, location, offline, pan / panDeg. A feature adds its geometry
// (a model, a tally light) or registration on top.
// def: { pos, target, sweep (0), speed (0.3), phase, label, name (default label), loc, offline }
function securityCamera(Base) {
    return class SecurityCamera extends Base {
        constructor(def, world) {
            super(def, world);
            this.fwd = v3.norm(v3.sub(def.target, def.pos));
            this.pan = 0;
            this.panDeg = 0;
        }

        get position() { return this.def.pos; }
        get name() { return this.def.name || this.label; }
        get location() { return this.def.loc || ''; }
        get offline() { return !!this.def.offline; }

        update(dt, t, ...rest) {
            super.update(dt, t, ...rest);
            const d = this.def, base = v3.norm(v3.sub(d.target, d.pos));
            const pan = this.pan = (d.sweep || 0) * Math.sin(t * (d.speed ?? 0.3) + (d.phase ?? d.pos[0])), c = Math.cos(pan), s = Math.sin(pan);
            this.panDeg = Math.round(pan * 180 / Math.PI);
            this.fwd = [base[0] * c + base[2] * s, base[1], -base[0] * s + base[2] * c];
        }
    };
}

return { securityCamera };
});
