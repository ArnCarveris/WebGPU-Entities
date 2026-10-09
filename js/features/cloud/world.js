'use strict';
// The world: builds the scenario's entities on the terrain and runs them.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { clamp, sat01, smoothstep } = Common;
const {
    MAX_CELLS, MAX_MOTHERSHIPS, MAX_SHELVES, FAR_FLOATS, TOWN_BLOCK, FAR_LAMP_PITCH, FAR_LAMP_SIDE, FAR_LAMP_REACH,
    FAR_LAMP_H, MAX_GLOWS, pcg32, Heightfield, Town, LAMPS, Structures, cloudMeshes, StormCell, Supercell, HURRICANE, SquallLine,
    Spawner, ENTITY_TYPES, WeatherSystem, RainZones, CloudLayers, Lightning,
} = feature;

class World {
    constructor(scenario) {
        this.scenario = scenario;
        this.meshes = cloudMeshes;      // the common mesh interface (kits.mesh), for what draws itself (buses)
        this.lamps = LAMPS;             // lamp kinds, for what lights itself (a bus's headlights, tail lights, cabin)
        const t = { size: 64000, resolution: 512, base: 1500, fieldSize: 800, pivots: 0.2, ...(scenario.terrain || {}) };
        this.terrain = t;
        this.field = new Heightfield(t.size, t.resolution, t.base);
        this.weather = new WeatherSystem(scenario.weather);
        this.clouds = new CloudLayers(scenario.clouds);
        this.lightning = new Lightning();
        this.entities = [];
        this.byId = new Map();
        this.flashCount = 0;
        this.buses = [];                 // every bus of every BusLine (each drawn, and can be ridden)
        this.busBoost = 1;               // their time runs this many times as fast (hold Z)
        for (const def of scenario.entities || []) this.add(def, false);
        for (const e of this.entities) { e.stamp(this.field); this.field.updateRange(); }
        this.field.freeze();
        this.structures = new Structures(this.field, scenario.buildings, scenario.plans);
        this.hurricanePos = scenario.hurricane?.pos || [0, 0];
        this.hurricaneCat = 0;
        for (const e of this.entities) e.build(this.structures);
        this.structures.finish();
        // the lit town (streetLights): painted like a town entity, its streets given the fake lamps
        const sl = scenario.streetLights;
        this.streetLights = sl ? { pos: sl.pos || this.hurricanePos, radius: sl.radius || 4000, density: sl.density ?? 0.95 } : null;
        if (this.streetLights) new Town(this.streetLights, this).stamp(this.field);
        this.buildFarLights();
        for (const e of [...this.entities]) e.spawn();
        for (const e of this.persistent) this.setOff(e, true);     // hidden until the cloud picker (or a view on it) shows them
        this.rainZones = new RainZones(this);
    }

    // Distant lights by night, fake and cheap (WGSL_FAR): the towns are only painted on the terrain (townColor), so their
    // street lamps are points on its 120 m street grid, one every FAR_LAMP_PITCH m, kept where the town is dense enough
    // (with a hash, so its edges thin out), never on water nor near the structures' real lamps. The field's lamp channel
    // holds that share for the terrain's light pools (streetGlow). farLights: those and the structures' lamps as sprites
    // (FAR_FLOATS each); glows: the light-pollution domes (cityGlow), each town and each cluster of real lamps
    buildFarLights() {
        const f = this.field, S = this.structures, n = f.n, real = new Set();
        for (const l of S.fixtures.lights) real.add(clamp(Math.round(f.ci(l.pos[2])), 0, n - 1) * n + clamp(Math.round(f.ci(l.pos[0])), 0, n - 1));
        const L0 = this.streetLights;
        f.eachAll((idx, x, z) => {
            const lit = L0 && Math.hypot(x - L0.pos[0], z - L0.pos[1]) < L0.radius;
            f.lamp[idx] = !lit || real.has(idx) ? 0 : sat01(f.land[idx * 3] * 1.6 - 0.35) * (1 - sat01(f.land[idx * 3 + 2] * 3));
        });
        const out = [], glows = [], seen = new Set(), fake = [], B = TOWN_BLOCK, P = FAR_LAMP_PITCH;
        const put = (l, fake) => out.push(...l.pos, l.size ?? 0.5, ...l.color.map(c => c * l.intensity), fake ? 1 : 0, ...(l.dir || [0, -1, 0]), l.cone ? l.cone[0] : -2,
            l.cone ? l.cone[1] : 1, l.range, f.surface(l.pos[0], l.pos[2]), 0);
        for (const t of L0 ? [L0] : []) {
            const [cx, cz] = t.pos, r = t.radius;
            let sum = 0;
            // lamp at grid point (x, z) of a street along z (alongZ) or x: its pole at the kerb on alternate sides, the
            // arm over the road, the head FAR_LAMP_SIDE m off the centre line (farLampHead in WGSL)
            const lamp = (x, z, alongZ) => {
                if (seen.has(x * 65536 + z)) return;
                seen.add(x * 65536 + z);
                if (pcg32(Math.imul(x / P + 65536, 196613) + z / P + 65536) / 4294967295 >= f.landAt(x, z, 3)) return;
                // a quarter of the districts have newer white LED lamps (farLampColor)
                const L = LAMPS[pcg32((Math.floor(x / 600) + 1000) * 4099 + Math.floor(z / 600) + 1000) / 4294967295 < 0.25 ? 'led' : 'sodium'];
                const sd = ((alongZ ? z : x) / P) & 1 ? -1 : 1, ax = alongZ ? [sd, 0] : [0, sd];
                const pole = [x + ax[0] * (FAR_LAMP_SIDE + FAR_LAMP_REACH), z + ax[1] * (FAR_LAMP_SIDE + FAR_LAMP_REACH)], g = f.surface(...pole);
                const l = { pos: [x + ax[0] * FAR_LAMP_SIDE, g + FAR_LAMP_H, z + ax[1] * FAR_LAMP_SIDE], color: L.color, intensity: L.intensity,
                    range: L.range, size: L.size, dir: [0, -1, 0], cone: null,
                    pole: [pole[0], g, pole[1], Math.atan2(-ax[1], -ax[0]), ...L.color.map(c => 0.55 + 0.45 * c), 0] };
                put(l, true);
                fake.push(l);
                sum += L.intensity;
            };
            for (let i = Math.ceil((cx - r) / B); i <= Math.floor((cx + r) / B); i++)
                for (let z = Math.ceil((cz - r) / P) * P; z <= cz + r; z += P) lamp(i * B, z, true);
            for (let j = Math.ceil((cz - r) / B); j <= Math.floor((cz + r) / B); j++)
                for (let x = Math.ceil((cx - r) / P) * P; x <= cx + r; x += P) if (x % B) lamp(x, j * B, false);
            if (sum) glows.push([cx, cz, r * 0.7, sum]);
        }
        // the structures' lamps (a bus's are written each frame, LightWriter.writeFar), and a dome per 1.5 km cluster of them
        this.realFar = [out.length / FAR_FLOATS, S.fixtures.lights.length];      // their first instance and count (vsFarPool)
        const cl = new Map();
        for (const l of S.fixtures.lights) {
            put(l, false);
            if (l.tag === 'road') continue;                              // a country road's lamps light no sky
            const k = Math.floor(l.pos[0] / 1500) * 65536 + Math.floor(l.pos[2] / 1500), c = cl.get(k) || { x: 0, z: 0, i: 0, n: 0 };
            c.x += l.pos[0] * l.intensity; c.z += l.pos[2] * l.intensity; c.i += l.intensity; c.n++;
            cl.set(k, c);
        }
        for (const c of cl.values()) if (c.n > 4) glows.push([c.x / c.i, c.z / c.i, 400, c.i]);
        this.farLights = new Float32Array(out);
        this.glows = glows.sort((a, b) => b[3] - a[3]).slice(0, MAX_GLOWS);
        // the fake lamps by FAKE_CELL m cells, for the ones near the camera: real lights (LightWriter.write) and poles
        this.fakeLamps = new Map();
        for (const l of fake) {
            const k = this.fakeCell(l.pos[0], l.pos[2]);
            if (!this.fakeLamps.has(k)) this.fakeLamps.set(k, []);
            this.fakeLamps.get(k).push(l);
        }
    }

    fakeCell(x, z) { return Math.floor(x / 250) * 65536 + Math.floor(z / 250); }

    // the fake street lamps within r (m, horizontally) of p, into out
    nearFakeLamps(p, r, out) {
        for (let i = Math.floor((p[0] - r) / 250); i <= Math.floor((p[0] + r) / 250); i++)
            for (let j = Math.floor((p[2] - r) / 250); j <= Math.floor((p[2] + r) / 250); j++)
                for (const l of this.fakeLamps.get(i * 65536 + j) || []) if (Math.hypot(l.pos[0] - p[0], l.pos[2] - p[2]) < r) out.push(l);
        return out;
    }

    add(def, spawn = true) {
        return kits.world.addEntity(this, ENTITY_TYPES, def, { spawn });
    }

    get(id) { return this.byId.get(id); }
    get storms() { return this.entities.filter(e => e instanceof StormCell); }
    get spawner() { return this.entities.find(e => e instanceof Spawner); }

    // the clouds the scenario places itself (supercells, squall lines, pinned or held cells), which the cloud picker
    // can hide and show again; a squall line's own cells go with it
    get persistent() {
        const owned = new Set(this.entities.flatMap(e => e.cells || []));
        return this.entities.filter(e => !owned.has(e) && (e instanceof SquallLine || (e instanceof StormCell && (e.def.pinned || e.def.hold))));
    }

    setOff(e, off) {
        e.off = off;
        for (const c of e.cells || []) c.off = off;
    }

    // analytic storm structures for the GPU: motherships (12 floats each) and shelf lines (16 floats each)
    features() {
        const out = { ms: [], shelves: [] };
        for (const e of this.entities) e.features(out);
        const host = this.tornadoHost;
        return { ms: out.ms.slice(0, MAX_MOTHERSHIPS), shelves: out.shelves.slice(0, MAX_SHELVES),
            tornado: host ? host.tornado(this.tornadoCat, this.tornadoGrow) : null };
    }

    // the hurricane (hurricaneCat, 0 off) for the GPU (12 floats, see the weather pass and hurricaneKeep)
    hurricaneData(maxTop) {
        if (!this.hurricaneCat || this.hurricaneGrow <= 0) return null;
        const k = HURRICANE[this.hurricaneCat], g = this.hurricaneGrow, base = this.weather.cur.base;
        const top = Math.max(Math.min(k.top, maxTop - 300), base + 3000);
        return [...this.hurricanePos, k.eye * (1.6 - 0.6 * smoothstep(0, 1, g)), smoothstep(0, 1, g),
            top, this.hurricaneTurn, k.bands, k.outer,
            k.precip, Math.min(k.bandTop, top - 1000), k.eyeFloor, k.ragged];
    }

    // the supercell the tornado (tornadoCat, 0 off) hangs from: the first one showing
    get tornadoHost() {
        if (!this.tornadoCat) return null;
        return this.entities.find(e => e instanceof Supercell && !e.off && e.state.coverage >= 0.05) || null;
    }

    update(dt, wdt, t) {
        this.weather.update(dt, wdt);
        this.rainZones.update(dt);
        // a hurricane organises over some seconds (its eye contracting) and turns, faster the stronger it is
        this.hurricaneGrow = this.hurricaneCat ? Math.min(1, (this.hurricaneGrow || 0) + dt / 10) : 0;
        if (this.hurricaneCat) this.hurricaneTurn = ((this.hurricaneTurn || 0) + wdt * HURRICANE[this.hurricaneCat].wind / (HURRICANE[this.hurricaneCat].eye * 2)) % (Math.PI * 2000);
        // a tornado touches down over some seconds, and lifts at once
        this.tornadoGrow = this.tornadoHost ? Math.min(1, (this.tornadoGrow || 0) + dt / 8) : 0;
        for (const e of [...this.entities]) e.update(dt, wdt, t);
        this.structures.lifts.update(dt, this.busBoost);            // (Z runs them ten times as fast too)
        if (this.entities.some(e => e.dead)) {
            this.entities = this.entities.filter(e => !e.dead);
            for (const [k, e] of this.byId) if (e.dead) this.byId.delete(k);
        }
        this.lightning.update(dt);
    }

    // storm cells for the GPU, nearest to `around` first when there are too many
    gpuCells(around) {
        const list = this.entities.map(e => e.cell()).filter(Boolean);
        if (list.length > MAX_CELLS) list.sort((a, b) => Math.hypot(a.x - around[0], a.z - around[2]) - Math.hypot(b.x - around[0], b.z - around[2]));
        return list.slice(0, MAX_CELLS);
    }
}

return { World };
});
