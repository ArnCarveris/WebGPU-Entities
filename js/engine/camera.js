'use strict';
// The one camera, and where a site is in the world.
//
//   camera { controller: "fly", pos, look, fov, speed, clearance }   the engine flies it (WASD, drag, wheel, Space / C)
//   camera { ..., mode: "walk" }                                     ... walking (the handheld switches): on every site's ground
//   camera { start: "<site>" }                                       (several sites) the engine's camera starts at that site's start view
//   camera { controller: "<site>" | ["<site>", ...] }                that site's own camera (its flight, its player) drives it;
//                                                                    the handheld's Walk picks the first that walks or flies where
//                                                                    the camera is (a building's player: in its rooms), else the
//                                                                    engine's walks there, on the site under it; from where the
//                                                                    camera is, falling to the ground
//
// Each site stands in the world by its `at`: { pos: [x, y, z], yaw: deg, on: "<entity>" } (on: an entity another site
// answers anchor() for, a pad on a planet, resolved every frame). The camera is a view { pos, fwd, up, fov } (metres,
// doubles), taken into each site's own frame with its SiteFrame.

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

// a rigid frame { pos, q }: a site's frame in the world, local -> world
class SiteFrame {
    constructor(pos = [0, 0, 0], q = [0, 0, 0, 1]) { this.pos = pos; this.q = q; }

    static fromDef(t = {}) {
        return new SiteFrame([...(t.offset || [0, 0, 0])], CamMath.qAxis([0, 1, 0], (t.yaw || 0) * Math.PI / 180));
    }

    toWorld(view) {
        const M = CamMath;
        return { pos: M.add(this.pos, M.qRotate(this.q, view.pos)), fwd: M.qRotate(this.q, view.fwd), up: M.qRotate(this.q, view.up), fov: view.fov };
    }

    toLocal(view) {
        const M = CamMath, iq = M.qConj(this.q);
        return { pos: M.qRotate(iq, M.sub(view.pos, this.pos)), fwd: M.qRotate(iq, view.fwd), up: M.qRotate(iq, view.up), fov: view.fov };
    }

    // a point of this frame in the world, and back
    point(p) { return CamMath.add(this.pos, CamMath.qRotate(this.q, p)); }
    local(p) { return CamMath.qRotate(CamMath.qConj(this.q), CamMath.sub(p, this.pos)); }

    // a direction of this frame in the world, and back
    dir(d) { return CamMath.qRotate(this.q, d); }
    localDir(d) { return CamMath.qRotate(CamMath.qConj(this.q), d); }

    // this frame placed in a parent frame
    within(parent) {
        return new SiteFrame(CamMath.add(parent.pos, CamMath.qRotate(parent.q, this.pos)), CamMath.qMul(parent.q, this.q));
    }
}

// the engine's own camera (camera { controller: "fly" }, or a scenario of several sites): a FirstPersonView (kits.view, an
// engine kit) driven by PointerInput, flying (at least `clearance` m over the ground; Alt slows it) or walking on
// floor(x, y, z) (every site's ground, Host.floorAt)
class FlyCamera {
    constructor(def, io, floor) {
        this.eye = new Features.kits.view.FirstPersonView({ pos: def.pos || [0, 100, 0], fov: (def.fov || 60) * Math.PI / 180,
            speed: def.speed || 60, wheel: { step: 1.2, min: 1, max: 20000 }, clearance: def.clearance || 0, slow: { keys: ['AltLeft'], factor: 0.2 } });
        this.input = new Common.PointerInput(io);
        this.floor = floor;
        if (def.look) this.eye.lookAt(def.look);
    }

    update(dt) { this.eye.control(dt, this.input.consume(), this.input.keys, this.on ? this.floorOn : this.floor); }

    // walking on a site (on: () => its SiteFrame, floorOn(x, y, z) in that frame; null: the world's): the eye in that
    // frame, riding along with it (a planet's surface turns and moves), walking and looking up its up
    walkOn(on, floorOn) {
        const v = this.view;
        this.on = on;
        this.floorOn = floorOn;
        this.view = v;
    }

    get view() { const v = this.eye.view; return this.on ? this.on().toWorld(v) : v; }
    set view(v) { this.eye.setView(this.on ? this.on().toLocal(v) : v); }
}
