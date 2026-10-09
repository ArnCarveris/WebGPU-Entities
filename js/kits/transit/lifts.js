'use strict';
// Lifts: cars in buildings' cores (Elevator), their landing doors, what a walker collides with and rides on, and their
// panels: an EntityGUI (the gui kit) in each car and one at each group's landing.

Features.kit('transit', (engine, kit) => {
const { Common } = engine;
const { clamp, v3 } = Common;
const { Elevator } = kit;
const { EntityGUI, col } = engine.kits.gui;

// Lifts: the car (m: its height, the gap round it in the shaft, its walls), its doors, speeds (m/s, m/s^2) and
// door times (s) by kind, how near (m) a panel can be used and the cars and landing doors are drawn, their colours
const LIFT = {
    car: { h: 2.6, gap: 0.12, wall: 0.06 }, door: { width: 1.1, height: 2.2 },
    local: { speed: 7, accel: 1.4, door: 1.6, dwell: 4 }, express: { speed: 60, accel: 2.5, door: 2.0, dwell: 6 },
    reach: 1.8, draw: 120, landingDraw: 60,
    colors: { car: [0.62, 0.60, 0.56], trim: [0.78, 0.74, 0.62], floor: [0.22, 0.20, 0.19], door: [0.66, 0.67, 0.68], frame: [0.30, 0.31, 0.32] },
};
const BOX_FLOATS = 12;               // a box instance (Lifts.instances): [centre, yaw] [half sizes, material] [colour, -]
const UI = { ink: [4, 14, 20], cyan: [110, 220, 255], amber: [255, 196, 90], white: [236, 244, 250], dim: [96, 128, 140], green: [96, 240, 150] };

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

// The panel in a car: where it is and how fast, its stops as buttons (lit while called), door open / close
class CarPanel extends EntityGUI {
    constructor(car) {
        super({ id: `lift-${car.slot}`, size: [0.30, 0.50], virtual: [300, 500], range: car.L.reach, hintRange: car.L.reach * 2.5, maxVerts: 12000 });
        this.car = car;
        this.page = 0;
    }

    draw(dc, now) {
        const c = this.car, el = c.el, W = this.vw, Hh = this.vh, A = UI.cyan;
        dc.fillRect(0, 0, W, Hh, col([6, 16, 22], 0.98));
        dc.rect(1, 1, W - 2, Hh - 2, 2, col(A, 0.5));
        // the display: the storey it is at or passing, which way, how high and how fast
        dc.fillRect(10, 10, W - 20, 92, col([0, 0, 0], 0.9));
        arrow(dc, 30, 56, 14, el.dir, el.dir ? UI.amber : UI.dim);
        const here = c.floor();
        dc.text(here, W / 2 + 10, 70, here.length > 4 ? 30 : 42, col(UI.amber), 'center');
        dc.text(`${Math.round(el.y)} m`, W - 18, 32, 12, col(UI.dim), 'right', false);
        dc.text(`${Math.abs(el.v).toFixed(el.v ? 1 : 0)} m/s`, W - 18, 92, 12, col(UI.dim), 'right', false);
        dc.text(c.name.toUpperCase(), 18, 30, 11, col(A, 0.8), 'left', false);
        // the stops: a grid, paged when there are many
        const n = el.stops.length, cols = n > 24 ? 4 : 3, rows = 8, per = cols * rows, pages = Math.ceil(n / per);
        this.page = clamp(this.page, 0, pages - 1);
        const x0 = 14, y0 = 116, bw = (W - 28 - (cols - 1) * 6) / cols, bh = 34;
        for (let k = 0; k < per; k++) {
            const i = this.page * per + k;
            if (i >= n) break;
            const r = Math.floor(k / cols), q = k % cols;
            this.button(dc, `stop:${i}`, x0 + q * (bw + 6), y0 + r * (bh + 5), bw, bh, el.names[i], el.calls.has(i), el.at === i);
        }
        const yb = y0 + rows * (bh + 5) + 4;
        if (pages > 1) {
            this.button(dc, 'prev', 14, yb, 54, 30, '‹', false);
            dc.text(`${this.page + 1}/${pages}`, W / 2, yb + 20, 12, col(UI.dim), 'center', false);
            this.button(dc, 'next', W - 68, yb, 54, 30, '›', false);
        }
        this.button(dc, 'open', 14, Hh - 46, (W - 34) / 2, 34, 'OPEN', false);
        this.button(dc, 'close', 20 + (W - 34) / 2, Hh - 46, (W - 34) / 2, 34, 'CLOSE', false);
    }

    button(dc, id, x, y, w, h, label, lit, here = false) {
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id), on = lit || this.isPressed(id), c = here ? UI.green : UI.cyan;
        dc.fillRect(x, y, w, h, col(c, on ? 0.85 : hover ? 0.28 : 0.1));
        dc.rect(x, y, w, h, hover ? 2 : 1, col(c, hover ? 1 : 0.6));
        dc.text(label, x + w / 2, y + h / 2 + 6, label.length > 4 ? 13 : 16, col(on ? UI.ink : UI.white), 'center', !on);
    }

    drawRangeHint(dc) { dc.text('CLOSER', this.vw / 2, this.vh - 60, 14, col(UI.amber), 'center'); }

    onPress(b) {
        if (!b) return;
        const el = this.car.el;
        this.game.audio.emit('liftButton', { id: b.id });
        if (b.id.startsWith('stop:')) el.call(+b.id.slice(5));
        else if (b.id === 'open') el.open();
        else if (b.id === 'close') el.close();
        else if (b.id === 'prev') this.page--;
        else if (b.id === 'next') this.page++;
    }
}

// The panel at a group's landing (shown at the storey the camera is on): where each car is, and the call button
class HallPanel extends EntityGUI {
    constructor(group) {
        super({ id: `hall-${group.name}`, size: [0.26, 0.36], virtual: [260, 360], range: group.L.reach, hintRange: group.L.reach * 2.5, maxVerts: 6000 });
        this.group = group;
        this.stop = -1;                  // the stop it stands at now
    }

    draw(dc) {
        const g = this.group, W = this.vw, A = UI.cyan, here = g.cars[0].el.names[this.stop] ?? '';
        dc.fillRect(0, 0, W, this.vh, col([6, 16, 22], 0.98));
        dc.rect(1, 1, W - 2, this.vh - 2, 2, col(A, 0.5));
        dc.text(g.name.toUpperCase(), W / 2, 26, 12, col(A, 0.85), 'center', false);
        dc.text(`FLOOR ${here}`, W / 2, 56, 20, col(UI.white), 'center');
        g.cars.forEach((c, i) => {
            const el = c.el, y = 86 + i * 40;
            dc.fillRect(14, y, W - 28, 32, col([0, 0, 0], 0.8));
            arrow(dc, 32, y + 16, 8, el.dir, el.dir ? UI.amber : UI.dim);
            dc.text(c.floor(), W / 2, y + 23, 18, col(UI.amber), 'center');
            dc.text(el.at === this.stop && el.door > 0 ? 'OPEN' : '', W - 22, y + 21, 11, col(UI.green), 'right', false);
        });
        const called = g.cars.some(c => c.el.calls.has(this.stop)), y = this.vh - 70;
        this.addButton('call', 40, y, W - 80, 52);
        const hover = this.isHover('call');
        dc.fillRect(40, y, W - 80, 52, col(UI.amber, called ? 0.9 : hover ? 0.3 : 0.12));
        dc.rect(40, y, W - 80, 52, hover ? 2 : 1, col(UI.amber, 0.9));
        dc.text(called ? 'CALLED' : 'CALL', W / 2, y + 33, 18, col(called ? UI.ink : UI.white), 'center', !called);
    }

    drawRangeHint(dc) { dc.text('CLOSER', this.vw / 2, this.vh - 84, 12, col(UI.amber), 'center'); }

    onPress(b) {
        if (b?.id !== 'call' || this.stop < 0) return;
        this.game.audio.emit('liftButton', { id: 'call' });
        this.group.call(this.stop);
    }
}

// The lifts of a world's buildings. A car (add) runs in a shaft of a building's core: frame f (the building's ground
// frame, Common.GroundFrame), shaft rect [x0, x1, z0, z1] (local), its door on `face` ('+x' / '-x': onto the lift lobby),
// stops [{ y, name, building (its Origin at height building.floor), g (its storey's number: what the panels show
// between stops) }]; cars of a `group` serve the same stops and share a landing panel. options: spec (LIFT's keys
// overridden), material(building, mat, lit): a part's material code in the world's renderer (mat 0 matte, 4 metal,
// 7 lamp; lit: a car's own, lit by its lamp)
class Lifts {
    constructor({ spec = {}, material = (b, mat) => mat } = {}) {
        this.L = { ...LIFT, ...spec };
        this.material = material;
        this.cars = [];
        this.groups = new Map();
        this.shafts = new Map();
    }

    add({ f, rect, face, kind = 'local', group, name, stops }) {
        const L = this.L, sx = face === '+x' ? 1 : -1, [x0, x1, z0, z1] = rect, g = L.car.gap, w = L.car.wall;
        const el = new Elevator({ stops: stops.map(s => s.y), names: stops.map(s => s.name), ...(L[kind] || L.local) });
        const car = {
            slot: this.cars.length, f, kind, name, stops, el, sx, L,
            // the car's outside, its front (the door side) and the wall line it opens onto, the door's centre (local)
            out: [x0 + g, x1 - g, z0 + g, z1 - g],
            front: sx > 0 ? x1 - g : x0 + g, wall: sx > 0 ? x1 : x0, zc: (z0 + z1) / 2,
        };
        // the floor it is at or passing: a stop's name there, else the storey's number (stops carry their storey: g)
        car.floor = () => {
            if (el.at >= 0 || !stops.every(st => st.g !== undefined)) return el.name;
            let i = 0;
            while (i + 1 < stops.length && stops[i + 1].y <= el.y) i++;
            const j = Math.min(i + 1, stops.length - 1), k = stops[j].y > stops[i].y ? (el.y - stops[i].y) / (stops[j].y - stops[i].y) : 0;
            const g = Math.round(stops[i].g + k * (stops[j].g - stops[i].g));
            return g === stops[i].g ? stops[i].name : g === stops[j].g ? stops[j].name : String(g);
        };
        car.panel = new CarPanel(car);
        const key = group || name;
        let G = this.groups.get(key);
        if (!G) {
            G = { name: key, cars: [], f, L, call: i => this.dispatch(G, i) };
            G.panel = new HallPanel(G);
            this.groups.set(key, G);
        }
        G.cars.push(car);
        car.group = G;
        this.cars.push(car);
        const sk = Lifts.shaftKey(f, rect);
        if (!this.shafts.has(sk)) this.shafts.set(sk, []);
        this.shafts.get(sk).push(car);
        return car;
    }

    static shaftKey(f, rect) { return `${f.c[0]},${f.c[1]},${rect.join(',')}`; }

    // is the landing door at height y of the shaft rect (local, in frame f) open: a car of it standing there with its
    // doors open (the portal from the lift lobby into the shaft's area)
    landingOpen(f, rect, y) { return Lifts.openAt(this.shaftCars(f, rect), y); }

    // the cars of the shaft rect (in frame f), and whether one of them stands open at height y
    shaftCars(f, rect) { return this.shafts.get(Lifts.shaftKey(f, rect)) || []; }
    static openAt(cars, y) {
        for (const c of cars) {
            const el = c.el;
            if (el.at >= 0 && el.door > 0.02 && Math.abs(el.stops[el.at] - y) < 0.5) return true;
        }
        return false;
    }

    // a landing call at stop i: the car that would get there first (distance at its speed, plus a pause for each call
    // it has, plus a trip's length if it is heading away)
    dispatch(G, i) {
        let best = null, cost = Infinity;
        for (const c of G.cars) {
            const el = c.el, y = el.stops[i], away = el.dir !== 0 && Math.sign(y - el.y) !== el.dir;
            const k = Math.abs(el.y - y) / el.speed + el.calls.size * (el.dwell + 2 * el.doorTime) + (away ? 60 : 0);
            if (k < cost) { cost = k; best = c; }
        }
        best?.el.call(i);
    }

    update(dt, boost = 1) { for (const c of this.cars) { c.el.boost = boost; c.el.update(dt); } }

    // building-local x, z of world p in car c's frame
    static local(c, p) {
        const dx = p[0] - c.f.c[0], dz = p[2] - c.f.c[1];
        return [dx * c.f.cs + dz * c.f.sn, -dx * c.f.sn + dz * c.f.cs];
    }

    // the building whose storey the car's floor is at now (its car is lit, and drawn, as that building's)
    static building(c) { return c.stops[c.el.nearest(c.el.y)].building; }

    // the car whose inside holds world p (feet), or null: what a walker rides
    carAt(p) {
        for (const c of this.near(p, 4)) {
            const [x, z] = Lifts.local(c, p), y = c.el.y;
            if (x > c.out[0] && x < c.out[1] && z > c.out[2] && z < c.out[3] && p[1] > y - 0.4 && p[1] < y + this.L.car.h) return c;
        }
        return null;
    }

    // the cars whose shafts lie within r m (horizontally) of p, and that reach its height
    near(p, r) {
        const out = [];
        for (const c of this.cars) {
            const [x, z] = Lifts.local(c, p);
            if (x < c.out[0] - r || x > c.out[1] + r || z < c.out[2] - r || z > c.out[3] + r) continue;
            if (p[1] < c.el.stops[0] - 6 || p[1] > c.el.stops[c.el.stops.length - 1] + 6) continue;
            out.push(c);
        }
        return out;
    }

    // the boxes of car c and of its landing doors near height y: [local x0, x1, z0, z1, y0, y1, colour, material, solid,
    // building]
    parts(c, y, all = true) {
        const L = this.L, K = L.colors, el = c.el, cy = el.y, h = L.car.h, w = L.car.wall, sx = c.sx, dw = L.door.width, dh = L.door.height;
        const [ox0, ox1, oz0, oz1] = c.out, zc = c.zc, F = c.front, out = [];
        const xs = (a, b) => [Math.min(a, b), Math.max(a, b)];
        const lb = Lifts.building(c), lit = mat => this.material(lb, mat, true);
        if (Math.abs(y - cy) < 12 || all) {
            out.push([ox0, ox1, oz0, oz1, cy - 0.15, cy, K.floor, lit(0), true, lb]);
            out.push([...xs(F, c.wall), zc - dw / 2, zc + dw / 2, cy - 0.06, cy, K.frame, lit(4), true, lb]);     // its sill, to the landing
            out.push([ox0, ox1, oz0, oz1, cy + h, cy + h + 0.12, K.car, lit(0), true, lb]);
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
            out.push([ox0 + 0.35, ox1 - 0.35, oz0 + 0.35, oz1 - 0.35, cy + h - 0.03, cy + h, [1.0, 0.96, 0.88], lit(7), false, lb]);
            const px = F - sx * (w + 0.36);
            out.push([px - 0.19, px + 0.19, oz1 - w - 0.03, oz1 - w, cy + 0.95, cy + 1.62, K.frame, lit(4), false, lb]);
        }
        // landing doors at the stops near y: shut unless the car stands there with its doors open
        const lx = xs(c.wall - sx * 0.09, c.wall - sx * 0.035);
        for (let i = 0; i < el.stops.length; i++) {
            const sy = el.stops[i];
            if (Math.abs(sy - y) > (all ? L.landingDraw : 3)) continue;
            const sb = c.stops[i].building, o = (el.at === i ? el.door : 0) * dw / 2, m = this.material(sb, 4, false), shut = !(el.at === i && el.door > 0.8);
            out.push([...lx, zc - dw / 2 - 0.03 - o, zc - o, sy, sy + dh, K.door, m, shut, sb]);
            out.push([...lx, zc + o, zc + dw / 2 + 0.03 + o, sy, sy + dh, K.door, m, shut, sb]);
        }
        return out;
    }

    // what a walker at p collides with: the parts of the cars near it that are solid now, as boxes { x, z, hx, hz, cs,
    // sn, y0, y1, slope } (turned by their frame)
    colliders(p) {
        const out = [];
        for (const c of this.near(p, 3)) for (const [x0, x1, z0, z1, y0, y1, , , solid] of this.parts(c, p[1], false)) {
            if (!solid) continue;
            const [x, z] = c.f.xz((x0 + x1) / 2, (z0 + z1) / 2);
            out.push({ x, z, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cs: c.f.cs, sn: c.f.sn, y0, y1, slope: 0 });
        }
        return out;
    }

    // the box instances to draw for the cars within L.draw of the camera, each in the Origin frame of the building whose
    // storey it is at (the car's, a landing's: x, z in its ground frame, y over its floor), BOX_FLOATS each: [centre,
    // yaw] [half sizes, material] [colour, -], grouped by building: into data, returns [{ b, first, count }]
    instances(cam, data) {
        const by = new Map(), max = data.length / BOX_FLOATS;
        for (const c of this.near(cam, this.L.draw)) for (const part of this.parts(c, cam[1])) {
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

    // the panels near the camera, placed: each car's, on its side wall by the door; each group's at the landing of the
    // storey the camera is on (if the group stops there and the camera is by its lobby). [EntityGUI]
    panels(cam, range = this.L.draw) {
        const out = [];
        for (const c of this.near(cam, 20)) {
            const el = c.el, F = c.front, w = this.L.car.wall, f = c.f;
            const p = f.at(F - c.sx * (w + 0.36), el.y + 1.28, c.out[3] - w - 0.035);
            if (v3.len(v3.sub(p, cam)) > range) continue;
            c.panel.setTransform(facing(p, [f.sn, 0, -f.cs]));
            out.push(c.panel);
        }
        for (const G of this.groups.values()) {
            const c = G.cars[0], [x, z] = Lifts.local(c, cam);
            G.panel.stop = -1;
            if (Math.abs(x - c.wall) > 14 || Math.abs(z - c.zc) > 14) continue;
            const i = c.el.nearest(cam[1] - 1.5);
            if (Math.abs(c.el.stops[i] - (cam[1] - 1.5)) > 2.5) continue;
            G.panel.stop = i;
            const zs = c.zc + (c.zc <= 0 ? 1 : -1) * (this.L.door.width / 2 + 0.4), f = c.f;
            const p = f.at(c.wall + c.sx * 0.09, c.el.stops[i] + 1.3, zs);
            G.panel.setTransform(facing(p, [c.sx * f.cs, 0, c.sx * f.sn]));
            out.push(G.panel);
        }
        return out;
    }
}

return { LIFT, Lifts, CarPanel, HallPanel, BOX_FLOATS };
});
