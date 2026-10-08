'use strict';
// The world: builds the scenario's entities into archetypes.

Features.part('imposter', (engine, feature) => {
const { kits } = engine;
const { Archetype, FORCE, Geo, MeshBuilder, lin, quat, ENTITY_TYPES } = feature;

// A builder of the mesh interface for indexed surfaces (point / face) over a Geo with vertex colours; finish(): the Geo
class GeoMesh {
    constructor() { this.g = new Geo(); this.g.col = []; }
    point(p, n, uv, color) { const i = this.g.vert(p, n, uv); this.g.col.push(...color); return i; }
    face(a, b, c, d) { this.g.quad(a, b, c, d); }
    finish() { return this.g; }
}

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
        // the common mesh interface (kits.mesh): instances are archetype slots (opts.lod: 'mesh' | 'imposter' forces how
        // they draw), add() makes a generated asset (opts: key, material, castShadows) from an indexed surface built only
        // when the library has none under that key; rotations as scenario `rot`s (a yaw, or [x, y, z] degrees); colours
        // as hex strings, to linear
        this.meshes = {
            builder: () => new GeoMesh(),
            add: (build, opts) => {
                const asset = this.lib.generated(opts.key, () => {
                    const b = new MeshBuilder();
                    b.add((typeof build === 'function' ? build() : build).finish(), this.lib.material(opts.material));
                    return b.finish();
                });
                asset.castShadows = opts.castShadows !== false;
                return asset;
            },
            instance: (model, p, opts = {}) => {
                const arch = this.archetype(model), slot = arch.add(p.pos, p.q, p.scale, FORCE[opts.lod] ?? 0);
                return { arch, slot, set: q => arch.set(slot, q.pos, q.q, q.scale) };
            },
            rotation: rot => quat.euler(rot),
            color: lin,
        };
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
