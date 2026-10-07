'use strict';
// Entities that build settlements: villages and the bus station.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, clamp, lerp, smoothstep } = Common;
const { mulberry32 } = kits.noise;
const { BUS_LIVERIES, Entity, GroundFrame, STRUCT_COLORS } = feature;

// A small village on a road, laid out from a seed on the terrain as drawn. The road runs across the river `river` (an
// entity id; or at `road` degrees from +x without one) on a stone bridge; a side street branches off on the longer
// bank. Houses (`houses` at most) line both, a bus shelter stands by the main road near the junction, and a wooden
// footbridge crosses the river `footbridge` m along it (in its path's direction; negative: the other way; 0: none).
// Viewpoints for scenario views (`spot`): "bus stop", "bridges", "under the bridge", "overview".
class Village extends Entity {
    // the river through the village gets a deeper channel (`channel` m), and the village draws its water itself at the
    // river's true width: the land-use map is far coarser than a river, so it is cleared here
    stamp(f) {
        const d = this.def, river = d.river && this.world.get(d.river);
        if (!river) return;
        const [cx, cz] = d.pos, R = d.radius ?? 380, halfW = (river.def.width || 60) / 2, depth = d.channel ?? 3, reach = R * 3;
        f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
            const r = Math.hypot(x - cx, z - cz), k = 1 - smoothstep(R * 1.1, R * 1.5, r);
            if (k > 0) f.h[idx] -= depth * k * (1 - smoothstep(halfW * 0.5, halfW + 160, river.distance(x, z)));
            f.land[idx * 3 + 2] *= smoothstep(R * 2.2, reach, r);     // where the village's water tapers off, the map's returns
        });
    }

    get anchor() { const p = this.def.pos; return [p[0], this.world.field.sample(p[0], p[1]) + (this.def.labelHeight ?? 110), p[1]]; }
    get focus() { const p = this.def.pos; return [p[0], this.world.field.sample(p[0], p[1]), p[1]]; }

    build(S) {
        const d = this.def, f = this.world.field, rnd = mulberry32(d.seed ?? 9), r = (a, b) => a + (b - a) * rnd();
        const [cx, cz] = d.pos, R = d.radius ?? 380, roadHalf = 3.5, C = STRUCT_COLORS;
        const river = d.river && this.world.get(d.river), halfW = river ? (river.def.width || 60) / 2 : 0;
        const water = (x, z) => Math.max(f.landAt(x, z, 2), river && river.distance(x, z) < halfW + 6 ? 1 : 0);
        // the road crosses the river where it is nearest to the village, square to it
        let along = [Math.cos((d.road ?? 0) * DEG), Math.sin((d.road ?? 0) * DEG)];
        let dir = [-along[1], along[0]];
        if (river) {
            const pts = river.def.path;
            let best = Infinity;
            for (let k = 0; k + 1 < pts.length; k++) {
                const [ax, az] = pts[k], [bx, bz] = pts[k + 1], l = Math.hypot(bx - ax, bz - az);
                const t = clamp(((cx - ax) * (bx - ax) + (cz - az) * (bz - az)) / (l * l), 0, 1);
                const dd = Math.hypot(ax + (bx - ax) * t - cx, az + (bz - az) * t - cz);
                if (dd < best) { best = dd; along = [(bx - ax) / l, (bz - az) / l]; }
            }
            dir = [-along[1], along[0]];
            if (d.footbridge && d.footbridge < 0) along = [-along[0], -along[1]];
        }
        const P = s => [cx + dir[0] * s, cz + dir[1] * s];
        // the stretch of a line that crosses water, nearest its middle: [s0, s1] or null
        const wetSpan = (at, a, b) => {
            let cur = null, best = null;
            for (let s = a; s <= b; s += 2) {
                if (water(...at(s)) > 0.15) { if (!cur) cur = [s, s]; cur[1] = s; }
                else if (cur) { if (!best || Math.abs(cur[0] + cur[1]) < Math.abs(best[0] + best[1])) best = cur; cur = null; }
            }
            if (cur && (!best || Math.abs(cur[0] + cur[1]) < Math.abs(best[0] + best[1]))) best = cur;
            return best;
        };
        const taken = [];            // [x, z, radius] of what stands already, and the roads as [a, b, half width]
        const roads = [];
        const segDist = ([a, b], x, z) => {
            const dx = b[0] - a[0], dz = b[1] - a[1], t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1);
            return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
        };
        const free = (x, z, rad) => taken.every(([ox, oz, or]) => Math.hypot(x - ox, z - oz) > rad + or + 1.5)
            && roads.every(rd => segDist(rd, x, z) > rad + rd[2] + 1)
            && [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => water(x + a * rad, z + b * rad) < 0.03);
        const addRoad = (a, b, hw) => { S.road(a, b, hw); roads.push([a, b, hw]); };

        // main road, with the bridge where it meets the river
        const span = river ? wetSpan(P, -R, R) : null;
        let bA = R, bB = R, deck = null;
        this.spots = {};
        if (span) {
            bA = span[0] - 26; bB = span[1] + 26;
            const top = S.fixtures.bridge(P(bA), P(bB), { width: 8, thick: 1.1, rise: 4, ramp: 22, arch: 1.5, parapet: true, surface: true, deck: C.stone, pier: C.stone, pierEvery: 24, pierHalf: 1.2 });
            deck = { a: bA, b: bB, top };
            roads.push([P(bA), P(bB), 5]);
            // under the deck on the bank, looking along the river past the dry ground below it
            for (let t = 0.02; t < 0.5; t += 0.005) {
                const c = P(lerp(bA, bB, t));
                if (water(...c)) break;
                const g = f.surface(...c);
                if (top(t) - 1.1 - g < 2.5) continue;
                const e = [c[0] - along[0] * 1.5, c[1] - along[1] * 1.5];
                this.spots['under the bridge'] = { pos: [e[0], g + 1.6, e[1]], look: [c[0] + along[0] * 60 + dir[0] * 25, g + 1.2, c[1] + along[1] * 60 + dir[1] * 25] };
                break;
            }
            if (bA > -R) addRoad(P(-R), P(bA), roadHalf);
            if (bB < R) addRoad(P(bB), P(R), roadHalf);
        } else addRoad(P(-R), P(R), roadHalf);

        // side street on the longer bank, along the river
        const sJ = span ? (R - bB > bA + R ? bB + (R - bB) * 0.42 : bA - (bA + R) * 0.42) : R * 0.2;
        const J = P(sJ), Q = u => [J[0] + along[0] * u, J[1] + along[1] * u];
        const ls = R * 0.6;
        const sideWet = wetSpan(u => Q(u), -ls, ls);
        let u0 = -ls, u1 = ls;
        if (sideWet) { if (sideWet[1] < 0) u0 = sideWet[1] + 20; else u1 = sideWet[0] - 20; }
        addRoad(Q(u0), Q(u1), 2.8);

        // bus stop by the main road just past the junction, its back to the west (where the rain comes from in most states)
        const sB = sJ + (Math.abs(sJ + 22) < R - 20 && (sJ + 22 < bA - 10 || sJ + 22 > bB + 10) ? 22 : -22);
        const sideB = (d.busStopSide ?? (along[0] < 0 ? 1 : -1));
        const out = [along[0] * sideB, along[1] * sideB];
        const stopC = [P(sB)[0] + out[0] * (roadHalf + 1.8), P(sB)[1] + out[1] * (roadHalf + 1.8)];
        const stop = GroundFrame.facing(stopC, out);
        const floor = S.fixtures.busStop(stop);
        const across = [P(sB)[0] - out[0] * (roadHalf + 12), P(sB)[1] - out[1] * (roadHalf + 12)];
        taken.push([...stopC, 4], [...across, 10]);      // and an open lot across the road, so the shelter looks out on the street
        const toward = sB > sJ ? -1 : 1, aim = P(sB + toward * 35);       // out across the street, toward the junction
        this.spots['bus stop'] = { pos: stop.at(0.4, floor + 1.65, 0.15), look: [aim[0] - out[0] * 20, floor + 2.4, aim[1] - out[1] * 20] };
        // for a bus line (BusLine): the main road runs through c along dir (s from -R to R), the bridge's deck over [a, b]
        // (its height at t = (s - a) / (b - a)), the shelter `out` of the road at s
        this.road = { c: [cx, cz], dir, R, half: roadHalf, deck, stop: { s: sB, out } };

        // houses along both streets, facing them
        const C2 = STRUCT_COLORS;
        let built = 0;
        const maxHouses = d.houses ?? 28;
        const lineHouses = (at, from, to, side, setback, skip) => {
            for (let s = from; s < to && built < maxHouses; s += r(17, 27)) {
                if (skip(s)) continue;
                for (const sg of [-1, 1]) {
                    if (rnd() < 0.18 || built >= maxHouses) continue;
                    const w = r(7, 11), dp = r(6.5, 9), off = setback + r(4, 9) + dp / 2, c0 = at(s);
                    const c = [c0[0] + side[0] * sg * off, c0[1] + side[1] * sg * off], rad = Math.hypot(w, dp) / 2;
                    if (!free(...c, rad)) continue;
                    const hf = GroundFrame.facing(c, [side[0] * sg, side[1] * sg]);
                    S.buildings.house(hf, w, dp, { type: d.houseType,
                        wallH: rnd() < 0.3 ? r(5.4, 6) : r(2.9, 3.4), pitch: r(28, 42) * DEG, eave: r(0.4, 0.7), across: rnd() < 0.35,
                        wall: C2.walls[Math.floor(rnd() * C2.walls.length)], roof: C2.roofs[Math.floor(rnd() * C2.roofs.length)],
                        chimney: rnd() < 0.4, door: r(-w / 2 + 1.2, w / 2 - 1.2),
                    });
                    taken.push([...c, rad]);
                    built++;
                }
            }
        };
        const nearJunction = s => Math.abs(s - sJ) < 16;
        lineHouses(P, -R + 12, R - 12, along, roadHalf, s => nearJunction(s) || (s > bA - 18 && s < bB + 18));
        lineHouses(Q, u0 + 8, u1 - 8, dir, 2.8, u => Math.abs(u) < 14);

        // street lamps (on by night) at the kerbs, on alternate sides, their arms over the road: none on the bridge, at
        // the junction or by the bus shelter, nor in the water
        const lamps = (at, from, to, side, half, every, skip) => {
            let k = 0;
            for (let s = from; s <= to; s += every, k++) {
                const sg = k % 2 ? 1 : -1, c = at(s), x = c[0] + side[0] * sg * (half + 0.9), z = c[1] + side[1] * sg * (half + 0.9);
                if (skip(s, sg) || water(x, z) > 0.03) continue;
                S.fixtures.lamp(x, z, [-side[0] * sg, -side[1] * sg], 'sodium');
            }
        };
        lamps(P, -R + 10, R - 10, along, roadHalf, 34, (s, sg) => (s > bA - 4 && s < bB + 4) || Math.abs(s - sJ) < 9 || (sg === sideB && Math.abs(s - sB) < 6));
        lamps(Q, u0 + 10, u1 - 10, dir, 2.8, 36, u => Math.abs(u) < 10);

        // footbridge across the river, `footbridge` m along it from the road bridge
        if (span && d.footbridge !== 0) {
            const fb = Math.abs(d.footbridge ?? 160), m = P((span[0] + span[1]) / 2), M = [m[0] + along[0] * fb, m[1] + along[1] * fb];
            const at = s => [M[0] + dir[0] * s, M[1] + dir[1] * s], fs = wetSpan(at, -260, 260);
            if (fs) {
                const a = at(fs[0] - 8), b = at(fs[1] + 8);
                S.fixtures.bridge(a, b, { width: 2.4, thick: 0.45, rise: 1.5, ramp: 7, arch: 2, deck: C.wood, rail: C.metal, pier: C.wood, pierEvery: 18, pierHalf: 0.2 });
                S.strip(at(fs[0] - 30), a, 1.1, C.gravel);
                S.strip(b, at(fs[1] + 30), 1.1, C.gravel);
            }
            const mid = (span[0] + span[1]) / 2, view = [m[0] - along[0] * 70 + dir[0] * (span[1] - mid) * 0.35, m[1] - along[1] * 70 + dir[1] * (span[1] - mid) * 0.35];
            const gy = f.sample(...view);
            this.spots.bridges = { pos: [view[0], gy + 9, view[1]], look: [M[0], gy + 3, M[1]] };
        }
        // the river's water, along its centre line through the village
        if (river) {
            const line = [];
            let prev = 0;
            for (let u = -R * 3, first = true; u <= R * 3; u += 8, first = false) {
                const o = [cx + along[0] * u, cz + along[1] * u];
                let best = Infinity, bs = prev;
                for (let s = first ? -R * 1.5 : prev - 60; s <= (first ? R * 1.5 : prev + 60); s += 2) {
                    const dd = river.distance(o[0] + dir[0] * s, o[1] + dir[1] * s);
                    if (dd < best) { best = dd; bs = s; }
                }
                prev = bs;
                line.push([o[0] + dir[0] * bs, o[1] + dir[1] * bs, halfW * (1 - smoothstep(R * 2.2, R * 3, Math.abs(u)))]);
            }
            S.water(line, dir);
        }
        const ov = [cx - dir[0] * R * 0.9 - along[0] * R * 0.6, cz - dir[1] * R * 0.9 - along[1] * R * 0.6];
        this.spots.overview = { pos: [ov[0], f.sample(...ov) + 90, ov[1]], look: [cx, f.sample(cx, cz), cz] };
    }
}

// A town's central bus station: a long cantilevered concrete canopy on one row of pillars, deep fascia, ribbed soffit and a
// glazed clerestory along its spine, over an island platform with benches, a kiosk and bay signs. Buses stand nose-in
// at the bays on one side, a drive-through lane runs along the other, and a terminal building closes one end. The ground
// is levelled under it (`level` m around `pos`). Parameters: pos, yaw (degrees; the canopy runs along it), length and
// width (m of canopy; 96 x 30), bays, buses, seed. Viewpoints (`spot`): "platform" (under the canopy), "forecourt", "overview".
class BusStation extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, r0 = d.level ?? 200, r1 = r0 + 300;
        let sum = 0, n = 0;
        f.each(cx - r0, cz - r0, cx + r0, cz + r0, (idx, x, z) => { if (Math.hypot(x - cx, z - cz) < r0) { sum += f.h[idx]; n++; } });
        const flat = n ? sum / n : f.sample(cx, cz);
        f.each(cx - r1, cz - r1, cx + r1, cz + r1, (idx, x, z) => {
            const k = 1 - smoothstep(r0, r1, Math.hypot(x - cx, z - cz));
            if (k > 0) f.h[idx] = lerp(f.h[idx], flat, k);
        });
    }

    get anchor() { const p = this.def.pos; return [p[0], this.world.field.sample(p[0], p[1]) + (this.def.labelHeight ?? 90), p[1]]; }
    get focus() { const p = this.def.pos; return [p[0], this.world.field.sample(p[0], p[1]), p[1]]; }

    build(S) {
        const d = this.def, C = STRUCT_COLORS, rnd = mulberry32(d.seed ?? 3), r = (a, b) => a + (b - a) * rnd();
        const f = new GroundFrame(d.pos, (d.yaw ?? 20) * DEG), L = (d.length ?? 96) / 2;
        const canopy = [0.80, 0.78, 0.72], pillar = [0.62, 0.60, 0.56], tiles = [0.56, 0.55, 0.52], red = [0.58, 0.12, 0.09];
        const at = (x, z) => S.ground(...f.xz(x, z));
        const foot = [];
        for (let x = -L - 34; x <= L + 16; x += 8) for (let z = -30; z <= 30; z += 6) foot.push(at(x, z));
        const gLo = Math.min(...foot) - 0.6, gHi = Math.max(...foot), plat = gHi + 0.18;

        // forecourt and lanes: concrete paving, asphalt lanes either side of the island platform, painted bays
        const strip = (x0, z0, x1, z1, col, mat, lift) => S.strip(f.xz(x0, (z0 + z1) / 2), f.xz(x1, (z0 + z1) / 2), (z1 - z0) / 2, col, mat, lift);
        strip(-L - 34, -30, L + 16, 30, tiles, 0, 0.12);
        strip(-L - 2, 7.5, L + 10, 25, C.asphalt, 3, 0.16);           // nose-in bays
        strip(-L - 2, -21, L + 10, -7.5, C.asphalt, 3, 0.16);         // drive-through lane
        const bays = d.bays ?? 20, bw = (2 * L - 4) / bays;
        for (let i = 0; i <= bays; i++) {
            const x = -L + 2 + i * bw;
            S.strip(f.xz(x, 8), f.xz(x, 21), 0.08, C.paint, 0, 0.18);
        }
        for (let x = -L; x < L + 8; x += 9) S.strip(f.xz(x, -14.2), f.xz(x + 4, -14.2), 0.08, C.paint, 0, 0.18);
        // island platform with kerbs
        S.box(f, 0, 0, L, 7.5, gLo, plat, tiles);
        for (const sz of [-1, 1]) S.box(f, 0, sz * 7.45, L, 0.12, gLo, plat + 0.02, C.concrete);

        // the canopy: slab, deep fascia with an upstand, ribs under the slab, a spine beam on the pillars, clerestory
        const hz = d.width ? d.width / 2 : 15, yt = plat + 6.2, yf = plat + 4.7, slab = yt - 0.4;
        S.box(f, 0, 0, L, hz, slab, yt, canopy);
        for (const sz of [-1, 1]) S.box(f, 0, sz * (hz - 0.15), L, 0.15, yf, yt + 0.2, canopy);
        for (const sx of [-1, 1]) S.box(f, sx * (L - 0.15), 0, 0.15, hz, yf, yt + 0.2, canopy);
        for (let x = -L + 4; x < L - 1; x += 4) S.box(f, x, 0, 0.18, hz - 0.3, slab - 0.75, slab, canopy);
        S.box(f, 0, 0, L - 0.3, 0.55, slab - 1.4, slab, pillar);
        S.box(f, 0, 0, L - 8, 3.5, yt, yt + 2.1, C.glass, 2);
        S.box(f, 0, 0, L - 7.4, 4.1, yt + 2.1, yt + 2.5, canopy);
        for (let x = -L + 8; x <= L - 8; x += 8) for (const sz of [-1, 1]) S.box(f, x, sz * 3.5, 0.08, 0.08, yt, yt + 2.1, C.metal, 4);
        const pillars = [];
        for (let x = -L + 6; x <= L - 5.9; x += 12) pillars.push(x);
        for (const x of pillars) S.box(f, x, 0, 0.45, 0.45, plat, slab - 1.4, pillar);
        // bay signs hanging under the fascia on the bays' side, and lights along the soffit
        for (let i = 0; i < bays; i++) {
            const x = -L + 2 + (i + 0.5) * bw;
            S.box(f, x, hz - 0.45, 0.32, 0.03, yf - 0.55, yf - 0.05, red, 4);
            S.box(f, x, hz - 0.49, 0.18, 0.012, yf - 0.47, yf - 0.13, [0.92, 0.92, 0.88]);
        }
        for (let x = -L + 2; x < L - 1; x += 4) for (const sz of [-hz * 0.75, -hz * 0.3, hz * 0.3, hz * 0.75]) S.box(f, x, sz, 0.6, 0.08, slab - 0.06, slab, [0.95, 0.93, 0.85], 7);
        // by night they light the platform and the lanes: a light for each stretch of them
        for (let x = -L + 8; x < L - 4; x += 14) for (const sz of [-hz * 0.55, hz * 0.55]) S.fixtures.light('canopy', f.at(x, slab - 0.35, sz));

        // on the platform: kiosk, benches, timetables, bins
        const kx = -L * 0.3;
        S.buildings.add(new GroundFrame(f.xz(kx, 2.6), f.yaw), { type: d.kioskType || 'kiosk', w: 4.4, d: 3.2, storeys: 1, floor: plat, base: plat,
            color: [0.30, 0.31, 0.30], windows: ['-z', '+z'], doors: [{ face: '+x', at: 0 }], seed: 31,
            roof: { kind: 'flat', overhang: 0.1, thick: 0.55, color: red, mat: 4, drip: false } });
        for (let i = 0; i + 1 < pillars.length; i++) {
            const x = (pillars[i] + pillars[i + 1]) / 2;
            if (Math.abs(x - kx) < 4) continue;
            for (const sz of [-1, 1]) {
                const z = sz * 4.6;
                S.box(f, x, z, 1.4, 0.22, plat + 0.42, plat + 0.48, C.wood);
                S.box(f, x, z + sz * 0.2, 1.4, 0.03, plat + 0.48, plat + 0.95, C.wood);
                for (const lx of [-1.2, 1.2]) S.box(f, x + lx, z, 0.04, 0.2, plat, plat + 0.42, C.metal, 4);
            }
            if (i % 2 === 0) {
                S.box(f, x + 3.5, 0, 0.6, 0.06, plat + 0.6, plat + 2.2, [0.85, 0.85, 0.82]);
                S.box(f, x + 3.5, 0, 0.66, 0.08, plat + 2.2, plat + 2.3, C.metal, 4);
                S.box(f, x - 4.2, 1.6, 0.22, 0.22, plat, plat + 0.9, [0.20, 0.32, 0.20], 4);
            }
        }

        // terminal building at the west end: offices and a waiting hall, window bands, a flat roof that overhangs
        const tx = -L - 18, thx = 12, thz = 13;
        S.buildings.add(new GroundFrame(f.xz(tx, 0), f.yaw), { type: d.terminalType || 'terminal', w: 2 * thx, d: 2 * thz, storeys: 2,
            base: gLo, floor: gHi + 0.15, color: [0.74, 0.72, 0.66], doors: [{ face: '+x', at: -2.4 }, { face: '+x', at: 2.4 }], seed: 17,
            roof: { kind: 'flat', overhang: 1.6, thick: 0.45, color: canopy } });
        // a bus line from here (BusLine) comes in through a gap in the railing, stops in the drive-through lane by the
        // platform, and leaves past the east end; its road runs along the south side of the town blocks (local z = road)
        const served = (this.world.scenario.entities || []).some(e => e.type === 'bus' && e.from === this.id);
        this.frame = f;
        this.busWay = served ? { lane: -9.2, road: -80, east: L + 21, gap: -L + 20, west: -L - 80, stop: 0 } : null;
        // railing along the forecourt's open side
        const gap = x => served && Math.abs(x - this.busWay.gap) < 5;
        // lamp posts along the forecourt's edges, their arms over it (none in the buses' way)
        for (let x = -L - 30; x <= L + 14; x += 19) {
            if (!(served && Math.abs(x - this.busWay.gap) < 12)) S.fixtures.lamp(...f.xz(x, -28.4), [-f.sn, f.cs], 'led', { height: 8, reach: 1.8 });
            if (x > -L - 4) S.fixtures.lamp(...f.xz(x, 28.6), [f.sn, -f.cs], 'led', { height: 8, reach: 1.8 });
        }
        for (let x = -L - 33; x <= L + 15; x += 2.5) if (!gap(x)) S.box(f, x, -29.5, 0.03, 0.03, gHi + 0.12, gHi + 1.1, C.metal, 4);
        for (const [a, b] of served ? [[-L - 33, this.busWay.gap - 5], [this.busWay.gap + 5, L + 15]] : [[-L - 33, L + 15]]) {
            S.box(f, (a + b) / 2, -29.5, (b - a) / 2, 0.03, gHi + 1.05, gHi + 1.12, C.metal, 4);
            S.box(f, (a + b) / 2, -29.5, (b - a) / 2, 0.02, gHi + 0.55, gHi + 0.6, C.metal, 4);
        }

        // buses: nose-in at some bays, one in the drive-through lane; none when a bus line runs from here (they are all
        // out on it, BusLine), though the draws are the same either way, so the town looks the same
        const bus = (bf, len) => {
            const hl = len / 2, hw = 1.27;
            const col = BUS_LIVERIES[Math.floor(rnd() * BUS_LIVERIES.length)];
            if (served) return;
            const g = Math.max(...[[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([x, z]) => S.ground(...bf.xz(x, z)))) + 0.16;
            S.box(bf, 0, 0, hl, hw, g + 0.35, g + 3.15, col, 4);
            S.box(bf, 0, 0, hl - 0.2, hw - 0.1, g + 3.15, g + 3.35, [0.82, 0.82, 0.80], 4);
            for (const sz of [-1, 1]) S.box(bf, 0.4, sz * (hw + 0.02), hl - 1.3, 0.02, g + 1.25, g + 2.75, C.window, 5);
            S.box(bf, hl + 0.02, 0, 0.02, hw - 0.12, g + 1.0, g + 2.85, C.window, 5);
            S.box(bf, -hl - 0.02, 0, 0.02, hw - 0.3, g + 1.9, g + 2.85, C.window, 5);
            for (const x of [-hl + 2.6, hl - 2.4]) for (const sz of [-1, 1]) S.box(bf, x, sz * (hw - 0.15), 0.5, 0.17, g, g + 1.0, [0.05, 0.05, 0.05]);
            S.boxes.add(bf, 0, 0, hl, hw, g, g + 3.35, 0.35);
        };
        const nBus = Math.min(d.buses ?? 5, bays);
        const used = new Set();
        for (let k = 0; k < nBus - 1; k++) {
            let i = Math.floor(rnd() * bays);
            while (used.has(i)) i = (i + 1) % bays;
            used.add(i);
            const x = -L + 2 + (i + 0.5) * bw, len = r(11.5, 12.6);
            bus(new GroundFrame(f.xz(x, 8.6 + len / 2), f.yaw + Math.PI / 2 + (rnd() < 0.5 ? Math.PI : 0)), len);
        }
        if (nBus > 0) {
            const lx = r(-L * 0.4, L * 0.4);
            bus(new GroundFrame(f.xz(lx, -11), f.yaw), 12.2);
        }

        // town-centre blocks around the forecourt: flat roofs, window bands per storey
        const blocks = [[-L - 10, 52, 22, 9], [-L + 40, 50, 16, 8], [-L + 82, 54, 24, 10], [L + 4, 48, 14, 9],
            [L + 38, 6, 10, 20], [-L - 10, -52, 24, 10], [-L + 44, -50, 18, 9], [L - 6, -54, 20, 11], [-L - 62, 6, 9, 18]];
        // each with its door on the side facing the forecourt
        blocks.forEach(([bx, bz, bhx, bhz], k) => {
            const storeys = 2 + Math.floor(rnd() * 4), col = C.walls[Math.floor(rnd() * C.walls.length)];
            const face = Math.abs(bx) - L > Math.abs(bz) ? (bx > 0 ? '-x' : '+x') : (bz > 0 ? '-z' : '+z');
            S.buildings.add(new GroundFrame(f.xz(bx, bz), f.yaw), { type: d.blockType || 'block', w: 2 * bhx, d: 2 * bhz, storeys, base: gLo,
                floor: gHi + 0.3, color: col, doors: [{ face, at: r(-3, 3) }], seed: 101 + k, roof: { kind: 'flat', overhang: 0.25, thick: 0.5, color: C.concrete, drip: false } });
        });

        // shader boxes: the canopy slab (dry under it: its box starts at the slab, since a point inside a box is not
        // sheltered by it), the fascia as thin boxes round its edges (they keep slanting rain off), the clerestory, the
        // pillars (sun shadows); rain runs off the fascia's edges
        S.boxes.add(f, 0, 0, L, hz, slab, yt + 0.2, 0.55, 0, gLo);
        for (const sz of [-1, 1]) S.boxes.add(f, 0, sz * (hz - 0.15), L, 0.15, yf, slab, 0);
        for (const sx of [-1, 1]) S.boxes.add(f, sx * (L - 0.15), 0, 0.15, hz - 0.3, yf, slab, 0);
        S.boxes.add(f, 0, 0, L - 7.4, 4.1, yt, yt + 2.5, 0.2, 0, gLo);
        for (const x of pillars) S.boxes.add(f, x, 0, 0.45, 0.45, plat, slab - 1.4, 0);
        S.boxes.drip(f, 0, 0, L, hz, yf, yf - plat + 0.18);

        this.spots = {
            platform: { pos: f.at(-L * 0.55, plat + 1.65, -2.2), look: f.at(-L * 0.05, plat + 2.4, 24) },
            forecourt: { pos: f.at(-L - 4, gHi + 1.7, -27), look: f.at(-L * 0.45, plat + 3.8, 2) },
            overview: { pos: f.at(-L - 70, gHi + 34, -80), look: f.at(-L * 0.2, gHi, 0) },
        };
    }
}

return { Village, BusStation };
});
