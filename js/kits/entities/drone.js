'use strict';
// Drones: hovering machines that patrol a loop or wander a route, bobbing, with a lamp and a ping.

Features.kit('entities', (engine, kit) => {
const { v3 } = engine.Common;
const { mulberry32 } = engine.kits.noise;
const { LightSource } = kit;

// A drone entity over a feature's own entity base. It moves one of two ways:
//   patrol   with `center` [x, y, z] and `radius` (r or [rx, rz]): round an ellipse at `speed` rad/s, facing along it
//   wander   from `pos`, along waypoints its feature plans: wander() (idle: pick somewhere and plan()) and plan() fill
//            `queue` with { pos, gate }; it waits at a gate that is `closed` and replans when one is not `navigable`.
//            `speed` m/s, turning toward where it flies at `turn` (6) per second
// Either way it bobs (`bob` { amp, freq }, default 0.05 m at 3 rad/s) and stands at `at` (pos with the bob), facing
// `fwd` / `yaw` (degrees, 0 = -z). `pingEvery` s it calls ping() (a radar blip, a sound...). `light` { color, intensity,
// radius, signal, ..., ahead (m along fwd), drop (m below) } is a LightSource that rides it (makeLight: the feature's
// own light class). The feature places its model from at / yaw / fwd after super.update().
function drone(Base) {
    return class Drone extends Base {
        constructor(def, world, ...rest) {
            super(def, world, ...rest);
            const d = def || {};
            this.patrol = !!d.center;
            this.pos = (d.center || d.pos || [0, 0, 0]).slice();
            this.at = this.pos.slice();
            this.yaw = 0;
            this.fwd = [0, 0, -1];
            this.angle = 0;
            this.speed = d.speed || 3;
            this.bob = d.bob || { amp: 0.05, freq: 3 };
            this.rnd = mulberry32(d.seed || 99);
            this.queue = [];
            this.wait = 0.5;
            this.target = -1;
            this.lastPing = 0;
            this.lightOn = !!d.light;
            this.light = d.light ? this.makeLight({ ...d.light, pos: this.pos.slice() }) : null;
        }

        makeLight(spec) { return new LightSource(spec, this.world); }
        plan() { return false; }
        wander() {}
        ping() {}

        update(dt, t, ...rest) {
            super.update(dt, t, ...rest);
            if (this.patrol) this.loop(dt); else this.follow(dt);
            const d = this.def, b = this.bob;
            this.at = [this.pos[0], this.pos[1] + b.amp * Math.sin(t * b.freq), this.pos[2]];
            if (d.pingEvery && t - this.lastPing > d.pingEvery) { this.lastPing = t; this.ping(); }
            if (this.light) {
                const L = d.light, ahead = L.ahead || 0;
                this.light.pos = [this.at[0] + this.fwd[0] * ahead, this.at[1] + this.fwd[1] * ahead - (L.drop || 0), this.at[2] + this.fwd[2] * ahead];
            }
        }

        loop(dt) {
            const d = this.def, [rx, rz] = Array.isArray(d.radius) ? d.radius : [d.radius, d.radius];
            this.angle += dt * this.speed;
            this.pos = [d.center[0] + rx * Math.cos(this.angle), d.center[1], d.center[2] + rz * Math.sin(this.angle)];
            this.fwd = v3.norm([-rx * Math.sin(this.angle), 0, rz * Math.cos(this.angle)]);
            this.yaw = Math.atan2(-this.fwd[0], -this.fwd[2]) * 180 / Math.PI;
        }

        follow(dt) {
            if (!this.queue.length) {
                this.wait -= dt;
                if (this.wait <= 0) { this.wander(); this.wait = 1.0; }
                return;
            }
            const wp = this.queue[0], d = v3.sub(wp.pos, this.pos), l = v3.len(d);
            if (wp.gate && !wp.gate.navigable) {                              // a door got locked/closed on us: replan
                if (!this.plan()) { this.queue = []; this.wait = 1.5; }
            } else if (!(wp.gate && wp.gate.closed && l < 1.6)) {             // wait for an automatic door
                const step = this.speed * dt;
                if (l <= step) { this.pos = wp.pos.slice(); this.queue.shift(); }
                else {
                    this.pos = v3.madd(this.pos, d, step / l);
                    if (Math.hypot(d[0], d[2]) > 0.05) {
                        const want = Math.atan2(-d[0], -d[2]) * 180 / Math.PI;
                        const dy = ((want - this.yaw + 540) % 360) - 180;
                        this.yaw += dy * Math.min(1, dt * (this.def.turn ?? 6));
                    }
                }
            }
            const a = this.yaw * Math.PI / 180;
            this.fwd = [-Math.sin(a), 0, -Math.cos(a)];
        }
    };
}

return { drone };
});
