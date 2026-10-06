'use strict';
// Fixtures: lights that are on by night, street lamps, bus shelters and bridges.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, lerp, smoothstep, v3 } = Common;
const { GroundFrame, LAMPS, STRUCT_COLORS } = feature;

class Fixtures {
    constructor(S) {
        this.S = S;
        this.lights = [];            // lamps that are on by night: { pos, color, intensity, range, dir, cone (cos edge, cos core) }
    }

    // a light that is on by night (LAMPS[kind], `o` overrides): at pos, shining along dir within cone [edge, core] (degrees
    // off its axis; none: all round)
    light(kind, pos, dir = null, o = {}) {
        const L = { ...LAMPS[kind], ...o }, cone = L.cone && dir ? [Math.cos(L.cone[0] * DEG), Math.cos(L.cone[1] * DEG)] : null;
        this.lights.push({ pos, color: L.color, intensity: L.intensity, range: L.range, size: L.size, dir: dir ? v3.norm(dir) : [0, -1, 0], cone, tag: L.tag });
    }

    // a street lamp standing at [x, z], its arm reaching `reach` m along `toward` ([x, z], over the road): a pole, the arm
    // and a head whose diffuser glows by night (material 7), and its light, a wide cone down onto the road
    lamp(x, z, toward, kind = 'sodium', o = {}) {
        const S = this.S;
        const C = STRUCT_COLORS, h = o.height ?? 6.5, reach = o.reach ?? 1.5, g = S.ground(x, z);
        const f = new GroundFrame([x, z], Math.atan2(toward[1], toward[0]));
        S.box(f, 0, 0, 0.08, 0.08, g - 0.3, g + h, C.metal, 4);
        S.prism(f, reach / 2, 0, reach / 2, 0.04, g + h - 0.07, g + h, C.metal, 4);
        S.prism(f, reach, 0, 0.34, 0.15, g + h - 0.14, g + h + 0.04, C.metal, 4);
        S.prism(f, reach, 0, 0.29, 0.12, g + h - 0.19, g + h - 0.14, LAMPS[kind].color.map(c => 0.55 + 0.45 * c), 7);
        this.light(kind, f.at(reach, g + h - 0.3, 0), [0, -1, 0], { cone: [78, 42], ...o.light });
    }

    // bus shelter: a roof on four posts, glass back and side panels, a bench, a timetable and the stop sign by the kerb.
    // Local -z faces the road. Returns the floor height
    busStop(f) {
        const S = this.S;
        const C = STRUCT_COLORS;
        const g = [[-2.6, -1.5], [2.6, -1.5], [2.6, 1.5], [-2.6, 1.5]].map(([x, z]) => S.ground(...f.xz(x, z)));
        const floor = Math.max(...g) + 0.12, yr = floor + 2.55;
        S.box(f, 0, -0.2, 2.6, 1.5, Math.min(...g) - 0.4, floor, C.concrete);
        for (const sx of [-2.05, 2.05]) for (const sz of [-0.85, 0.85]) S.box(f, sx, sz, 0.05, 0.05, floor, yr, C.metal, 4);
        S.box(f, 0, 0, 2.35, 1.2, yr, yr + 0.14, C.metal, 4);
        S.box(f, 0, 0.85, 2.0, 0.015, floor + 0.12, yr - 0.08, C.glass, 2);
        for (const sx of [-2.05, 2.05]) S.box(f, sx, 0.3, 0.015, 0.55, floor + 0.12, yr - 0.08, C.glass, 2);
        S.box(f, 0, 0.55, 1.3, 0.18, floor + 0.42, floor + 0.47, C.wood);
        for (const sx of [-1.1, 1.1]) S.box(f, sx, 0.55, 0.04, 0.15, floor, floor + 0.42, C.metal, 4);
        S.box(f, -1.2, 0.82, 0.35, 0.012, floor + 1.1, floor + 1.8, [0.80, 0.80, 0.78]);
        S.box(f, -2.9, -1.2, 0.035, 0.035, floor, floor + 2.75, C.metal, 4);
        S.box(f, -2.9, -1.2, 0.02, 0.3, floor + 2.2, floor + 2.75, C.sign, 4);
        const gLo = Math.min(...g) - 0.5;
        S.boxes.add(f, 0, 0, 2.35, 1.2, yr, yr + 0.14, 0.6, 0, gLo);
        S.boxes.add(f, 0, 0.85, 2.0, 0.02, floor, yr - 0.08, 0.1, 0, gLo);
        for (const sx of [-2.05, 2.05]) S.boxes.add(f, sx, 0.3, 0.02, 0.55, floor, yr - 0.08, 0.05, 0, gLo);
        S.boxes.drip(f, 0, 0, 2.35, 1.2, yr, yr - floor + 0.12);
        // a light strip under the roof
        S.box(f, 0, 0.2, 1.4, 0.06, yr - 0.03, yr, [0.95, 0.97, 1.0], 7);
        this.light('shelter', f.at(0, yr - 0.25, 0.1));
        return floor;
    }

    // bridge from a to b ([x, z], ends on the ground): a deck `width` wide and `thick` deep that ramps up `rise` m over
    // the first and last `ramp` m and arches `arch` m more, parapets (`parapet`) or railings, on piers about
    // every `pierEvery` m. Returns the deck height at t (0 at a .. 1 at b)
    bridge(a, b, o) {
        const S = this.S;
        const C = STRUCT_COLORS, L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], side = [-u[1], u[0]];
        const ha = S.ground(...a) + 0.15, hb = S.ground(...b) + 0.15, hw = o.width / 2;
        const ramp = Math.min((o.ramp ?? 20) / L, 0.45), at = t => [a[0] + u[0] * L * t, a[1] + u[1] * L * t];
        const top = t => lerp(ha, hb, t) + (o.rise ?? 0) * smoothstep(0, ramp, t) * (1 - smoothstep(1 - ramp, 1, t)) + o.arch * Math.sin(Math.PI * t);
        const n = Math.max(8, Math.ceil(L / 3)), ts = Array.from({ length: n + 1 }, (_, k) => k / n);
        const pts = ts.map(at), tops = ts.map(top), offs = (dy) => tops.map(y => y + dy);
        S.sweep(pts, side, -hw, hw, offs(-o.thick), tops, o.deck, 0);
        if (o.surface) S.sweep(pts, side, -hw + 0.4, hw - 0.4, tops, offs(0.03), C.asphalt, 3);
        for (const sg of [-1, 1]) {
            if (o.parapet) { S.sweep(pts, side, sg * hw - (sg > 0 ? 0.35 : 0), sg * hw + (sg < 0 ? 0.35 : 0), tops, offs(0.9), o.deck, 0); continue; }
            const rail = sg * (hw - 0.04);
            S.sweep(pts, side, rail - 0.03, rail + 0.03, offs(1.0), offs(1.07), o.rail, 4);
            S.sweep(pts, side, rail - 0.02, rail + 0.02, offs(0.5), offs(0.54), o.rail, 4);
            for (let s = 1; s < L; s += 2) {
                const t = s / L, pf = new GroundFrame(at(t), Math.atan2(u[1], u[0]));
                S.box(pf, 0, rail, 0.03, 0.03, top(t), top(t) + 1.07, o.rail, 4);
            }
        }
        // piers down to the ground (under water, the river bed)
        const yaw = Math.atan2(u[1], u[0]), np = Math.max(1, Math.round(L / o.pierEvery));
        for (let i = 1; i < np; i++) {
            const t = i / np, c = at(t), pf = new GroundFrame(c, yaw);
            S.box(pf, 0, 0, o.pierHalf, hw * 0.8, S.ground(...c) - 2, top(t) - o.thick, o.pier);
        }
        // shader boxes along the deck, sheared to the chord of each piece and kept inside the curved deck (so its top
        // stays wet and its underside dry)
        const nb = Math.max(1, Math.ceil(L / 8)), ks = [0, 0.25, 0.5, 0.75, 1];
        for (let i = 0; i < nb; i++) {
            const t0 = i / nb, t1 = (i + 1) / nb, tm = (t0 + t1) / 2, len = L * (t1 - t0);
            const slope = (top(t1) - top(t0)) / len, mid = (top(t0) + top(t1)) / 2;
            const dev = ks.map(k => top(lerp(t0, t1, k)) - lerp(top(t0), top(t1), k));
            const base = Math.min(...ks.map(k => S.ground(...at(lerp(t0, t1, k))))) - 1;
            const pf = new GroundFrame(at(tm), yaw);
            S.boxes.add(pf, 0, 0, len / 2, hw, mid + Math.max(...dev) - o.thick + 0.03, mid + Math.min(...dev) - 0.03, 0.55, slope, base);
            // to walk on: the deck, and its parapets or railings
            S.solids.add(pf, 0, 0, len / 2, hw, mid - o.thick, mid + Math.max(...dev), slope);
            for (const sg of [-1, 1]) S.solids.add(pf, 0, sg * (hw - 0.1), len / 2, 0.1, mid - o.thick, mid + Math.max(...dev) + 1.0, slope);
        }
        return top;
    }
}

return { Fixtures };
});
