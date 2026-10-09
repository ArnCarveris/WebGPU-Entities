'use strict';
// Elevator: a lift car on a vertical line of stops, dispatched by the calls at its landings and the buttons in its car.

Features.kit('transit', (engine, kit) => {

// A car serving `stops` (heights of their floors, ascending; names: what its displays call them). It runs a collective
// scan: on in its direction while a call lies ahead, then the other way; it brakes to stop level at the call nearest
// ahead (speed limited to sqrt(2 a d), so it eases in), opens, waits `dwell` s (longer while held) and closes.
// spec: { stops, names, speed (m/s), accel (m/s^2), door (s to open or shut), dwell (s), start (stop index) }
// State: y (its floor's height), v (signed m/s), dir (+1 up, -1 down, 0 idle), at (the stop it stands level at, or -1),
// door (0 shut .. 1 open), calls (stop indices it will serve)
class Elevator {
    constructor({ stops, names = null, speed = 4, accel = 1.2, door = 2.2, dwell = 4, start = 0 }) {
        this.stops = stops;
        this.names = names || stops.map((_, i) => String(i));
        Object.assign(this, { speed, accel, doorTime: door, dwell });
        this.at = start;
        this.y = stops[start];
        this.v = 0;
        this.dir = 0;
        this.door = 0;
        this.doorTarget = 0;
        this.wait = 0;
        this.calls = new Set();
        this.dy = 0;                    // how far it moved in the last update (what rides it moves as much)
        this.boost = 1;                 // its time runs this many times as fast
    }

    // the stop nearest height y
    nearest(y) {
        let best = 0;
        for (let i = 1; i < this.stops.length; i++) if (Math.abs(this.stops[i] - y) < Math.abs(this.stops[best] - y)) best = i;
        return best;
    }

    // a call for stop i (a landing's button, or one in the car): opens at once if it stands there
    call(i) {
        if (i < 0 || i >= this.stops.length) return false;
        if (this.at === i && this.v === 0) { this.open(); return true; }
        this.calls.add(i);
        return true;
    }

    open() { if (this.at >= 0 && this.v === 0) { this.doorTarget = 1; this.wait = this.dwell; } }
    close() { this.wait = 0; }

    get moving() { return this.v !== 0; }
    get name() { return this.at >= 0 ? this.names[this.at] : this.names[this.nearest(this.y)]; }

    // the call to head for: the nearest ahead in its direction, else the nearest the other way
    next() {
        if (!this.calls.size) return -1;
        const y = this.y, ahead = [...this.calls].filter(i => this.dir >= 0 ? this.stops[i] > y - 1e-3 : this.stops[i] < y + 1e-3);
        const pool = ahead.length ? ahead : [...this.calls];
        return pool.reduce((b, i) => Math.abs(this.stops[i] - y) < Math.abs(this.stops[b] - y) ? i : b, pool[0]);
    }

    update(dt0) {
        const dt = dt0 * this.boost, y0 = this.y;
        // doors first: nothing moves until they are shut
        if (this.doorTarget > 0 || this.door > 0) {
            if (this.doorTarget > 0 && this.door >= 1) {
                this.wait -= dt;
                if (this.wait <= 0) this.doorTarget = 0;
            }
            const step = dt / this.doorTime;
            this.door = this.doorTarget > this.door ? Math.min(1, this.door + step) : Math.max(0, this.door - step);
            this.dy = 0;
            return;
        }
        const t = this.next();
        if (t < 0) { this.dir = 0; this.dy = 0; return; }
        const goal = this.stops[t], d = goal - this.y;
        if (Math.abs(d) < 1e-3 && Math.abs(this.v) < 0.05) {
            // level: arrived
            this.y = goal;
            this.v = 0;
            this.at = t;
            this.calls.delete(t);
            if (!this.calls.size) this.dir = 0;
            else this.dir = this.next() >= 0 && this.stops[this.next()] > goal ? 1 : -1;
            this.open();
            this.dy = this.y - y0;
            return;
        }
        this.at = -1;
        this.dir = Math.sign(d);
        // the speed it may have here: its top speed, or what lets it stop at the goal
        const want = this.dir * Math.min(this.speed, Math.sqrt(2 * this.accel * Math.abs(d)));
        const dv = want - this.v, a = this.accel * dt;
        this.v += Math.abs(dv) < a ? dv : Math.sign(dv) * a;
        let step = this.v * dt;
        if (Math.abs(step) >= Math.abs(d)) { step = d; this.v = 0; }
        this.y += step;
        this.dy = this.y - y0;
    }
}

return { Elevator };
});
