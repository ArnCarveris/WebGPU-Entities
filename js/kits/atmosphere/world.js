'use strict';
// World: a world under the atmosphere: the scenario's entities (its types) on a terrain (the terrain kit's LandField), the
// weather state, the cloud layers and lightning (the weather kit's). The Renderer and FrameWriter draw it. What a world
// type adds, and what the features on in it bring (the structures the entities build, the buses running on them...), is
// composed in as extensions, never by subclassing.
//
// WorldExtension: a class built with the world (new E(world), before its entities), kept as world.ext[E.key]: the
// world type's and the features' on in it (their extensions.world); each hook optional, called in order:
//   created()           after the core's systems (terrain, curvature, weather, clouds, lightning), before the entities:
//                       a feature puts its own in their place (the curvature feature's Curvature)
//   centre()            [x, z]: where what the scenario does not place goes (the lit town); the first one's
//   build()             after the entities stamped the terrain: what they build (the structures feature's Structures:
//                       each entity's build(structures))
//   townLit()           after the lit town (streetLights) is painted (the structures feature's distant lights)
//   spawned()           after the entities spawned
//   advance(dt, wdt)    each frame, before the entities (dt real s, wdt weather s)
//   after(dt, wdt, t)   each frame, after the entities (the structures feature's lifts)
//   features(out)       the GPU's analytic structures: out { ms, shelves, tornado } (the entities' are in already)
//   hurricane(maxTop)   a hurricane for the GPU (12 floats: the weather pass, hurricaneKeep) or null; the first one's
//   colliders(p, out)   what a walker at feet p walks on and into (Walker); carrierAt(p): the moving floor it stands on
//   sheltered(p)        the interior that shelters p from the weather, or null (atmosphereWorld: sheltered)

Features.kit('atmosphere', (engine, kit) => {
const { kits } = engine;
const { MAX_CELLS, MAX_MOTHERSHIPS, MAX_SHELVES } = kit;
const { LandField } = kits.terrain;
const { WeatherSystem, RainZones, CloudLayers, Lightning } = kits.weather;

// The outdoors drawn flat, what a world without a `curvature` entity has (the curvature feature's Curvature in its place):
// what the frame, the HUD and the culling ask of one (as the curvature kit's Curvature does when off)
class FlatCurvature {
    constructor(reference = 0) {
        this.on = false;
        this.radius = 6371000;
        this.reference = reference;
        this.setEye([0, reference, 0]);
    }

    setEye(eye) { this.eye = [eye[0], eye[1], eye[2]]; this.K = this.radius + Math.max(eye[1] - this.reference, -0.5 * this.radius); }
    horizon() { return 260000; }
    horizonDip() { return 0; }
    offset() { return [0, 0, 0]; }
    toRender(p) { return [p[0], p[1], p[2]]; }
    toWorld(r) { return [r[0], r[1], r[2]]; }
    bounds(lo, hi, outLo = [0, 0, 0], outHi = [0, 0, 0]) { for (let k = 0; k < 3; k++) { outLo[k] = lo[k]; outHi[k] = hi[k]; } return [outLo, outHi]; }
    gpu() { return [this.K, 0, this.horizon() * 1.1, this.radius]; }
}

class World {
    // types: the entity classes by type name; town: the class the lit town (scenario streetLights) is painted with (a
    // town entity's); extensions: WorldExtension classes
    constructor(scenario, { types, town, extensions = [] }) {
        this.scenario = scenario;
        this.types = types;
        this.ext = {};
        this.extensions = extensions.map(E => (this.ext[E.key] = new E(this)));
        this.meshes = null;             // the common mesh interface (kits.mesh), for what draws itself (a bus): the structures'
        this.lamps = null;              // lamp kinds, for what lights itself (a bus's headlights, tail lights, cabin): theirs
        const t = { size: 64000, resolution: 512, base: 1500, fieldSize: 800, pivots: 0.2, ...(scenario.terrain || {}) };
        this.terrain = t;
        this.field = new LandField(t.size, t.resolution, t.base, { rough: t.rough || 0 });
        // the outdoors drawn flat (a `curvature` entity turns the curvature feature on: a round planet in its place)
        this.curvature = new FlatCurvature(t.base);
        this.weather = new WeatherSystem(scenario.weather);
        this.clouds = new CloudLayers(scenario.clouds);
        this.lightning = new Lightning();
        for (const x of this.extensions) x.created?.();
        this.entities = [];
        this.byId = new Map();
        this.flashCount = 0;
        this.buses = [];                 // the vehicles to board and ride (the buses feature's: every bus of every BusLine)
        this.busBoost = 1;               // their time runs this many times as fast (hold Z)
        for (const def of scenario.entities || []) this.add(def, false);
        for (const e of this.entities) { e.stamp(this.field); this.field.updateRange(); }
        for (const x of this.extensions) x.build?.();
        // the lit town (streetLights): painted like a town entity (the structures feature gives its streets the fake lamps)
        const sl = scenario.streetLights;
        this.streetLights = sl ? { pos: sl.pos || this.centre, radius: sl.radius || 4000, density: sl.density ?? 0.95 } : null;
        if (this.streetLights) new town(this.streetLights, this).stamp(this.field);
        for (const x of this.extensions) x.townLit?.();
        for (const e of [...this.entities]) e.spawn();
        for (const x of this.extensions) x.spawned?.();
        this.rainZones = new RainZones(this);
    }

    // where what the scenario does not place goes: an extension's, or the middle
    get centre() {
        for (const x of this.extensions) if (x.centre) return x.centre();
        return [0, 0];
    }

    // open water at x, z: the sea off the coastline, the land-use map's (inland: by the shore the coastline is finer), or
    // an entity's own (a river's channel, which villages draw at its true width)
    water(x, z) {
        const d = this.field.coastAt?.(x, z)[0] ?? Infinity;
        return d < 0 || this.field.landAt(x, z, 2) > 0.4 && d > 20 || this.entities.some(e => e.waterAt?.(x, z));
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
        for (const x of this.extensions) x.after?.(dt, wdt, t);
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

return { World, FlatCurvature };
});
