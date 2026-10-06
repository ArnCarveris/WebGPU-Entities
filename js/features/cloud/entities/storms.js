'use strict';
// Weather entities: storm cells, supercells, squall lines, spawners and clearings.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, sat01, lerp, smoothstep, mulberry32 } = Common;
const { Entity } = feature;

// --- weather

// A storm cell (cumulus congestus -> cumulonimbus): grows, matures (rain or snow, lightning), decays (anvil lingers,
// precipitation turns to virga). It drifts with the layer wind; `pinned` cells hold their place and stay mature, `hold`
// cells only stay mature. Optional: `shelf` (shelf cloud on the gust front), `laminar` (mothership plates), `green`
// (green storm light), `wallCloud` (m the base lowers under the updraft).
class StormCell extends Entity {
    constructor(def, world) {
        super(def, world);
        this.pos = [...def.pos];
        this.life = def.life || [600, 1800, 900];
        this.age = def.age ?? (def.pinned ? this.life[0] : 0);
        this.seed = def.seed ?? Math.random();
        this.flashClock = 0;
        this.state = {};
        this.evolve();
    }

    get anchor() { return [this.pos[0], this.world.weather.cur.base - 250, this.pos[1]]; }
    get mature() { return this.age >= this.life[0] && this.age < this.life[0] + this.life[1]; }

    evolve() {
        const d = this.def, [g, m, k] = this.life, wx = this.world.weather.cur;
        const grow = smoothstep(0, 1, clamp(this.age / g, 0, 1));
        const decay = clamp((this.age - g - m) / k, 0, 1);
        const base = wx.base;
        const s = this.state;
        s.coverage = grow * (1 - smoothstep(0.35, 1, decay));
        s.top = Math.max(base + 600, lerp(base + 500, d.top || 9000, grow));
        s.precip = Math.min(2, (d.precip ?? 0.7) * wx.power) * smoothstep(0.55, 1, clamp(this.age / g, 0, 1)) * (1 - smoothstep(0.45, 1, decay));
        s.virga = lerp(d.virga ?? 0.1, 0.92, smoothstep(0.2, 0.85, decay));
        s.radius = (d.radius || 4000) * (0.55 + 0.45 * grow) * (1 + 0.3 * decay);
        s.decay = decay;
    }

    update(dt, wdt) {
        const d = this.def, w = this.world.weather.cur;
        if (d.pinned || d.hold) this.age = Math.min(this.age + wdt, this.life[0] + this.life[1] * 0.5);
        else this.age += wdt;
        if (!d.pinned) {
            const drift = d.drift ?? 1, vel = d.velocity || [0, 0];
            this.pos[0] += (w.wind[0] * drift + vel[0]) * wdt;
            this.pos[1] += (w.wind[1] * drift + vel[1]) * wdt;
        }
        this.evolve();
        if (this.age > this.life[0] + this.life[1] + this.life[2]) this.dead = true;
        // lightning, in real time while mature
        const rate = (d.lightning || 0) * w.lightning / 60;
        if (rate > 0 && !this.off && this.mature && this.state.precip > 0.15) {
            this.flashClock -= dt;
            if (this.flashClock <= 0) {
                this.world.lightning.strike(this);
                this.flashClock = -Math.log(1 - Math.random() * 0.999) / rate;
            }
        }
    }

    cell() {
        const s = this.state;
        if (this.off || (s.coverage <= 0.005 && s.precip <= 0.005)) return null;
        // the precipitation core sits on the downwind flank unless the definition places it
        const w = this.world.weather.cur.wind, wl = Math.hypot(w[0], w[1]) || 1;
        const off = this.def.coreOffset || [w[0] / wl * s.radius * 0.2, w[1] / wl * s.radius * 0.2];
        const d = this.def, rain = sat01(s.precip * 3);
        return { x: this.pos[0], z: this.pos[1], radius: s.radius, top: s.top, coverage: s.coverage, precip: s.precip,
            seed: this.seed, virga: s.virga, core: d.core ?? 0.45, offset: off,
            shelf: (d.shelf || 0) * rain, laminar: (d.laminar || 0) * s.coverage, green: d.green || 0, wall: (d.wallCloud || 0) * rain };
    }

    // cloud genus for labels
    get kind() {
        if (this.def.shelf) return 'cumulonimbus + shelf cloud';
        return this.state.top - this.world.weather.cur.base > 4500 ? 'cumulonimbus' : 'cumulus congestus';
    }

    describe() {
        const s = this.state, wx = this.world.weather;
        const kind = s.precip < 0.03 ? 'building' : s.virga > 0.7 ? 'virga' : wx.typeAt(this.world.field.base);
        const level = s.precip < 0.03 ? '' : s.precip < 0.25 ? 'light ' : s.precip < 0.55 ? 'moderate ' : s.precip < 0.85 ? 'heavy ' : 'torrential ';
        return `${this.kind} · ${kind === 'building' || kind === 'virga' ? '' : level}${kind}${this.mature && this.def.lightning && wx.cur.lightning > 0 ? ' ⚡' : ''}`;
    }
}

// "mothership": a rotating supercell. Wide, with smooth stacked plates, a wall cloud under the updraft and a shelf
// cloud on its gust front; `green` tints the light under it.
// The plate stack is analytic (mothershipDensity): `stackRadius` (x radius), `stackDrop` / `stackHeight` (m around the
// cloud base), `plates`, `twist`, `spin` (rad/s), `wallCloud` (m), `wallRadius` (x stack radius).
class Supercell extends StormCell {
    constructor(def, world) {
        super({ radius: 7000, top: 12000, precip: 1, core: 0.4, lightning: 6, ...def }, world);
        this.spin = 0;
    }
    get kind() { return 'supercell (mothership)'; }
    get focus() { const o = this.updraft; return [o[0], this.world.field.base, o[1]]; }

    // the updraft sits opposite the rain core
    get updraft() {
        const off = this.def.coreOffset || [0, 0];
        return [this.pos[0] - off[0] * 0.25, this.pos[1] - off[1] * 0.25];
    }

    update(dt, wdt) {
        super.update(dt, wdt);
        this.spin += dt * (this.def.spin ?? 0.03);
    }

    features(out) {
        const d = this.def, s = this.state, base = this.world.weather.cur.base, [x, z] = this.updraft;
        if (this.off || s.coverage < 0.05) return;
        out.ms.push([x, z, s.radius * (d.stackRadius ?? 0.8), this.spin,
            base - (d.stackDrop ?? 300), base + (d.stackHeight ?? 4500), d.plates ?? 6, d.twist ?? 0.5,
            d.wallCloud ?? 800, d.wallRadius ?? 0.3, smoothstep(0.1, 0.6, s.coverage), this.seed * 10]);
    }

    // the tornado of category cat (TORNADO) under the wall cloud, for the GPU (16 floats, see tornadoDensity); grow 0..1
    tornado(cat, grow) {
        const k = TORNADO[cat], d = this.def, s = this.state, [ux, uz] = this.updraft;
        // on the wall cloud's rear flank, away from the rain core
        const off = d.coreOffset || [0, 0], ol = Math.hypot(off[0], off[1]) || 1;
        const wr = s.radius * (d.stackRadius ?? 0.8) * (d.wallRadius ?? 0.3) * 0.35;
        const x = ux - off[0] / ol * wr, z = uz - off[1] / ol * wr;
        const ground = this.world.field.sample(x, z);
        const top = Math.max(this.world.weather.cur.base - (d.stackDrop ?? 300) + 150, ground + 300), H = top - ground;   // up in the plates
        const sz = clamp(H / 1500, 0.4, 1);                 // under a low base, a slimmer one
        // its bottom trails off the axis, slowly swinging round; ropes lean the most
        const a = this.seed * 6.283 + this.age * 0.004;
        // touching down: the condensation comes down out of the wall cloud as it grows
        return [x, z, ground, top,
            k.ground * sz, k.top * sz, k.condensed * smoothstep(0, 0.7, grow), k.flare,
            Math.cos(a) * k.lean * H, Math.sin(a) * k.lean * H, k.debris * sz * smoothstep(0.5, 1, grow), k.debris * sz * 0.4,
            smoothstep(0.1, 0.6, s.coverage) * smoothstep(0, 0.25, grow), k.wind / ((k.ground + k.top) * sz) * 1.6, k.vortices, this.seed * 7];
    }
}

// hurricane categories (Saffir-Simpson), scaled down to the weather map: eye radius (m), eyewall top (m), spiral rain
// bands, outer radius of the bands (m), precipitation, band top (m), low cloud on the eye floor (coverage), raggedness of
// the eyewall, wind (m/s, how fast it turns). The stronger, the smaller, clearer and rounder the eye.
const HURRICANE = [null,
    { name: 'Cat 1', kmh: '119-153', eye: 15000, top: 10500, bands: 3, outer: 60000, precip: 1.0, bandTop: 7000, eyeFloor: 0.55, ragged: 0.22, wind: 38 },
    { name: 'Cat 2', kmh: '154-177', eye: 13000, top: 11000, bands: 3, outer: 62000, precip: 1.15, bandTop: 7500, eyeFloor: 0.45, ragged: 0.16, wind: 46 },
    { name: 'Cat 3', kmh: '178-208', eye: 11000, top: 11500, bands: 4, outer: 64000, precip: 1.3, bandTop: 8000, eyeFloor: 0.35, ragged: 0.11, wind: 54 },
    { name: 'Cat 4', kmh: '209-251', eye: 9000, top: 12000, bands: 4, outer: 66000, precip: 1.45, bandTop: 8500, eyeFloor: 0.25, ragged: 0.07, wind: 64 },
    { name: 'Cat 5', kmh: '252+', eye: 7500, top: 12200, bands: 5, outer: 68000, precip: 1.6, bandTop: 9000, eyeFloor: 0.15, ragged: 0.04, wind: 76 },
];

// tornado categories (Fujita): funnel radius (m) at the ground and up in the wall cloud, how much of its height the
// condensation reaches down (1: to the ground), flare (how it widens upwards), lean (x its height), debris cloud
// radius (m), wind (m/s), subvortices
const TORNADO = [null,
    { name: 'F1', kmh: '117-180', ground: 40, top: 190, condensed: 0.8, flare: 2.6, lean: 0.3, debris: 150, wind: 45, vortices: 0 },
    { name: 'F2', kmh: '181-253', ground: 70, top: 300, condensed: 0.85, flare: 2.2, lean: 0.2, debris: 220, wind: 60, vortices: 0 },
    { name: 'F3', kmh: '254-332', ground: 130, top: 420, condensed: 0.95, flare: 1.8, lean: 0.18, debris: 340, wind: 80, vortices: 3 },
    { name: 'F4', kmh: '333-418', ground: 280, top: 620, condensed: 1, flare: 1.4, lean: 0.08, debris: 600, wind: 100, vortices: 4 },
    { name: 'F5', kmh: '419-512', ground: 520, top: 850, condensed: 1, flare: 1.1, lean: 0.03, debris: 950, wind: 125, vortices: 5 },
];

// a line of storms carried by the wind, each with a shelf cloud along its gust front; starts over after `travel` m
class SquallLine extends Entity {
    spawn() {
        const d = this.def, n = d.count || 5, rng = mulberry32(d.seed || 3);
        this.cells = [];
        for (let k = 0; k < n; k++) {
            const t = n > 1 ? k / (n - 1) : 0.5;
            this.cells.push(this.world.add({
                type: 'storm', label: k === Math.floor(n / 2) ? this.label : '', seed: rng(),
                pos: [lerp(d.from[0], d.to[0], t) + (rng() - 0.5) * 2500, lerp(d.from[1], d.to[1], t) + (rng() - 0.5) * 2500],
                radius: (d.radius || 4500) * (0.8 + 0.4 * rng()), top: (d.top || 10000) * (0.85 + 0.15 * rng()),
                precip: d.precip ?? 0.9, core: 0.55, coreOffset: [0, 0], life: [400, 1e9, 900], age: 400, hold: true, drift: 0,
                lightning: d.lightning ?? 3, virga: 0.05, green: d.green || 0,
            }));
        }
        this.starts = this.cells.map(c => [...c.pos]);
        this.offset = [0, 0];
        this.label = '';            // the middle cell carries it
    }

    get motion() {
        const w = this.world.weather.cur.wind, v = this.def.velocity || [0, 0], k = this.def.drift ?? 1;
        return [w[0] * k + v[0], w[1] * k + v[1]];
    }

    update(dt, wdt) {
        const [vx, vz] = this.motion;
        this.offset[0] += vx * wdt;
        this.offset[1] += vz * wdt;
        if (Math.hypot(...this.offset) > (this.def.travel || 60000)) this.offset = [0, 0];
        this.cells.forEach((c, i) => { c.pos = [this.starts[i][0] + this.offset[0], this.starts[i][1] + this.offset[1]]; });
    }

    // the gust front: the line moved ahead of the cells, bowed out in the middle
    get front() {
        const d = this.def, [vx, vz] = this.motion, ml = Math.hypot(vx, vz) || 1, m = [vx / ml, vz / ml];
        const gap = (d.radius || 4500) * (d.gap ?? 0.9);
        const a = [d.from[0] + this.offset[0] + m[0] * gap, d.from[1] + this.offset[1] + m[1] * gap];
        const b = [d.to[0] + this.offset[0] + m[0] * gap, d.to[1] + this.offset[1] + m[1] * gap];
        const bow = d.bow ?? 4000;
        const c = [(a[0] + b[0]) / 2 + m[0] * bow * 2, (a[1] + b[1]) / 2 + m[1] * bow * 2];   // control point: the curve reaches half of it
        return { a, b, c, m };
    }

    get focus() { const { a, b, c } = this.front; return [(a[0] + b[0]) / 4 + c[0] / 2, this.world.field.base, (a[1] + b[1]) / 4 + c[1] / 2]; }

    features(out) {
        if (this.off) return;
        const d = this.def, { a, b, c, m } = this.front, depth = d.shelfDepth ?? 7000, pad = depth + 2000;
        const strength = (d.shelf ?? 1) * this.cells.reduce((sum, e) => sum + e.state.coverage, 0) / this.cells.length;
        if (strength < 0.02) return;
        out.shelves.push([...a, ...b, ...c, ...m, d.lip ?? 650, depth, d.tiers ?? 3, strength,
            Math.min(a[0], b[0], c[0]) - pad, Math.min(a[1], b[1], c[1]) - pad, Math.max(a[0], b[0], c[0]) + pad, Math.max(a[1], b[1], c[1]) + pad]);
    }
}

// keeps the sky populated: spawns storm cells inside `area` at `rate` cells per weather-hour (times the state's `storms`)
class Spawner extends Entity {
    spawn() {
        this.rng = mulberry32(this.def.seed || 1);
        this.clock = 0;
        this.made = 0;
        for (let k = 0; k < (this.def.initial || 0); k++) {
            const def = this.make(this.rand(this.def.area[0], this.def.area[2]), this.rand(this.def.area[1], this.def.area[3]));
            def.age = this.rng() * (def.life[0] + def.life[1] + def.life[2]) * 0.8;
            this.world.add(def);
        }
    }

    rand(a, b) { return lerp(a, b, this.rng()); }
    pick(key, fallback) { const r = (this.def.template || {})[key]; return r ? this.rand(r[0], r[1]) : fallback; }

    make(x, z) {
        this.made++;
        return {
            type: 'storm', label: `Cell ${this.made}`, pos: [x, z], spawned: true, seed: this.rng(),
            radius: this.pick('radius', 3500), top: this.pick('top', 8000), precip: this.pick('precip', 0.6), core: this.pick('core', 0.45),
            life: [this.pick('grow', 700), this.pick('mature', 1500), this.pick('decay', 900)],
            lightning: this.pick('lightning', 1), virga: this.pick('virga', 0.2), drift: this.pick('drift', 1),
        };
    }

    count() { return this.world.entities.filter(e => e instanceof StormCell && e.def.spawned && !e.dead).length; }

    update(dt, wdt) {
        const w = this.world.weather.cur, rate = (this.def.rate || 6) * w.storms / 3600;
        if (rate <= 0) return;
        this.clock -= wdt;
        if (this.clock > 0) return;
        this.clock = -Math.log(1 - this.rng() * 0.999) / rate;
        if (this.count() >= (this.def.max || 16)) return;
        // new cells form upwind, so they drift across the area while they live
        const [x0, z0, x1, z1] = this.def.area, wl = Math.hypot(w.wind[0], w.wind[1]) || 1;
        let x = this.rand(x0, x1), z = this.rand(z0, z1);
        x -= w.wind[0] / wl * (x1 - x0) * 0.25;
        z -= w.wind[1] / wl * (z1 - z0) * 0.25;
        this.world.add(this.make(x, z));
    }

    // a cell where the user asked for one
    spawnAt(x, z) { const def = this.make(x, z); def.label = `Cell ${this.made} (yours)`; return this.world.add(def); }
}

// Levels the ground to `level` over a rectangle (size [x, z] m, yaw degrees) or a disc (radius): a site where another
// world of a composition stands (js/engine/compositor.js). The ground eases back to the terrain over `blend` m, outside
// the site; with `inset` inside it instead, so the terrain meets the other world's edge at its own height and the
// levelled ground stays hidden under that world. `water` paints the site as water.
class Clearing extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, blend = d.blend ?? 600, yaw = (d.yaw || 0) * DEG, cs = Math.cos(yaw), sn = Math.sin(yaw);
        const [hx, hz] = d.size ? [d.size[0] / 2, d.size[1] / 2] : [d.radius || 1000, d.radius || 1000], reach = Math.hypot(hx, hz) + blend;
        f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
            const rx = x - cx, rz = z - cz, lx = rx * cs + rz * sn, lz = -rx * sn + rz * cs;
            // signed distance to the site's edge (negative inside)
            const ox = Math.abs(lx) - hx, oz = Math.abs(lz) - hz;
            const sd = d.size ? Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0) : Math.hypot(lx, lz) - hx;
            const k = d.inset ? smoothstep(-blend, 0, sd) : smoothstep(0, blend, sd);
            f.h[idx] = lerp(d.level, f.h[idx], k);
            if (d.water) f.paint(idx, 2, 1 - smoothstep(0, f.cell, sd));
        });
    }
}

return { StormCell, Supercell, HURRICANE, TORNADO, SquallLine, Spawner, Clearing };
});
