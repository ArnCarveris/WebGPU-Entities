'use strict';
// The player: camera and controller.

Features.part('portal', (engine, feature) => {
const { Common, kits } = engine;
const { v3 } = Common;
const { m4 } = feature;

// Camera and PlayerController: walking (gravity, walls, stairs, ladders, swimming, riding vehicles),
// fly mode (noclip) and standing at a ship's helm. Tuning comes from the scenario's `player` block.

const PLAYER_DEFAULTS = {
    eyeHeight: 1.65, radius: 0.3, walkSpeed: 4.2, runSpeed: 7.5, stepHeight: 0.55,
    jumpSpeed: 5.2, gravity: 18, climbSpeed: 2.4,
    swim: { speedFactor: 0.45, jumpSpeed: 3.5, depth: 1.3 },
    fly: { speed: 5, runSpeed: 14 },
    turnSpeed: 1.8, mouseSensitivity: 0.0022,
    helm: { throttleRate: 0.35, rudderRate: 0.9, rudderReturn: 0.5 },
};

// defaults overridden by (possibly partial) scenario values, one level of nesting deep
function withDefaults(defaults, over = {}) {
    const out = {};
    for (const k of Object.keys(defaults)) {
        const d = defaults[k], o = over[k];
        out[k] = d && typeof d === 'object' && !Array.isArray(d) ? Object.assign({}, d, o) : (o ?? d);
    }
    return out;
}

// the view (a FirstPersonView turning right with +yaw; look() takes radians), where it started, and on a vehicle a basis
// turned with it
class Camera extends kits.view.FirstPersonView {
    constructor(def) {
        const d = def || {};
        super({ pos: def ? def.pos : [0, 1.7, -16], yaw: def ? (d.yaw || 0) * Math.PI / 180 : Math.PI, pitch: (d.pitch || 0) * Math.PI / 180,
            fov: (d.fov || 70) * Math.PI / 180, turn: 'right', sensitivity: 1, pitchLimit: 1.5 });
        this.start = { pos: this.pos.slice(), yaw: this.yaw, pitch: this.pitch };
    }

    reset() { Object.assign(this, { pos: this.start.pos.slice(), yaw: this.start.yaw, pitch: this.start.pitch }); }

    // arrow keys turn the view
    turn(keys, rate) {
        if (keys.has('ArrowLeft')) this.yaw -= rate;
        if (keys.has('ArrowRight')) this.yaw += rate;
        if (keys.has('ArrowUp')) this.pitch = Math.min(1.5, this.pitch + rate);
        if (keys.has('ArrowDown')) this.pitch = Math.max(-1.5, this.pitch - rate);
    }

    // view axes; on a vehicle the look direction is kept relative to the ship and turned by its full
    // rotation (heading, pitch, roll)
    basis(vehicle = null) {
        const { yaw, pitch } = this;
        if (vehicle) {
            const ly = yaw + vehicle.heading;
            const fwd = v3.norm(m4.dir(vehicle.M, [Math.sin(ly) * Math.cos(pitch), Math.sin(pitch), -Math.cos(ly) * Math.cos(pitch)]));
            const right = v3.norm(m4.dir(vehicle.M, [Math.cos(ly), 0, Math.sin(ly)]));
            return { fwd, right, up: v3.cross(right, fwd) };
        }
        return super.basis();
    }
}

class PlayerController {
    constructor(game, cameraDef, def) {
        this.game = game;
        this.cfg = withDefaults(PLAYER_DEFAULTS, def);
        this.cam = new Camera(cameraDef);
        this.reset(this.cam.pos);
    }

    get world() { return this.game.world; }
    get walking() { return this.game.opts.walk; }

    // put the walker's feet under an eye position
    reset(eye) {
        Object.assign(this, {
            feet: [eye[0], eye[1] - this.cfg.eyeHeight, eye[2]], vy: 0, support: null, local: null,
            onGround: false, wasGround: false, swimming: false, climbing: false, driving: null,
        });
    }

    basis() { return this.cam.basis(this.walking && this.driving); }

    get stateLabel() {
        if (!this.walking) return 'flying';
        return this.driving ? 'at the helm' : this.climbing ? 'climbing' : this.swimming ? 'swimming' : this.onGround ? 'walking' : 'airborne';
    }

    update(dt, keys) {
        if (this.walking) this.walk(dt, keys);
        else this.fly(dt, keys);
        this.cam.turn(keys, this.cfg.turnSpeed * dt);
    }

    fly(dt, k) {
        const { fwd, right } = this.basis(), f = this.cfg.fly;
        let mv = [0, 0, 0];
        if (k.has('KeyW')) mv = v3.add(mv, fwd);
        if (k.has('KeyS')) mv = v3.sub(mv, fwd);
        if (k.has('KeyD')) mv = v3.add(mv, right);
        if (k.has('KeyA')) mv = v3.sub(mv, right);
        if (k.has('KeyE') || k.has('Space')) mv[1] += 1;
        if (k.has('KeyQ') || k.has('ControlLeft')) mv[1] -= 1;
        const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? f.runSpeed : f.speed;
        if (v3.len(mv) > 0) this.cam.pos = v3.madd(this.cam.pos, v3.norm(mv), speed * dt);
    }

    walk(dt, k) {
        const w = this.world, c = this.cfg, R = c.radius;
        // ride along with whatever vehicle we stand on (or are inside)
        if (this.support) { this.feet = this.support.toWorld(this.local); this.cam.yaw -= this.support.dHeading; }
        if (this.driving) { this.drive(dt, k); return; }
        const { fwd, right } = this.basis(), f = v3.norm([fwd[0], 0, fwd[2]]);
        let mv = [0, 0, 0];
        if (k.has('KeyW')) mv = v3.add(mv, f);
        if (k.has('KeyS')) mv = v3.sub(mv, f);
        if (k.has('KeyD')) mv = v3.add(mv, right);
        if (k.has('KeyA')) mv = v3.sub(mv, right);
        if (v3.len(mv) > 0) mv = v3.norm(mv);
        const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? c.runSpeed : c.walkSpeed) * (this.swimming ? c.swim.speedFactor : 1);
        const step = this.swimming ? 3.2 : c.stepHeight;
        // ladders: W / S climb; forward motion only at the top, to step off
        const lad = w.ladderAt(this.feet, R);
        let climb = 0;
        this.climbing = !!lad && (k.has('KeyW') || k.has('KeyS'));
        if (this.climbing) {
            climb = (k.has('KeyW') ? 1 : -1) * c.climbSpeed * dt;
            if (!(k.has('KeyW') && this.feet[1] >= lad.top - 0.2)) mv = v3.sub(mv, v3.mul(f, v3.dot(mv, f)));
        }
        const h = v3.mul(mv, speed * dt), n = Math.max(1, Math.ceil(Math.hypot(h[0], h[2]) / 0.1));
        for (let i = 0; i < n; i++) { this.feet[0] += h[0] / n; this.feet[2] += h[2] / n; w.collide(this.feet, R, step, 1.75); }
        if (this.climbing) { this.feet[1] += climb; this.vy = 0; }
        else {
            if (k.has('Space') && (this.onGround || this.swimming)) this.vy = this.swimming ? c.swim.jumpSpeed : c.jumpSpeed;
            this.vy -= c.gravity * dt;
            this.feet[1] += this.vy * dt;
        }
        // ground under the whole footprint (centre + 4 rim samples) so short treads can be stepped onto
        let g = w.groundAt(this.feet, this.climbing ? 0.05 : step);
        if (!this.climbing) for (const [ox, oz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
            const gi = w.groundAt([this.feet[0] + ox * R, this.feet[1], this.feet[2] + oz * R], step);
            if (gi.y > g.y) g = gi;
        }
        this.onGround = false;
        if (!this.climbing && this.vy <= 0 && (this.feet[1] <= g.y + 1e-3 || (this.wasGround && this.feet[1] - g.y < 0.35))) {
            this.feet[1] = g.y; this.vy = 0; this.onGround = true;
        }
        this.support = this.climbing ? (lad.o.vehicle || null) : g.support;
        const depth = c.swim.depth;
        const wl = w.water && w.areaAt(v3.add(this.feet, [0, 0.5, 0])) === 0 ? w.water.level : -Infinity;   // the sea is outdoors only
        this.swimming = this.feet[1] < wl - depth + 1e-3 && !this.onGround;
        if (this.feet[1] < wl - depth) { this.feet[1] = wl - depth; this.vy = Math.max(this.vy, 0); this.swimming = true; this.support = null; }
        if (this.feet[1] < -40) this.reset(this.cam.start.pos);
        this.wasGround = this.onGround;
        if (this.support) this.local = this.support.toLocal(this.feet);
        this.cam.pos = v3.add(this.feet, [0, c.eyeHeight, 0]);
    }

    // at the helm: the player stands at the wheel and the camera rolls and pitches with the hull
    drive(dt, k) {
        const veh = this.driving, ctl = veh.control, st = veh.helmStation.stand, hc = this.cfg.helm;
        if (k.has('KeyW')) ctl.throttle = Math.min(1, ctl.throttle + hc.throttleRate * dt);
        if (k.has('KeyS')) ctl.throttle = Math.max(-0.5, ctl.throttle - hc.throttleRate * dt);
        if (k.has('KeyX')) ctl.throttle = 0;
        const steer = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
        if (steer) ctl.rudder = Math.max(-1, Math.min(1, ctl.rudder + steer * hc.rudderRate * dt));
        else ctl.rudder -= Math.sign(ctl.rudder) * Math.min(Math.abs(ctl.rudder), hc.rudderReturn * dt);   // self-centring
        if (k.has('Space')) ctl.rudder = 0;
        this.local = st.slice(); this.support = veh; this.feet = veh.toWorld(this.local);
        this.vy = 0; this.onGround = true; this.climbing = false; this.swimming = false;
        this.cam.pos = veh.toWorld([st[0], st[1] + this.cfg.eyeHeight, st[2]]);
    }

    // take the helm in reach, or let go of the one we hold; returns a message, or null if no helm is near
    toggleHelm() {
        if (!this.walking) return null;
        if (this.driving) { this.driving.leaveHelm(); this.driving = null; return 'Left the helm: autopilot returns to the route'; }
        for (const h of this.world.helms) {
            if (!h.vehicle || v3.dist(this.feet, h.vehicle.toWorld(h.stand)) > h.reach) continue;
            h.vehicle.takeHelm();
            this.driving = h.vehicle;
            return 'At the helm: W/S throttle, A/D steer, X stop, Space centre rudder, F leave';
        }
        return null;
    }

    teleport(pos) {
        this.cam.pos = pos;
        if (this.walking) this.reset(pos);
    }
}

return { PlayerController };
});
