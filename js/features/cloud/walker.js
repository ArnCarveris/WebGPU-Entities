'use strict';
// Walking: collision against the terrain and the structures, and the walker's motion.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { clamp } = Common;
const { BUS, WALK, River } = feature;

// Pushes a walker at feet p ([x, y, z], changed in place) out of the walls among `boxes` (Solids.add's shape) and
// returns the highest floor under it: a box whose top is within a step of the feet is a floor, one that reaches higher
// is a wall, unless it is all above the head.
function collideWalker(p, boxes, ground) {
    const R = WALK.radius;
    for (let it = 0; it < 3; it++) {
        for (const b of boxes) {
            if (b.off) continue;
            const rx = p[0] - b.x, rz = p[2] - b.z;
            let lx = rx * b.cs + rz * b.sn, lz = -rx * b.sn + rz * b.cs;
            if (Math.abs(lx) > b.hx + R || Math.abs(lz) > b.hz + R) continue;
            const top = b.y1 + b.slope * lx, bot = b.y0 + b.slope * lx;
            if (bot > p[1] + WALK.head || top <= p[1] + WALK.step) continue;
            const cx = clamp(lx, -b.hx, b.hx), cz = clamp(lz, -b.hz, b.hz), dx = lx - cx, dz = lz - cz, d2 = dx * dx + dz * dz;
            if (d2 >= R * R) continue;
            if (d2 > 1e-10) { const d = Math.sqrt(d2), k = (R - d) / d; lx += dx * k; lz += dz * k; }
            else if (b.hx - Math.abs(lx) < b.hz - Math.abs(lz)) lx = Math.sign(lx || 1) * (b.hx + R);
            else lz = Math.sign(lz || 1) * (b.hz + R);
            p[0] = b.x + lx * b.cs - lz * b.sn;
            p[2] = b.z + lx * b.sn + lz * b.cs;
        }
    }
    for (const b of boxes) {
        if (b.off) continue;
        const rx = p[0] - b.x, rz = p[2] - b.z, lx = rx * b.cs + rz * b.sn, lz = -rx * b.sn + rz * b.cs;
        if (Math.abs(lx) > b.hx || Math.abs(lz) > b.hz) continue;
        const top = b.y1 + b.slope * lx;
        if (top <= p[1] + WALK.step) ground = Math.max(ground, top);
    }
    return ground;
}

// On foot: walks on the terrain as drawn and on what stands on it (Structures' boxes, bridge decks), into the bus and
// out of it. Aboard, the walker lives in the bus's frame (`local`), so it rides along; seated, its eye is the seat's.
// The camera's yaw turns with the bus while aboard.
class Walker {
    constructor() {
        this.active = false;
        this.feet = [0, 0, 0];         // world, or the bus's frame while aboard
        this.bus = null;
        this.seat = null;
        this.vy = 0;
        this.lag = 0;                  // eye height still to catch up after a step (smooths stairs and kerbs)
        this.prompt = '';
    }

    // on foot at x, z, on whatever is there within a step of height y (default: the ground)
    place(app, x, z, y) {
        this.active = true;
        this.bus = null;
        this.seat = null;
        this.vy = this.lag = 0;
        const g = app.world.field.surface(x, z);
        this.feet = [x, Math.max(y ?? g, g), z];
        this.feet[1] = this.floorAt(app, this.feet, -Infinity);
    }

    // seated aboard the bus (seat index, or the best free window seat)
    sit(app, bus, k) {
        const seats = bus.mesh.seats, s = seats[k ?? seats.findIndex(q => q.name.startsWith('window seat, row 5 left'))] || seats[0];
        this.active = true;
        this.bus = bus;
        this.seat = s;
        this.feet = [s.x, BUS.floor, s.z];
        this.lag = 0;
        app.camera.yaw = bus.yaw;
        app.camera.pitch = -0.08;
        this.busYaw = bus.yaw;
    }

    // world: the terrain or the highest box top under the feet (within a step); the walls and floors of buses near it too
    floorAt(app, p, below) {
        const w = app.world, boxes = w.structures.solids.near(p[0], p[2], 2);
        for (const bus of w.buses) {
            if (Math.hypot(p[0] - bus.pose.x, p[2] - bus.pose.z) > 10) continue;
            for (const b of bus.colliders()) {
                const c = bus.toWorld([b.x, b.y0, b.z]);
                boxes.push({ x: c[0], z: c[2], hx: b.hx, hz: b.hz, cs: bus.pose.cs, sn: bus.pose.sn, y0: c[1], y1: c[1] + b.y1 - b.y0, slope: 0 });
            }
        }
        return collideWalker(p, boxes, Math.max(below, w.field.surface(p[0], p[2])));
    }

    // open water at x, z (the land-use map's, or a river's own channel, which villages draw at its true width)
    water(app, x, z) {
        const w = app.world;
        return w.field.landAt(x, z, 2) > 0.4 || w.entities.some(e => e instanceof River && e.distance(x, z) < (e.def.width || 60) / 2 - 2);
    }

    update(dt, io, input, app) {
        const cam = app.camera, k = input.keys;
        // the view turns with the bus while aboard
        if (this.bus) { cam.yaw += this.bus.yaw - this.busYaw; this.busYaw = this.bus.yaw; }
        cam.yaw -= io.dx * 0.0025;
        cam.pitch = clamp(cam.pitch - io.dy * 0.0025, -1.45, 1.45);
        const pressed = io.pressed.includes('KeyE');
        if (this.seat) {
            if (pressed) {                                          // stand up into the aisle beside the seat
                this.feet = [this.seat.x + 0.3, BUS.floor, 0];
                this.lag = this.seat.eye[1] - BUS.floor - WALK.eye;
                this.seat = null;
            } else { this.prompt = `seated: ${this.seat.name} · E stand up`; this.eye(app); return; }
        }
        // where to: along the ground, the way the camera looks
        const f = [-Math.sin(cam.yaw), -Math.cos(cam.yaw)], r = [Math.cos(cam.yaw), -Math.sin(cam.yaw)];
        let mx = 0, mz = 0;
        if (k.has('KeyW')) { mx += f[0]; mz += f[1]; }
        if (k.has('KeyS')) { mx -= f[0]; mz -= f[1]; }
        if (k.has('KeyD')) { mx += r[0]; mz += r[1]; }
        if (k.has('KeyA')) { mx -= r[0]; mz -= r[1]; }
        const l = Math.hypot(mx, mz), speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? WALK.run : WALK.speed) * (k.has('AltLeft') ? 0.3 : 1);
        if (l > 0) { mx *= speed * dt / l; mz *= speed * dt / l; }
        if (this.bus) {
            // aboard: move in the bus's frame, against its walls, seats and doors; out through an open door
            const d = this.bus.toLocal([mx, 0, mz], 0), p = this.feet, y0 = p[1];
            p[0] += d[0]; p[2] += d[2];
            const g = collideWalker(p, this.bus.colliders(), -Infinity);
            this.settle(g, y0, dt);
            if (Math.abs(p[0]) > BUS.hl || Math.abs(p[2]) > BUS.hw) {
                this.feet = this.bus.toWorld(p);
                this.bus = null;
            }
        } else {
            const p = this.feet, y0 = p[1], was = [p[0], p[2]], f0 = app.world.field;
            p[0] += mx; p[2] += mz;
            let g = this.floorAt(app, p, -Infinity);
            // no wading into the water (a bridge's deck over it is fine)
            if (l > 0 && g < f0.surface(p[0], p[2]) + 0.5 && this.water(app, p[0], p[2]) && !this.water(app, ...was)) {
                p[0] = was[0]; p[2] = was[1];
                g = this.floorAt(app, p, -Infinity);
            }
            this.settle(g, y0, dt);
            // stepped into a bus (through a door): ride along in its frame
            for (const bus of app.world.buses) {
                const q = bus.toLocal(p);
                if (Math.abs(q[0]) < BUS.hl - 0.05 && Math.abs(q[2]) < BUS.hw - 0.05 && q[1] > BUS.floor - 0.4) {
                    this.bus = bus;
                    this.busYaw = bus.yaw;
                    this.feet = [q[0], Math.max(q[1], BUS.floor), q[2]];
                    break;
                }
            }
        }
        // a seat in view within reach: E sits down in it
        this.prompt = '';
        this.aim = null;
        if (this.bus) {
            const { fwd } = cam.basis(), d = this.bus.toLocal(fwd, 0), o = [this.feet[0], this.feet[1] + WALK.eye + this.lag, this.feet[2]];
            let best = 2.2;
            for (const s of this.bus.mesh.seats) {
                const lo = [s.x - 0.27, s.y - 0.12, s.z - 0.23], hi = [s.x + 0.23, s.y + 0.62, s.z + 0.23];
                let tn = 0, tf = best;
                for (let a = 0; a < 3; a++) {
                    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) { tn = Infinity; } continue; }
                    const t0 = (lo[a] - o[a]) / d[a], t1 = (hi[a] - o[a]) / d[a];
                    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
                }
                if (tn <= tf && tn < best) { best = tn; this.aim = s; }
            }
            if (this.aim) {
                this.prompt = `E sit: ${this.aim.name}`;
                if (pressed) { this.seat = this.aim; this.aim = null; cam.yaw = this.bus.yaw; this.busYaw = this.bus.yaw; }
            } else this.prompt = 'aboard · look at a seat to sit';
        }
        this.eye(app);
    }

    // feet onto the floor g: up a step at once (the eye follows), or falling to it
    settle(g, y0, dt) {
        const p = this.feet;
        if (g >= p[1]) { this.lag -= g - p[1]; p[1] = g; this.vy = 0; }
        else {
            this.vy -= 9.81 * dt;
            p[1] = Math.max(g, p[1] + this.vy * dt);
            if (p[1] === g) this.vy = 0;
        }
        this.lag *= Math.exp(-dt * 10);
        if (Math.abs(this.lag) < 1e-3) this.lag = 0;
    }

    // the camera at the eye: standing, or the seat's
    eye(app) {
        const e = this.seat ? this.seat.eye : [this.feet[0], this.feet[1] + WALK.eye + this.lag, this.feet[2]];
        app.camera.pos = this.bus ? this.bus.toWorld(e) : e;
    }
}

return { Walker };
});
