'use strict';
// Lifts: cars in buildings' cores (Elevator), each in its shaft (the building kit's coreLayout: the car's run, the
// technical space beside it with the counterweight), its landing doors, what a walker collides with and rides in, the
// car as an area of its own (aboard it: its own light and air), and its panels: a keypad in the car, a call panel beside
// each of its landing doors.

Features.kit('transit', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, v3 } = Common;
const { Elevator } = kit;
const { EntityGUI, col } = kits.gui;
const { Origin } = kits.interior;

// Lifts: how near (m) a panel can be used, the cars and landing doors are drawn, a landing panel shows; the car's
// walls; how long a forced landing door stays open (s); colours, the car lamp's
const LIFT = {
    reach: 1.8, draw: 120, landingDraw: 60, panelRange: 16, wall: 0.05, forced: 12,
    colors: { car: [0.62, 0.60, 0.56], trim: [0.78, 0.74, 0.62], floor: [0.22, 0.20, 0.19], door: [0.66, 0.67, 0.68], frame: [0.30, 0.31, 0.32],
        weight: [0.20, 0.21, 0.23], roof: [0.34, 0.35, 0.36], lamp: [1.0, 0.96, 0.88] },
};
const BOX_FLOATS = 12;               // a box instance (Lifts.instances): [centre, yaw] [half sizes, material] [colour, -]
const UI = { ink: [4, 14, 20], cyan: [110, 220, 255], amber: [255, 196, 90], white: [236, 244, 250], dim: [96, 128, 140], green: [96, 240, 150], red: [255, 96, 80] };

// a surface matrix (the gui kit's: columns right, up, normal toward the viewer, position) for a panel at world p facing
// the world direction n
function facing(p, n) {
    const up = [0, 1, 0], r = v3.norm(v3.cross(up, n));
    return new Float32Array([r[0], r[1], r[2], 0, 0, 1, 0, 0, n[0], n[1], n[2], 0, p[0], p[1], p[2], 1]);
}

// a direction arrow centred at x, y (r: its half size): up, down, or a dot for idle
function arrow(dc, x, y, r, dir, c) {
    if (!dir) { dc.fillRect(x - r * 0.25, y - r * 0.25, r * 0.5, r * 0.5, col(c)); return; }
    dc.polygon(dir > 0 ? [[x, y - r], [x + r, y + r * 0.7], [x - r, y + r * 0.7]] : [[x, y + r], [x - r, y - r * 0.7], [x + r, y - r * 0.7]], col(c));
}

function button(gui, dc, id, x, y, w, h, label, { lit = false, color = UI.cyan, size = 16 } = {}) {
    gui.addButton(id, x, y, w, h);
    const hover = gui.isHover(id), on = lit || gui.isPressed(id);
    dc.fillRect(x, y, w, h, col(color, on ? 0.85 : hover ? 0.28 : 0.1));
    dc.rect(x, y, w, h, hover ? 2 : 1, col(color, hover ? 1 : 0.6));
    dc.text(label, x + w / 2, y + h / 2 + size * 0.36, size, col(on ? UI.ink : UI.white), 'center', !on);
}

// The panel in a car: where it is and how fast; the destination as digits (tap one, pick its value on the keypad that
// opens, GO), door open / close. The car's stops are storey numbers (stop.g): any number it does not stop at says so
class CarPanel extends EntityGUI {
    constructor(car) {
        super({ id: `lift-${car.slot}`, size: [0.30, 0.52], virtual: [300, 520], range: car.L.reach, hintRange: car.L.reach * 2.5, maxVerts: 12000 });
        this.car = car;
        const maxG = Math.max(...car.stops.map(s => s.g ?? 0));
        this.digitCount = Math.max(1, String(maxG).length);       // (not `width`: the EntityGUI's, in metres)
        this.digits = null;              // the number being entered, as characters
        this.sel = -1;                   // the digit the keypad is open for
        this.msg = null;                 // { text, color, until }
    }

    // the number of the storey the car is at or passing, padded to the panel's digits
    here() { return String(this.car.floorNumber()).padStart(this.digitCount, '0').slice(-this.digitCount).split(''); }

    draw(dc, now) {
        const c = this.car, el = c.el, W = this.vw, Hh = this.vh, A = UI.cyan;
        this.now = now;
        if (this.digits?.length !== this.digitCount) this.digits = this.here();
        dc.fillRect(0, 0, W, Hh, col([6, 16, 22], 0.98));
        dc.rect(1, 1, W - 2, Hh - 2, 2, col(A, 0.5));
        // the display: the storey it is at or passing, which way, how high and how fast
        dc.fillRect(10, 10, W - 20, 84, col([0, 0, 0], 0.9));
        arrow(dc, 30, 52, 14, el.dir, el.halted ? UI.red : el.dir ? UI.amber : UI.dim);
        const here = c.floor();
        dc.text(here, W / 2 + 10, 64, here.length > 4 ? 28 : 40, col(el.halted ? UI.red : UI.amber), 'center');
        dc.text(el.halted ? 'STOPPED · SAFETY' : `${Math.round(el.y)} m`, W - 18, 28, 11, col(el.halted ? UI.red : UI.dim), 'right', false);
        dc.text(`${Math.abs(el.v).toFixed(el.v ? 1 : 0)} m/s`, W - 18, 86, 11, col(UI.dim), 'right', false);
        dc.text(c.name.toUpperCase(), 18, 26, 10, col(A, 0.8), 'left', false);
        // the destination: a slot per digit
        const n = this.digitCount, sw = Math.min(54, (W - 40 - (n - 1) * 8) / n), x0 = (W - (n * sw + (n - 1) * 8)) / 2, y0 = 108;
        dc.text('DESTINATION', W / 2, y0 - 2, 10, col(UI.dim), 'center', false);
        for (let i = 0; i < n; i++) button(this, dc, `digit:${i}`, x0 + i * (sw + 8), y0 + 6, sw, 52, this.digits[i], { lit: this.sel === i, color: UI.amber, size: 30 });
        const ky = y0 + 72;
        if (this.sel >= 0) {
            // the keypad for the selected digit
            const kw = 72, kh = 46, kx = (W - 3 * kw - 2 * 8) / 2;
            const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '×', '0', '·'];
            keys.forEach((k, i) => {
                if (k === '·') return;
                const r = Math.floor(i / 3), q = i % 3;
                button(this, dc, k === '×' ? 'keypad:close' : `key:${k}`, kx + q * (kw + 8), ky + r * (kh + 7), kw, kh, k, { size: 22 });
            });
        } else {
            dc.text('TAP A DIGIT TO CHANGE IT', W / 2, ky + 18, 11, col(UI.dim), 'center', false);
            // what it serves: its stops' labels, the first and last few
            const names = c.stops.map(s => s.name), list = names.length <= 8 ? names.join(' ') : `${names.slice(0, 3).join(' ')} … ${names.slice(-3).join(' ')}`;
            dc.text('SERVES', W / 2, ky + 52, 10, col(A, 0.7), 'center', false);
            dc.text(list, W / 2, ky + 72, 12, col(UI.white, 0.85), 'center', false);
            const calls = [...el.calls].map(i => c.stops[i].name);
            dc.text(calls.length ? `CALLED  ${calls.slice(0, 5).join(' ')}${calls.length > 5 ? ' …' : ''}` : '', W / 2, ky + 104, 11, col(UI.amber, 0.9), 'center', false);
            const want = +this.digits.join(''), i = c.stopIndex(want);
            button(this, dc, 'go', 20, ky + 130, W - 40, 50, i >= 0 ? `GO → ${c.stops[i].name}` : 'GO', { lit: i >= 0 && el.calls.has(i), color: UI.green, size: 20 });
        }
        if (this.msg && now < this.msg.until) dc.text(this.msg.text, W / 2, Hh - 64, 13, col(this.msg.color), 'center');
        button(this, dc, 'open', 14, Hh - 50, (W - 34) / 2, 38, '‹ › OPEN', { size: 14 });
        button(this, dc, 'close', 20 + (W - 34) / 2, Hh - 50, (W - 34) / 2, 38, '› ‹ CLOSE', { size: 14 });
    }

    drawRangeHint(dc) { dc.text('CLOSER', this.vw / 2, this.vh - 70, 14, col(UI.amber), 'center'); }

    say(text, color = UI.amber) { this.msg = { text, color, until: (this.now ?? 0) + 2500 }; }

    onPress(b) {
        if (!b) return;
        const c = this.car, el = c.el, id = b.id;
        this.game.audio.emit('liftButton', { id });
        if (id.startsWith('digit:')) { const i = +id.slice(6); this.sel = this.sel === i ? -1 : i; }
        else if (id.startsWith('key:')) { this.digits[this.sel] = id.slice(4); this.sel = -1; }
        else if (id === 'keypad:close') this.sel = -1;
        else if (id === 'go') {
            const want = +this.digits.join(''), i = c.stopIndex(want);
            if (i < 0) this.say(`NO STOP AT ${want}`, UI.red);
            else if (el.halted) this.say('SAFETY CIRCUIT OPEN', UI.red);
            else {
                el.call(i);
                if (el.at !== i) el.wait = Math.min(el.wait, 1.5);          // (a destination chosen: the doors shut soon)
                this.say(el.at === i ? 'HERE' : `TO ${c.stops[i].name}`, UI.green);
            }
        } else if (id === 'open') el.open();
        else if (id === 'close') el.close();
    }
}

// The call panel beside a car's landing door (shown at the storey the camera is on, where the car stops): where the car
// is and which way it goes, the call button
class LandingPanel extends EntityGUI {
    constructor(car) {
        super({ id: `landing-${car.slot}`, size: [0.20, 0.32], virtual: [200, 320], range: car.L.reach, hintRange: car.L.reach * 2.5, maxVerts: 5000 });
        this.car = car;
        this.stop = -1;                  // the stop it stands at now
    }

    draw(dc) {
        const c = this.car, el = c.el, W = this.vw, A = UI.cyan, i = this.stop;
        dc.fillRect(0, 0, W, this.vh, col([6, 16, 22], 0.98));
        dc.rect(1, 1, W - 2, this.vh - 2, 2, col(A, 0.5));
        dc.text(c.name.toUpperCase(), W / 2, 22, 11, col(A, 0.85), 'center', false);
        dc.text(i >= 0 ? `FLOOR ${c.stops[i].name}` : '', W / 2, 44, 13, col(UI.dim), 'center', false);
        dc.fillRect(14, 58, W - 28, 74, col([0, 0, 0], 0.85));
        arrow(dc, 34, 95, 11, el.dir, el.halted ? UI.red : el.dir ? UI.amber : UI.dim);
        const f = c.floor();
        dc.text(f, W / 2 + 12, 108, f.length > 4 ? 22 : 30, col(el.halted ? UI.red : UI.amber), 'center');
        const here = el.at === i && el.door > 0, called = el.calls.has(i);
        dc.text(el.halted ? 'STOPPED' : here ? 'HERE' : called ? 'COMING' : '', W / 2, 160, 13, col(el.halted ? UI.red : UI.green), 'center', false);
        button(this, dc, 'call', 34, this.vh - 120, W - 68, 84, called ? 'CALLED' : 'CALL', { lit: called, color: UI.amber, size: 20 });
    }

    drawRangeHint(dc) { dc.text('CLOSER', this.vw / 2, this.vh - 140, 12, col(UI.amber), 'center'); }

    onPress(b) {
        if (b?.id !== 'call' || this.stop < 0) return;
        this.game.audio.emit('liftButton', { id: 'call' });
        this.car.el.call(this.stop);
    }
}

// The lifts of a world's buildings. A car (add) runs in a shaft of a building's core (shaft: the building kit's
// coreLayout shaft: its car's rect, front, door, the technical space; local to frame f, the building's ground frame,
// Common.GroundFrame), stops [{ y, name, building (its Origin at height building.floor), g (its storey's number) }],
// motion { speed, accel, door, dwell }. options: spec (LIFT's keys overridden), material(building, mat, lit): a
// part's material code in the world's renderer (mat 0 matte, 4 metal, 7 lamp; lit: a car's own, lit by its lamp)
class Lifts {
    constructor({ spec = {}, material = (b, mat) => mat } = {}) {
        this.L = { ...LIFT, ...spec, colors: { ...LIFT.colors, ...spec.colors } };
        this.material = material;
        this.cars = [];
        this.groups = new Map();
        this.shafts = new Map();
        this.forced = new Map();         // `${shaft key}@${stop height}` -> { s left, key, y, car }
        this.occupied = new Map();       // shaft key -> s left: someone is in it (its ladder, a car's roof, its pit)
    }

    add({ f, shaft, kind = 'local', group, name, motion = {}, stops, owner = null }) {
        const L = this.L, sh = shaft;
        const el = new Elevator({ stops: stops.map(s => s.y), names: stops.map(s => s.name), ...motion });
        const car = {
            slot: this.cars.length, f, shaft: sh, kind, name, stops, el, L, owner, sx: sh.sx,
            out: sh.car.rect.slice(), front: sh.car.front, wall: sh.wall, zc: sh.door.c, dw: sh.door.w, dh: sh.door.h, h: sh.car.h,
            key: Lifts.shaftKey(f, sh.rect), poseStamp: 0, lastY: el.y,
        };
        // its frame: the building's, at the height of its floor (what rides it, its area and door portal, are in it)
        let My = NaN, M = null;
        car.matrix = () => {
            if (el.y !== My) { My = el.y; M = [f.cs, 0, f.sn, 0, 0, 1, 0, 0, -f.sn, 0, f.cs, 0, f.c[0], el.y, f.c[1], 1]; }
            return M;
        };
        Object.defineProperty(car, 'M', { get: car.matrix });
        car.origin = new Origin(car.matrix);
        car.toLocal = p => car.origin.toLocal(p);
        car.toWorld = (q, w = 1) => car.origin.toWorld(q, w);
        // the floor it is at or passing: a stop's name there, else the storey's number between them
        car.floorNumber = () => {
            if (el.at >= 0) return stops[el.at].g ?? el.at;
            let i = 0;
            while (i + 1 < stops.length && stops[i + 1].y <= el.y) i++;
            const j = Math.min(i + 1, stops.length - 1), k = stops[j].y > stops[i].y ? (el.y - stops[i].y) / (stops[j].y - stops[i].y) : 0;
            return Math.round((stops[i].g ?? i) + k * ((stops[j].g ?? j) - (stops[i].g ?? i)));
        };
        car.floor = () => {
            const g = car.floorNumber(), s = stops.find(st => (st.g ?? -1) === g);
            return s ? s.name : String(g);
        };
        car.stopIndex = g => stops.findIndex(s => (s.g ?? -1) === g);
        car.panel = new CarPanel(car);
        car.landing = new LandingPanel(car);
        const gk = group || name;
        if (!this.groups.has(gk)) this.groups.set(gk, { name: gk, cars: [] });
        this.groups.get(gk).cars.push(car);
        car.group = this.groups.get(gk);
        this.cars.push(car);
        if (!this.shafts.has(car.key)) this.shafts.set(car.key, []);
        this.shafts.get(car.key).push(car);
        return car;
    }

    static shaftKey(f, rect) { return `${f.c[0]},${f.c[1]},${rect.join(',')}`; }

    // The car as an area of AreaSet A aboard it (A.vehicles: its frame moves with it; areaAt finds it before the shaft
    // it runs in), with its own light and air (fog), and its door a portal onto its shaft's area (car.shaftArea), open as
    // far as the doors are
    carArea(car, A) {
        const w = this.L.wall, [x0, x1, z0, z1] = car.out, h = car.h;
        const a = A.addArea({ shape: [[x0 + w, z0 + w], [x1 - w, z0 + w], [x1 - w, z1 - w], [x0 + w, z1 - w]], y: 0, height: h, shelter: true,
            ambient: [0.05, 0.05, 0.05], fog: [0, 0, 0, 0] });
        a.vehicle = car;
        a.room = { car };
        a.light = { color: this.L.colors.lamp, pos: [(x0 + x1) / 2, h - 0.05, (z0 + z1) / 2] };
        car.area = a.index;
        (A.vehicles ||= []).push(car);
        const P = A.addPortal({ center: [car.front, car.dh / 2, car.zc], size: [car.dw, car.dh], normal: [car.sx, 0, 0], front: a.index, back: car.shaftArea, kind: 'door' });
        P.attach(car);
        car.doorPortal = P;
        return a;
    }

    // the cars of the shaft rect (in frame f)
    shaftCars(f, rect) { return this.shafts.get(Lifts.shaftKey(f, rect)) || []; }

    // is the landing door at height y of the shaft with key `key` open (a car of it standing there with its doors open,
    // or forced): the portal from the lift lobby into the shaft's area
    landingOpen(key, y) {
        if (this.forced.has(Lifts.forcedKey(key, y))) return true;
        for (const c of this.shafts.get(key) || []) {
            const el = c.el;
            if (el.at >= 0 && el.door > 0.02 && Math.abs(el.stops[el.at] - y) < 0.5) return true;
        }
        return false;
    }

    static forcedKey(key, y) { return `${key}@${y.toFixed(1)}`; }

    // how far landing door i of car c stands open (0 shut .. 1): its car there with its doors open, or forced
    landingDoor(c, i) {
        if (this.forced.has(Lifts.forcedKey(c.key, c.el.stops[i]))) return 1;
        return c.el.at === i ? c.el.door : 0;
    }

    // The emergency release: landing door i of car c forced open (for L.forced s, while anyone is in its doorway the
    // world keeps it so): every car of its shaft halts until it shuts again
    force(c, i, s = this.L.forced) {
        const k = Lifts.forcedKey(c.key, c.el.stops[i]);
        this.forced.set(k, { s, key: c.key, y: c.el.stops[i], car: c, i });
        return k;
    }

    // keeps landing door (key) forced a while longer (someone in its doorway, on the ladder by it)
    holdForced(key, y, s = 2) { const F = this.forced.get(Lifts.forcedKey(key, y)); if (F) F.s = Math.max(F.s, s); }

    // someone is in shaft `key` (out of its cars): they stay halted s seconds more
    occupy(key, s = 0.5) { this.occupied.set(key, Math.max(this.occupied.get(key) ?? 0, s)); }

    update(dt, boost = 1) {
        const halt = new Set();
        for (const [k, F] of this.forced) {
            F.s -= dt;
            if (F.s <= 0) this.forced.delete(k);
            else halt.add(F.key);
        }
        for (const [k, s] of this.occupied) {
            if (s - dt <= 0) this.occupied.delete(k);
            else { this.occupied.set(k, s - dt); halt.add(k); }
        }
        for (const c of this.cars) {
            c.el.boost = boost;
            c.el.halted = halt.has(c.key);
            c.el.update(dt);
            if (c.el.y !== c.lastY) { c.lastY = c.el.y; c.poseStamp++; }
        }
    }

    // building-local x, z of world p in car c's frame
    static local(c, p) {
        const dx = p[0] - c.f.c[0], dz = p[2] - c.f.c[1];
        return [dx * c.f.cs + dz * c.f.sn, -dx * c.f.sn + dz * c.f.cs];
    }

    // the building whose storey the car's floor is at now (its car is lit, and drawn, as that building's)
    static building(c) { return c.stops[c.el.nearest(c.el.y)].building; }

    // the car whose inside holds world p (feet), or null: what a walker rides
    carAt(p, below = 0.6) {
        for (const c of this.near(p, 4)) {
            const [x, z] = Lifts.local(c, p), y = c.el.y, w = this.L.wall;
            if (x > c.out[0] + w && x < c.out[1] - w && z > c.out[2] + w && z < c.out[3] - w && p[1] > y - below && p[1] < y + c.h) return c;
        }
        return null;
    }

    // the car whose roof world p stands on (within a step), or null: riding on top in the shaft
    roofAt(p) {
        for (const c of this.near(p, 4)) {
            const [x, z] = Lifts.local(c, p), top = c.el.y + c.h + 0.12;
            if (x > c.out[0] && x < c.out[1] && z > c.out[2] && z < c.out[3] && Math.abs(p[1] - top) < 0.6) return c;
        }
        return null;
    }

    // the cars whose shafts lie within r m (horizontally) of p, and that reach its height
    near(p, r) {
        const out = [];
        for (const c of this.cars) {
            const [x, z] = Lifts.local(c, p);
            if (x < c.out[0] - r || x > c.out[1] + r || z < c.out[2] - r || z > c.out[3] + r) continue;
            if (p[1] < c.el.stops[0] - 8 || p[1] > c.el.stops[c.el.stops.length - 1] + 8) continue;
            out.push(c);
        }
        return out;
    }

    // The boxes of car c (its floor, walls, roof, doors, handrail, lamp, panel plate, its sill to the landing), its
    // counterweight, and its landing doors near height y (within L.landingDraw; `all` false: within 3 m; and those
    // within `range` [y0, y1]: the stretch of its shaft in view, seen from end to end): [local x0, x1, z0, z1, y0, y1,
    // colour, material, solid, building]
    parts(c, y, all = true, car = true, range = null) {
        const L = this.L, K = L.colors, el = c.el, cy = el.y, h = c.h, w = L.wall, sx = c.sx, dw = c.dw, dh = c.dh;
        const [ox0, ox1, oz0, oz1] = c.out, zc = c.zc, F = c.front, out = [];
        const xs = (a, b) => [Math.min(a, b), Math.max(a, b)];
        const lb = Lifts.building(c), lit = mat => this.material(lb, mat, true), m4 = this.material(lb, 4, false);
        if (car && (Math.abs(y - cy) < 14 || all)) {
            out.push([ox0, ox1, oz0, oz1, cy - 0.15, cy, K.floor, lit(0), true, lb]);
            out.push([...xs(F, c.wall - sx * 0.06), zc - dw / 2, zc + dw / 2, cy - 0.06, cy, K.frame, lit(4), true, lb]);     // its sill, to the landing's
            out.push([ox0, ox1, oz0, oz1, cy + h, cy + h + 0.12, K.roof, lit(0), true, lb]);
            const back = sx > 0 ? ox0 : ox1;
            out.push([...xs(back, back + sx * w), oz0, oz1, cy, cy + h, K.car, lit(0), true, lb]);
            out.push([ox0, ox1, oz0, oz0 + w, cy, cy + h, K.car, lit(0), true, lb]);
            out.push([ox0, ox1, oz1 - w, oz1, cy, cy + h, K.car, lit(0), true, lb]);
            out.push([...xs(F, F - sx * w), oz0, zc - dw / 2, cy, cy + h, K.trim, lit(4), true, lb]);
            out.push([...xs(F, F - sx * w), zc + dw / 2, oz1, cy, cy + h, K.trim, lit(4), true, lb]);
            out.push([...xs(F, F - sx * w), zc - dw / 2, zc + dw / 2, cy + dh, cy + h, K.trim, lit(4), false, lb]);
            // its doors, sliding apart behind the front; the handrail, the lamp, the panel's plate
            const o = el.door * dw / 2, dx = xs(F - sx * w, F - sx * (w + 0.035));
            out.push([...dx, zc - dw / 2 - o, zc - o, cy, cy + dh, K.door, lit(4), el.door < 0.8, lb]);
            out.push([...dx, zc + o, zc + dw / 2 + o, cy, cy + dh, K.door, lit(4), el.door < 0.8, lb]);
            const bx = sx > 0 ? ox0 + w : ox1 - w;
            out.push([...xs(bx, bx + sx * 0.06), oz0 + w + 0.1, oz1 - w - 0.1, cy + 0.88, cy + 0.94, K.trim, lit(4), false, lb]);
            out.push([ox0 + 0.35, ox1 - 0.35, oz0 + 0.35, oz1 - 0.35, cy + h - 0.03, cy + h, K.lamp, lit(7), false, lb]);
            const px = F - sx * (w + 0.36);
            out.push([px - 0.19, px + 0.19, oz1 - w - 0.03, oz1 - w, cy + 0.95, cy + 1.62, K.frame, lit(4), false, lb]);
        }
        // the counterweight, in the technical space: as high as the car is low over its run
        const cw = c.shaft.counterweight, lo = el.stops[0], hi = el.stops[el.stops.length - 1], wy = lo + hi - cy + h - cw.h;
        if (all && Math.abs(y - wy) < 30) out.push([cw.rect[0], cw.rect[1], cw.rect[2], cw.rect[3], wy, wy + cw.h, K.weight, m4, true, lb]);
        // landing doors at the stops near y: shut unless the car stands there with its doors open (or forced), within
        // the wall's thickness (the landing's frame lines the opening in front of their edges)
        const lx = xs(c.wall - sx * 0.012, c.wall - sx * 0.05);
        for (let i = 0; i < el.stops.length; i++) {
            const sy = el.stops[i];
            if (Math.abs(sy - y) > (all ? L.landingDraw : 3) && !(range && sy >= range[0] - 3 && sy <= range[1])) continue;
            const sb = c.stops[i].building, open = this.landingDoor(c, i), o = open * (dw / 2 + 0.04), m = this.material(sb, 4, false), shut = open < 0.8;
            // (from just under the sill, and overlapping where they meet: no crack to see the lobby by from the shaft)
            out.push([...lx, zc - dw / 2 - 0.05 - o, zc - o + 0.01, sy - 0.03, sy + dh + 0.04, K.door, m, shut, sb]);
            out.push([...lx, zc + o - 0.01, zc + dw / 2 + 0.05 + o, sy - 0.03, sy + dh + 0.04, K.door, m, shut, sb]);
        }
        return out;
    }

    // what a walker at p collides with: the parts of the cars near it that are solid now, as boxes { x, z, hx, hz, cs,
    // sn, y0, y1, slope, car } (turned by their frame)
    colliders(p) {
        const out = [];
        for (const c of this.near(p, 3)) for (const [x0, x1, z0, z1, y0, y1, , , solid] of this.parts(c, p[1], true)) {
            if (!solid || y1 < p[1] - 3 || y0 > p[1] + 3) continue;
            const [x, z] = c.f.xz((x0 + x1) / 2, (z0 + z1) / 2);
            out.push({ x, z, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cs: c.f.cs, sn: c.f.sn, y0, y1, slope: 0, car: c });
        }
        return out;
    }

    // The box instances to draw: the cars in `cars` (those the camera sees: their areas reached; default every car
    // within L.draw) and the landing doors and counterweights near the camera, each in the Origin frame of the building
    // whose storey it is at (x, z in its ground frame, y over its floor), BOX_FLOATS each: [centre, yaw] [half sizes,
    // material] [colour, -], grouped by building: into data, returns [{ b, first, count }]. ranges: car -> [y0, y1], the
    // stretch of its shaft in view (its landing doors there too)
    instances(cam, data, cars = null, ranges = null) {
        const by = new Map(), max = data.length / BOX_FLOATS;
        for (const c of this.near(cam, this.L.draw)) for (const part of this.parts(c, cam[1], true, !cars || cars.has(c), ranges?.get(c))) {
            const b = part[9];
            if (!by.has(b)) by.set(b, []);
            by.get(b).push(part);
        }
        const out = [];
        let n = 0;
        for (const [b, parts] of by) {
            const g = { b, first: n, count: 0 };
            for (const [x0, x1, z0, z1, y0, y1, k, m] of parts) {
                if (n >= max) break;
                data.set([(x0 + x1) / 2, (y0 + y1) / 2 - b.floor, (z0 + z1) / 2, 0, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, m, k[0], k[1], k[2], 0], n * BOX_FLOATS);
                n++;
                g.count++;
            }
            if (g.count) out.push(g);
        }
        return out;
    }

    // The panels near the camera, placed: each car's on its side wall by the door (the cars in `cars`, or all near);
    // each car's landing panel beside its landing door at the storey the camera is on (if it stops there and the camera
    // is by the lobby). [EntityGUI]
    panels(cam, cars = null) {
        const out = [], range = this.L.draw;
        for (const c of this.near(cam, this.L.panelRange)) {
            const el = c.el, F = c.front, w = this.L.wall, f = c.f;
            if (!cars || cars.has(c)) {
                const p = f.at(F - c.sx * (w + 0.36), el.y + 1.28, c.out[3] - w - 0.035);
                if (v3.len(v3.sub(p, cam)) < range) {
                    c.panel.setTransform(facing(p, [f.sn, 0, -f.cs]));
                    out.push(c.panel);
                }
            }
            const i = el.stopAt(cam[1] - 1.5, 2.5);
            c.landing.stop = i;
            if (i < 0) continue;
            const [x] = Lifts.local(c, cam);
            if (Math.sign(x - c.wall) !== c.sx) continue;           // (from the lobby's side only)
            const side = c.shaft.tech.side, zs = c.zc + side * (c.dw / 2 + 0.32);
            const p = f.at(c.wall + c.sx * 0.075, el.stops[i] + 1.25, zs);
            c.landing.setTransform(facing(p, [c.sx * f.cs, 0, c.sx * f.sn]));
            out.push(c.landing);
        }
        return out;
    }
}

return { LIFT, Lifts, CarPanel, LandingPanel, BOX_FLOATS };
});
