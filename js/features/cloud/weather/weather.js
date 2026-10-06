'use strict';
// The weather state: transitions between weather states, rain zones, cloud layers and the sky.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, sat01, lerp, smoothstep } = Common;
const {
    MAX_LAYERS, MAX_RAIN_ZONES, ZONE_STEP, ZONE_RADIUS, CLEAR_RADIUS, WEATHER_DEFAULTS, LAYER_DEFAULTS, LAYER_KINDS,
} = feature;

// Weather, sky, lightning
// Named weather states; the current state blends towards the target over `transition` seconds. A state's `zones` (rain
// that differs along the bus route, RainZones) is not blended: the zones fade in and out on their own.
class WeatherSystem {
    constructor(def) {
        this.def = def || {};
        this.states = Object.fromEntries(Object.entries(this.def.states || { default: {} }).map(([k, v]) => [k, { zones: null, ...WEATHER_DEFAULTS, ...v }]));
        this.names = Object.keys(this.states);
        const start = this.states[this.def.start] ? this.def.start : this.names[0];
        this.cur = structuredClone(this.states[start]);
        this.from = structuredClone(this.cur);
        this.target = start;
        this.blend = 1;
        this.transition = this.def.transition ?? 10;
        this.cycle = { enabled: false, hold: 40, ...(this.def.cycle || {}) };
        this.cycleClock = this.cycle.hold;
        this.offset = [0, 0];
    }

    set(name) {
        if (!this.states[name]) return;
        this.from = structuredClone(this.cur);
        this.target = name;
        this.cur.zones = this.states[name].zones;
        this.blend = 0;
        this.cycleClock = this.cycle.hold;
    }

    next() { this.set(this.names[(this.names.indexOf(this.target) + 1) % this.names.length]); }

    get freezingLevel() { return this.cur.temperature / 6.5 * 1000; }

    // precipitation type reaching height y
    typeAt(y) {
        const fl = this.freezingLevel;
        return y > fl + 150 ? 'snow' : y > fl - 250 ? 'sleet' : 'rain';
    }

    update(dt, wdt) {
        if (this.blend < 1) {
            this.blend = Math.min(1, this.blend + dt / Math.max(this.transition, 1e-3));
            const k = smoothstep(0, 1, this.blend), to = this.states[this.target];
            for (const key of Object.keys(to)) {
                if (key === 'zones') continue;
                const a = this.from[key], b = to[key];
                if (Array.isArray(b)) this.cur[key] = b.map((v, i) => lerp(a[i], v, k));
                else if (typeof b === 'object') {
                    const names = new Set([...Object.keys(a || {}), ...Object.keys(b)]);
                    this.cur[key] = Object.fromEntries([...names].map(n => [n, lerp(a?.[n] ?? 0, b[n] ?? 0, k)]));
                } else this.cur[key] = lerp(a, b, k);
            }
        }
        if (this.cycle.enabled && (this.cycleClock -= dt) <= 0) this.next();
        this.offset[0] += this.cur.wind[0] * wdt;
        this.offset[1] += this.cur.wind[1] * wdt;
    }
}

// Mixed rain: a state's `zones` puts its `variants` (other weather states: drizzle, light rain, ...) along a bus route
// at once, in stretches of `length` m from the station out to the turn, each variant at least once, and reshuffles them
// after a random `hold` [min, max] s (blending over the weather transition). `dry` { state, count } adds `count`
// stretches of a state without a deck (clear), twice as long: no rain, and the genus layers open up over them to its
// sky. The route is sampled every ZONE_STEP m; each sample carries a rain scale for the genus layers (F.rain.z there,
// see zoneAt in WGSL), a cover scale for them (0 a clear stretch), the route's direction there and a drop size (the
// near-field rain at the camera). A variant's rain scale is the one that gives this state's deck the precipitation the
// variant's own deck has (deckRain), so a drizzle stretch rains like drizzle under the mixed state's nimbostratus.
// A clear stretch's opening reaches CLEAR_RADIUS m past its ends along the route (short of the next stretch's rain:
// rain needs cloud above it) and CLEAR_WIDE times that to the sides, so the sky over it is open, not a gap overhead.
class RainZones {
    constructor(world) {
        this.world = world;
        this.pts = [];          // { x, z, s (m from the station), dir [x, z], scale, cover, drops, from, to }
        this.ends = [];         // where each stretch of `order` ends (m from the station)
        this.fade = 0;          // 0 no zones .. 1 the zones rule along the route
        this.spec = null;
        this.order = [];
        this.clock = 0;
        this.blend = 1;
    }

    // precipitation of a state's genus decks at a rain scale, as the weather map has it where the decks are typical
    static deckRain(state, defs, scale) {
        let pr = 0, pour = 0;
        for (const d of defs) {
            const c = state.layers?.[d.name] ?? 0, lc = sat01(c * 0.45 + c * c * 0.6);
            const lp = d.precip * smoothstep(0.35, 0.85, lc) * scale;
            pr = 1 - (1 - pr) * (1 - sat01(lp));
            pour = Math.max(pour, lp - 1);
        }
        return pr + pour;
    }

    // the route of `along` (a bus line): its path from the station out to the turn
    build(spec) {
        const line = this.world.get(spec.along);
        this.pts = [];
        if (!line?.path) return;
        const half = line.len / 2;
        for (let s = 0; s <= half && this.pts.length < MAX_RAIN_ZONES; s += ZONE_STEP) {
            const p = line.at(s), a = line.at(s - 20), b = line.at(s + 20), l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
            this.pts.push({ x: p[0], z: p[2], s, dir: [(b[0] - a[0]) / l, (b[2] - a[2]) / l], scale: 1, cover: 1, drops: 0.5, from: [1, 1, 0.5], to: [1, 1, 0.5] });
        }
        this.half = half;
    }

    // a new random order of the variants along the route: every one at least once, the dry stretches (two units of
    // `length` each) added, no two stretches alike side by side
    shuffle(spec) {
        const W = this.world.weather, defs = this.world.clouds.defs, deck = W.states[W.target];
        const vars = (spec.variants || []).filter(n => W.states[n]);
        const dry = W.states[spec.dry?.state] ? spec.dry.state : null, dryCount = dry ? Math.max(0, spec.dry.count ?? 2) : 0;
        if (!vars.length || !this.pts.length) return;
        const wet = Math.max(vars.length, Math.round(this.half / (spec.length || 1200)) - 2 * dryCount);
        const bag = [...vars, ...new Array(dryCount).fill(dry)];
        while (bag.length < wet + dryCount) bag.push(vars[Math.floor(Math.random() * vars.length)]);
        let order = bag;
        for (let t = 0; t < 200; t++) {
            order = [...bag].sort(() => Math.random() - 0.5);
            if (order.every((v, i) => i === 0 || v !== order[i - 1])) break;
        }
        this.order = order;
        // a variant's rain scale: what gives this state's deck the variant's own precipitation; its cover: 0 for a
        // state without a deck (clear)
        const want = name => {
            const v = W.states[name], target = RainZones.deckRain(v, defs, v.rain);
            let lo = 0, hi = 8;
            for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (RainZones.deckRain(deck, defs, m) < target) lo = m; else hi = m; }
            const cover = smoothstep(0, 0.5, Math.max(0, ...Object.values(v.layers || {})));
            return [(lo + hi) / 2, cover, v.drops];
        };
        const params = Object.fromEntries([...new Set(order)].map(n => [n, want(n)]));
        const unit = this.half / order.reduce((a, v) => a + (v === dry ? 2 : 1), 0);
        let end = 0;
        this.ends = order.map(v => (end += (v === dry ? 2 : 1) * unit));
        for (const p of this.pts) {
            p.from = [p.scale, p.cover, p.drops];
            p.to = params[this.order[this.stretch(p.s)]];
        }
        this.blend = 0;
        const h = spec.hold || [40, 100];
        this.clock = lerp(h[0], h[1] ?? h[0], Math.random());
    }

    update(dt) {
        const W = this.world.weather, spec = W.cur.zones;
        if (spec && spec !== this.spec) {
            if (spec.along !== this.spec?.along) this.build(spec);
            this.spec = spec;
            this.shuffle(spec);
            if (this.fade === 0) { this.blend = 1; for (const p of this.pts) [p.scale, p.cover, p.drops] = p.to; }
        }
        this.fade = sat01(this.fade + (spec ? 1 : -1) * dt / Math.max(W.transition, 1e-3));
        if (!this.spec) return;
        if (spec && (this.clock -= dt) <= 0) this.shuffle(spec);
        if (this.blend < 1) {
            this.blend = Math.min(1, this.blend + dt / Math.max(W.transition, 1e-3));
            const k = smoothstep(0, 1, this.blend);
            for (const p of this.pts) [p.scale, p.cover, p.drops] = p.from.map((a, i) => lerp(a, p.to[i], k));
        }
        if (!spec && this.fade === 0) this.spec = null;
    }

    // weight of the route at x, z (0 off it, 1 on it) and the zones' drop size there; mirrors zoneAt in WGSL
    at(x, z) {
        let w = 0, v = 0;
        for (const p of this.pts) { const d = Math.hypot(x - p.x, z - p.z) / ZONE_RADIUS; if (d < 3) { const g = Math.exp(-d * d); w += g; v += g * p.drops; } }
        return { k: sat01(w) * this.fade, drops: w > 1e-4 ? v / w : 0 };
    }

    // drop size at the camera: the state's, or the zone's along the route
    drops(x, z, base) { if (!this.fade) return base; const a = this.at(x, z); return lerp(base, a.drops, a.k); }

    // index in `order` of the stretch at s m from the station
    stretch(s) { const i = this.ends.findIndex(e => s < e); return i < 0 ? this.ends.length - 1 : i; }

    // the variant of the stretch nearest x, z (for the HUD), or null off the route
    variantAt(x, z) {
        if (!this.fade || !this.order.length) return null;
        let best = null, bd = ZONE_RADIUS * 1.5;
        for (const p of this.pts) { const d = Math.hypot(x - p.x, z - p.z); if (d < bd) { bd = d; best = p; } }
        return best ? this.order[this.stretch(best.s)] : null;
    }

    write(F) {
        const n = this.fade > 0 ? this.pts.length : 0;
        for (let i = 0; i < n; i++) {
            const p = this.pts[i];
            F.set('rainZones', [p.x, p.z, p.cover, p.scale], i * 4);
            F.set('zoneDirs', p.dir, i * 2);
        }
        F.set('zoneInfo', [n, this.fade, ZONE_RADIUS, CLEAR_RADIUS]);
    }
}

// Cloud genus layers besides the convective one (stratus, nimbostratus, altostratus, altocumulus, ...): shape data from
// the scenario's `clouds`, coverage per weather state (`layers: { genus: coverage }`). Up to MAX_LAYERS.
class CloudLayers {
    constructor(defs) {
        this.defs = (defs || []).slice(0, MAX_LAYERS).map((d, i) => ({ ...LAYER_DEFAULTS, seed: i * 0.37 + 0.11, ...d }));
    }

    coverage(weather, d) { return d ? (weather.layers?.[d.name] ?? 0) : 0; }

    write(frame, weather, convectiveBase) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < MAX_LAYERS; k++) {
            const d = this.defs[k], cov = this.coverage(weather, d);
            frame.set('layers', d ? [d.base, d.top, cov, d.density, d.mapScale, d.shapeScale, d.stretch, d.erosion,
                LAYER_KINDS[d.kind] ?? 1, d.ambient, d.precip, d.seed] : new Array(12).fill(0), k * 12);
            if (cov > 0.005) { lo = Math.min(lo, d.base); hi = Math.max(hi, d.top); }
        }
        frame.set('layerInfo', [isFinite(lo) ? lo : 1e6, isFinite(hi) ? hi : -1e6, Math.min(convectiveBase - 1300, lo), 0]);
    }

    // [name, coverage] of every genus present, for the HUD
    active(weather) {
        const list = [['cumulus', weather.coverage]];
        for (const d of this.defs) list.push([d.name, this.coverage(weather, d)]);
        list.push(['cirrus', weather.cirrus]);
        return list.filter(([, c]) => c > 0.02);
    }
}

// sun and sky colours from the sun elevation (Kasten-Young air mass through Rayleigh + Mie) and the weather
class Sky {
    // moon: 0 for the sun, else the moon by night (its lit fraction)
    static compute(az, el, intensity, weather, moon = 0) {
        const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
        const elDeg = el / DEG;
        const am = 1 / (Math.sin(Math.max(el, 0)) + 0.50572 * Math.pow(Math.max(elDeg, 0) + 6.07995, -1.6364));
        const tauR = [0.04, 0.095, 0.22], tauM = 0.02 + 0.035 * weather.haze;
        const trans = tauR.map(t => Math.exp(-(t + tauM) * am));
        const day = smoothstep(-3, 10, elDeg);
        const sun = trans.map(t => t * intensity * (0.2 + 0.8 * day));
        const blue = [0.16, 0.32, 0.72].map((c, i) => c * (0.25 + 0.75 * day) * (0.6 + 0.4 * trans[i]));
        const low = (1 - smoothstep(2, 18, elDeg)) * 0.6;
        const warm = trans.map(t => t / Math.max(...trans));
        const horizon = [0.6, 0.68, 0.78].map((c, i) => lerp(c, c * (0.55 + 0.6 * warm[i]), low) * (0.3 + 0.7 * day));
        // overcast: greyer, darker sky
        const g = Math.pow(clamp(weather.coverage, 0, 1), 1.5) * 0.85;
        const grey = 0.45 * (0.3 + 0.7 * day);
        const zenith = blue.map(c => lerp(c, grey, g)).map(c => c * (1 - 0.35 * g));
        const hor = horizon.map(c => lerp(c, grey * 1.1, g * 0.8));
        const ambient = zenith.map((c, i) => (c * 0.6 + hor[i] * 0.4) * 1.1);
        if (moon > 0) {
            // moonlight is sunlight off the moon, seen with night vision (bluer, less saturated); the sky it lights is
            // dark (the stars show), its horizon a little brighter (airglow, far towns)
            const night = (v, a) => { const l = v[0] * 0.3 + v[1] * 0.55 + v[2] * 0.15; return v.map((c, i) => lerp(c, l * [0.78, 0.9, 1.25][i], a)); };
            const k = 0.03 * (0.3 + 0.7 * moon);
            return { dir, sun: night(sun, 0.6), zenith: night(zenith, 0.2).map(c => c * k), horizon: night(hor, 0.4).map(c => c * k * 1.3), ambient: night(ambient, 0.4).map(c => c * k * 1.3) };
        }
        return { dir, sun, zenith, horizon: hor, ambient };
    }
}

return { WeatherSystem, RainZones, CloudLayers, Sky };
});
