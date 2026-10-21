'use strict';
// The water's WorldExtension (the one World, kits.world): builds the scenario's entities into the heightfield and the
// initial water.

Features.world('water', (engine, kit) => {
const { Heightfield, ENTITY_TYPES } = kit;

class WorldExtension {
    static key = 'water';
    // what it answers on the World (Common.Composite)
    static exposes = ['boost', 'emitters', 'field', 'gather', 'rainOn', 'scenario', 'seaLevel', 'snowLine', 'types',
        'update', 'water'];
    constructor(world, scenario) {
        this.world = world;
        this.scenario = scenario;
        this.types = ENTITY_TYPES;
        const t = { size: 2048, resolution: 512, base: 0, ...(scenario.terrain || {}) };
        this.field = new Heightfield(t.size, t.resolution, t.base);
        this.snowLine = t.snowLine ?? 1e4;
        this.emitters = [];
        this.seaLevel = null;
        this.rainOn = false;
        this.boost = false;
        for (const def of scenario.entities || []) world.add(def, { spawn: false });
        for (const e of world.entities) { e.stamp(this.field); this.field.updateRange(); }
        this.water = new Float32Array(this.field.n * this.field.n);
        for (const e of world.entities) e.fill(this.water);
        for (const e of world.entities) e.spawn();
        this.field.dirty = null;
    }

    gather() {
        const out = { list: [], rain: 0 };
        for (const e of this.world.entities) e.sources(out);
        return out;
    }

    update(dt, t) { for (const e of this.world.entities) e.update(dt, t); }
}

return { WorldExtension };
});
