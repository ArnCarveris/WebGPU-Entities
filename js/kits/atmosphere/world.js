'use strict';
// World: a world under the atmosphere: the scenario's entities (its types) on a terrain (the terrain kit's LandField),
// what they build (the settlement kit's Structures: buildings, lifts, doors, roads), the buses running on it, the weather
// state, the cloud layers and lightning (the weather kit's), the distant lights by night (FarLights). The Renderer and
// FrameWriter draw it. What a world type adds is composed in as extensions, never by subclassing.
//
// WorldExtension: a class built with the world (new E(world), before its entities), kept as world.ext[E.key]; each hook
// optional, called in order:
//   centre()            [x, z]: where what the scenario does not place goes (the lit town); the first one's
//   spawned()           after the entities spawned
//   advance(dt, wdt)    each frame, before the entities (dt real s, wdt weather s)
//   features(out)       the GPU's analytic structures: out { ms, shelves, tornado } (the entities' are in already)
//   hurricane(maxTop)   a hurricane for the GPU (12 floats: the weather pass, hurricaneKeep) or null; the first one's

Features.kit('atmosphere', (engine, kit) => {
const { kits } = engine;
const { MAX_CELLS, MAX_MOTHERSHIPS, MAX_SHELVES, FarLights } = kit;
const { LandField } = kits.terrain;
const { LAMPS, Structures, cloudMeshes } = kits.settlement;
const { WeatherSystem, RainZones, CloudLayers, Lightning } = kits.weather;
const { Curvature } = kits.curvature;

class World {
    // types: the entity classes by type name; town: the class the lit town (scenario streetLights) is painted with (a
    // town entity's); extensions: WorldExtension classes
    constructor(scenario, { types, town, extensions = [] }) {
        this.scenario = scenario;
        this.types = types;
        this.ext = {};
        this.extensions = extensions.map(E => (this.ext[E.key] = new E(this)));
        this.meshes = cloudMeshes;      // the common mesh interface (kits.mesh), for what draws itself (buses)
        this.lamps = LAMPS;             // lamp kinds, for what lights itself (a bus's headlights, tail lights, cabin)
        const t = { size: 64000, resolution: 512, base: 1500, fieldSize: 800, pivots: 0.2, ...(scenario.terrain || {}) };
        this.terrain = t;
        this.field = new LandField(t.size, t.resolution, t.base, { rough: t.rough || 0 });
        // the outdoors drawn on a round planet (the scenario's optional `curvature` entity; off without one)
        this.curvature = new Curvature(scenario.curvature, t.base);
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
        this.structures = new Structures(this.field, scenario.buildings, scenario.plans);
        for (const e of this.entities) e.build(this.structures);
        this.structures.finish();
        // the lit town (streetLights): painted like a town entity, its streets given the fake lamps
        const sl = scenario.streetLights;
        this.streetLights = sl ? { pos: sl.pos || this.centre, radius: sl.radius || 4000, density: sl.density ?? 0.95 } : null;
        if (this.streetLights) new town(this.streetLights, this).stamp(this.field);
        this.far = new FarLights(this.field, this.structures, this.streetLights);     // distant lights by night
        for (const e of [...this.entities]) e.spawn();
        for (const x of this.extensions) x.spawned?.();
        this.rainZones = new RainZones(this);
    }

    // where what the scenario does not place goes: an extension's, or the middle
    get centre() {
        for (const x of this.extensions) if (x.centre) return x.centre();
        return [0, 0];
    }

    // open water at x, z: the land-use map's, or an entity's own (a river's channel, which villages draw at its true width)
    water(x, z) {
        return this.field.landAt(x, z, 2) > 0.4 || this.entities.some(e => e.waterAt?.(x, z));
    }

    add(def, spawn = true) {
        return kits.world.addEntity(this, this.types, def, { spawn });
    }

    get(id) { return this.byId.get(id); }

    // analytic storm structures for the GPU: motherships (12 floats each) and shelf lines (16 floats each), a tornado
    features() {
        const out = { ms: [], shelves: [], tornado: null };
        for (const e of this.entities) e.features(out);
        for (const x of this.extensions) x.features?.(out);
        return { ms: out.ms.slice(0, MAX_MOTHERSHIPS), shelves: out.shelves.slice(0, MAX_SHELVES), tornado: out.tornado };
    }

    // a hurricane for the GPU, or null
    hurricaneData(maxTop) {
        for (const x of this.extensions) { const h = x.hurricane?.(maxTop); if (h) return h; }
        return null;
    }

    update(dt, wdt, t) {
        this.weather.update(dt, wdt);
        this.rainZones.update(dt);
        for (const x of this.extensions) x.advance?.(dt, wdt);
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
