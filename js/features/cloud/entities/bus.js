'use strict';
// One bus: its motion along the route and its mesh.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3 } = Common;
const { BUS, BUS_IN, BUS_LEAF, fmtKm, GroundFrame, LAMPS, Structures } = feature;

// One bus on a BusLine: where it is round the loop (s, m), its speed, its doors (0..1), and what it does: dwell at a
// stop or drive to the next (`stop`: 0 the station, 1 the village). Its pose comes from its axles on the path.
class Bus {
    constructor(line, label, livery) {
        this.line = line;
        this.label = label;
        this.s = 0;
        this.v = 0;
        this.doors = 1;
        this.mode = 'dwell';
        this.stop = 0;                   // the stop it stands at or drives to: 0 the station, 1 the village
        this.clock = (line.def.dwell || [60, 30])[0];
        // mesh and glass in its own frame, colliders, seats; a moving shader box (rain shadow, sun shadow)
        this.mesh = livery ? buildBus(livery) : null;
        this.box = { x: 0, z: 0, hx: BUS.hl, hz: BUS.hw, cs: 1, sn: 0, y0: 0, y1: 1, ao: 0.35, slope: 0, base: 0, dyn: true };
        this.place();
    }

    get anchor() { const p = this.pose; return [p.x, p.y + 5, p.z]; }
    get focus() { const p = this.pose; return [p.x, p.y, p.z]; }

    // pose from the axles on the path: heading from the rear axle to the front one, pitched by their heights
    place() {
        const K = BUS, r = this.line.at(this.s + K.axleR), f = this.line.at(this.s + K.axleF);
        const dx = f[0] - r[0], dz = f[2] - r[2], l = Math.hypot(dx, dz) || 1, cs = dx / l, sn = dz / l, slope = (f[1] - r[1]) / l;
        const x = r[0] - cs * K.axleR, z = r[2] - sn * K.axleR, y = r[1] - slope * K.axleR;
        const cp = 1 / Math.hypot(1, slope), sp = slope * cp;
        // local -> world, column-major: x along the heading (pitched), y up, z to the right
        this.model = [cs * cp, sp, sn * cp, 0, -cs * sp, cp, -sn * sp, 0, -sn, 0, cs, 0, x, y, z, 1];
        this.pose = { x, y, z, cs, sn, slope };
        Object.assign(this.box, { x, z, cs, sn, slope, y0: y + K.skirt, y1: y + K.roof, base: y - 1 });
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
    // the FlyCamera yaw that looks along the bus
    get yaw() { return Math.atan2(-this.pose.cs, -this.pose.sn); }

    // dt s on, with `room` m of clear road ahead of its front bumper (to the next bus), of which it leaves 6 m
    step(dt, room = Infinity) {
        const L = this.line, dwell = L.def.dwell || [60, 30];
        if (this.mode === 'dwell') {
            this.clock -= dt;
            if (this.clock <= 0 && this.doors <= 0) { this.mode = 'drive'; this.stop = 1 - this.stop; }
        } else {
            // up to the speed limit here, braking to stop at the next stop or behind the bus ahead (1 m/s^2), pulling
            // away at 1.1 m/s^2
            const left = (L.stops[this.stop] - this.s + L.len) % L.len, clear = Math.max(room - 6, 0);
            const i = Math.floor(this.s / L.step) % L.path.length;
            const vt = Math.min(L.vmax[i], Math.sqrt(2 * Math.max(left - 0.02, 0)), Math.sqrt(2 * clear));
            this.braking = vt < this.v - 0.05;
            this.v = vt < this.v ? vt : Math.min(vt, this.v + 1.1 * dt);
            const ds = Math.min(this.v * dt, left, clear);
            this.s = (this.s + ds) % L.len;
            if (left - ds < 0.03) { this.s = L.stops[this.stop]; this.v = 0; this.mode = 'dwell'; this.clock = dwell[this.stop]; }
        }
        // the doors open once the bus stands, and close 3 s before it leaves (1.5 s each way)
        const open = this.mode === 'dwell' && this.clock > 3;
        this.doors = clamp(this.doors + (open ? dt : -dt) / 1.5, 0, 1);
        this.place();
    }

    // its lights by night, into `out` (LightWriter.write): the headlights, a beam each ahead and a little down; the tail
    // lights (one light for the two), brighter while it brakes; the cabin's lamps, out through its windows
    lights(out) {
        const L = LAMPS, K = BUS, on = (kind, q, d, k = 1) => {
            const l = L[kind];
            out.push({ pos: this.toWorld(q), dir: d ? v3.norm(this.toWorld(d, 0)) : [0, -1, 0], color: l.color, intensity: l.intensity * k, range: l.range, size: l.size,
                cone: l.cone ? [Math.cos(l.cone[0] * DEG), Math.cos(l.cone[1] * DEG)] : null, cabin: kind === 'cabin' });
        };
        for (const sz of [-1, 1]) on('headlight', [K.hl + 0.15, 0.64, sz * 0.91], [1, -0.09, sz * 0.03]);
        on('tail', [-K.hl - 0.15, 0.8, 0], null, this.mode === 'drive' && this.braking ? 3 : 1);
        on('cabin', [0, K.ceil - 0.3, 0]);
    }

    // where it is, for the HUD
    describe() {
        const L = this.line, names = [L.world.get(L.def.from)?.label || 'station', L.world.get(L.def.to)?.label || 'village'];
        if (this.mode === 'dwell') return `at ${names[this.stop]} · ${this.clock > 3 ? `doors open, leaves in ${Math.ceil(this.clock)} s` : 'doors closing'}`;
        const left = (L.stops[this.stop] - this.s + L.len) % L.len;
        return `to ${names[this.stop]} · ${fmtKm(left)} · ${(this.v * 3.6).toFixed(0)} km/h`;
    }

    // colliders in the bus's frame: the floor (walkable), walls, the driver's cab, wheel arches, seats, and the door leaves
    // while the doors are not open
    colliders() {
        const m = this.mesh;
        return this.doors > 0.85 ? m.solids : m.solids.concat(m.doorSolids);
    }
}

// the bus's mesh in its own frame (see BUS): opaque parts, glass (drawn see-through in the final pass), the solids a walker
// collides with, and the seats ({ x, z, y (cushion top), eye [x, y, z], name })
function buildBus(livery) {
    const K = BUS, f0 = new GroundFrame([0, 0], 0), B = new Structures(null), G = new Structures(null);
    const { hl, hw, floor, ceil, roof, skirt, winLo, winHi, wall } = K;
    const box = (S, x0, x1, y0, y1, z0, z1, col, mat = 0) => S.box(f0, (x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, y0, y1, col, mat);
    const pane = (S, a, b, c, d, mat) => S.quad(a, b, c, d, [0.5, 0.56, 0.58], mat);
    const dark = [0.05, 0.05, 0.06], white = [0.84, 0.84, 0.82], lining = [0.66, 0.68, 0.70], vinyl = [0.22, 0.23, 0.24];
    const fabric = [0.13, 0.17, 0.34], yellow = [0.85, 0.62, 0.10], IN = BUS_IN;
    const bx = k => K.bay0 + k * K.bay, door = k => K.doorBays.includes(k), axles = [K.axleF, K.axleR];
    const solids = [], doorSolids = [], S0 = (x0, x1, z0, z1, y0, y1, list = solids) => list.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cs: 1, sn: 0, y0, y1, slope: 0 });
    // chassis and floor, roof and ceiling with its lamps
    box(B, -hl, hl, skirt, floor - 0.02, -hw, hw, dark);
    box(B, -hl + wall, hl - wall, floor - 0.02, floor, -hw + wall, hw - wall, vinyl, IN);
    box(B, -hl, hl, ceil + 0.03, roof, -hw, hw, white, 1);
    box(B, -hl + wall, hl - wall, ceil, ceil + 0.03, -hw + wall, hw - wall, [0.80, 0.80, 0.78], IN);
    for (const sz of [-1, 1]) box(B, -hl + 0.6, hl - 1.9, ceil - 0.015, ceil, sz * 0.36, sz * 0.5, [1.0, 0.95, 0.85], 7 + IN);
    box(B, -2.2, 1.2, roof, roof + 0.26, -0.8, 0.8, white, 1);                                       // air conditioning
    S0(-hl, hl, -hw, hw, -0.5, floor);
    // sides: skin outside, lining inside; below the windows (open over the wheels and at the doors), above them, pillars
    for (const sd of [-1, 1]) {
        const zo = [sd * (hw - 0.035), sd * hw].sort((a, b) => a - b), zi = [sd * (hw - wall), sd * (hw - 0.035)].sort((a, b) => a - b);
        const zw = [sd * (hw - wall), sd * hw].sort((a, b) => a - b);
        let cuts = axles.map(a => [a - 0.62, a + 0.62]);
        if (sd > 0) cuts = cuts.concat(K.doorBays.map(k => [bx(k) + K.pillar / 2, bx(k + 1) - K.pillar / 2]));
        cuts.sort((a, b) => a[0] - b[0]);
        let x = -hl;
        for (const [a, b] of [...cuts, [hl, hl]]) {
            if (a > x) { box(B, x, a, skirt, winLo, ...zo, livery); box(B, x, a, floor, winLo, ...zi, lining, IN); }
            x = Math.max(x, b);
        }
        for (const a of axles) box(B, a - 0.62, a + 0.62, skirt + 0.75, winLo, ...zo, livery);       // over the wheel arches
        box(B, -hl, hl, winHi, ceil + 0.03, ...zo, white);
        box(B, -hl + wall, hl - wall, winHi, ceil, ...zi, lining, IN);
        for (let k = 0; k <= K.bays; k++) {
            const x0 = k === 0 ? -hl : bx(k) - K.pillar / 2, x1 = k === K.bays ? hl : bx(k) + K.pillar / 2;
            box(B, x0, x1, winLo, winHi, ...zo, dark, 4);
            box(B, Math.max(x0, -hl + wall), Math.min(x1, hl - wall), winLo, winHi, ...zi, lining, IN);
        }
        for (let k = 0; k < K.bays; k++) {
            if (sd > 0 && door(k)) continue;
            const x0 = bx(k) + K.pillar / 2, x1 = bx(k + 1) - K.pillar / 2, z = sd * (hw - 0.035);
            pane(G, [x0, winLo, z], [x1, winLo, z], [x1, winHi, z], [x0, winHi, z], 0);
        }
        // the wall to walk into: all of it but the door openings
        let wx = -hl;
        for (const k of sd > 0 ? [...K.doorBays].sort((a, b) => a - b) : []) { S0(wx, bx(k) + K.pillar / 2, ...zw, 0, roof); wx = bx(k + 1) - K.pillar / 2; }
        S0(wx, hl, ...zw, 0, roof);
    }
    // doors: two glazed leaves per door bay that slide apart outside the body (BUS_LEAF)
    for (const k of K.doorBays) {
        const x0 = bx(k) + K.pillar / 2, x1 = bx(k + 1) - K.pillar / 2, xm = (x0 + x1) / 2, z = hw - 0.02;
        for (const [a, b, tag] of [[x0, xm, BUS_LEAF[0]], [xm, x1, BUS_LEAF[1]]]) {
            box(B, a, b, floor - 0.05, floor + 0.35, z - 0.015, z + 0.015, dark, 4 + tag);
            box(B, a, b, winHi - 0.06, winHi, z - 0.015, z + 0.015, dark, 4 + tag);
            for (const e of [a, b - 0.05]) box(B, e, e + 0.05, floor + 0.35, winHi - 0.06, z - 0.015, z + 0.015, dark, 4 + tag);
            pane(G, [a + 0.05, floor + 0.35, z], [b - 0.05, floor + 0.35, z], [b - 0.05, winHi - 0.06, z], [a + 0.05, winHi - 0.06, z], tag);
        }
        S0(x0 - 0.06, x1 + 0.06, hw - wall, hw, 0, roof, doorSolids);
        box(B, x0, x1, skirt, floor - 0.05, z - 0.03, z, dark);
    }
    // front: lower panel and bumper, windscreen between corner pillars, the destination display, headlights
    const fw = [0.95, 2.45];
    box(B, hl - 0.05, hl, skirt, fw[0], -hw, hw, livery);
    box(B, hl - wall, hl - 0.05, floor, fw[0], -hw + wall, hw - wall, dark, IN);
    box(B, hl, hl + 0.07, skirt, skirt + 0.25, -hw + 0.05, hw - 0.05, dark, 4);
    for (const sz of [-1, 1]) box(B, hl - 0.1, hl, fw[0], fw[1], ...[sz * (hw - 0.1), sz * hw].sort((a, b) => a - b), dark, 4);
    box(B, hl - 0.06, hl, fw[1], roof, -hw, hw, white);
    box(B, hl, hl + 0.01, fw[1] + 0.06, fw[1] + 0.36, -0.95, 0.95, [1.0, 0.55, 0.08], 7);
    for (const sz of [-1, 1]) box(B, hl, hl + 0.02, 0.55, 0.72, ...[sz * 0.72, sz * 1.1].sort((a, b) => a - b), [1.0, 0.97, 0.9], 7);
    pane(G, [hl - 0.03, fw[0], -hw + 0.1], [hl - 0.03, fw[0], hw - 0.1], [hl - 0.03, fw[1], hw - 0.1], [hl - 0.03, fw[1], -hw + 0.1], 1);
    S0(hl - wall, hl, -hw, hw, 0, roof);
    // mirrors on arms
    for (const sz of [-1, 1]) { box(B, hl - 0.05, hl + 0.32, 2.3, 2.34, ...[sz * hw, sz * (hw + 0.12)].sort((a, b) => a - b), dark, 4); box(B, hl + 0.26, hl + 0.32, 1.9, 2.32, ...[sz * (hw + 0.05), sz * (hw + 0.24)].sort((a, b) => a - b), dark, 4); }
    // rear: panel round the rear window, tail lights
    const rw = [1.4, 2.3, 0.9];
    box(B, -hl, -hl + 0.05, skirt, rw[0], -hw, hw, livery);
    box(B, -hl, -hl + 0.05, rw[1], roof, -hw, hw, white);
    for (const sz of [-1, 1]) {
        const zz = [sz * rw[2], sz * hw].sort((a, b) => a - b);
        box(B, -hl, -hl + 0.05, rw[0], rw[1], ...zz, livery);
        box(B, -hl + 0.05, -hl + wall, rw[0], rw[1], ...[sz * rw[2], sz * (hw - wall)].sort((a, b) => a - b), lining, IN);
        box(B, -hl - 0.02, -hl, 0.6, 1.0, ...[sz * 0.95, sz * 1.18].sort((a, b) => a - b), [0.9, 0.06, 0.04], 7);
    }
    box(B, -hl + 0.05, -hl + wall, floor, rw[0], -hw + wall, hw - wall, lining, IN);
    box(B, -hl + 0.05, -hl + wall, rw[1], ceil, -hw + wall, hw - wall, lining, IN);
    pane(G, [-hl + 0.03, rw[0], -rw[2]], [-hl + 0.03, rw[0], rw[2]], [-hl + 0.03, rw[1], rw[2]], [-hl + 0.03, rw[1], -rw[2]], 1);
    S0(-hl, -hl + wall, -hw, hw, 0, roof);
    // wheels (twelve-sided), and their arches inside
    for (const a of axles) for (const sz of [-1, 1]) {
        const zz = [sz * (hw - 0.32), sz * (hw - 0.03)], ring = k => { const t = k / 12 * 2 * Math.PI; return [a + Math.cos(t) * K.wheel, K.wheel + Math.sin(t) * K.wheel]; };
        for (let k = 0; k < 12; k++) {
            const p = ring(k), q = ring(k + 1);
            B.quad([p[0], p[1], zz[0]], [q[0], q[1], zz[0]], [q[0], q[1], zz[1]], [p[0], p[1], zz[1]], [0.04, 0.04, 0.04]);
            for (const z of zz) B.tri([a, K.wheel, z], [p[0], p[1], z], [q[0], q[1], z], z === zz[1] ? [0.45, 0.46, 0.47] : [0.04, 0.04, 0.04], 4);
        }
        const zi = [sz * (hw - 0.55), sz * (hw - wall)].sort((p, q) => p - q);
        box(B, a - 0.65, a + 0.65, floor, 1.05, ...zi, [0.30, 0.31, 0.32], IN);
        S0(a - 0.65, a + 0.65, ...zi, 0, 1.05);
    }
    // driver's cab: partition, dashboard, seat, steering wheel, the driver
    const dz = [-hw + wall, -0.2];
    box(B, hl - 1.75, hl - 1.7, floor, 1.45, ...dz, lining, IN);
    box(B, hl - 0.65, hl - wall, floor, 1.0, -hw + wall, -0.1, [0.10, 0.10, 0.11], IN);
    box(B, hl - 1.45, hl - 1.0, floor, floor + 0.5, -0.95, -0.5, dark, IN);
    box(B, hl - 1.5, hl - 1.42, floor + 0.5, floor + 1.25, -0.95, -0.5, dark, IN);
    box(B, hl - 0.85, hl - 0.75, 1.05, 1.1, -0.95, -0.5, dark, 4 + IN);
    box(B, hl - 1.4, hl - 1.1, floor + 0.55, floor + 1.15, -0.9, -0.55, [0.16, 0.22, 0.36], IN);
    box(B, hl - 1.33, hl - 1.13, floor + 1.18, floor + 1.42, -0.82, -0.63, [0.72, 0.55, 0.45], IN);
    box(B, hl - 1.1, hl - 0.75, floor + 0.85, floor + 0.95, -0.9, -0.82, [0.16, 0.22, 0.36], IN);
    box(B, hl - 1.1, hl - 0.75, floor + 0.85, floor + 0.95, -0.63, -0.55, [0.16, 0.22, 0.36], IN);
    box(B, hl - 1.95, hl - 1.85, floor, floor + 1.25, 0.55, 0.68, yellow, 4 + IN);                    // ticket validator
    S0(hl - 1.75, hl, -hw, -0.15, 0, 1.45);
    // seats facing forward in pairs either side of the aisle (none by the middle door: room to stand), raised over the
    // wheel arches, and a bench across the back; poles and rails to hold on to
    const seats = [], seat = (x, z, raise, name) => {
        const y = floor + 0.45 + raise;
        if (raise) box(B, x - 0.25, x + 0.22, floor, y - 0.1, z - 0.22, z + 0.22, lining, IN);
        box(B, x - 0.21, x + 0.21, y - 0.1, y, z - 0.21, z + 0.21, fabric, IN);
        box(B, x - 0.26, x - 0.19, y, y + 0.62, z - 0.21, z + 0.21, fabric, IN);
        if (!raise) box(B, x - 0.05, x + 0.05, floor, y - 0.1, z - 0.15, z + 0.15, [0.35, 0.36, 0.37], 4 + IN);
        S0(x - 0.26, x + 0.22, z - 0.22, z + 0.22, 0, y + 0.62);
        seats.push({ x, z, y, eye: [x + 0.02, y + 0.78, z * 0.8], name });            // the head a little in from the window
    };
    let row = 0;
    for (let x = 3.6; x > -4.9; x -= 0.8) {
        row++;
        const raise = axles.some(a => Math.abs(x - a) < 0.7) ? 0.35 : 0;
        for (const sd of [-1, 1]) {
            if (sd > 0 && x > -2.1 && x < 0.5) continue;
            const side = sd < 0 ? 'left' : 'right';
            seat(x, sd * (hw - wall - 0.24), raise, `window seat, row ${row} ${side}`);
            seat(x, sd * (hw - wall - 0.69), raise, `aisle seat, row ${row} ${side}`);
            if (row % 2) box(B, x - 0.32, x - 0.29, floor, ceil, sd * 0.3 - 0.015, sd * 0.3 + 0.015, yellow, 4 + IN);
        }
    }
    for (let k = -2; k <= 2; k++) seat(-hl + wall + 0.47, k * 0.47, 0.18, `back bench, seat ${k + 3}`);
    for (const sd of [-1, 1]) box(B, -hl + 1.2, hl - 2.0, floor + 1.86, floor + 1.89, sd * 0.32 - 0.015, sd * 0.32 + 0.015, yellow, 4 + IN);
    for (const x of [-1.9, 0.3]) box(B, x - 0.015, x + 0.015, floor, ceil, 0.6, 0.63, yellow, 4 + IN);
    return { v: B.v, glass: G.v, solids, doorSolids, seats };
}

return { Bus };
});
