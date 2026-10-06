'use strict';
// One camera for every world of a composition.
//
//   camera { controller: "fly", pos, look, fov, speed }    the engine flies it (WASD, drag, wheel, Space / C)
//   camera { from: "<world id>" }                         that world's own camera (walk, fly, ride...) drives it
//   camera { from: ["a", "b"], carry }                    ... several: giving one the keys (`) gives it the camera too,
//                                                         from where the camera is (carry, default) or where it was
//
// Each world sits in the composition through its root entity's `layer.transform`: { offset: [x, y, z], yaw: deg } or
// { anchor: "<world id>:<entity id>", offset, yaw }, an entity of another world it rides on (a moon base, a ship...),
// resolved every frame. The camera is passed around as a view { pos, fwd, up, fov } (metres, doubles), converted
// between composition space and each world's own space with that transform.

const CamMath = {
    ...Common.v3,
    // quaternions [x, y, z, w]
    qAxis(axis, rad) { const s = Math.sin(rad / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]; },
    qMul(a, b) {
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
    },
    qConj: q => [-q[0], -q[1], -q[2], q[3]],
    qRotate(q, v) {
        const u = [q[0], q[1], q[2]], t = CamMath.mul(CamMath.cross(u, v), 2);
        return CamMath.add(CamMath.add(v, CamMath.mul(t, q[3])), CamMath.cross(u, t));
    },
};

// a rigid frame { pos, q }: local -> composition space
class LayerFrame {
    constructor(pos = [0, 0, 0], q = [0, 0, 0, 1]) { this.pos = pos; this.q = q; }

    static fromDef(t = {}) {
        return new LayerFrame([...(t.offset || [0, 0, 0])], CamMath.qAxis([0, 1, 0], (t.yaw || 0) * Math.PI / 180));
    }

    toWorld(view) {
        const M = CamMath;
        return { pos: M.add(this.pos, M.qRotate(this.q, view.pos)), fwd: M.qRotate(this.q, view.fwd), up: M.qRotate(this.q, view.up), fov: view.fov };
    }

    toLocal(view) {
        const M = CamMath, iq = M.qConj(this.q);
        return { pos: M.qRotate(iq, M.sub(view.pos, this.pos)), fwd: M.qRotate(iq, view.fwd), up: M.qRotate(iq, view.up), fov: view.fov };
    }

    // this frame placed in a parent frame
    within(parent) {
        return new LayerFrame(CamMath.add(parent.pos, CamMath.qRotate(parent.q, this.pos)), CamMath.qMul(parent.q, this.q));
    }
}

// the engine's own free camera
class FlyCamera {
    constructor(def, io) {
        this.pos = [...(def.pos || [0, 100, 0])];
        this.yaw = 0;
        this.pitch = 0;
        this.fov = (def.fov || 60) * Math.PI / 180;
        this.speed = def.speed || 60;
        this.keys = new Set();
        this.drag = false;
        this.dx = this.dy = this.wheel = 0;
        if (def.look) this.lookAt(def.look);
        const c = io.canvas;
        io.listen(c, 'pointerdown', e => { if (e.button === 0 && !e.ctrlKey) this.drag = true; });
        io.listen(c, 'pointermove', e => { if (this.drag) { this.dx += e.movementX; this.dy += e.movementY; } });
        io.listen(window, 'pointerup', () => { this.drag = false; });
        io.listen(c, 'wheel', e => { this.wheel += Math.sign(e.deltaY); });
        io.listen(window, 'keydown', e => this.keys.add(e.code));
        io.listen(window, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => { this.keys.clear(); this.drag = false; });
    }

    lookAt(target) {
        Object.assign(this, Common.yawPitch(CamMath.norm(CamMath.sub(target, this.pos))));
    }

    basis() {
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const fwd = [-sy * cp, sp, -cy * cp], right = [cy, 0, -sy];
        return { fwd, right, up: CamMath.cross(right, fwd) };
    }

    update(dt) {
        this.yaw -= this.dx * 0.0025;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - this.dy * 0.0025));
        this.dx = this.dy = 0;
        if (this.wheel) { this.speed = Math.max(1, Math.min(20000, this.speed * Math.pow(1.2, -this.wheel))); this.wheel = 0; }
        const k = this.keys, { fwd, right } = this.basis();
        let m = [0, 0, 0];
        if (k.has('KeyW')) m = CamMath.add(m, fwd);
        if (k.has('KeyS')) m = CamMath.sub(m, fwd);
        if (k.has('KeyD')) m = CamMath.add(m, right);
        if (k.has('KeyA')) m = CamMath.sub(m, right);
        if (k.has('Space')) m[1] += 1;
        if (k.has('KeyC')) m[1] -= 1;
        const mul = k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1;
        this.pos = CamMath.add(this.pos, CamMath.mul(m, this.speed * mul * dt));
    }

    get view() {
        const { fwd, up } = this.basis();
        return { pos: [...this.pos], fwd, up, fov: this.fov };
    }

    set view(v) {
        this.pos = [...v.pos];
        Object.assign(this, Common.yawPitch(v.fwd));
        if (v.fov) this.fov = v.fov;
    }
}
