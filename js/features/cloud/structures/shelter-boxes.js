'use strict';
// Shader boxes (WGSL_SHELTER) that cast sun shadows and keep rain off, and the roof edges rain runs off: kept, written
// into the frame uniform near the camera, and tested on the CPU as the shaders do.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { clamp } = Common;
const { GridHash } = kits.interior;
const { BLOCK_RANGE, MAX_BLOCKERS, BLOCK_GRID, MAX_DRIPS, DRIP_DENSITY, DRIP_PARTICLES } = feature;

class ShelterBoxes {
    constructor() {
        this.list = [];              // { x, z, hx, hz, cs, sn, y0, y1, ao, slope, base, enclosed, dyn }
        this.drips = [];
        this.listed = null;          // the boxes in the frame uniform now
        this.hashed = -1;            // static boxes and drip edges in grids (GridHash), so the frame's range queries cost
                                     // the cells near the camera, not the world's boxes; moving ones (`dyn`) listed apart
    }

    // (re)bucket the boxes and drip edges when some were added
    rehash() {
        if (this.hashed === this.list.length + this.drips.length) return;
        this.hashed = this.list.length + this.drips.length;
        this.grid = new GridHash(512);
        this.dyn = [];
        this.reach = 0;
        for (const b of this.list) {
            if (b.dyn) { this.dyn.push(b); continue; }
            const r = Math.hypot(b.hx, b.hz);
            this.reach = Math.max(this.reach, r);
            this.grid.insert(b, b.x - r, b.z - r, b.x + r, b.z + r);
        }
        this.dripGrid = new GridHash(64);
        for (const e of this.drips) { const r = Math.hypot(e.hx, e.hz); this.dripGrid.insert(e, e.x - r, e.z - r, e.x + r, e.z + r); }
    }

    // the boxes / drip edges whose cells lie within `range` (plus their own size) of p
    nearBoxes(p, range) {
        const out = [], R = range + this.reach;
        this.grid.each(p[0] - R, p[2] - R, p[0] + R, p[2] + R, b => out.push(b));
        return out.concat(this.dyn);
    }

    // a shader box (see WGSL_SHELTER): frame f around local (ox, oz), half sizes, bottom / top at its centre, sky
    // occlusion under it, slope (m per m along local x), the lowest ground it shades (default: its bottom), and enclosed
    // (a building's interior: what is inside it is sheltered whichever way the rain blows, blockerRain)
    add(f, ox, oz, hx, hz, y0, y1, ao = 0, slope = 0, base = y0, enclosed = false) {
        const [x, z] = f.xz(ox, oz);
        this.list.push({ x, z, hx, hz, cs: f.cs, sn: f.sn, y0, y1, ao, slope, base, enclosed });
    }

    // a roof edge rain runs off (see drip in WGSL): the rectangle around local (ox, oz) in frame f, half sizes hx, hz, at
    // height y, `drop` m above the ground; alongX: only its two edges along local x drip (a gable roof's eaves)
    drip(f, ox, oz, hx, hz, y, drop, alongX = false) {
        const [x, z] = f.xz(ox, oz);
        this.drips.push({ x, z, hx, hz, cs: f.cs, sn: f.sn, y, drop, alongX, per: alongX ? 4 * hx : 4 * (hx + hz) });
    }

    // the roof edges near `around` that rain runs off (returns how many), and the boxes nearest it into the frame uniform, their bounds, and the grid of which boxes can shade each cell,
    // for this sun (sunDir) and wind ([x, z]; snow, which blows further, when the freezing level is near the boxes)
    write(F, around, sunDir, wind, freezing, fall = 9.5) {
        this.rehash();
        const drips = this.writeDrips(F, around);
        // the boxes within BLOCK_RANGE (the village and the bus station lie kilometres apart: one grid over both would
        // be too coarse to help), nearest first when there are too many
        const d = b => Math.hypot(b.x - around[0], b.z - around[2]);
        let list = this.nearBoxes(around, BLOCK_RANGE).filter(b => d(b) < BLOCK_RANGE + Math.hypot(b.hx, b.hz));
        // in the order they were added, as a scan of the whole list would give them
        if (list.length > 1) { const at = this.order ??= new Map(); if (at.size !== this.list.length) { at.clear(); this.list.forEach((b, i) => at.set(b, i)); } list.sort((p, q) => at.get(p) - at.get(q)); }
        if (list.length > MAX_BLOCKERS) list = list.sort((p, q) => d(p) - d(q)).slice(0, MAX_BLOCKERS);
        if (!list.length) { F.set('blocks', [0, 0, 0, 0]); this.listed = null; this.gridBox = null; return drips; }
        // moving boxes (the bus, `dyn`) are rewritten every frame
        if (!this.listed || list.length !== this.listed.length || list.some((b, i) => b !== this.listed[i] || b.dyn)) {
            this.listed = list;
            this.data ??= new Float32Array(MAX_BLOCKERS * 12);
            this.data.fill(0);
            list.forEach((b, i) => this.data.set([b.x, b.z, b.hx, b.hz, b.cs, b.sn, b.y0, b.y1, b.ao, b.slope, b.dyn ? 1 : 0, b.enclosed ? 1 : 0], i * 12));
            this.lo = Math.min(...list.map(b => Math.min(b.base, b.y0 - Math.abs(b.slope) * b.hx)));
            this.hi = Math.max(...list.map(b => b.y1 + Math.abs(b.slope) * b.hx));
        }
        // a box shades what lies down-sun of it (its sun shadow) and downwind of it (its rain shadow), as far as a ray
        // from the ground under it climbs to its top: a capsule each way from its centre, as wide as the box
        const snow = freezing < this.hi + 250, wl = Math.hypot(...wind);
        if (snow) fall = 1.35;
        const sunL = Math.hypot(sunDir[0], sunDir[2]), sunUp = sunDir[1] > 0 && sunL > 1e-4;
        const sunSlant = sunUp ? Math.min(sunL / Math.max(sunDir[1], 0.05), 20) : 0, rainSlant = wl * 0.8 / fall;
        const caps = list.map(b => {
            const h = b.y1 + Math.abs(b.slope) * b.hx - b.base, r = Math.hypot(b.hx, b.hz) + 1;
            const ls = Math.min(h * sunSlant, 400), lr = Math.min(h * rainSlant, 400);
            const sunEnd = sunUp ? [b.x - sunDir[0] / sunL * ls, b.z - sunDir[2] / sunL * ls] : [b.x, b.z];
            const rainEnd = wl > 1e-4 ? [b.x + wind[0] / wl * lr, b.z + wind[1] / wl * lr] : [b.x, b.z];
            return { r, segs: [sunEnd, rainEnd], x0: Math.min(b.x, sunEnd[0], rainEnd[0]) - r, x1: Math.max(b.x, sunEnd[0], rainEnd[0]) + r,
                z0: Math.min(b.z, sunEnd[1], rainEnd[1]) - r, z1: Math.max(b.z, sunEnd[1], rainEnd[1]) + r };
        });
        const x0 = Math.min(...caps.map(c => c.x0)), x1 = Math.max(...caps.map(c => c.x1));
        const z0 = Math.min(...caps.map(c => c.z0)), z1 = Math.max(...caps.map(c => c.z1));
        const G = BLOCK_GRID, cw = (x1 - x0) / G, ch = (z1 - z0) / G, half = Math.hypot(cw, ch) / 2, grid = this.grid2 ??= new Uint32Array(G * G * 4);
        const segDist = (px, pz, ax, az, bx, bz) => {
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
            return Math.hypot(ax + dx * t - px, az + dz * t - pz);
        };
        grid.fill(0);
        list.forEach((b, k) => {
            const c = caps[k];
            const i0 = clamp(Math.floor((c.x0 - x0) / cw), 0, G - 1), i1 = clamp(Math.floor((c.x1 - x0) / cw), 0, G - 1);
            const j0 = clamp(Math.floor((c.z0 - z0) / ch), 0, G - 1), j1 = clamp(Math.floor((c.z1 - z0) / ch), 0, G - 1);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const px = x0 + (i + 0.5) * cw, pz = z0 + (j + 0.5) * ch;
                if (c.segs.some(e => segDist(px, pz, b.x, b.z, e[0], e[1]) <= c.r + half)) grid[(j * G + i) * 4 + (k >> 5)] |= 1 << (k & 31);
            }
        });
        F.set('blockers', this.data);
        F.set('blocks', [list.length, this.lo, this.hi, 0]);
        F.set('blockBox', [x0, z0, x1, z1]);
        this.gridBox = [x0, z0, x1, z1];
        F.setBits('blockGrid', grid);
        return drips;
    }

    // the roof edges nearest `around` (within 150 m) that rain runs off, with each one's share of the drip particles
    writeDrips(F, around) {
        const d = e => Math.max(Math.abs((around[0] - e.x) * e.cs + (around[2] - e.z) * e.sn) - e.hx, 0)
            + Math.max(Math.abs(-(around[0] - e.x) * e.sn + (around[2] - e.z) * e.cs) - e.hz, 0) + Math.abs(around[1] - e.y) * 0.5;
        const near = [];
        this.dripGrid.each(around[0] - 150, around[2] - 150, around[0] + 150, around[2] + 150, e => near.push(e));
        const list = near.filter(e => d(e) < 150).sort((p, q) => d(p) - d(q)).slice(0, MAX_DRIPS);
        // nearer edges get more drops, but a long edge gets more than a short one
        const wts = list.map(e => e.per / (1 + d(e) / 25)), sum = wts.reduce((a, b) => a + b, 0);
        let acc = 0;
        const data = this.dripData ??= new Float32Array(MAX_DRIPS * 12);
        data.fill(0);
        list.forEach((e, i) => {
            acc += wts[i] / sum;
            // the drops land within 30 m of the camera along each side: thin them to about DRIP_DENSITY per metre there
            const seen = Math.min(60, 2 * e.hx) * 2 + (e.alongX ? 0 : Math.min(60, 2 * e.hz) * 2);
            const keep = Math.min(1, DRIP_DENSITY * seen / (DRIP_PARTICLES * wts[i] / sum));
            data.set([e.x, e.z, e.hx, e.hz, e.cs, e.sn, e.y, Math.max(e.drop, 0.5), acc, e.alongX ? 1 : 0, keep, 0], i * 12);
        });
        F.set('drips', [list.length, 0, 0, 0]);
        F.set('dripEdges', data);
        return list.length;
    }

    // as blockerRain in WGSL: p is inside the enclosed box b
    static holds(b, p) { return !!b.enclosed && ShelterBoxes.contains(b, p); }

    // p is inside box b
    static contains(b, p) {
        const rx = p[0] - b.x, rz = p[2] - b.z, lx = rx * b.cs + rz * b.sn, lz = -rx * b.sn + rz * b.cs, y = p[1] - b.slope * lx;
        return Math.abs(lx) < b.hx && Math.abs(lz) < b.hz && y > b.y0 && y < b.y1;
    }

    // blockerHit in WGSL: the ray from o along d enters box b
    static hit(b, o, d) {
        const rx = o[0] - b.x, rz = o[2] - b.z, lx = rx * b.cs + rz * b.sn, dx = d[0] * b.cs + d[2] * b.sn;
        const slabs = [[lx, dx, -b.hx, b.hx], [o[1] - b.slope * lx, d[1] - b.slope * dx, b.y0, b.y1],
            [-rx * b.sn + rz * b.cs, -d[0] * b.sn + d[2] * b.cs, -b.hz, b.hz]];
        let tn = -Infinity, tf = Infinity;
        for (const [p, v, a, c] of slabs) {
            if (Math.abs(v) < 1e-9) { if (p < a || p > c) return false; continue; }
            const ta = (a - p) / v, tc = (c - p) / v;
            tn = Math.max(tn, Math.min(ta, tc));
            tf = Math.min(tf, Math.max(ta, tc));
        }
        return tn > 0.02 && tn <= tf;
    }

    // a structure keeps off what falls on p along -d (d: back up against the fall). As rainReaches in WGSL: only the boxes
    // the frame's grid lists for p's cell (write(), around the camera); outside the grid no box can reach p. Before the
    // first frame is written, the boxes near p
    shelters(p, d) {
        const test = b => ShelterBoxes.holds(b, p) || ShelterBoxes.hit(b, p, d);
        if (!this.listed || !this.gridBox) { this.rehash(); return this.nearBoxes(p, 400).some(test); }
        const [x0, z0, x1, z1] = this.gridBox, G = BLOCK_GRID;
        if (p[0] <= x0 || p[0] >= x1 || p[2] <= z0 || p[2] >= z1) return false;
        const i = Math.min(Math.floor((p[0] - x0) / (x1 - x0) * G), G - 1), j = Math.min(Math.floor((p[2] - z0) / (z1 - z0) * G), G - 1);
        for (let w = 0; w < 4; w++) for (let bits = this.grid2[(j * G + i) * 4 + w]; bits; bits &= bits - 1) {
            const k = w * 32 + 31 - Math.clz32(bits & -bits);
            if (test(this.listed[k])) return true;
        }
        return false;
    }
}

return { ShelterBoxes };
});
