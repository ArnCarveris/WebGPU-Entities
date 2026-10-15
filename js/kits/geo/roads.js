'use strict';
// Mapped roads as drawn: each a ribbon along its line with its corners rounded into curves, on the ground as drawn (or a
// bridge's deck between its ends, on piers), with its markings; into a world's TiledMesh (Structures.bulk).

Features.kit('geo', (engine, kit) => {
const { Common, kits } = engine;
const { lerp, GroundFrame } = Common;
const { TiledMesh, KINDS, PALETTE } = kits.mesh;
const { toPoints, roundCorners, densify, frames } = kit;

// what each highway class is drawn as: its width (m) two-way, one-way, per lane (with a lane count), the corner radius
// its curves are rounded to (m), how far it stands over the ground (m: the bigger road wins where two meet), its colour
// (COLORS) and markings (US style: yellow between the directions, white edges and lanes)
const ROAD_TYPES = {
    motorway: { w: 24, one: 12, lane: 3.6, r: 450, lift: 0.36, marks: 'lanes' },
    trunk: { w: 16, one: 9, lane: 3.5, r: 250, lift: 0.35, marks: 'lanes' },
    primary: { w: 13, one: 8, lane: 3.4, r: 150, lift: 0.34, marks: 'lanes' },
    secondary: { w: 11, one: 7, lane: 3.3, r: 90, lift: 0.33, marks: 'lanes' },
    tertiary: { w: 9, one: 6, lane: 3.2, r: 50, lift: 0.32, marks: 'centre' },
    motorway_link: { w: 9, one: 6, lane: 3.6, r: 120, lift: 0.355, marks: 'edges' },
    trunk_link: { w: 8, one: 5.5, lane: 3.4, r: 70, lift: 0.345, marks: 'edges' },
    primary_link: { w: 8, one: 5.5, lane: 3.4, r: 50, lift: 0.335, marks: 'edges' },
    secondary_link: { w: 7.5, one: 5, lane: 3.3, r: 40, lift: 0.325 },
    tertiary_link: { w: 7, one: 5, lane: 3.2, r: 30, lift: 0.315 },
    unclassified: { w: 6.5, lane: 3, r: 30, lift: 0.3 },
    residential: { w: 7, lane: 3, r: 20, lift: 0.3 },
    living_street: { w: 5.5, lane: 3, r: 12, lift: 0.29 },
    road: { w: 6, lane: 3, r: 20, lift: 0.29 },
    busway: { w: 4, lane: 3.5, r: 40, lift: 0.29 },
    service: { w: 4.5, lane: 3, r: 8, lift: 0.27 },
    pedestrian: { w: 5, r: 8, lift: 0.26, color: 'paving' },
    track: { w: 3, r: 10, lift: 0.22, color: 'gravel' },
    footway: { w: 2, r: 3, lift: 0.25, color: 'paving' },
    cycleway: { w: 2.4, r: 6, lift: 0.25, color: 'paving' },
    path: { w: 1.4, r: 3, lift: 0.2, color: 'dirt' },
    steps: { w: 2, r: 0, lift: 0.25, color: 'paving' },
};
const COLORS = { asphalt: PALETTE.asphalt, paving: [0.42, 0.41, 0.39], gravel: PALETTE.gravel, dirt: [0.30, 0.24, 0.17], concrete: PALETTE.concrete,
    white: [0.72, 0.72, 0.68], yellow: [0.72, 0.52, 0.08] };
const ROAD = KINDS.indexOf('road'), MATTE = KINDS.indexOf('matte');
// the data's road flags (tools/geo-import.mjs)
const BRIDGE = 1, TUNNEL = 2, ONEWAY = 4, MINOR = 8;
const STEP = 5;              // m: the ground is sampled this often along a road...
const TOL = 0.05;            // ...and a sample dropped where the road between its neighbours stays this close to it (m)
const MAX_LEN = 60;          // m: the longest piece of ribbon
const DECK = 1.2;            // m: a bridge deck's depth; its parapets stand PARAPET over it, its piers every PIER_EVERY
const PARAPET = 0.85, PIER_EVERY = 36;
const MARK = 0.03;           // m: markings over the road

const roadWidth = (r, T) => {
    if (r.width > 1.5) return r.width;
    const one = r.flags & ONEWAY;
    if (r.lanes && T.lane) return r.lanes * T.lane + (one ? 1.5 : 1);
    return one && T.one ? T.one : T.w;
};

// the samples to keep (indices): where the road would leave the ground (or its curve) by more than TOL without them
function simplify(pts, yl, yr, along) {
    const n = pts.length, keep = [0];
    let a = 0;
    for (let e = 2; e < n; e++) {
        let ok = along[e] - along[a] <= MAX_LEN;
        for (let j = a + 1; ok && j < e; j++) {
            const t = (along[j] - along[a]) / (along[e] - along[a]);
            ok = Math.hypot(lerp(pts[a][0], pts[e][0], t) - pts[j][0], lerp(pts[a][1], pts[e][1], t) - pts[j][1]) < 0.08
                && Math.abs(lerp(yl[a], yl[e], t) - yl[j]) < TOL && Math.abs(lerp(yr[a], yr[e], t) - yr[j]) < TOL;
        }
        if (!ok) { keep.push(e - 1); a = e - 1; }
    }
    if (n > 1) keep.push(n - 1);
    return keep;
}

// A strip along a road's kept samples (K: { p, side, yl, yr, along, hw }) from offset o0 to o1 across it (m, 0 the
// centre line), `lift` over its surface; with a dash pattern [on, period] (m) only the dashes
function strip(mesh, K, o0, o1, lift, color, dash = null) {
    const n = K.p.length, at = (k, o) => {
        const p = K.p[k], s = K.side[k], y = lerp(K.yl[k], K.yr[k], (o + K.hw) / (2 * K.hw)) + lift;
        return [p[0] + s[0] * o, y, p[1] + s[1] * o];
    };
    if (!dash) {
        let tile = null, pa = null, pb = null, qa = null, qb = null;
        for (let k = 0; k < n; k++) {
            const a = at(k, o0), b = at(k, o1), t = mesh.at(K.p[k][0], K.p[k][1]);
            if (t !== tile) { if (k) { pa = mesh.vertex(t, ...qa, color); pb = mesh.vertex(t, ...qb, color); } tile = t; }
            const ia = mesh.vertex(t, ...a, color), ib = mesh.vertex(t, ...b, color);
            if (k) { mesh.tri(t, pa, ia, ib); mesh.tri(t, pa, ib, pb); }
            pa = ia; pb = ib; qa = a; qb = b;
        }
        return;
    }
    // dashes: [s, s + on] every period along the road, each one quad between the samples round its ends
    const [on, period] = dash, L = K.along[n - 1];
    let k = 0;
    const point = (s, o) => {
        while (k < n - 2 && K.along[k + 1] < s) k++;
        const t = (s - K.along[k]) / Math.max(K.along[k + 1] - K.along[k], 1e-6), a = at(k, o), b = at(k + 1, o);
        return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    };
    for (let s = period / 2; s + on < L; s += period) {
        const a0 = point(s, o0), a1 = point(s, o1), b0 = point(s + on, o0), b1 = point(s + on, o1);
        mesh.quad(mesh.at(a0[0], a0[2]), a0, a1, b1, b0, color);
    }
}

// a box from y0 to y1 about [x, z], half sizes hx along `dir` and hz across it
function block(mesh, x, z, dir, hx, hz, y0, y1, color) {
    const ax = [dir[0] * hx, dir[1] * hx], az = [-dir[1] * hz, dir[0] * hz], t = mesh.at(x, z);
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [x + ax[0] * u + az[0] * v, z + ax[1] * u + az[1] * v]);
    const v = c.flatMap(([px, pz]) => [mesh.vertex(t, px, y0, pz, color), mesh.vertex(t, px, y1, pz, color)]);
    for (let e = 0; e < 4; e++) { const a = e * 2, b = ((e + 1) % 4) * 2; mesh.tri(t, v[a], v[b], v[b + 1]); mesh.tri(t, v[a], v[b + 1], v[a + 1]); }
    mesh.tri(t, v[1], v[3], v[5]); mesh.tri(t, v[1], v[5], v[7]);
}

// Keeps the field's procedural detail off the roads buildRoads lays (the same skip / minor), and a margin round them
// (LandField.keepSmooth), so the ground they are laid on is the ground drawn under them
function smoothRoads(field, data, { skip = [], minor = true } = {}) {
    if (!field.rough) return;
    for (const r of data.roads) {
        const T = ROAD_TYPES[r.kind];
        if (!T || skip.includes(r.kind) || (r.flags & TUNNEL) || (!minor && (r.flags & MINOR))) continue;
        const pts = toPoints(r.pts);
        if (pts.length < 2) continue;
        const r0 = roadWidth(r, T) / 2 + 4;
        for (const p of densify(pts, field.mcell / 2)) field.keepSmooth(p[0], p[1], r0);
    }
}

// The roads of `data` (the geo kit's roadData) into S.bulk (the world's TiledMesh), standing on S.ground; the bridge
// decks walkable (S.solids). opts: skip (highway classes left out), minor (driveways and parking aisles; default true),
// curves (round the corners; default true), marks (default true). Tunnels are left out (they are under the ground).
// Returns { roads, bridges, km }
function buildRoads(S, data, { skip = [], minor = true, curves = true, marks = true } = {}) {
    const mesh = S.bulk, out = { roads: 0, bridges: 0, km: 0 };
    const col = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, TiledMesh.color(c, k === 'asphalt' ? ROAD : MATTE)]));
    for (const r of data.roads) {
        const T = ROAD_TYPES[r.kind];
        if (!T || skip.includes(r.kind) || (r.flags & TUNNEL) || (!minor && (r.flags & MINOR))) continue;
        let pts = toPoints(r.pts);
        if (pts.length < 2) continue;
        if (curves) pts = roundCorners(pts, T.r);
        pts = densify(pts, STEP);
        const { side, along } = frames(pts), n = pts.length, hw = roadWidth(r, T) / 2, bridge = !!(r.flags & BRIDGE);
        const yl = new Float32Array(n), yr = new Float32Array(n);
        if (bridge) {
            // the deck: straight from its ends' ground, never under the ground
            const g = k => S.ground(pts[k][0], pts[k][1]) + T.lift, y0 = g(0), y1 = g(n - 1), L = along[n - 1] || 1;
            for (let k = 0; k < n; k++) {
                const p = pts[k], s = side[k];
                yl[k] = yr[k] = Math.max(lerp(y0, y1, along[k] / L), S.ground(p[0] - s[0] * hw, p[1] - s[1] * hw) + T.lift,
                    S.ground(p[0] + s[0] * hw, p[1] + s[1] * hw) + T.lift, g(k));
            }
        } else {
            for (let k = 0; k < n; k++) {
                const p = pts[k], s = side[k];
                yl[k] = S.ground(p[0] - s[0] * hw, p[1] - s[1] * hw) + T.lift;
                yr[k] = S.ground(p[0] + s[0] * hw, p[1] + s[1] * hw) + T.lift;
            }
        }
        const keep = simplify(pts, yl, yr, along);
        const K = { p: keep.map(k => pts[k]), side: keep.map(k => side[k]), yl: keep.map(k => yl[k]), yr: keep.map(k => yr[k]), along: keep.map(k => along[k]), hw };
        const surface = col[T.color || 'asphalt'];
        strip(mesh, K, -hw, hw, 0, surface);
        out.roads++;
        out.km += along[n - 1] / 1000;
        if (bridge) { bridgeUnder(S, mesh, K, col.concrete); out.bridges++; }
        if (!marks || !T.marks || hw < 2.5) continue;
        // markings: white edge lines; two-way, a double yellow line between the directions; white dashes between lanes
        const one = !!(r.flags & ONEWAY), w = col.white, y = col.yellow, e = hw - 0.45, line = 0.08;
        if (T.marks !== 'centre') { strip(mesh, K, -e - line, -e + line, MARK, w); strip(mesh, K, e - line, e + line, MARK, w); }
        if (!one && T.marks !== 'edges') { strip(mesh, K, -0.25, -0.1, MARK, y); strip(mesh, K, 0.1, 0.25, MARK, y); }
        if (T.marks === 'lanes') {
            const lanes = r.lanes || Math.max(1, Math.round(2 * e / T.lane)), dirs = one ? 1 : 2, per = Math.max(1, Math.round(lanes / dirs));
            for (let d = 0; d < dirs; d++) for (let l = 1; l < per; l++) {
                const span = one ? 2 * e : e, o = (one ? -e : d ? 0 : -e) + span * l / per;
                strip(mesh, K, o - line, o + line, MARK, w, [3, 12]);
            }
        }
    }
    return out;
}

// a bridge under its deck: the deck's edges down DECK, its underside, low parapets along both sides, piers where it
// stands high, and the solids a walker stands on (a sloped box per piece)
function bridgeUnder(S, mesh, K, color) {
    const n = K.p.length, hw = K.hw;
    const edge = (k, o, dy) => { const p = K.p[k], s = K.side[k]; return [p[0] + s[0] * o, K.yl[k] + dy, p[1] + s[1] * o]; };
    let last = -Infinity;
    for (let k = 0; k + 1 < n; k++) {
        const t = mesh.at(K.p[k][0], K.p[k][1]);
        for (const o of [-hw, hw]) {
            mesh.quad(t, edge(k, o, -DECK), edge(k + 1, o, -DECK), edge(k + 1, o, 0), edge(k, o, 0), color);
            mesh.quad(t, edge(k, o, 0), edge(k + 1, o, 0), edge(k + 1, o, PARAPET), edge(k, o, PARAPET), color);
        }
        mesh.quad(t, edge(k, -hw, -DECK), edge(k + 1, -hw, -DECK), edge(k + 1, hw, -DECK), edge(k, hw, -DECK), color);
        const a = K.p[k], b = K.p[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > 0.01) {
            const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], f = new GroundFrame([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Math.atan2(dir[1], dir[0]));
            const top = (K.yl[k] + K.yl[k + 1]) / 2 - 0.02;
            S.solids.add(f, 0, 0, len / 2, hw, top - DECK, top, (K.yl[k + 1] - K.yl[k]) / len);
            for (const o of [-hw + 0.1, hw - 0.1]) S.solids.add(f, 0, o, len / 2, 0.1, top, top + PARAPET, (K.yl[k + 1] - K.yl[k]) / len);
        }
        // a pier every PIER_EVERY m where the deck stands 4 m or more over the ground
        if (K.along[k] - last >= PIER_EVERY && k > 0) {
            const p = K.p[k], g = S.ground(p[0], p[1]);
            if (K.yl[k] - DECK - g > 4) {
                const s = K.side[k], dir = [s[1], -s[0]];
                for (const o of hw > 7 ? [-hw * 0.55, hw * 0.55] : [0]) block(mesh, p[0] + s[0] * o, p[1] + s[1] * o, dir, 0.9, 0.9, g - 1, K.yl[k] - DECK, color);
                last = K.along[k];
            }
        }
    }
}

return { ROAD_TYPES, buildRoads, smoothRoads };
});
