'use strict';
// The world: builds the scenario's entities into the heightfield and the initial water.

Features.part('water', (engine, feature) => {
const { kits } = engine;
const { Heightfield, ENTITY_TYPES } = feature;

class World {
    constructor(scenario) {
        this.scenario = scenario;
        const t = { size: 2048, resolution: 512, base: 0, ...(scenario.terrain || {}) };
        this.field = new Heightfield(t.size, t.resolution, t.base);
        this.snowLine = t.snowLine ?? 1e4;
        this.entities = [];
        this.byId = new Map();
        this.emitters = [];
        this.seaLevel = null;
        this.rainOn = false;
        this.boost = false;
        for (const def of scenario.entities || []) kits.world.addEntity(this, ENTITY_TYPES, def, { spawn: false });
        for (const e of this.entities) { e.stamp(this.field); this.field.updateRange(); }
        this.water = new Float32Array(this.field.n * this.field.n);
        for (const e of this.entities) e.fill(this.water);
        for (const e of this.entities) e.spawn();
        this.field.dirty = null;
    }

    get(id) { return this.byId.get(id); }

    gather() {
        const out = { list: [], rain: 0 };
        for (const e of this.entities) e.sources(out);
        return out;
    }

    update(dt, t) { for (const e of this.entities) e.update(dt, t); }
}

return { World };
});
