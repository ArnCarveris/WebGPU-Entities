'use strict';
// Buses: the bus's dimensions, one bus (a LineVehicle with its body, lights and colliders) and the bus line entity.

Features.kit('transit', (engine, kit) => {
const { Common } = engine;
const { DEG, v3, lerp } = Common;
const { PALETTE } = engine.kits.mesh;
const { roundPath, offsetLine, speedLimits, TransitLine, PolylineRoute, LineVehicle } = kit;

// The bus (BusLine) in its own frame: x forward (the front at +hl), y up from the road, z to its right, where the doors are.
// The side windows fill `bays` bays of `bay` m from bay0, a pillar between each; the front door fills bay 7, the middle
// door bay 3. Its body, from the skirt to the roof, is the cabin: no rain, snow or volumetrics inside it (inCabin in WGSL)
const BUS = {
    hl: 6, hw: 1.27, floor: 0.36, ceil: 2.5, roof: 2.92, skirt: 0.3, winLo: 1.05, winHi: 2.25, bay0: -5.65, bay: 1.4125, bays: 8,
    pillar: 0.12, doorBays: [7, 3], axleF: 3.4, axleR: -3.1, wheel: 0.5, wall: 0.07,
};
// liveries of the buses at a bus station, and of a bus line's buses after its first (BusLine)
const BUS_LIVERIES = [[0.16, 0.36, 0.18], [0.70, 0.66, 0.58], [0.14, 0.30, 0.48], [0.62, 0.16, 0.12]];
// how it runs on its line (LineVehicle): its axles, and its length bumper to bumper
// its cabin (kits.interior), from the skirt to the roof: the windows down both sides, the glazed doors (seen through
// shut or open), the windscreen; no rain or snow inside
const BUS_SPEC = { axleF: BUS.axleF, axleR: BUS.axleR, length: 2 * BUS.hl, cabin: busCabin() };

function busCabin() {
    const K = BUS, y = (K.winLo + K.winHi) / 2, h = K.winHi - K.winLo, bx = k => K.bay0 + k * K.bay, portals = [];
    for (const sd of [-1, 1]) for (let k = 0; k < K.bays; k++) {
        const door = sd > 0 && K.doorBays.includes(k), x0 = bx(k) + K.pillar / 2, x1 = bx(k + 1) - K.pillar / 2;
        portals.push(door ? { c: [(x0 + x1) / 2, (K.floor + K.winHi) / 2, K.hw], n: [0, 0, 1], w: x1 - x0, h: K.winHi - K.floor, kind: 'opening' }
            : { c: [(x0 + x1) / 2, y, sd * K.hw], n: [0, 0, sd], w: x1 - x0, h, kind: 'window' });
    }
    portals.push({ c: [K.hl, 1.7, 0], n: [1, 0, 0], w: 2 * K.hw - 0.2, h: 1.5, kind: 'window' });
    return { lo: [-K.hl, K.skirt, -K.hw], hi: [K.hl, K.roof, K.hw], portals };
}

// m between the pairs of street lamps along a bus line's open road (a line's `lampStep`)
const ROAD_LAMP_STEP = 100;

// The bus types over a world's own entity base (Base: BusLine; Bus is a LineVehicle). A bus is drawn through its world's
// meshes (the common mesh interface, kits.mesh: two builders, its body (cuboid, quad, tri) and its glass (layer 'glass':
// kinds 'side' and 'screen'); materials { color, kind, inside (the cabin's inside), leaf (0 | 1: a door leaf sliding
// toward -x / +x as the doors open) }) and lit with its world's lamps ({ headlight, tail, cabin }: color, intensity,
// range, size, cone [inner, outer] degrees). A BusLine builds into the world's structures (build(S): S.ground, S.ribbon,
// S.strip, S.fixtures.lamp, S.boxes, S.interiors) and runs from a busStation (`from`: its frame, busWay, label,
// def.buses) to a village (`to`: its road, label); its world has get(id), buses (every bus, numbered by slot), busBoost.
function busTypes(Base) {
    const STRUCT_COLORS = PALETTE;

    // One bus on a BusLine: a vehicle of its line (kits.transit's LineVehicle: where it is round the loop, its speed, its
    // doors, dwelling at a stop or driving to the next) with the bus's body: its mesh, the moving shader box that keeps the
    // rain off and casts its shadow, its lights and its colliders.
    class Bus extends LineVehicle {
        constructor(line, label, livery, world) {
            super(line, BUS_SPEC);
            this.label = label;
            this.world = world;
            // mesh and glass in its own frame, colliders, seats; a moving shader box (rain shadow, sun shadow)
            this.mesh = livery ? buildBus(livery, world.meshes) : null;
            this.box = { x: 0, z: 0, hx: BUS.hl, hz: BUS.hw, cs: 1, sn: 0, y0: 0, y1: 1, ao: 0.35, slope: 0, base: 0, dyn: true };
            this.place();
        }

        get anchor() { const p = this.pose; return [p.x, p.y + 5, p.z]; }

        place() {
            super.place();
            const K = BUS, { x, y, z, cs, sn, slope } = this.pose;
            Object.assign(this.box, { x, z, cs, sn, slope, y0: y + K.skirt, y1: y + K.roof, base: y - 1 });
        }

        // a viewpoint on it (a view's `spot`), on foot: "seat" seated aboard (Walker.sit); else at the door: outside its front
        // door while it stands at a stop, aboard in the aisle while it drives
        board(app, spot) {
            const wk = app.walker, cam = app.camera;
            if (spot === 'seat') { wk.sit(app, this); wk.eye(app); return; }
            const doorX = BUS.bay0 + (BUS.doorBays[0] + 0.5) * BUS.bay;
            if (this.mode === 'dwell') {
                const p = this.toWorld([doorX, 0, BUS.hw + 1.2]);
                wk.place(app, p[0], p[2], p[1]);
                wk.eye(app);
                cam.lookAt(this.toWorld([doorX, 1.5, 0]));
            } else {
                wk.place(app, this.pose.x, this.pose.z);
                Object.assign(wk, { bus: this, seat: null, feet: [-1.0, BUS.floor, 0], busYaw: this.yaw });
                wk.eye(app);
                cam.yaw = this.yaw;
            }
            cam.pitch = 0;
        }

        // its lights by night, into `out` (LightWriter.write): the headlights, a beam each ahead and a little down; the tail
        // lights (one light for the two), brighter while it brakes; the cabin's lamps, out through its windows
        lights(out) {
            const L = this.world.lamps, K = BUS, on = (kind, q, d, k = 1) => {
                const l = L[kind];
                out.push({ pos: this.toWorld(q), dir: d ? v3.norm(this.toWorld(d, 0)) : [0, -1, 0], color: l.color, intensity: l.intensity * k, range: l.range, size: l.size,
                    cone: l.cone ? [Math.cos(l.cone[0] * DEG), Math.cos(l.cone[1] * DEG)] : null, cabin: kind === 'cabin' });
            };
            for (const sz of [-1, 1]) on('headlight', [K.hl + 0.15, 0.64, sz * 0.91], [1, -0.09, sz * 0.03]);
            on('tail', [-K.hl - 0.15, 0.8, 0], null, this.mode === 'drive' && this.braking ? 3 : 1);
            on('cabin', [0, K.ceil - 0.3, 0]);
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
    // what the bus is made of (kits.mesh material references: { color } is added to each), its glass's kinds (a side pane,
    // streaked by the wind of its speed; the windscreen and rear window), and the flags of its cabin's inside
    const MATTE = {}, PAINT = { kind: 'paint' }, METAL = { kind: 'metal' }, LAMP = { kind: 'lamp' }, IN = { inside: true };
    const IN_METAL = { kind: 'metal', inside: true }, IN_LAMP = { kind: 'lamp', inside: true }, SIDE = { kind: 'side' }, SCREEN = { kind: 'screen' };

    function buildBus(livery, meshes) {
        const K = BUS, B = meshes.builder(), G = meshes.builder({ layer: 'glass' });
        const { hl, hw, floor, ceil, roof, skirt, winLo, winHi, wall } = K;
        const box = (S, x0, x1, y0, y1, z0, z1, color, mat = MATTE) => S.cuboid([x0, y0, z0], [x1, y1, z1], { color, ...mat });
        const pane = (S, a, b, c, d, mat) => S.quad(a, b, c, d, { color: [0.5, 0.56, 0.58], ...mat });
        const dark = [0.05, 0.05, 0.06], white = [0.84, 0.84, 0.82], lining = [0.66, 0.68, 0.70], vinyl = [0.22, 0.23, 0.24];
        const fabric = [0.13, 0.17, 0.34], yellow = [0.85, 0.62, 0.10];
        const bx = k => K.bay0 + k * K.bay, door = k => K.doorBays.includes(k), axles = [K.axleF, K.axleR];
        const solids = [], doorSolids = [], S0 = (x0, x1, z0, z1, y0, y1, list = solids) => list.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cs: 1, sn: 0, y0, y1, slope: 0 });
        // chassis and floor, roof and ceiling with its lamps
        box(B, -hl, hl, skirt, floor - 0.02, -hw, hw, dark);
        box(B, -hl + wall, hl - wall, floor - 0.02, floor, -hw + wall, hw - wall, vinyl, IN);
        box(B, -hl, hl, ceil + 0.03, roof, -hw, hw, white, PAINT);
        box(B, -hl + wall, hl - wall, ceil, ceil + 0.03, -hw + wall, hw - wall, [0.80, 0.80, 0.78], IN);
        for (const sz of [-1, 1]) box(B, -hl + 0.6, hl - 1.9, ceil - 0.015, ceil, sz * 0.36, sz * 0.5, [1.0, 0.95, 0.85], IN_LAMP);
        box(B, -2.2, 1.2, roof, roof + 0.26, -0.8, 0.8, white, PAINT);                                       // air conditioning
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
                box(B, x0, x1, winLo, winHi, ...zo, dark, METAL);
                box(B, Math.max(x0, -hl + wall), Math.min(x1, hl - wall), winLo, winHi, ...zi, lining, IN);
            }
            for (let k = 0; k < K.bays; k++) {
                if (sd > 0 && door(k)) continue;
                const x0 = bx(k) + K.pillar / 2, x1 = bx(k + 1) - K.pillar / 2, z = sd * (hw - 0.035);
                pane(G, [x0, winLo, z], [x1, winLo, z], [x1, winHi, z], [x0, winHi, z], SIDE);
            }
            // the wall to walk into: all of it but the door openings
            let wx = -hl;
            for (const k of sd > 0 ? [...K.doorBays].sort((a, b) => a - b) : []) { S0(wx, bx(k) + K.pillar / 2, ...zw, 0, roof); wx = bx(k + 1) - K.pillar / 2; }
            S0(wx, hl, ...zw, 0, roof);
        }
        // doors: two glazed leaves per door bay that slide apart outside the body (leaf 0 toward -x, leaf 1 toward +x)
        for (const k of K.doorBays) {
            const x0 = bx(k) + K.pillar / 2, x1 = bx(k + 1) - K.pillar / 2, xm = (x0 + x1) / 2, z = hw - 0.02;
            for (const [a, b, tag] of [[x0, xm, 0], [xm, x1, 1]]) {
                box(B, a, b, floor - 0.05, floor + 0.35, z - 0.015, z + 0.015, dark, { kind: 'metal', leaf: tag });
                box(B, a, b, winHi - 0.06, winHi, z - 0.015, z + 0.015, dark, { kind: 'metal', leaf: tag });
                for (const e of [a, b - 0.05]) box(B, e, e + 0.05, floor + 0.35, winHi - 0.06, z - 0.015, z + 0.015, dark, { kind: 'metal', leaf: tag });
                pane(G, [a + 0.05, floor + 0.35, z], [b - 0.05, floor + 0.35, z], [b - 0.05, winHi - 0.06, z], [a + 0.05, winHi - 0.06, z], { kind: 'side', leaf: tag });
            }
            S0(x0 - 0.06, x1 + 0.06, hw - wall, hw, 0, roof, doorSolids);
            box(B, x0, x1, skirt, floor - 0.05, z - 0.03, z, dark);
        }
        // front: lower panel and bumper, windscreen between corner pillars, the destination display, headlights
        const fw = [0.95, 2.45];
        box(B, hl - 0.05, hl, skirt, fw[0], -hw, hw, livery);
        box(B, hl - wall, hl - 0.05, floor, fw[0], -hw + wall, hw - wall, dark, IN);
        box(B, hl, hl + 0.07, skirt, skirt + 0.25, -hw + 0.05, hw - 0.05, dark, METAL);
        for (const sz of [-1, 1]) box(B, hl - 0.1, hl, fw[0], fw[1], ...[sz * (hw - 0.1), sz * hw].sort((a, b) => a - b), dark, METAL);
        box(B, hl - 0.06, hl, fw[1], roof, -hw, hw, white);
        box(B, hl, hl + 0.01, fw[1] + 0.06, fw[1] + 0.36, -0.95, 0.95, [1.0, 0.55, 0.08], LAMP);
        for (const sz of [-1, 1]) box(B, hl, hl + 0.02, 0.55, 0.72, ...[sz * 0.72, sz * 1.1].sort((a, b) => a - b), [1.0, 0.97, 0.9], LAMP);
        pane(G, [hl - 0.03, fw[0], -hw + 0.1], [hl - 0.03, fw[0], hw - 0.1], [hl - 0.03, fw[1], hw - 0.1], [hl - 0.03, fw[1], -hw + 0.1], SCREEN);
        S0(hl - wall, hl, -hw, hw, 0, roof);
        // mirrors on arms
        for (const sz of [-1, 1]) { box(B, hl - 0.05, hl + 0.32, 2.3, 2.34, ...[sz * hw, sz * (hw + 0.12)].sort((a, b) => a - b), dark, METAL); box(B, hl + 0.26, hl + 0.32, 1.9, 2.32, ...[sz * (hw + 0.05), sz * (hw + 0.24)].sort((a, b) => a - b), dark, METAL); }
        // rear: panel round the rear window, tail lights
        const rw = [1.4, 2.3, 0.9];
        box(B, -hl, -hl + 0.05, skirt, rw[0], -hw, hw, livery);
        box(B, -hl, -hl + 0.05, rw[1], roof, -hw, hw, white);
        for (const sz of [-1, 1]) {
            const zz = [sz * rw[2], sz * hw].sort((a, b) => a - b);
            box(B, -hl, -hl + 0.05, rw[0], rw[1], ...zz, livery);
            box(B, -hl + 0.05, -hl + wall, rw[0], rw[1], ...[sz * rw[2], sz * (hw - wall)].sort((a, b) => a - b), lining, IN);
            box(B, -hl - 0.02, -hl, 0.6, 1.0, ...[sz * 0.95, sz * 1.18].sort((a, b) => a - b), [0.9, 0.06, 0.04], LAMP);
        }
        box(B, -hl + 0.05, -hl + wall, floor, rw[0], -hw + wall, hw - wall, lining, IN);
        box(B, -hl + 0.05, -hl + wall, rw[1], ceil, -hw + wall, hw - wall, lining, IN);
        pane(G, [-hl + 0.03, rw[0], -rw[2]], [-hl + 0.03, rw[0], rw[2]], [-hl + 0.03, rw[1], rw[2]], [-hl + 0.03, rw[1], -rw[2]], SCREEN);
        S0(-hl, -hl + wall, -hw, hw, 0, roof);
        // wheels (twelve-sided), and their arches inside
        for (const a of axles) for (const sz of [-1, 1]) {
            const zz = [sz * (hw - 0.32), sz * (hw - 0.03)], ring = k => { const t = k / 12 * 2 * Math.PI; return [a + Math.cos(t) * K.wheel, K.wheel + Math.sin(t) * K.wheel]; };
            for (let k = 0; k < 12; k++) {
                const p = ring(k), q = ring(k + 1);
                B.quad([p[0], p[1], zz[0]], [q[0], q[1], zz[0]], [q[0], q[1], zz[1]], [p[0], p[1], zz[1]], { color: [0.04, 0.04, 0.04] });
                for (const z of zz) B.tri([a, K.wheel, z], [p[0], p[1], z], [q[0], q[1], z], { color: z === zz[1] ? [0.45, 0.46, 0.47] : [0.04, 0.04, 0.04], ...METAL });
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
        box(B, hl - 0.85, hl - 0.75, 1.05, 1.1, -0.95, -0.5, dark, IN_METAL);
        box(B, hl - 1.4, hl - 1.1, floor + 0.55, floor + 1.15, -0.9, -0.55, [0.16, 0.22, 0.36], IN);
        box(B, hl - 1.33, hl - 1.13, floor + 1.18, floor + 1.42, -0.82, -0.63, [0.72, 0.55, 0.45], IN);
        box(B, hl - 1.1, hl - 0.75, floor + 0.85, floor + 0.95, -0.9, -0.82, [0.16, 0.22, 0.36], IN);
        box(B, hl - 1.1, hl - 0.75, floor + 0.85, floor + 0.95, -0.63, -0.55, [0.16, 0.22, 0.36], IN);
        box(B, hl - 1.95, hl - 1.85, floor, floor + 1.25, 0.55, 0.68, yellow, IN_METAL);                    // ticket validator
        S0(hl - 1.75, hl, -hw, -0.15, 0, 1.45);
        // seats facing forward in pairs either side of the aisle (none by the middle door: room to stand), raised over the
        // wheel arches, and a bench across the back; poles and rails to hold on to
        const seats = [], seat = (x, z, raise, name) => {
            const y = floor + 0.45 + raise;
            if (raise) box(B, x - 0.25, x + 0.22, floor, y - 0.1, z - 0.22, z + 0.22, lining, IN);
            box(B, x - 0.21, x + 0.21, y - 0.1, y, z - 0.21, z + 0.21, fabric, IN);
            box(B, x - 0.26, x - 0.19, y, y + 0.62, z - 0.21, z + 0.21, fabric, IN);
            if (!raise) box(B, x - 0.05, x + 0.05, floor, y - 0.1, z - 0.15, z + 0.15, [0.35, 0.36, 0.37], IN_METAL);
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
                if (row % 2) box(B, x - 0.32, x - 0.29, floor, ceil, sd * 0.3 - 0.015, sd * 0.3 + 0.015, yellow, IN_METAL);
            }
        }
        for (let k = -2; k <= 2; k++) seat(-hl + wall + 0.47, k * 0.47, 0.18, `back bench, seat ${k + 3}`);
        for (const sd of [-1, 1]) box(B, -hl + 1.2, hl - 2.0, floor + 1.86, floor + 1.89, sd * 0.32 - 0.015, sd * 0.32 + 0.015, yellow, IN_METAL);
        for (const x of [-1.9, 0.3]) box(B, x - 0.015, x + 0.015, floor, ceil, 0.6, 0.63, yellow, IN_METAL);
        return { v: B.finish(), glass: G.finish(), solids, doorSolids, seats };
    }

    // A bus line between a bus station (`from`) and a village's bus stop (`to`): its buses (Bus) drive one loop from the
    // station's platform, along a two-lane road (built here) to the village, through it to a turning loop past its far end,
    // and back; each stops by the village's shelter on the pass that has it on the right, and dwells at each stop (`dwell`
    // [station, village] s) with its doors open. Cruise at `speed` m/s, slower in the village (`village` m/s) and the station.
    // `fleet` buses (default: the station's `buses`, which then all run the line) leave the station at even intervals round
    // the trip, and none closes up to within a few metres of the one ahead. The first is `label` in `livery`, the others are
    // numbered after it in the station's liveries. A bus can be walked into (Walker): its floor, walls, seats and doors are
    // colliders in its frame. Viewpoint (`spot`): "seat" (seated aboard the first bus). The route, its stops and speed limits
    // are built here; running the buses round it is the line's (kits.transit's TransitLine, `line`).
    class BusLine extends Base {
        constructor(def, world) {
            super(def, world);
            this.buses = [];
            this.line = null;
        }

        // the buses carry the labels; a view that follows the line follows its first bus (or, with `each`, every bus)
        get anchor() { return null; }
        get focus() { return this.buses[0]?.focus ?? null; }
        get members() { return this.buses; }
        board(app, spot) { this.buses[0]?.board(app, spot); }

        build(S) {
            const d = this.def, st = this.world.get(d.from), vil = this.world.get(d.to);
            const W = st?.busWay, V = vil?.road;
            if (!W || !V) throw new Error('bus: `from` must be a busStation and `to` a village');
            const sf = (x, z) => st.frame.xz(x, z), P = s => [V.c[0] + V.dir[0] * s, V.c[1] + V.dir[1] * s];
            const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
            const lane = 1.75, head = sf(W.west, W.road);
            // into the village from the road end nearer the station, out past the other end
            const sig = dist(P(V.R), head) < dist(P(-V.R), head) ? 1 : -1;
            const E1 = P(sig * V.R), F2 = P(-sig * (V.R + 15));
            const CL = [sf(W.east, W.road), sf(W.gap, W.road), head, E1, F2];        // the two-lane road's centre line
            const out = offsetLine(CL, lane), back = offsetLine([F2, E1, head, sf(W.gap, W.road)], lane);
            const u = [(F2[0] - E1[0]) / dist(F2, E1), (F2[1] - E1[1]) / dist(F2, E1)], rt = [-u[1], u[0]];
            const T = (a, b) => [F2[0] + u[0] * a + rt[0] * b, F2[1] + u[1] * a + rt[1] * b];
            // a balloon loop past the village's far end: out to the right, round to the left, back in the other lane
            const turn = [T(14, 12), T(36, 11), T(44, -5), T(28, -17), T(10, -lane)];
            const C = (p, r = 12) => ({ p, r });
            const ctrl = [C(sf(W.stop, W.lane)), C(sf(W.east, W.lane), 11), ...out.map((p, k) => C(p, k === 3 ? 40 : 11)),
                ...turn.map(p => C(p, 9)), ...back.map((p, k) => C(p, k === 1 ? 40 : 11)), C(sf(W.gap, W.lane), 10)];
            const loop = roundPath(ctrl), path = loop.pts, step = loop.step, len = loop.length;
            // where each point is: 0 the station, 1 the open road, 2 the village, 3 the turning loop
            const sc = st.frame.c, zone = p => dist(p, sc) < 160 ? 0 : dist(p, V.c) < V.R + 20 ? 2 : dist(p, T(25, 0)) < 40 ? 3 : 1;
            const zones = path.map(zone);
            // road height: the bridge's deck in the village, else the terrain as drawn (the roads' lift)
            const height = (x, z) => {
                const rx = x - V.c[0], rz = z - V.c[1], s = rx * V.dir[0] + rz * V.dir[1], side = Math.abs(-rx * V.dir[1] + rz * V.dir[0]);
                if (V.deck && side < 4.5 && s > V.deck.a && s < V.deck.b) return V.deck.top((s - V.deck.a) / (V.deck.b - V.deck.a)) + 0.03;
                return S.ground(x, z) + 0.14;
            };
            const heights = path.map(p => height(...p));
            // the stops: the station's at s = 0; the village's where the front door is by the shelter
            const kerb = [P(V.stop.s)[0] + V.stop.out[0] * lane, P(V.stop.s)[1] + V.stop.out[1] * lane];
            let best = 0;
            path.forEach((p, i) => { if (dist(p, kerb) < dist(path[best], kerb)) best = i; });
            const doorX = BUS.bay0 + (BUS.doorBays[0] + 0.5) * BUS.bay;
            const stops = [0, (best * step - doorX + len) % len];
            // speed limits: cruising on the open road, slower in the village, at the station and round the loop, and through
            // bends (1.3 m/s^2 sideways); then braking (1 m/s^2) ahead of every slower stretch
            const cruise = d.speed ?? 22, slow = d.village ?? 10;
            const vmax = speedLimits(path, step, i => [6, cruise, slow, 6][zones[i]], { lateral: 1.3, brake: 1 });
            const route = new PolylineRoute({ path, heights, step, length: len });
            this.line = new TransitLine({ route, stops, dwell: d.dwell || [60, 30], limit: s => vmax[route.index(s)],
                names: [st?.label || 'station', vil?.label || 'village'] });
            // roads: the two-lane road to the village (dashed centre line), the station's one-way lanes and the turning loop
            const C2 = STRUCT_COLORS, road = roundPath([C(sf(W.east, W.road)), C(head, 11), C(E1, 40), C(P(sig * (V.R - 30)))], 4, false).pts;
            const roadPts = [];
            for (const p of road) { roadPts.push(p); if (dist(p, E1) < 3) break; }
            S.ribbon(roadPts, 3.6, C2.asphalt);
            // street lamps along the open road, a pair facing each other across it every `lampStep` m, their arms over it
            // (lights near the camera, distant sprites further: LightWriter.write, World.buildFarLights)
            for (let k = 0, step = d.lampStep ?? ROAD_LAMP_STEP, run = step / 2; k + 1 < roadPts.length; k++) {
                const a = roadPts[k], b = roadPts[k + 1], len = dist(a, b), t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
                for (; run < len; run += step) {
                    const c = [a[0] + t[0] * run, a[1] + t[1] * run];
                    if (dist(c, sc) < 200 || dist(c, V.c) < V.R + 40) continue;
                    for (const sd of [-1, 1]) {
                        const o = [-t[1] * sd, t[0] * sd];
                        S.fixtures.lamp(c[0] + o[0] * 4.8, c[1] + o[1] * 4.8, [-o[0], -o[1]], 'sodium', { light: { tag: 'road' } });
                    }
                }
                run -= len;
            }
            for (let k = 0; k + 1 < roadPts.length; k++) {
                const a = roadPts[k], b = roadPts[k + 1];
                if (k % 3 === 0 && dist(a, sc) > 150) S.strip(a, [lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75)], 0.08, C2.paint, 0, 0.17);
            }
            S.ribbon([P(-sig * (V.R - 2)), F2], 3.5, C2.asphalt);
            const lanes = [];
            let cur = null;
            path.forEach((p, i) => {
                const z = zones[i];
                if ((z === 0 || z === 3) && i % 3 === 0) { if (!cur) lanes.push(cur = []); cur.push(p); } else if (z !== 0 && z !== 3) cur = null;
            });
            for (const l of lanes) if (l.length > 1) S.ribbon(l, 3.1, C2.asphalt, 3, 0.15);
            // the buses: the first stands at the station's stop, its doors open, the others spread round the trip
            const fleet = Math.max(1, Math.round(d.fleet ?? st.def.buses ?? 1));
            const liveries = [d.livery || [0.12, 0.36, 0.62], ...BUS_LIVERIES];
            this.buses = this.line.fleet(fleet, BUS_SPEC, k => new Bus(this.line, k ? `${this.label} #${k + 1}` : this.label, liveries[k % liveries.length], this.world));
            for (const b of this.buses) { S.boxes.list.push(b.box); S.interiors.add(b.interior); }
            this.world.buses.push(...this.buses);
            this.world.buses.forEach((b, k) => { b.slot = k; });     // its slot in the renderer's bus uniforms
        }

        update(dt) { this.line.update(dt * (this.world.busBoost || 1)); }
    }

    return { Bus, BusLine };
}

return { BUS, BUS_LIVERIES, BUS_SPEC, ROAD_LAMP_STEP, busTypes };
});
