'use strict';
// The camera and its controller (its input: Common.PointerInput).

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3 } = Common;
const { MAX_CELL, quat, WorldPos } = feature;

// Free-flight camera. It lives in world space (WorldPos + quaternion); its controls work in the origin
// frame: yaw turns about origin +Y, Space / C move along it, and speed is in origin units per second.
class Camera {
    constructor(fov = 60) {
        this.pos = new WorldPos();
        this.q = quat.identity();
        this.fov = fov * DEG;
        this.vel = [0, 0, 0];
    }

    // { pos (metres, doubles, from world 0), fwd, up, fov } (FeatureWorld.view)
    get view() { return { pos: this.pos.metres(), fwd: quat.rotate(this.q, [0, 0, -1]), up: quat.rotate(this.q, [0, 1, 0]), fov: this.fov }; }

    setView(v) {
        this.pos = WorldPos.of(v.pos);
        this.q = quat.look(v.fwd, v.up);
        if (v.fov) this.fov = v.fov;
        this.vel = [0, 0, 0];
    }
}

class CameraController {
    constructor(camera, input) {
        this.cam = camera;
        this.input = input;
        this.speedExp = 0;
        this.level = true;
    }

    // maxExp: with auto scale the speed already follows proximity, so the wheel only fine-tunes it
    // (a large boost on top would feed back into an exponential escape)
    update(dt, io, origin, prox, minAlt, maxExp) {
        const cam = this.cam, inp = this.input, U = origin.up;
        this.speedExp = clamp(this.speedExp - io.wheel, -8, maxExp);
        if (io.dx || io.dy) {
            cam.q = quat.norm(quat.mul(quat.axisAngle(U, -io.dx * 0.0025), cam.q));
            cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([1, 0, 0], -io.dy * 0.0025)));
        }
        const roll = (inp.keys.has('KeyQ') ? 1 : 0) - (inp.keys.has('KeyE') ? 1 : 0);
        const [X, , Z] = quat.axes(cam.q);
        if (roll) cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([0, 0, 1], roll * 1.3 * dt)));
        else if (this.level && prox.body && prox.alt < prox.body.radius * 0.5 && Math.abs(v3.dot(Z, U)) < 0.97) {
            // settle the horizon on origin +Y near a surface
            const err = Math.asin(clamp(v3.dot(X, U), -1, 1));
            cam.q = quat.norm(quat.mul(cam.q, quat.axisAngle([0, 0, 1], -err * Math.min(1, dt * 2.5))));
        }

        let m = [0, 0, 0];
        if (inp.keys.has('KeyW') || inp.keys.has('ArrowUp')) m = v3.sub(m, Z);
        if (inp.keys.has('KeyS') || inp.keys.has('ArrowDown')) m = v3.add(m, Z);
        if (inp.keys.has('KeyA') || inp.keys.has('ArrowLeft')) m = v3.sub(m, X);
        if (inp.keys.has('KeyD') || inp.keys.has('ArrowRight')) m = v3.add(m, X);
        if (inp.keys.has('Space')) m = v3.add(m, U);
        if (inp.keys.has('KeyC')) m = v3.sub(m, U);
        const boost = (inp.keys.has('ShiftLeft') || inp.keys.has('ShiftRight') ? 10 : 1) * (inp.keys.has('ControlLeft') || inp.keys.has('ControlRight') ? 0.1 : 1);
        this.unitSpeed = 6 * 2 ** this.speedExp * boost;           // origin units / s
        const target = v3.len(m) ? v3.mul(v3.norm(m), this.unitSpeed * origin.scale) : [0, 0, 0];
        cam.vel = v3.lerp(cam.vel, target, 1 - Math.exp(-dt * 6));
        cam.pos.addIn(v3.mul(cam.vel, dt));
        const edge = MAX_CELL * 0.9;
        if (cam.pos.c.some(c => Math.abs(c) > edge)) {
            cam.pos = new WorldPos(cam.pos.c.map(c => clamp(c, -edge, edge)), cam.pos.l);
            cam.vel = [0, 0, 0];
            this.atEdge = true;
        }

        // stay above every surface
        for (const b of prox.body ? [prox.body] : []) {
            const d = cam.pos.sub(b.pos), len = v3.len(d), floor = b.radius + minAlt;
            if (len < floor) {
                const n = v3.mul(d, 1 / len);
                cam.pos.addIn(v3.mul(n, floor - len));
                const vn = v3.dot(cam.vel, n);
                if (vn < 0) cam.vel = v3.madd(cam.vel, n, -vn);
            }
        }
    }
}

return { Camera, CameraController };
});
