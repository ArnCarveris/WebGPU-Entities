'use strict';
// The bus line entity: its route, timetable and buses.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { lerp } = Common;
const { roundPath, offsetLine, speedLimits, TransitLine, PolylineRoute } = kits.transit;
const { ROAD_LAMP_STEP, BUS, BUS_LIVERIES, Entity, STRUCT_COLORS, Bus, BUS_SPEC } = feature;

// A bus line between a bus station (`from`) and a village's bus stop (`to`): its buses (Bus) drive one loop from the
// station's platform, along a two-lane road (built here) to the village, through it to a turning loop past its far end,
// and back; each stops by the village's shelter on the pass that has it on the right, and dwells at each stop (`dwell`
// [station, village] s) with its doors open. Cruise at `speed` m/s, slower in the village (`village` m/s) and the station.
// `fleet` buses (default: the station's `buses`, which then all run the line) leave the station at even intervals round
// the trip, and none closes up to within a few metres of the one ahead. The first is `label` in `livery`, the others are
// numbered after it in the station's liveries. A bus can be walked into (Walker): its floor, walls, seats and doors are
// colliders in its frame. Viewpoint (`spot`): "seat" (seated aboard the first bus). The route, its stops and speed limits
// are built here; running the buses round it is the line's (kits.transit's TransitLine, `line`).
class BusLine extends Entity {
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
        path.forEach((p, i) => {
            const z = zones[i];
            if ((z === 0 || z === 3) && i % 3 === 0) { if (!cur) lanes.push(cur = []); cur.push(p); } else if (z !== 0 && z !== 3) cur = null;
        });
        for (const l of lanes) if (l.length > 1) S.ribbon(l, 3.1, C2.asphalt, 3, 0.15);
        // the buses: the first stands at the station's stop, its doors open, the others spread round the trip
        const fleet = Math.max(1, Math.round(d.fleet ?? st.def.buses ?? 1));
        const liveries = [d.livery || [0.12, 0.36, 0.62], ...BUS_LIVERIES];
        this.buses = this.line.fleet(fleet, BUS_SPEC, k => new Bus(this.line, k ? `${this.label} #${k + 1}` : this.label, liveries[k % liveries.length]));
        for (const b of this.buses) S.boxes.list.push(b.box);
        this.world.buses.push(...this.buses);
    }

    update(dt) { this.line.update(dt * (this.world.busBoost || 1)); }
}

return { BusLine };
});
