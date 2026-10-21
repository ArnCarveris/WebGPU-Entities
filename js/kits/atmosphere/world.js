'use strict';
// The atmosphere's WorldExtension (the one World, kits.world): a world under the atmosphere: the scenario's entities (its
// types) on a terrain (the terrain kit's LandField), the weather state, the cloud layers and lightning (the weather kit's).
// The renderer and FrameWriter draw it. What a world type adds, and what the features on in it bring (the structures the
// entities build, the buses running on them...), is composed in as the world's other extensions, never by subclassing.
//
// Their WorldExtensions: classes built with the world (world.compose: new E(world), before its entities), kept as
// world.ext[E.key]: the world type's and the features' on in it (their extensions.world); each hook optional, called in
// order:
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
    altitude(p) { return p[1] - this.reference; }
    offset() { return [0, 0, 0]; }
    toRender(p) { return [p[0], p[1], p[2]]; }
    toWorld(r) { return [r[0], r[1], r[2]]; }
    bounds(lo, hi, outLo = [0, 0, 0], outHi = [0, 0, 0]) { for (let k = 0; k < 3; k++) { outLo[k] = lo[k]; outHi[k] = hi[k]; } return [outLo, outHi]; }
    gpu() { return [this.K, 0, this.horizon() * 1.1, this.radius]; }
}

class WorldExtension {
    static key = 'atmosphere';
    // what it answers on the World (Common.Composite)
    static exposes = ['busBoost', 'buses', 'centre', 'clouds', 'curvature', 'far', 'features', 'field', 'flashCount',
        'gpuCells', 'hurricaneData', 'lamps', 'lightning', 'meshes', 'rainZones', 'scenario', 'streetLights',
        'structures', 'terrain', 'types', 'update', 'water', 'weather'];
    // types: the entity classes by type name; town: the class the lit town (scenario streetLights) is painted with (a
    // town entity's); extensions: the other WorldExtension classes
    constructor(world, scenario, { types, town, extensions = [] }) {
        this.world = world;
        this.scenario = scenario;
        this.types = types;
        world.compose(extensions);
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
        world.each('created');
        this.flashCount = 0;
        this.buses = [];                 // the vehicles to board and ride (the buses feature's: every bus of every BusLine)
        this.busBoost = 1;               // their time runs this many times as fast (the bus menu's ×10)
        for (const def of scenario.entities || []) world.add(def, { spawn: false });
        for (const e of this.world.entities) { e.stamp(this.field); this.field.updateRange(); }
        this.world.each('build');
        // the lit town (streetLights): painted like a town entity (the structures feature gives its streets the fake lamps)
        const sl = scenario.streetLights;
        this.streetLights = sl ? { pos: sl.pos || this.centre, radius: sl.radius || 4000, density: sl.density ?? 0.95 } : null;
        if (this.streetLights) new town(this.streetLights, world).stamp(this.field);
        this.world.each('townLit');
        for (const e of [...this.world.entities]) e.spawn();
        this.world.each('spawned');
        this.rainZones = new RainZones(world);
    }

    // where what the scenario does not place goes: an extension's, or the middle
    get centre() {
        for (const x of this.world.extensions) if (x.centre) return x.centre();
        return [0, 0];
    }

    // open water at x, z: the sea off the coastline, the land-use map's (inland: by the shore the coastline is finer), or
    // an entity's own (a river's channel, which villages draw at its true width)
    water(x, z) {
        const d = this.field.coastAt?.(x, z)[0] ?? Infinity;
        return d < 0 || this.field.landAt(x, z, 2) > 0.4 && d > 20 || this.world.entities.some(e => e.waterAt?.(x, z));
    }

    // analytic storm structures for the GPU: motherships (12 floats each) and shelf lines (16 floats each), a tornado
    features() {
        const out = { ms: [], shelves: [], tornado: null };
        for (const e of this.world.entities) e.features(out);
        this.world.each('features', out);
        return { ms: out.ms.slice(0, MAX_MOTHERSHIPS), shelves: out.shelves.slice(0, MAX_SHELVES), tornado: out.tornado };
    }

    // a hurricane for the GPU, or null
    hurricaneData(maxTop) {
        return this.world.first('hurricane', maxTop);
    }

    update(dt, wdt, t) {
        this.weather.update(dt, wdt);
        this.rainZones.update(dt);
        this.world.each('advance', dt, wdt);
        for (const e of [...this.world.entities]) e.update(dt, wdt, t);
        this.world.each('after', dt, wdt, t);
        if (this.world.entities.some(e => e.dead)) {
            this.world.entities = this.world.entities.filter(e => !e.dead);
            for (const [k, e] of this.world.byId) if (e.dead) this.world.byId.delete(k);
        }
        this.lightning.update(dt);
    }

    // storm cells for the GPU, nearest to `around` first when there are too many
    gpuCells(around) {
        const list = this.world.entities.map(e => e.cell()).filter(Boolean);
        if (list.length > MAX_CELLS) list.sort((a, b) => Math.hypot(a.x - around[0], a.z - around[2]) - Math.hypot(b.x - around[0], b.z - around[2]));
        return list.slice(0, MAX_CELLS);
    }
}

return { WorldExtension, FlatCurvature };
});
