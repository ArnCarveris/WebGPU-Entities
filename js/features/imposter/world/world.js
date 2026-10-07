'use strict';
// The world: builds the scenario's entities into archetypes.

Features.part('imposter', (engine, feature) => {
const { kits } = engine;
const { Archetype, ENTITY_TYPES } = feature;

class World {
    constructor(game, scenario) {
        this.game = game;
        this.sc = scenario;
        this.lib = game.lib;
        this.archetypes = new Map();
        this.list = [];
        this.entities = [];
        this.terrain = null;
        this.occ = new Map();           // spatial hash of footprints: 8 m cells -> [x, z, r, ...]
        this.occMax = 0;
        this.warnings = [];
    }

    async build() {
        this.lib.load(this.sc);
        for (const def of this.sc.entities || []) kits.world.addEntity(this, ENTITY_TYPES, def, { warnings: this.warnings, tolerant: true });
        this.warnings.push(...new Set(this.lib.warnings));
        this.list = [...this.archetypes.values()];
        for (const a of this.list) {
            if (a.asset.settings.enabled && !a.asset.atlas) await this.game.bake(a.asset);
            a.create(this.game.renderer);
        }
    }

    archetype(model) {
        const asset = typeof model === 'string' ? this.lib.asset(model) : model;
        let a = this.archetypes.get(asset.name);
        if (!a) this.archetypes.set(asset.name, a = new Archetype(asset));
        return a;
    }

    heightAt(x, z) { return this.terrain ? this.terrain.height(x, z) : 0; }

    occupy(x, z, r) {
        const k = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
        let c = this.occ.get(k);
        if (!c) this.occ.set(k, c = []);
        c.push(x, z, r);
        this.occMax = Math.max(this.occMax, r);
    }

    occupied(x, z, r) {
        const reach = r + this.occMax, i0 = Math.floor((x - reach) / 8), i1 = Math.floor((x + reach) / 8);
        const j0 = Math.floor((z - reach) / 8), j1 = Math.floor((z + reach) / 8);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const c = this.occ.get(`${i},${j}`);
            if (c) for (let k = 0; k < c.length; k += 3) if (Math.hypot(c[k] - x, c[k + 1] - z) < r + c[k + 2]) return true;
        }
        return false;
    }

    update(dt, t) { for (const e of this.entities) e.update(dt, t); }

    destroy() { for (const a of this.list) a.destroy(); }
}

return { World };
});
