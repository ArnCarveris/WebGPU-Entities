'use strict';
// Mapped buildings as drawn: each footprint's walls stood up from the ground as drawn to its height (mapped, from its
// levels, else its kind's), under a flat roof, or a hipped one on a small house; into a world's TiledMesh
// (Structures.bulk). Walls a walker bumps into come from the footprints when asked (a Solids source), not stored.

Features.kit('geo', (engine, kit) => {
const { kits } = engine;
const { TiledMesh, KINDS, g2 } = kits.mesh;
const { mulberry32 } = kits.noise;

// what each kind of building is when its map says nothing: its height (m; null: by its size), whether it is a house
// (hipped roof when it is a plain rectangle, house colours), how high its walls start (m: a roof on posts)
const BUILDING_TYPES = {
    house: { h: 4.2, house: true }, detached: { h: 4.2, house: true }, semidetached_house: { h: 4.5, house: true }, terrace: { h: 5, house: true },
    bungalow: { h: 4, house: true }, cabin: { h: 3.5, house: true }, hut: { h: 3, house: true }, farm: { h: 5, house: true },
    residential: { h: null, house: true }, apartments: { h: 12 }, dormitory: { h: 10 },
    garage: { h: 2.8 }, garages: { h: 2.8 }, shed: { h: 2.6 }, kiosk: { h: 3 }, service: { h: 3.5 }, greenhouse: { h: 4 }, barn: { h: 6 },
    roof: { h: 3.4, min: 2.8 }, carport: { h: 2.8, min: 2.3 }, grandstand: { h: 10 }, stadium: { h: 18 },
    commercial: { h: 7 }, retail: { h: 6 }, office: { h: 14 }, industrial: { h: 8 }, warehouse: { h: 9 }, hangar: { h: 12 },
    school: { h: 7 }, university: { h: 10 }, hospital: { h: 16 }, church: { h: 9 }, temple: { h: 7 }, hotel: { h: 24 },
    public: { h: 8 }, civic: { h: 8 }, government: { h: 10 }, parking: { h: 10 }, military: { h: 6 }, train_station: { h: 8 },
    transportation: { h: 7 }, construction: { h: 4 },
};
const LEVEL = 3.3;           // m per storey
const HIP = 22 * Math.PI / 180;
const FACADE = 7;            // m: walls this tall get windows (the renderer's facade material), lower ones are plain
const PALETTES = {
    houseWalls: [[0.82, 0.80, 0.74], [0.77, 0.72, 0.62], [0.62, 0.70, 0.60], [0.66, 0.72, 0.76], [0.80, 0.70, 0.56], [0.86, 0.85, 0.81], [0.72, 0.60, 0.48]],
    houseRoofs: [[0.20, 0.21, 0.22], [0.30, 0.24, 0.20], [0.24, 0.32, 0.29], [0.36, 0.20, 0.16], [0.44, 0.44, 0.42], [0.18, 0.24, 0.30]],
    walls: [[0.72, 0.71, 0.68], [0.62, 0.60, 0.56], [0.80, 0.78, 0.72], [0.56, 0.58, 0.60], [0.76, 0.72, 0.64], [0.68, 0.66, 0.70]],
    roofs: [[0.64, 0.64, 0.62], [0.46, 0.46, 0.45], [0.78, 0.78, 0.76], [0.36, 0.36, 0.37]],
    shedWalls: [[0.56, 0.59, 0.61], [0.64, 0.63, 0.58], [0.50, 0.52, 0.50]],
};
const SHEDS = new Set(['industrial', 'warehouse', 'hangar', 'garage', 'garages', 'shed', 'roof', 'carport', 'service', 'greenhouse', 'barn', 'parking']);
const MATTE = KINDS.indexOf('matte'), PAINT = KINDS.indexOf('paint'), FACADE_MAT = KINDS.indexOf('facade');

// how tall b stands (m) over its footprint of `area` m^2, and from where its walls start
function heights(b, area, rnd) {
    const T = BUILDING_TYPES[b.kind] || {};
    let h = b.height;
    if (!h && b.levels) h = b.levels * LEVEL + b.roofLevels * 1.5 + 0.6;
    if (!h) h = T.h ?? (area < 60 ? 3 : area < 300 ? 4.5 : area < 1200 ? 7 : area < 5000 ? 9 : 11);
    if (!b.height && !b.levels) h *= 0.9 + 0.2 * rnd();
    return { h, min: b.minHeight || T.min || 0, house: !!T.house || (b.kind === 'yes' && area < 300) };
}

// a near-rectangle (4 corners, square to within 12 degrees): [centre, long axis unit, long half, short half] or null
function rectangle(p) {
    if (p.length !== 4) return null;
    const e = k => [p[(k + 1) % 4][0] - p[k][0], p[(k + 1) % 4][1] - p[k][1]];
    for (let k = 0; k < 4; k++) {
        const a = e(k), b = e((k + 1) % 4), c = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
        if (Math.abs(c) > 0.2) return null;
    }
    const a = e(0), b = e(1), la = Math.hypot(...a), lb = Math.hypot(...b), long = la >= lb ? a : b, ll = Math.max(la, lb);
    const c = [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4];
    return [c, [long[0] / ll, long[1] / ll], ll / 2, Math.min(la, lb) / 2];
}

// The buildings of `data` (the geo kit's buildingData) into S.bulk, standing on S.ground; their walls as a source of
// S.solids. opts: seed. Returns { buildings, houses, triangles }
function buildBuildings(S, data, { seed = 7 } = {}) {
    const mesh = S.bulk, out = { buildings: 0, houses: 0 }, rnd = mulberry32(seed);
    const pick = list => list[Math.floor(rnd() * list.length)];
    // what the walls source keeps per building: its ring's first point in `ring`, its point count, bottom and top
    const ring = [], first = [], count = [], bottom = [], top = [];
    for (const b of data.buildings) {
        const flat = b.pts, n = flat.length / 2;
        if (n < 3) continue;
        const pts = [];
        for (let k = 0; k < n; k++) pts.push([flat[k * 2], flat[k * 2 + 1]]);
        const area = g2.area(pts);
        if (!(area > 2)) continue;
        const H = heights(b, area, rnd), sheds = SHEDS.has(b.kind);
        let g0 = Infinity, g1 = -Infinity;
        for (const [x, z] of pts) { const g = S.ground(x, z); g0 = Math.min(g0, g); g1 = Math.max(g1, g); }
        const y0 = H.min ? g1 + H.min : g0 - 0.4, y1 = g1 + H.h;
        const wall = TiledMesh.color(pick(H.house ? PALETTES.houseWalls : sheds ? PALETTES.shedWalls : PALETTES.walls), H.h - (H.min || 0) >= FACADE && !H.house && !sheds ? FACADE_MAT : MATTE);
        const roof = TiledMesh.color(pick(H.house ? PALETTES.houseRoofs : PALETTES.roofs), PAINT);
        const t = mesh.at(pts[0][0], pts[0][1]);
        // walls: a ring of vertices at the bottom and one at the top (flat-shaded: the renderer derives the faces)
        const lo = pts.map(([x, z]) => mesh.vertex(t, x, y0, z, wall)), hi = pts.map(([x, z]) => mesh.vertex(t, x, y1, z, wall));
        for (let k = 0; k < n; k++) { const j = (k + 1) % n; mesh.tri(t, lo[k], lo[j], hi[j]); mesh.tri(t, lo[k], hi[j], hi[k]); }
        // the roof: hipped on a small rectangular house, else flat (and its underside, for a roof on posts)
        const R = H.house && area < 600 ? rectangle(pts) : null;
        if (R) {
            const [c, u, hl, hs] = R, v = [-u[1], u[0]], rise = hs * Math.tan(HIP), r = hl - hs;
            const ridge = [-1, 1].map(s => mesh.vertex(t, c[0] + u[0] * r * s, y1 + rise, c[1] + u[1] * r * s, roof));
            const eave = pts.map(([x, z]) => mesh.vertex(t, x, y1, z, roof));
            for (let k = 0; k < 4; k++) {
                const j = (k + 1) % 4, m = [(pts[k][0] + pts[j][0]) / 2 - c[0], (pts[k][1] + pts[j][1]) / 2 - c[1]];
                const along = m[0] * u[0] + m[1] * u[1], across = m[0] * v[0] + m[1] * v[1];
                if (Math.abs(along) > Math.abs(across)) mesh.tri(t, eave[k], eave[j], ridge[along > 0 ? 1 : 0]);    // a hip end
                else {                                                                                            // a long side
                    const rk = ((pts[k][0] - c[0]) * u[0] + (pts[k][1] - c[1]) * u[1]) > 0 ? 1 : 0;
                    mesh.tri(t, eave[k], eave[j], ridge[1 - rk]); mesh.tri(t, eave[k], ridge[1 - rk], ridge[rk]);
                }
            }
            out.houses++;
        } else {
            const tris = g2.triangulate(pts), at = new Map(), vtx = ([x, z]) => {
                const key = `${x},${z}`;
                if (!at.has(key)) at.set(key, mesh.vertex(t, x, y1, z, roof));
                return at.get(key);
            };
            for (const [a, b2, c] of tris) mesh.tri(t, vtx(a), vtx(b2), vtx(c));
            if (H.min) {
                const under = new Map(), uv = ([x, z]) => { const key = `${x},${z}`; if (!under.has(key)) under.set(key, mesh.vertex(t, x, y0, z, wall)); return under.get(key); };
                for (const [a, b2, c] of tris) mesh.tri(t, uv(a), uv(b2), uv(c));
            }
        }
        first.push(ring.length / 2); count.push(n); bottom.push(y0); top.push(H.min ? y1 + 0.3 : y1);
        for (const [x, z] of pts) ring.push(x, z);
        out.buildings++;
    }
    S.solids.sources.push(new FootprintWalls(Float32Array.from(ring), first, count, bottom, top));
    return out;
}

// The footprints' walls as Solids boxes (Solids.near asks its sources): a 64 m grid of the buildings over their
// footprints, and each building's wall boxes (one thin box per side) made when first asked for, a few thousand kept
const WALL = 0.2;
class FootprintWalls {
    constructor(ring, first, count, bottom, top) {
        Object.assign(this, { ring, first, count, bottom, top });
        this.G = 64;
        this.grid = new Map();
        this.made = new Map();
        for (let b = 0; b < first.length; b++) {
            let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
            for (let k = 0; k < count[b]; k++) { const x = ring[(first[b] + k) * 2], z = ring[(first[b] + k) * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
            for (let i = Math.floor(x0 / this.G); i <= Math.floor(x1 / this.G); i++) for (let j = Math.floor(z0 / this.G); j <= Math.floor(z1 / this.G); j++) {
                const key = i * 65536 + j;
                if (!this.grid.has(key)) this.grid.set(key, []);
                this.grid.get(key).push(b);
            }
        }
    }

    walls(b) {
        let w = this.made.get(b);
        if (w) return w;
        if (this.made.size > 4000) this.made.clear();
        w = [];
        const { ring, first, count } = this, n = count[b], hy = (this.top[b] - this.bottom[b]) / 2;
        for (let k = 0; k < n; k++) {
            const a = (first[b] + k) * 2, c = (first[b] + (k + 1) % n) * 2, dx = ring[c] - ring[a], dz = ring[c + 1] - ring[a + 1], l = Math.hypot(dx, dz);
            if (l < 0.05) continue;
            // (its outer face on the footprint's edge: a ring of positive area has its inside to the left of each side, (-sn, cs))
            const cs = dx / l, sn = dz / l, ox = -sn * WALL / 2, oz = cs * WALL / 2;
            w.push({ x: (ring[a] + ring[c]) / 2 + ox, z: (ring[a + 1] + ring[c + 1]) / 2 + oz, hx: l / 2 + WALL / 2, hz: WALL / 2, cs, sn, y0: this.bottom[b], y1: this.top[b], slope: 0 });
        }
        this.made.set(b, w);
        return w;
    }

    // the wall boxes of the buildings within r of x, z
    near(x, z, r) {
        const G = this.G, out = [], seen = new Set();
        for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++)
            for (let j = Math.floor((z - r) / G); j <= Math.floor((z + r) / G); j++) for (const b of this.grid.get(i * 65536 + j) || []) {
                if (seen.has(b)) continue;
                seen.add(b);
                for (const w of this.walls(b)) out.push(w);
            }
        return out;
    }
}

// Keeps the field's procedural detail off the buildings' plots and a margin round them (LandField.keepSmooth)
function smoothBuildings(field, data) {
    if (!field.rough) return;
    for (const b of data.buildings) {
        const f = b.pts, n = f.length / 2;
        if (n < 3) continue;
        let cx = 0, cz = 0, r = 0;
        for (let k = 0; k < n; k++) { cx += f[k * 2] / n; cz += f[k * 2 + 1] / n; }
        for (let k = 0; k < n; k++) r = Math.max(r, Math.hypot(f[k * 2] - cx, f[k * 2 + 1] - cz));
        field.keepSmooth(cx, cz, r + 3);
    }
}

return { BUILDING_TYPES, buildBuildings, smoothBuildings, FootprintWalls };
});
