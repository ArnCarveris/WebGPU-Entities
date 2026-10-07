'use strict';
// One camera for every world of a composition.
//
//   camera { controller: "fly", pos, look, fov, speed }    the engine flies it (WASD, drag, wheel, Space / C)
//   camera { ..., mode: "walk" }                           ... walking (H switches): on the ground of every shown world
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

    // a point of this frame in composition space, and back
    point(p) { return CamMath.add(this.pos, CamMath.qRotate(this.q, p)); }
    local(p) { return CamMath.qRotate(CamMath.qConj(this.q), CamMath.sub(p, this.pos)); }

    // this frame placed in a parent frame
    within(parent) {
        return new LayerFrame(CamMath.add(parent.pos, CamMath.qRotate(parent.q, this.pos)), CamMath.qMul(parent.q, this.q));
    }
}

// the engine's own camera (camera { controller: "fly" }): a FirstPersonView (kits.view, an engine kit) driven by
// PointerInput, flying or walking on floor(x, y, z) (composition space: every shown world's ground, Host.floorAt)
class FlyCamera {
    constructor(def, io, floor) {
        this.eye = new Features.kits.view.FirstPersonView({ pos: def.pos || [0, 100, 0], fov: (def.fov || 60) * Math.PI / 180,
            speed: def.speed || 60, wheel: { step: 1.2, min: 1, max: 20000 } });
        this.input = new Common.PointerInput(io);
        this.floor = floor;
        if (def.look) this.eye.lookAt(def.look);
    }

    update(dt) { this.eye.control(dt, this.input.consume(), this.input.keys, this.floor); }

    get view() { return this.eye.view; }
    set view(v) { this.eye.setView(v); }
}
