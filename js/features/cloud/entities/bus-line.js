'use strict';
// The bus line entity: its route, timetable and buses.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { clamp, lerp } = Common;
const { ROAD_LAMP_STEP, BUS, BUS_LIVERIES, Entity, STRUCT_COLORS, Bus } = feature;

// --- vehicles

// a path through control points { p: [x, z], r (corner radius, m) }: straight between them, the corners rounded by arcs,
// resampled evenly about every `step` m. Closed: a loop starting at ctrl[0] (which should be on a straight), the last
// point one step short of it; open: from the first point to the last
function roundPath(ctrl, step = 1, closed = true) {
    const n = ctrl.length, pts = [];
    for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) { pts.push(ctrl[i].p); continue; }
        const A = ctrl[(i + n - 1) % n].p, B = ctrl[i].p, C = ctrl[(i + 1) % n].p;
        const l1 = Math.hypot(B[0] - A[0], B[1] - A[1]), l2 = Math.hypot(C[0] - B[0], C[1] - B[1]);
        const u1 = [(B[0] - A[0]) / l1, (B[1] - A[1]) / l1], u2 = [(C[0] - B[0]) / l2, (C[1] - B[1]) / l2];
        const th = Math.acos(clamp(u1[0] * u2[0] + u1[1] * u2[1], -1, 1)), sg = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);
        if (th < 1e-3) { pts.push(B); continue; }
        // the arc is tangent to both legs, its centre on the side the path turns to (right of travel: (-z, x))
        const dd = Math.min(ctrl[i].r * Math.tan(th / 2), 0.48 * Math.min(l1, l2)), r = dd / Math.tan(th / 2);
        const P1 = [B[0] - u1[0] * dd, B[1] - u1[1] * dd], O = [P1[0] - u1[1] * sg * r, P1[1] + u1[0] * sg * r];
        const a0 = Math.atan2(P1[1] - O[1], P1[0] - O[0]), k1 = Math.max(2, Math.ceil(th * r / 0.5));
        for (let k = 0; k <= k1; k++) { const a = a0 + sg * th * k / k1; pts.push([O[0] + Math.cos(a) * r, O[1] + Math.sin(a) * r]); }
    }
    if (closed) pts.push(pts[0]);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const total = cum[cum.length - 1], N = Math.max(1, Math.round(total / step)), out = [];
    for (let i = 0, k = 0; i < N + (closed ? 0 : 1); i++) {
        const s = i * total / N;
        while (k + 2 < cum.length && cum[k + 1] < s) k++;
        const t = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
        out.push([lerp(pts[k][0], pts[k + 1][0], t), lerp(pts[k][1], pts[k + 1][1], t)]);
    }
    return { pts: out, length: total, step: total / N };
}

// the polyline `o` m to the right of travel (right of a heading [x, z] is [-z, x]), mitred at the corners
function offsetLine(pts, o) {
    const nrm = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [-dz / l, dx / l]; };
    return pts.map((p, k) => {
        const n1 = k > 0 ? nrm(pts[k - 1], p) : nrm(p, pts[1]), n2 = k + 1 < pts.length ? nrm(p, pts[k + 1]) : n1;
        const m = [n1[0] + n2[0], n1[1] + n2[1]], d = m[0] * n1[0] + m[1] * n1[1];
        return [p[0] + m[0] / d * o, p[1] + m[1] / d * o];
    });
}

// A bus line between a bus station (`from`) and a village's bus stop (`to`): its buses (Bus) drive one loop from the
// station's platform, along a two-lane road (built here) to the village, through it to a turning loop past its far end,
// and back; each stops by the village's shelter on the pass that has it on the right, and dwells at each stop (`dwell`
// [station, village] s) with its doors open. Cruise at `speed` m/s, slower in the village (`village` m/s) and the station.
// `fleet` buses (default: the station's `buses`, which then all run the line) leave the station at even intervals round
// the trip, and none closes up to within a few metres of the one ahead. The first is `label` in `livery`, the others are
// numbered after it in the station's liveries. A bus can be walked into (Walker): its floor, walls, seats and doors are
// colliders in its frame. Viewpoint (`spot`): "seat" (seated aboard the first bus).
class BusLine extends Entity {
    constructor(def, world) {
        super(def, world);
        this.buses = [];
    }

    // the buses carry the labels; a view that follows the line follows its first bus
    get anchor() { return null; }
    get focus() { return this.buses[0]?.focus ?? null; }

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
        const loop = roundPath(ctrl);
        this.path = loop.pts;
        this.len = loop.length;
        this.step = loop.step;
        const n = this.path.length;
        // where each point is: 0 the station, 1 the open road, 2 the village, 3 the turning loop
        const sc = st.frame.c, zone = p => dist(p, sc) < 160 ? 0 : dist(p, V.c) < V.R + 20 ? 2 : dist(p, T(25, 0)) < 40 ? 3 : 1;
        this.zones = this.path.map(zone);
        // road height: the bridge's deck in the village, else the terrain as drawn (the roads' lift)
        const height = (x, z) => {
            const rx = x - V.c[0], rz = z - V.c[1], s = rx * V.dir[0] + rz * V.dir[1], side = Math.abs(-rx * V.dir[1] + rz * V.dir[0]);
            if (V.deck && side < 4.5 && s > V.deck.a && s < V.deck.b) return V.deck.top((s - V.deck.a) / (V.deck.b - V.deck.a)) + 0.03;
            return S.ground(x, z) + 0.14;
        };
        this.heights = this.path.map(p => height(...p));
        // the stops: the station's at s = 0; the village's where the front door is by the shelter
        const kerb = [P(V.stop.s)[0] + V.stop.out[0] * lane, P(V.stop.s)[1] + V.stop.out[1] * lane];
        let best = 0;
        this.path.forEach((p, i) => { if (dist(p, kerb) < dist(this.path[best], kerb)) best = i; });
        const doorX = BUS.bay0 + (BUS.doorBays[0] + 0.5) * BUS.bay;
        this.stops = [0, (best * this.step - doorX + this.len) % this.len];
        // speed limits: cruising on the open road, slower in the village, at the station and round the loop, and through
        // bends (1.3 m/s^2 sideways); then braking (1 m/s^2) ahead of every slower stretch, twice round the loop
        const cruise = d.speed ?? 22, slow = d.village ?? 10;
        const head8 = i => { const a = this.path[(i + n - 4) % n], b = this.path[i], c = this.path[(i + 4) % n];
            const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
            return Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1))) / (8 * this.step); };
        const vmax = this.path.map((p, i) => Math.min([6, cruise, slow, 6][this.zones[i]], Math.sqrt(1.3 / Math.max(head8(i), 1e-6))));
        for (let k = 2 * n - 1; k >= 0; k--) { const i = k % n; vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[(i + 1) % n] ** 2 + 2 * this.step)); }
        this.vmax = vmax;
        // roads: the two-lane road to the village (dashed centre line), the station's one-way lanes and the turning loop
        const C2 = STRUCT_COLORS, road = roundPath([C(sf(W.east, W.road)), C(head, 11), C(E1, 40), C(P(sig * (V.R - 30)))], 4, false).pts;
        const roadPts = [];
        for (const p of road) { roadPts.push(p); if (dist(p, E1) < 3) break; }
        S.ribbon(roadPts, 3.6, C2.asphalt);
        // street lamps along the open road, a pair facing each other across it every ROAD_LAMP_STEP m, their arms over it
        // (lights near the camera, distant sprites further: LightWriter.write, World.buildFarLights)
        for (let k = 0, run = ROAD_LAMP_STEP / 2; k + 1 < roadPts.length; k++) {
            const a = roadPts[k], b = roadPts[k + 1], len = dist(a, b), t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
            for (; run < len; run += ROAD_LAMP_STEP) {
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
        this.path.forEach((p, i) => {
            const z = this.zones[i];
            if ((z === 0 || z === 3) && i % 3 === 0) { if (!cur) lanes.push(cur = []); cur.push(p); } else if (z !== 0 && z !== 3) cur = null;
        });
        for (const l of lanes) if (l.length > 1) S.ribbon(l, 3.1, C2.asphalt, 3, 0.15);
        // the buses: the first stands at the station's stop, its doors open; each of the others leaves a headway (one
        // trip round over the fleet) after the one before, so it is that much further back in its trip (run on here)
        const fleet = Math.max(1, Math.round(d.fleet ?? st.def.buses ?? 1));
        const liveries = [d.livery || [0.12, 0.36, 0.62], ...BUS_LIVERIES];
        const trip = this.tripTime(), dt = 0.25;
        for (let k = 0; k < fleet; k++) {
            const b = new Bus(this, k ? `${this.label} #${k + 1}` : this.label, liveries[k % liveries.length]);
            for (let t = (trip - k * trip / fleet) % trip; t > 1e-6; t -= dt) b.step(Math.min(dt, t));
            S.boxes.list.push(b.box);
            this.buses.push(b);
        }
        this.world.buses.push(...this.buses);
    }

    // seconds round the trip for a lone bus: from arriving at the station's stop to arriving there again
    tripTime() {
        const b = new Bus(this, '', null), dt = 0.25;
        let t = 0, away = false;
        while (t < 4 * 3600) {
            b.step(dt);
            t += dt;
            if (b.stop === 1) away = true;
            else if (away && b.mode === 'dwell') return t;
        }
        return t;
    }

    // position, height on the path at arc length s
    at(s) {
        const n = this.path.length, x = ((s % this.len) + this.len) % this.len / this.step, i = Math.floor(x) % n, j = (i + 1) % n, t = x - Math.floor(x);
        const a = this.path[i], b = this.path[j];
        return [lerp(a[0], b[0], t), lerp(this.heights[i], this.heights[j], t), lerp(a[1], b[1], t)];
    }

    update(dt) {
        dt *= this.world.busBoost || 1;
        for (const b of this.buses) {
            // the clear road to the next bus round the loop (to its rear bumper)
            let gap = Infinity;
            for (const o of this.buses) if (o !== b) { const g = (o.s - b.s + this.len) % this.len; if (g > 0 && g < gap) gap = g; }
            b.step(dt, gap - 2 * BUS.hl);
        }
    }
}

return { BusLine };
});
