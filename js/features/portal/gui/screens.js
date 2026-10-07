'use strict';
// The GUI screens of the bunker and the freighter: world-space EntityGUIs (the gui kit, js/kits/gui/) on the consoles,
// generators and bridge (world/entities.js Screen draws them).

Features.part('portal', (engine, feature) => {
const { clamp, col, deg, wrapIndex, pad3, cardinal, timeText, fitRect, EntityGUI } = engine.kits.gui;
const { g2, RATED_RPM } = feature;

// Every kind is an EntityGUI whose screen is a Screen entity (world/entities.js): `this.screen`, `this.world`, and once
// the game has the world, `this.app` (the Game: player, fx). The base draws the frame (background, header, border);
// a kind draws its body (drawBody) and handles its buttons (press). Kinds, by `screen.gui` in the scenario:
//   facility    the island's areas on two levels: who is where, doors, power
//   doors       access control: every door of the island, lock / unlock, lockdown
//   harbour     the freighter's route round the island, where it is and when it sails
//   power       a breaker per area of the grid, the units feeding it, the load
//   generator   one generator unit (`unit`): speed, load, coolant, fuel, start / stop
//   engine      the freighter's main engine: shaft speed, load, exhaust, telegraph
//   navigation  the freighter's chart: route, waypoints, track, speed, ETA at the dock
//   helm        rudder angle, engine telegraph, heel and trim, who steers
//   cctv        the security cameras: the selected one's feed (the gui kit's CctvSystem, 'cctv' material) and the list
// Maps show the island with +z up and -x to the right: as seen facing +z, the way the control room's consoles face.

const C = {
    cyan: [110, 220, 255], orange: [255, 154, 46], red: [255, 70, 55], green: [90, 255, 140], white: [235, 245, 255],
    ink: [3, 16, 22], dim: [90, 130, 145], amber: [255, 200, 80],
};
const kn = v => Math.abs(v) * 1.9438;
const now = () => performance.now();
const mmss = s => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

// world xz -> a panel: +z up, -x right, uniformly scaled to fit the bounds
function chart(bounds, x, y, w, h, pad = 10) {
    const [x0, z0, x1, z1] = bounds, s = Math.min((w - 2 * pad) / Math.max(1e-3, x1 - x0), (h - 2 * pad) / Math.max(1e-3, z1 - z0));
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, mx = x + w / 2, my = y + h / 2;
    return { s, at: (px, pz) => [mx - (px - cx) * s, my - (pz - cz) * s], inside: (p) => p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h };
}

function boundsOf(points, grow = 0) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    return [b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow];
}

// a compass bearing on the maps' north (+z), clockwise toward -x
const bearing = heading => wrapIndex(deg(-heading), 360);

class ScreenGUI extends EntityGUI {
    constructor(def, screen) {
        super(def);
        this.screen = screen;
        this.world = screen.world;
        this.app = null;
    }

    // the game that runs the world: its renderer (which draws the GUI model itself, FrameBuilder's 'gui' commands), its
    // events for sound
    attachTo(app) {
        this.app = app;
        this.attach({ renderer: app.renderer, audio: { emit: (name, payload) => app.fx.emit(name, payload) } });
    }

    // picking (the gui kit's InteractionSystem): the screen's own face, usable within `range` of the hit
    trace(eye, dir) { return this.screen.trace(eye, dir); }
    inRange(eye, hit) { return hit.t <= this.range; }

    get accent() { return C.cyan; }
    get title() { return this.def.title || 'TERMINAL'; }
    get status() { return timeText(new Date()); }
    get eye() { return this.app?.player?.cam.pos || [0, 0, 0]; }
    areaName(i) { return i === 0 ? 'Outside' : this.world.areas[i].name; }

    draw(dc, now) {
        const t = now / 1000, W = this.vw, H = this.vh, A = this.accent;
        dc.fillRect(0, 0, W, H, col([3, 12, 18], 0.97));
        for (let x = 24; x < W; x += 24) dc.fillRect(x, 34, 0.75, H - 34, col(A, 0.05));
        for (let y = 58; y < H; y += 24) dc.fillRect(0, y, W, 0.75, col(A, 0.05));
        dc.fillRect(0, 0, W, 34, col(A, 0.16));
        dc.fillRect(0, 33, W, 2, col(A));
        const a = t * 0.8;
        dc.polyline([0, 1, 2, 3].map(k => [18 + Math.cos(a + k * Math.PI / 2) * 8, 17 + Math.sin(a + k * Math.PI / 2) * 8]), 2, col(A), true);
        dc.text(this.title, 36, 24, 16, col(C.white));
        dc.text(this.status, W - 12, 23, 12, col(A), 'right');
        this.drawBody(dc, t, now);
        dc.rect(1, 1, W - 2, H - 2, 2, col(A, 0.45));
    }

    drawBody(dc, t, now) {}

    drawRangeHint(dc) {
        const W = this.vw, H = this.vh;
        dc.fillRect(W / 2 - 100, H - 34, 200, 24, col(C.ink, 0.9));
        dc.rect(W / 2 - 100, H - 34, 200, 24, 1, col(C.orange, 0.8));
        dc.text('MOVE CLOSER TO USE', W / 2, H - 17, 12, col(C.orange), 'center');
    }

    onPress(b) {
        if (!b) return;
        this.game.audio.emit('tap', { id: b.id });
        this.press(b.id);
    }

    press(id) {}

    // ---- widgets ----
    panel(dc, x, y, w, h, title, accent = this.accent) {
        const pts = dc.chamferPts(x, y, w, h, 8);
        dc.polygon(pts, col([10, 40, 52], 0.4));
        dc.polyline(pts, 1.5, col(accent, 0.75), true);
        if (title) {
            const tw = dc.textWidth(title, 10) + 12;
            dc.fillRect(x + 8, y, tw, 14, col(accent, 0.85));
            dc.text(title, x + 14, y + 11, 10, col(C.ink), 'left', false);
        }
    }

    button(dc, id, x, y, w, h, label, color, lit = false) {
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id), pressed = this.isPressed(id) || lit;
        const pts = dc.chamferPts(x, y, w, h, Math.min(7, h / 4));
        if (hover) dc.image('blob', x - 12, y - 12, w + 24, h + 24, col(color, 0.2));
        dc.polygon(pts, col(color, pressed ? 0.9 : hover ? 0.3 : 0.1));
        dc.polyline(pts, hover ? 2 : 1.25, col(color, hover ? 1 : 0.75), true);
        const size = Math.min(15, Math.max(10, Math.floor(h * 0.42)));
        dc.text(label, x + w / 2, y + h / 2 + size * 0.36, size, pressed ? col(C.ink) : col(hover ? C.white : color), 'center', !pressed);
    }

    bar(dc, x, y, w, h, frac, color) {
        dc.fillRect(x, y, w, h, col(color, 0.12));
        dc.fillRect(x, y, w * clamp(frac, 0, 1), h, col(color, 0.85));
        dc.rect(x, y, w, h, 1, col(color, 0.5));
    }

    row(dc, x, y, w, label, value, color = C.white, size = 13) {
        dc.text(label, x, y, size - 2, col(C.dim), 'left', false);
        dc.text(String(value), x + w, y, size, col(color), 'right');
    }

    // round gauge from 7:30 to 4:30; red beyond `red` (fraction)
    dial(dc, cx, cy, r, frac, label, value, color, red = 0.88) {
        const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, at = f => a0 + (a1 - a0) * clamp(f, 0, 1);
        dc.polyline(dc.arcPts(cx, cy, r, a0, a1, 40), 5, col(color, 0.15));
        dc.polyline(dc.arcPts(cx, cy, r, at(red), a1, 12), 5, col(C.red, 0.55));
        dc.polyline(dc.arcPts(cx, cy, r, a0, at(frac), 40), 5, col(frac > red ? C.red : color, 0.9));
        for (let k = 0; k <= 10; k++) {
            const a = at(k / 10), c = Math.cos(a), s = Math.sin(a), l = k % 5 ? 6 : 11;
            dc.line(cx + c * (r - 8), cy + s * (r - 8), cx + c * (r - 8 - l), cy + s * (r - 8 - l), 1.5, col(color, 0.6));
        }
        const a = at(frac);
        dc.line(cx, cy, cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12), 2.5, col(C.white));
        dc.circle(cx, cy, 5, col(color));
        dc.text(String(value), cx, cy + r * 0.62, 17, col(C.white), 'center');
        dc.text(label, cx, cy + r * 0.62 + 16, 10, col(C.dim), 'center', false);
    }

    // a ship triangle at p heading h (world heading: forward = (sin h, cos h) in xz), on a chart
    ship(dc, ch, px, pz, h, size, color) {
        const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
        const P = (a, b) => ch.at(px + fx * a + rx * b, pz + fz * a + rz * b);
        const s = size / ch.s;
        dc.polygon([P(s, 0), P(-s * 0.7, s * 0.55), P(-s * 0.4, 0), P(-s * 0.7, -s * 0.55)], col(color));
    }
}

// ------------------------------------------------------------------------------------------------ facility
class FacilityGUI extends ScreenGUI {
    get title() { return this.def.title || 'FACILITY // OVERVIEW'; }

    levels() {
        if (!this._levels) {
            const areas = this.world.power.areas;
            // an area's label goes at the centre of its largest triangle (inside an L-shaped one, unlike its box's)
            const label = tris => {
                const area = t => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]));
                const t = tris.reduce((a, b) => (area(b) > area(a) ? b : a));
                return [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
            };
            const level = (name, list) => {
                const tris = new Map(list.map(a => [a, g2.triangulate(a.shape)]));
                return { name, areas: list, bounds: boundsOf(list.flatMap(a => a.shape), 1.5), tris, labels: new Map(list.map(a => [a, label(tris.get(a))])) };
            };
            this._levels = [level('LEVEL 0', areas.filter(a => a.y >= -0.5)), level('LEVEL -1', areas.filter(a => a.y < -0.5))].filter(l => l.areas.length);
        }
        return this._levels;
    }

    drawBody(dc, t) {
        const W = this.vw, H = this.vh, w = this.world, R = 290, top = 46, mh = H - top - 12;
        const levels = this.levels(), eye = this.eye, here = w.areaAt(eye);
        const droneAreas = new Set(w.drones.map(d => w.areaAt(d.pos)));
        const span = levels.reduce((s, l) => s + (l.bounds[2] - l.bounds[0]) / (l.bounds[3] - l.bounds[1]), 0);
        let x = 12;
        for (const L of levels) {
            const mw = (W - R - 24 - 10 * (levels.length - 1)) * ((L.bounds[2] - L.bounds[0]) / (L.bounds[3] - L.bounds[1])) / span;
            this.panel(dc, x, top, mw, mh, L.name);
            this.drawLevel(dc, t, L, chart(L.bounds, x, top + 14, mw, mh - 14, 8), here, droneAreas, eye);
            x += mw + 10;
        }
        // status
        const px = W - R - 2, A = this.accent;
        this.panel(dc, px, top, R - 10, mh, 'STATUS');
        const doors = w.doors.filter(d => !d.portal.vehicle), open = doors.filter(d => d.open > 0.5).length, locked = doors.filter(d => d.portal.locked).length;
        const P = w.power, rows = [
            ['YOU', this.areaName(here), C.white],
            ...w.drones.map((d, i) => [`DRONE ${i + 1}`, this.areaName(w.areaAt(d.pos)), C.red]),
            ['DOORS OPEN', `${open} / ${doors.length}`, C.green],
            ['LOCKED', locked, locked ? C.red : C.dim],
            ['POWER', !P.units.length ? 'MAINS' : P.live ? 'ON GRID' : 'OUTAGE', P.live || !P.units.length ? C.green : C.red],
            ['LOAD', P.units.length ? `${P.load.toFixed(0)} / ${P.capacity} kW` : '-', A],
        ];
        rows.forEach(([l, v, c], i) => this.row(dc, px + 12, top + 38 + i * 24, R - 34, l, v, c));
        // legend
        const ly = top + mh - 52;
        const key = (k, color, label, sq) => {
            const kx = px + 12 + (k % 2) * 130, ky = ly + Math.floor(k / 2) * 20;
            if (sq) dc.fillRect(kx, ky - 8, 9, 9, col(color)); else dc.circle(kx + 4.5, ky - 3.5, 4.5, col(color));
            dc.text(label, kx + 16, ky, 10, col(C.dim), 'left', false);
        };
        key(0, C.green, 'door open', true); key(1, C.red, 'door locked', true);
        key(2, C.white, 'you', false); key(3, C.red, 'drone', false);
    }

    drawLevel(dc, t, L, ch, here, droneAreas, eye) {
        const w = this.world, A = this.accent;
        for (const a of L.areas) {
            const upper = L.name === 'LEVEL 0' && a.y > 2, powered = w.power.powered(a.index);
            const fill = a.index === here ? col(C.white, 0.22) : droneAreas.has(a.index) ? col(C.red, 0.16 + 0.08 * Math.sin(t * 5)) : col(powered ? A : C.dim, powered ? 0.09 : 0.04);
            if (!upper) for (const tri of L.tris.get(a)) dc.polygon(tri.map(p => ch.at(p[0], p[1])), fill);
            const outline = a.shape.map(p => ch.at(p[0], p[1]));
            if (upper) {
                for (let i = 0; i < outline.length; i++) {
                    const p = outline[i], q = outline[(i + 1) % outline.length], n = Math.max(1, Math.floor(Math.hypot(q[0] - p[0], q[1] - p[1]) / 8));
                    for (let k = 0; k < n; k += 2) dc.line(p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n, p[0] + (q[0] - p[0]) * (k + 1) / n, p[1] + (q[1] - p[1]) * (k + 1) / n, 1, col(A, 0.5));
                }
            } else dc.polyline(outline, 1.25, col(powered ? A : C.dim, 0.75), true);
            const lp = L.labels.get(a), c = ch.at(lp[0], lp[1]), name = a.name.toUpperCase();
            const room = Math.min((a.bbox[2] - a.bbox[0]), (a.bbox[3] - a.bbox[1])) * ch.s;
            if (!upper && room > 26 && dc.textWidth(name, 9) < (a.bbox[2] - a.bbox[0]) * ch.s - 4) dc.text(name, c[0], c[1] + (upper ? 10 : 3), 9, col(powered ? C.white : C.dim, 0.8), 'center', false);
        }
        const lower = L.name !== 'LEVEL 0';
        for (const d of w.doors) {
            const P = d.portal;
            if (P.vehicle || (P.center[1] < -0.5) !== lower) continue;
            const p = ch.at(P.center[0], P.center[2]), color = P.locked ? C.red : d.open > 0.5 ? C.green : C.cyan;
            dc.fillRect(p[0] - 4, p[1] - 4, 8, 8, col(color, P.locked || d.open > 0.5 ? 1 : 0.55));
        }
        for (const dr of w.drones) {
            if ((dr.pos[1] < -0.5) !== lower) continue;
            const p = ch.at(dr.pos[0], dr.pos[2]);
            if (ch.inside(p)) { dc.image('blob', p[0] - 12, p[1] - 12, 24, 24, col(C.red, 0.5 + 0.4 * Math.sin(t * 6))); dc.circle(p[0], p[1], 3.5, col(C.red)); }
        }
        if ((eye[1] < -0.5) === lower && this.app) {
            const p = ch.at(eye[0], eye[2]), { fwd } = this.app.player.basis();
            if (ch.inside(p)) {
                const f = Math.hypot(fwd[0], fwd[2]) || 1, q = ch.at(eye[0] + fwd[0] / f * 14 / ch.s, eye[2] + fwd[2] / f * 14 / ch.s);
                dc.line(p[0], p[1], q[0], q[1], 2, col(C.white));
                dc.circle(p[0], p[1], 4.5, col(C.white));
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ doors
class DoorsGUI extends ScreenGUI {
    get title() { return this.def.title || 'ACCESS CONTROL'; }
    get doors() { return this.world.doors.filter(d => !d.portal.vehicle); }
    get accent() { return this.doors.every(d => d.portal.locked) ? C.red : C.cyan; }

    lock(d, on) {
        const P = d.portal;
        P.locked = on;
        P.autoDoor = d.auto && !on;
        if (on) { d.target = 0; d.hold = 0; }
    }

    press(id) {
        const doors = this.doors;
        if (id === 'lockdown') doors.forEach(d => this.lock(d, true));
        else if (id === 'release') doors.forEach(d => this.lock(d, false));
        else if (id.startsWith('lock:')) { const d = doors[+id.slice(5)]; if (d) this.lock(d, !d.portal.locked); }
    }

    drawBody(dc, t) {
        const W = this.vw, H = this.vh, doors = this.doors, cols = 2, rows = Math.ceil(doors.length / cols);
        const top = 46, bottom = H - 50, cw = (W - 36) / cols, rh = Math.min(44, (bottom - top) / Math.max(1, rows));
        doors.forEach((d, i) => {
            const P = d.portal, x = 12 + Math.floor(i / rows) * (cw + 12), y = top + (i % rows) * rh;
            const state = P.locked ? (d.open > 0.02 ? ['SEALING', C.orange] : ['LOCKED', C.red]) : d.open > 0.98 ? ['OPEN', C.green] : d.open > 0.02 ? ['MOVING', C.amber] : ['CLOSED', C.cyan];
            dc.fillRect(x, y + 2, cw, rh - 6, col(state[1], 0.06));
            dc.fillRect(x, y + 2, 3, rh - 6, col(state[1], 0.9));
            const name = `${this.areaName(P.front)} · ${this.areaName(P.back)}`.toUpperCase();
            dc.text(name, x + 12, y + 18, 12, col(C.white), 'left', false);
            dc.text(state[0], x + 12, y + rh - 10, 10, col(state[1]), 'left');
            this.bar(dc, x + 84, y + rh - 18, cw - 210, 6, d.open, state[1]);
            this.button(dc, `lock:${i}`, x + cw - 104, y + (rh - 26) / 2, 96, 24, P.locked ? 'UNLOCK' : 'LOCK', P.locked ? C.green : C.red);
        });
        const locked = doors.filter(d => d.portal.locked).length;
        this.button(dc, 'lockdown', 12, H - 42, 150, 30, 'LOCKDOWN', C.red, locked === doors.length && Math.sin(t * 6) > 0);
        this.button(dc, 'release', 172, H - 42, 150, 30, 'RELEASE ALL', C.green);
        dc.text(`${locked} of ${doors.length} locked · locked doors stay shut, the drone finds another way`, W - 14, H - 22, 11, col(C.dim), 'right', false);
    }
}

// ------------------------------------------------------------------------------------------------ harbour
class HarbourGUI extends ScreenGUI {
    get title() { return this.def.title || 'HARBOUR // TRAFFIC'; }
    get vessel() { return this.world.vehicles[0] || null; }

    drawBody(dc, t) {
        const W = this.vw, H = this.vh, v = this.vessel, R = 300, top = 46;
        if (!v) { dc.text('NO VESSEL ON THE ROUTE', W / 2, H / 2, 16, col(C.dim), 'center'); return; }
        const pts = [];
        for (let s = 0; s < v.route.length; s += 4) pts.push(v.route.at(s));
        const island = this.world.power.areas.flatMap(a => a.shape);
        const ch = chart(boundsOf(pts.concat(island), 12), 12, top + 14, W - R - 24, H - top - 26, 8);
        this.panel(dc, 12, top, W - R - 24, H - top - 12, 'CHART');
        dc.polyline(pts.map(p => ch.at(p[0], p[1])), 1.5, col(this.accent, 0.55), true);
        for (const a of this.world.power.areas) dc.polyline(a.shape.map(p => ch.at(p[0], p[1])), 1, col(C.dim, 0.9), true);
        const dock = v.route.at(v.route.waypointS(v.data.route.dock || 0)), dp = ch.at(dock[0], dock[1]);
        dc.ring(dp[0], dp[1], 7, 1.5, col(C.amber));
        dc.text('DOCK', dp[0] + 10, dp[1] + 4, 10, col(C.amber), 'left', false);
        const M = v.M, sp = ch.at(M[12], M[14]);
        dc.image('blob', sp[0] - 16, sp[1] - 16, 32, 32, col(C.green, 0.35 + 0.25 * Math.sin(t * 4)));
        this.ship(dc, ch, M[12], M[14], v.heading, 11, C.green);
        const eye = this.eye, ep = ch.at(eye[0], eye[2]);
        if (ch.inside(ep)) dc.circle(ep[0], ep[1], 3.5, col(C.white));
        // the vessel
        const px = W - R - 2;
        this.panel(dc, px, top, R - 10, H - top - 12, `MV ${String(v.id).toUpperCase()}`);
        const state = v.state, docked = state === 'docked';
        const rows = [
            ['STATUS', state.toUpperCase(), docked ? C.amber : C.green],
            ['SPEED', `${kn(v.v).toFixed(1)} kn`, C.white],
            ['HEADING', `${pad3(bearing(v.heading))}° ${cardinal(bearing(v.heading))}`, C.white],
            [docked ? 'SAILS IN' : 'HELM', docked ? mmss(v.wait) : v.control ? 'MANUAL' : 'AUTOPILOT', docked ? C.amber : v.control ? C.orange : C.green],
            ['DISTANCE', `${Math.round(Math.hypot(M[12] - eye[0], M[14] - eye[2]))} m`, C.white],
        ];
        rows.forEach(([l, val, c], i) => this.row(dc, px + 12, top + 40 + i * 26, R - 34, l, val, c));
        if (docked) {
            const total = v.data.route.wait ?? 25;
            dc.text('BOARDING · GANGWAY DOWN', px + 12, H - 52, 11, col(C.amber), 'left', Math.sin(t * 3) > 0);
            this.bar(dc, px + 12, H - 40, R - 34, 8, 1 - v.wait / total, C.amber);
        } else dc.text('UNDER WAY · GANGWAY RAISED', px + 12, H - 34, 11, col(C.green), 'left', false);
    }
}

// ------------------------------------------------------------------------------------------------ power
class PowerGUI extends ScreenGUI {
    get title() { return this.def.title || 'POWER // DISTRIBUTION'; }
    get accent() { return this.world.power.live ? C.cyan : C.red; }

    press(id) {
        const P = this.world.power;
        if (id.startsWith('brk:')) { const i = +id.slice(4); P.setBreaker(i, !P.breaker(i)); }
        else if (id === 'all-on') P.areas.forEach(a => P.setBreaker(a.index, true));
        else if (id === 'shed') P.areas.forEach(a => P.setBreaker(a.index, a.lights.some(L => L.signal === 'pulse')));
    }

    drawBody(dc, t) {
        const W = this.vw, H = this.vh, P = this.world.power, areas = P.areas, top = 46, L = 250;
        // the units
        this.panel(dc, 12, top, L - 12, H - top - 12, 'SUPPLY');
        P.units.forEach((u, i) => {
            const y = top + 26 + i * 70, up = u.rpm > RATED_RPM * 0.8, color = up ? C.green : u.on ? C.amber : C.red;
            dc.text(`UNIT ${u.id}`, 24, y + 10, 13, col(C.white));
            dc.text(up ? 'ONLINE' : u.on ? 'STARTING' : 'OFFLINE', L - 12, y + 10, 11, col(color), 'right');
            this.bar(dc, 24, y + 20, L - 48, 7, u.rpm / RATED_RPM, color);
            dc.text(`${Math.round(u.rpm)} rpm · ${u.load.toFixed(0)} kW · fuel ${Math.round(u.fuel * 100)}%`, 24, y + 44, 10, col(C.dim), 'left', false);
        });
        const load = P.load, cap = P.capacity, over = cap > 0 && load > cap;
        const by = H - 66;
        dc.text('LOAD', 24, by, 10, col(C.dim), 'left', false);
        dc.text(`${load.toFixed(0)} / ${cap} kW`, L - 12, by, 13, col(over ? C.red : C.white), 'right');
        this.bar(dc, 24, by + 8, L - 48, 10, cap ? load / cap : 0, over ? C.red : this.accent);
        if (!P.live && Math.sin(t * 6) > 0) dc.text('GRID DOWN', L / 2 + 6, H - 24, 14, col(C.red), 'center');
        else if (over) dc.text('OVERLOAD · START A UNIT', L / 2 + 6, H - 24, 11, col(C.orange), 'center');
        // the breakers
        const bx = L + 10, bw = W - bx - 12;
        this.panel(dc, bx, top, bw, H - top - 12, 'BREAKERS');
        const cols = 3, rows = Math.ceil(areas.length / cols), cw = (bw - 24 - (cols - 1) * 8) / cols, rh = Math.min(56, (H - top - 76) / Math.max(1, rows));
        areas.forEach((a, k) => {
            const x = bx + 12 + (k % cols) * (cw + 8), y = top + 22 + Math.floor(k / cols) * rh, on = P.breaker(a.index), lit = P.powered(a.index);
            const id = `brk:${a.index}`, hover = this.isHover(id), color = !on ? C.red : lit ? C.green : C.amber;
            this.addButton(id, x, y, cw, rh - 6);
            dc.fillRect(x, y, cw, rh - 6, col(color, hover ? 0.22 : 0.08));
            dc.rect(x, y, cw, rh - 6, hover ? 2 : 1, col(color, hover ? 1 : 0.6));
            dc.text(a.name.toUpperCase(), x + 8, y + 17, 11, col(C.white), 'left', false);
            dc.text(on ? 'ON' : 'OFF', x + cw - 8, y + 17, 12, col(color), 'right');
            dc.text(`${P.demand(a).toFixed(1)} kW`, x + 8, y + rh - 14, 10, col(C.dim), 'left', false);
            // the switch
            const sx = x + cw - 40, sy = y + rh - 24;
            dc.roundRect(sx, sy, 32, 12, 6, col(color, 0.3));
            dc.circle(on ? sx + 26 : sx + 6, sy + 6, 5, col(color));
        });
        this.button(dc, 'all-on', bx + 12, H - 50, 140, 28, 'ALL ON', C.green);
        this.button(dc, 'shed', bx + 162, H - 50, 140, 28, 'LOAD SHED', C.orange);
        dc.text('emergency beacons stay lit', bx + bw - 12, H - 32, 10, col(C.dim), 'right', false);
    }
}

// ------------------------------------------------------------------------------------------------ generator
class GeneratorGUI extends ScreenGUI {
    constructor(def, screen) {
        super(def, screen);
        this.unit = screen.world.power.unit(def.unit || 'G1', def);
    }

    get title() { return this.def.title || `GENERATOR ${this.unit.id}`; }
    get accent() { const u = this.unit; return u.temp > 95 || (u.on && u.fuel <= 0) ? C.red : u.on ? C.cyan : C.amber; }
    get status() { return `DIESEL · ${this.unit.capacity} kW`; }

    press(id) {
        if (id === 'start') this.unit.on = true;
        else if (id === 'stop') this.unit.on = false;
    }

    drawBody(dc, t) {
        const W = this.vw, H = this.vh, u = this.unit, A = this.accent, R = 230, top = 46;
        const r = Math.min(78, (W - R - 40) / 6, (H - top - 40) / 2.3), dy = top + 22 + r;
        const span = (W - R - 24) / 3;
        this.dial(dc, 12 + span * 0.5, dy, r, u.rpm / 1800, 'RPM', Math.round(u.rpm), A, 0.9);
        this.dial(dc, 12 + span * 1.5, dy, r, u.load / u.capacity / 1.25, 'LOAD %', Math.round(u.load / u.capacity * 100), A, 0.8);
        this.dial(dc, 12 + span * 2.5, dy, r, u.temp / 120, 'COOLANT °C', Math.round(u.temp), A, 0.79);
        // frequency strip
        const hz = 50 * u.rpm / RATED_RPM;
        dc.text(`${hz.toFixed(1)} Hz · ${u.rpm > RATED_RPM * 0.8 ? 400 : Math.round(400 * u.rpm / RATED_RPM)} V · ${(u.load * 1.44).toFixed(0)} A`, 12 + (W - R - 24) / 2, H - 22, 13, col(C.white), 'center');
        // the unit
        const px = W - R - 2;
        this.panel(dc, px, top, R - 10, H - top - 12, 'UNIT');
        const status = u.on ? (u.fuel <= 0 ? ['NO FUEL', C.red] : u.rpm > RATED_RPM * 0.8 ? ['RUNNING', C.green] : ['STARTING', C.amber]) : u.rpm > 5 ? ['STOPPING', C.amber] : ['STOPPED', C.red];
        dc.text(status[0], px + 12, top + 40, 18, col(status[1]));
        dc.text('FUEL', px + 12, top + 66, 10, col(C.dim), 'left', false);
        dc.text(`${Math.round(u.fuel * 100)}%`, px + R - 22, top + 66, 12, col(u.fuel < 0.15 ? C.red : C.white), 'right');
        this.bar(dc, px + 12, top + 72, R - 34, 9, u.fuel, u.fuel < 0.15 ? C.red : A);
        dc.text(`RUN TIME ${Math.floor(u.fuel * 100 / 0.9)} h`, px + 12, top + 100, 10, col(C.dim), 'left', false);
        const by = H - 50, bw = (R - 44) / 2;
        this.button(dc, 'start', px + 12, by, bw, 32, 'START', C.green, u.on && u.rpm > RATED_RPM * 0.8);
        this.button(dc, 'stop', px + 22 + bw, by, bw, 32, 'STOP', C.red, !u.on && u.rpm < 5);
    }
}

// ------------------------------------------------------------------------------------------------ the freighter
// what the screens aboard read: the vehicle the screen rides (or the first one)
class ShipGUI extends ScreenGUI {
    get vessel() { return this.screen.veh || this.world.vehicles[0] || null; }

    // engine order telegraph for a throttle (-0.5 .. 1)
    static order(th) {
        const a = Math.abs(th), dir = th < 0 ? 'ASTERN' : 'AHEAD';
        return a < 0.03 ? 'STOP' : a < 0.18 ? `DEAD SLOW ${dir}` : a < 0.45 ? `SLOW ${dir}` : a < 0.8 ? `HALF ${dir}` : `FULL ${dir}`;
    }

    drawBody(dc, t, now) {
        if (!this.vessel) { dc.text('NO VESSEL', this.vw / 2, this.vh / 2, 16, col(C.dim), 'center'); return; }
        this.drawShip(dc, t, this.vessel, now);
    }

    drawShip(dc, t, v, now) {}
}

class EngineGUI extends ShipGUI {
    constructor(def, screen) {
        super(def, screen);
        this.rpm = 0; this.load = 0; this.exhaust = 160; this.fuel = def.fuel ?? 0.74;
    }

    get title() { return this.def.title || 'MAIN ENGINE'; }
    get accent() { return this.exhaust > 410 ? C.orange : C.cyan; }

    update(dt) {
        const v = this.vessel;
        if (!v || !(dt > 0)) return;
        const th = v.helm.throttle, a = Math.abs(th), k = Math.min(1, dt * 0.6);
        this.rpm += ((v.docked && a < 0.03 ? 0 : 22 + 98 * a) * Math.sign(th || 1) - this.rpm) * k;
        this.load += (a * 100 * (0.9 + 0.1 * Math.sin(now() * 0.0013)) - this.load) * k;
        this.exhaust += (160 + 280 * a - this.exhaust) * Math.min(1, dt * 0.15);
        this.fuel = Math.max(0, this.fuel - dt * 0.00002 * (0.2 + a));
    }

    drawShip(dc, t, v) {
        const W = this.vw, H = this.vh, A = this.accent, R = 250, top = 46;
        const r = Math.min(76, (W - R - 40) / 6, (H - top - 50) / 2.2), dy = top + 22 + r, span = (W - R - 24) / 3;
        this.dial(dc, 12 + span * 0.5, dy, r, Math.abs(this.rpm) / 130, this.rpm < -1 ? 'SHAFT RPM ASTERN' : 'SHAFT RPM', Math.round(Math.abs(this.rpm)), A, 0.88);
        this.dial(dc, 12 + span * 1.5, dy, r, this.load / 110, 'LOAD %', Math.round(this.load), A, 0.85);
        this.dial(dc, 12 + span * 2.5, dy, r, this.exhaust / 500, 'EXHAUST °C', Math.round(this.exhaust), A, 0.84);
        dc.text(`SPEED ${kn(v.v).toFixed(1)} kn · PROPELLER ${this.rpm >= 0 ? 'AHEAD' : 'ASTERN'}`, 12 + (W - R - 24) / 2, H - 22, 13, col(C.white), 'center');
        const px = W - R - 2;
        this.panel(dc, px, top, R - 10, H - top - 12, 'TELEGRAPH');
        const order = ShipGUI.order(v.helm.throttle);
        dc.text(order, px + 12, top + 42, 16, col(order === 'STOP' ? C.amber : C.green));
        dc.text(v.control ? 'BRIDGE · MANUAL' : v.docked ? 'BRIDGE · FINISHED WITH ENGINES' : 'BRIDGE · AUTOPILOT', px + 12, top + 62, 10, col(C.dim), 'left', false);
        this.row(dc, px + 12, top + 96, R - 34, 'LUBE OIL', `${(3.2 + 1.4 * Math.abs(this.rpm) / 120).toFixed(1)} bar`);
        this.row(dc, px + 12, top + 120, R - 34, 'JACKET WATER', `${Math.round(62 + 22 * this.load / 100)} °C`);
        this.row(dc, px + 12, top + 144, R - 34, 'FUEL OIL', `${Math.round(this.fuel * 100)}%`, this.fuel < 0.15 ? C.red : C.white);
        this.bar(dc, px + 12, top + 152, R - 34, 7, this.fuel, A);
        this.row(dc, px + 12, H - 30, R - 34, 'ENGINE HOURS', `${(12840 + now() / 3.6e6).toFixed(2)} h`, C.dim, 11);
    }
}

class NavigationGUI extends ShipGUI {
    constructor(def, screen) {
        super(def, screen);
        this.track = [];
        this.lastFix = 0;
    }

    get title() { return this.def.title || 'NAVIGATION // CHART'; }
    get status() { const v = this.vessel; return v ? `HDG ${pad3(bearing(v.heading))}° · ${kn(v.v).toFixed(1)} kn` : ''; }

    update() {
        const v = this.vessel, n = now();
        if (!v || n - this.lastFix < 2000) return;
        this.lastFix = n;
        this.track.push([v.M[12], v.M[14]]);
        if (this.track.length > 90) this.track.shift();
    }

    drawShip(dc, t, v) {
        const W = this.vw, H = this.vh, A = this.accent, R = Math.min(220, W * 0.42), top = 46, route = v.route;
        const pts = [];
        for (let s = 0; s < route.length; s += 4) pts.push(route.at(s));
        const wps = v.data.route.points, island = this.world.power.areas.flatMap(a => a.shape);
        const cw = W - R - 24;
        this.panel(dc, 12, top, cw, H - top - 12, 'CHART');
        const ch = chart(boundsOf(pts.concat(island), 10), 12, top + 14, cw, H - top - 26, 8);
        for (const a of this.world.power.areas) dc.polyline(a.shape.map(p => ch.at(p[0], p[1])), 1, col(C.dim, 0.9), true);
        dc.polyline(pts.map(p => ch.at(p[0], p[1])), 1.25, col(A, 0.5), true);
        // next waypoint along the route
        const L = route.length, ws = wps.map((_, i) => route.waypointS(i)), ahead = i => (ws[i] - v.s + L) % L;
        let next = 0;
        ws.forEach((_, i) => { if (ahead(i) > 1 && (ahead(next) <= 1 || ahead(i) < ahead(next))) next = i; });
        wps.forEach((p, i) => {
            const q = ch.at(p[0], p[1]);
            dc.circle(q[0], q[1], i === next ? 4 : 2.5, col(i === next ? C.amber : A, i === next ? 1 : 0.7));
            if (i === next) dc.ring(q[0], q[1], 8 + 2 * Math.sin(t * 4), 1.25, col(C.amber));
        });
        if (this.track.length > 1) dc.polyline(this.track.map(p => ch.at(p[0], p[1])), 1.5, col(C.green, 0.4));
        const M = v.M, sp = ch.at(M[12], M[14]), np = ch.at(wps[next][0], wps[next][1]);
        if (!v.docked) dc.line(sp[0], sp[1], np[0], np[1], 1, col(C.amber, 0.5));
        this.ship(dc, ch, M[12], M[14], v.heading, 10, C.green);
        // readouts
        const px = W - R - 2, dockS = route.waypointS(v.data.route.dock || 0), toDock = (dockS - v.s + L) % L;
        this.panel(dc, px, top, R - 10, H - top - 12, 'VOYAGE');
        const docked = v.docked, rows = [
            ['SOG', `${kn(v.v).toFixed(1)} kn`, C.white],
            ['HDG', `${pad3(bearing(v.heading))}°`, C.white],
            ['NEXT WP', docked ? '-' : `${next} · ${Math.round(ahead(next))} m`, C.amber],
            ['TO DOCK', docked ? 'ALONGSIDE' : `${Math.round(toDock)} m`, docked ? C.amber : C.white],
            ['ETA', docked ? `SAILS ${mmss(v.wait)}` : mmss(toDock / Math.max(0.5, Math.abs(v.v))), C.green],
            ['MODE', v.control ? 'MANUAL' : v.free === 'rejoin' ? 'REJOINING' : 'ROUTE', v.control ? C.orange : C.green],
        ];
        rows.forEach(([l, val, c], i) => this.row(dc, px + 12, top + 38 + i * 24, R - 34, l, val, c, 12));
        dc.text(`${(v.travelled / 1852).toFixed(2)} nm this leg`, px + 12, H - 28, 10, col(C.dim), 'left', false);
    }
}

class HelmGUI extends ShipGUI {
    get title() { return this.def.title || 'HELM // CONDITIONS'; }
    get accent() { return this.vessel?.control ? C.orange : C.cyan; }
    get status() { return this.vessel?.control ? 'MANUAL' : 'AUTOPILOT'; }

    drawShip(dc, t, v) {
        const W = this.vw, H = this.vh, A = this.accent, top = 46, half = (W - 34) / 2;
        // rudder angle: an arc from 35° port to 35° starboard
        this.panel(dc, 12, top, half, 140, 'RUDDER');
        const cx = 12 + half / 2, cy = top + 112, r = Math.min(84, half / 2 - 20), max = 35 * Math.PI / 180;
        const at = ang => -Math.PI / 2 + ang;
        dc.polyline(dc.arcPts(cx, cy, r, at(-max), at(max), 30), 5, col(A, 0.15));
        dc.polyline(dc.arcPts(cx, cy, r, at(-max), at(-max * 0.15), 12), 5, col(C.red, 0.45));
        dc.polyline(dc.arcPts(cx, cy, r, at(max * 0.15), at(max), 12), 5, col(C.green, 0.45));
        for (let k = -7; k <= 7; k++) {
            const a = at(k * 5 * Math.PI / 180), l = k % 2 ? 5 : 10;
            dc.line(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8), cx + Math.cos(a) * (r - 8 - l), cy + Math.sin(a) * (r - 8 - l), 1.25, col(A, 0.6));
        }
        const rud = clamp(v.helm.rudder, -1, 1), ra = at(rud * max);
        dc.line(cx, cy, cx + Math.cos(ra) * (r - 6), cy + Math.sin(ra) * (r - 6), 3, col(C.white));
        dc.circle(cx, cy, 5, col(A));
        dc.text('PORT', 24, top + 132, 10, col(C.red), 'left', false);
        dc.text('STBD', 12 + half - 12, top + 132, 10, col(C.green), 'right', false);
        dc.text(`${Math.abs(rud * 35).toFixed(0)}° ${Math.abs(rud) < 0.03 ? 'MIDSHIPS' : rud > 0 ? 'STBD' : 'PORT'}`, cx, top + 134, 12, col(C.white), 'center');
        // engine order telegraph
        const tx = 22 + half, orders = ['FULL AHEAD', 'HALF AHEAD', 'SLOW AHEAD', 'DEAD SLOW AHEAD', 'STOP', 'DEAD SLOW ASTERN', 'SLOW ASTERN', 'HALF ASTERN'];
        this.panel(dc, tx, top, half, H - top - 12, 'TELEGRAPH');
        const cur = ShipGUI.order(v.helm.throttle), rh = Math.min(26, (H - top - 66) / orders.length);
        orders.forEach((o, i) => {
            const y = top + 20 + i * rh, on = o === cur, c = o.includes('ASTERN') ? C.orange : o === 'STOP' ? C.amber : C.green;
            if (on) dc.fillRect(tx + 8, y, half - 16, rh - 4, col(c, 0.85));
            dc.text(o, tx + half / 2, y + rh / 2 + 2, 11, on ? col(C.ink) : col(c, 0.55), 'center', false);
        });
        dc.text(v.control ? 'F: leave the helm' : 'F at the wheel: take the helm', tx + half / 2, H - 22, 10, col(C.dim), 'center', false);
        // heel and trim
        const ay = top + 150, ah = H - ay - 12;
        this.panel(dc, 12, ay, half, ah, 'ATTITUDE');
        const ox = 12 + half / 2, oy = ay + ah / 2 + 6, rr = Math.min(ah / 2 - 14, half / 2 - 60);
        const roll = v.roll, pitch = v.pitch, off = clamp(pitch * 180 / Math.PI * 4, -rr, rr);
        const dx = Math.cos(roll) * rr, dyy = Math.sin(roll) * rr;
        dc.ring(ox, oy, rr, 1.5, col(A, 0.6));
        dc.line(ox - dx, oy + off - dyy, ox + dx, oy + off + dyy, 2.5, col(C.green));
        dc.line(ox - rr * 0.5, oy, ox - 8, oy, 2, col(C.white)); dc.line(ox + 8, oy, ox + rr * 0.5, oy, 2, col(C.white));
        dc.text(`HEEL ${Math.abs(deg(roll)).toFixed(1)}°`, 22, oy - 4, 10, col(C.white), 'left', false);
        dc.text(`TRIM ${deg(pitch).toFixed(1)}°`, 22, oy + 12, 10, col(C.white), 'left', false);
    }
}

// The island's security cameras (game/media.js: the gui kit's CctvSystem over the SecurityCamera entities). The feed
// renders only while this screen is drawn (request() from drawBody, which runs only when the screen is seen).
class CctvGUI extends ScreenGUI {
    get title() { return this.def.title || 'SECURITY // CCTV'; }
    get cctv() { return this.app?.media?.cctv || null; }

    drawBody(dc, t, now) {
        const W = this.vw, H = this.vh, cctv = this.cctv, cams = cctv ? cctv.cameras : [];
        if (!cams.length) {
            dc.text('NO CAMERAS ON THIS NETWORK', W / 2, H / 2, 16, col(C.orange), 'center');
            return;
        }
        cctv.request();
        const top = 44, listW = Math.min(170, W * 0.3), rowH = Math.min(30, (H - top - 10) / cams.length);
        this.panel(dc, 8, top, listW, H - top - 8, 'CAMERAS');
        cams.forEach((cam, i) => {
            const on = i === cctv.selected;
            this.button(dc, `cam:${i}`, 14, top + 20 + i * rowH, listW - 12, rowH - 4, cam.label, cam.offline ? C.dim : on ? C.green : C.cyan, on);
        });
        const fx = listW + 16, area = { x: fx, y: top, w: W - fx - 8, h: H - top - 8 };
        this.panel(dc, area.x, area.y, area.w, area.h, 'FEED');
        const R = fitRect({ x: area.x + 6, y: area.y + 18, w: area.w - 12, h: area.h - 24 }, cctv.aspect), cam = cctv.current;
        const sig = cctv.signal(now);
        if (sig > 0) {
            dc.setMaterial('cctv');
            dc.stretchPic(R.x, R.y, R.w, R.h, 0, 0, 1, 1, [sig, sig, sig, 1]);
            dc.setMaterial('atlas');
        } else dc.fillRect(R.x, R.y, R.w, R.h, col(C.ink));
        if (cam.offline) dc.text('NO SIGNAL', R.x + R.w / 2, R.y + R.h / 2, 18, col(C.red), 'center');
        dc.text(`${cam.label}  ${cam.name}`, R.x + 8, R.y + 18, 12, col(C.white));
        dc.text(timeText(new Date()), R.x + R.w - 8, R.y + 18, 12, col(C.white), 'right');
        if (Math.floor(t * 2) % 2) dc.circle(R.x + 12, R.y + R.h - 14, 4, col(C.red));
        dc.text('REC', R.x + 22, R.y + R.h - 10, 11, col(C.red));
    }

    press(id) {
        if (id.startsWith('cam:')) this.cctv?.select(+id.slice(4));
    }
}

const SCREEN_GUIS = {
    facility: FacilityGUI, doors: DoorsGUI, harbour: HarbourGUI, power: PowerGUI, generator: GeneratorGUI,
    engine: EngineGUI, navigation: NavigationGUI, helm: HelmGUI, cctv: CctvGUI,
};

return { ScreenGUI, SCREEN_GUIS };
});
