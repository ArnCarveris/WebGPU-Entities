'use strict';
// A transit line: vehicles running round a closed path on a timetable, stopping at its stops.

Features.kit('transit', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp, fmtKm } = Common;
const { Interior } = engine.kits.interior;

// Speed limits (m/s) at every point of a closed path sampled every `step` m: limit(i) where the line sets one, slower
// through bends (`lateral` m/s^2 sideways, the heading's change over `span` points either side), then braking (`brake`
// m/s^2) ahead of every slower stretch, twice round the loop so it carries over the start.
function speedLimits(path, step, limit, { lateral = 1.3, brake = 1, span = 4 } = {}) {
    const n = path.length;
    const turn = i => {
        const a = path[(i + n - span) % n], b = path[i], c = path[(i + span) % n];
        const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        return Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1))) / (2 * span * step);
    };
    const vmax = path.map((p, i) => Math.min(limit(i), Math.sqrt(lateral / Math.max(turn(i), 1e-6))));
    for (let k = 2 * n - 1; k >= 0; k--) { const i = k % n; vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[(i + 1) % n] ** 2 + 2 * brake * step)); }
    return vmax;
}

// A closed path sampled every `step` m (`length` m round): `path` [x, z] and `heights` (the road's y) at each point
class PolylineRoute {
    constructor({ path, heights, step, length }) {
        Object.assign(this, { path, heights, step, length });
    }

    // the sample at or before arc length s (0 <= s < length)
    index(s) { return Math.floor(s / this.step) % this.path.length; }

    // position at arc length s: [x, y, z]
    at(s) {
        const n = this.path.length, x = ((s % this.length) + this.length) % this.length / this.step, i = Math.floor(x) % n, j = (i + 1) % n, t = x - Math.floor(x);
        const a = this.path[i], b = this.path[j];
        return [lerp(a[0], b[0], t), lerp(this.heights[i], this.heights[j], t), lerp(a[1], b[1], t)];
    }
}

// A line round a closed `route` (anything with a `length` and at(s); a PolylineRoute, a SplineRoute...). Its vehicles
// (LineVehicle) stop at `stops` (arc lengths) in turn, dwelling `dwell[k]` s at stop k, called `names[k]`, at most
// limit(s) m/s (e.g. speedLimits per sample of a PolylineRoute; default none).
class TransitLine {
    constructor({ route, stops, dwell, names = [], limit = () => Infinity }) {
        Object.assign(this, { route, len: route.length, stops, dwell, names, limit });
        this.vehicles = [];
    }

    at(s) { return this.route.at(s); }

    // arc length from s ahead to stop k
    toStop(s, k) { return (this.stops[k] - s + this.len) % this.len; }

    // seconds round the line for a lone vehicle of `spec` (LineVehicle): from arriving at stop 0 to arriving there again
    tripTime(spec) {
        const v = new LineVehicle(this, spec), dt = 0.25;
        let t = 0, away = false;
        while (t < 4 * 3600) {
            v.step(dt);
            t += dt;
            if (v.stop !== 0) away = true;
            else if (away && v.mode === 'dwell') return t;
        }
        return t;
    }

    // `count` vehicles of `spec` from make(k), spread evenly round the trip: the first stands at stop 0 with its doors open,
    // each other leaves a headway (one trip over the fleet) after the one before, so it is that much further on (run here)
    fleet(count, spec, make) {
        const trip = this.tripTime(spec), dt = 0.25;
        for (let k = 0; k < count; k++) {
            const v = make(k);
            for (let t = (trip - k * trip / count) % trip; t > 1e-6; t -= dt) v.step(Math.min(dt, t));
            this.vehicles.push(v);
        }
        return this.vehicles;
    }

    // dt s on: each vehicle keeps clear of the one ahead round the loop
    update(dt) {
        for (const v of this.vehicles) {
            let gap = Infinity;
            for (const o of this.vehicles) if (o !== v) { const g = (o.s - v.s + this.len) % this.len; if (g > 0 && g < gap) gap = g; }
            v.step(dt, gap - v.spec.length);
        }
    }
}

// One vehicle on a TransitLine: where it is round the loop (s, m), its speed (v), its doors (0..1), and what it does:
// dwell at stop `stop` or drive to it. `spec`, all optional but what place() needs:
//   axleF, axleR     its axles, m along it from its origin, which runs over the route (place)
//   length           m bumper to bumper; gap: m it leaves to the vehicle ahead
//   accel            m/s^2 pulling away; brake: the deceleration it plans its stops with; maxDecel: the most it slows by
//                    (default: at once to what the plan allows)
//   stopMargin       m short of the stop it plans to be at rest (it then creeps on to it); arrive: within this it is there
//   doors            whether it has doors; doorTime: s to open or close, closing doorLead s before it leaves
//   cabin            its interior (kits.interior): { lo, hi, portals, shelter } in its own frame; its Origin is the
//                    vehicle's pose (`frame`, read live), so it moves with it at no cost. Add it to the world's
//                    InteriorIndex; place() re-buckets it there (O(1))
// Each step ends with moved(): by default place(), which poses it from its axles on the route: `model` (column-major,
// local -> world: x along the heading, pitched by the axles' heights, y up, z to its right) and `pose` { x, y, z, cs, sn,
// slope }. A vehicle that poses itself overrides moved() (and `frame`, the rigid local -> world matrix its interior uses).
class LineVehicle {
    constructor(line, spec) {
        this.line = line;
        this.spec = { gap: 6, accel: 1.1, brake: 1, maxDecel: Infinity, stopMargin: 0.02, arrive: 0.03, doors: true, doorTime: 1.5, doorLead: 3, ...spec };
        this.s = 0;
        this.v = 0;
        this.doors = this.spec.doors ? 1 : 0;
        this.mode = 'dwell';
        this.stop = 0;
        this.clock = line.dwell[0];
        this.braking = false;
        this.interior = this.spec.cabin ? new Interior({ owner: this, kind: 'vehicle', origin: () => this.frame, ...this.spec.cabin }) : null;
    }

    get frame() { return this.model; }

    get focus() { const p = this.pose; return [p.x, p.y, p.z]; }

    // pose from the axles on the path: heading from the rear axle to the front one, pitched by their heights
    place() {
        const K = this.spec, r = this.line.at(this.s + K.axleR), f = this.line.at(this.s + K.axleF);
        const dx = f[0] - r[0], dz = f[2] - r[2], l = Math.hypot(dx, dz) || 1, cs = dx / l, sn = dz / l, slope = (f[1] - r[1]) / l;
        const x = r[0] - cs * K.axleR, z = r[2] - sn * K.axleR, y = r[1] - slope * K.axleR;
        const cp = 1 / Math.hypot(1, slope), sp = slope * cp;
        this.model = [cs * cp, sp, sn * cp, 0, -cs * sp, cp, -sn * sp, 0, -sn, 0, cs, 0, x, y, z, 1];
        this.pose = { x, y, z, cs, sn, slope };
        this.interior?.moved();
    }

    toWorld(q, w = 1) { const m = this.model; return [0, 1, 2].map(r => m[r] * q[0] + m[4 + r] * q[1] + m[8 + r] * q[2] + m[12 + r] * w); }
    toLocal(p, w = 1) {
        const m = this.model, d = w ? [p[0] - m[12], p[1] - m[13], p[2] - m[14]] : p;
        return [0, 1, 2].map(c => m[c * 4] * d[0] + m[c * 4 + 1] * d[1] + m[c * 4 + 2] * d[2]);
    }
    // world to its frame, column-major (model is a rotation and a translation)
    get inverse() {
        const m = this.model, inv = new Array(16).fill(0), t = [m[12], m[13], m[14]];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) inv[c * 4 + r] = m[r * 4 + c];
            inv[12 + r] = -(m[r * 4] * t[0] + m[r * 4 + 1] * t[1] + m[r * 4 + 2] * t[2]);
        }
        inv[15] = 1;
        return inv;
    }
    // the fly-camera yaw (Common.yawPitch) that looks along it
    get yaw() { return Math.atan2(-this.pose.cs, -this.pose.sn); }

    // dt s on, with `room` m of clear road ahead of its front bumper (to the vehicle ahead), of which it leaves spec.gap
    step(dt, room = Infinity) {
        const L = this.line, K = this.spec;
        if (this.mode === 'dwell') {
            this.clock -= dt;
            if (this.clock <= 0 && this.doors <= 0) { this.mode = 'drive'; this.stop = (this.stop + 1) % L.stops.length; }
        } else {
            // up to the speed limit here, braking to stop at the next stop or behind the vehicle ahead, pulling away at
            // spec.accel
            // (standing on the stop it drives to, as a line with one stop does, it has the whole loop to go)
            const left = L.toStop(this.s, this.stop) || L.len, clear = Math.max(room - K.gap, 0);
            const vt = Math.min(L.limit(this.s), Math.sqrt(2 * K.brake * Math.max(left - K.stopMargin, 0)), Math.sqrt(2 * K.brake * clear));
            this.braking = vt < this.v - 0.05;
            this.v = vt >= this.v ? Math.min(vt, this.v + K.accel * dt) : K.maxDecel === Infinity ? vt : Math.max(vt, this.v - K.maxDecel * dt);
            const ds = Math.min(this.v * dt, left, clear);
            this.s = (this.s + ds) % L.len;
            if (left - ds < K.arrive) { this.s = L.stops[this.stop]; this.v = 0; this.mode = 'dwell'; this.clock = L.dwell[this.stop]; }
        }
        // the doors open once it stands, and close doorLead s before it leaves
        if (K.doors) {
            const open = this.mode === 'dwell' && this.clock > K.doorLead;
            this.doors = clamp(this.doors + (open ? dt : -dt) / K.doorTime, 0, 1);
        }
        this.moved();
    }

    moved() { this.place(); }

    // where it is: at a stop (its doors) or on the way to the next (how far, how fast)
    describe() {
        const L = this.line, name = L.names[this.stop] || `stop ${this.stop + 1}`;
        if (this.mode === 'dwell') return `at ${name} · ${this.clock > this.spec.doorLead ? `doors open, leaves in ${Math.ceil(this.clock)} s` : 'doors closing'}`;
        return `to ${name} · ${fmtKm(L.toStop(this.s, this.stop))} · ${(this.v * 3.6).toFixed(0)} km/h`;
    }
}

return { speedLimits, PolylineRoute, TransitLine, LineVehicle };
});
