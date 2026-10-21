'use strict';
// World: the one world every world type is (Common.Composite). What a type makes of it is its WorldExtension (the
// atmosphere's, the water's, the facility's...), which answers for it what it exposes: its terrain, its systems, its
// update. The World holds what every world has: its entities, by id.

Features.kit('world', (engine, kit) => {
const { Composite } = engine.Common;
const { addEntity } = kit;

class World {
    // E: its own WorldExtension, new E(world, ...args) (or later: world.extend(E, ...args)): it keeps the world
    // (this.world = world), builds it and composes in its features' (world.compose(list): new F(world), world.ext[F.key])
    constructor(E, ...args) {
        const world = Composite.of(this);
        this.entities = [];
        this.byId = new Map();
        if (E) Composite.own(world, E, ...args);
        return world;
    }

    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // its own extension, on a world made empty (new World()); everything off it, its entities too (a site rebuilt in
    // place); one kept beside it (Common.Composite)
    extend(E, ...args) { Composite.own(this, E, ...args); return this; }
    reset() { Composite.reset(this); this.entities = []; this.byId = new Map(); return this; }
    attach(key, E, ...args) { return Composite.attach(this, key, E, ...args); }

    // its extensions' hooks, in compose order (Common.Composite): every one's, the first truthy result, the largest
    // number, every result
    each(name, ...args) { return Composite.each(this, name, ...args); }
    first(name, ...args) { return Composite.first(this, name, ...args); }
    most(name, ...args) { return Composite.most(this, name, ...args); }
    all(name, ...args) { return Composite.all(this, name, ...args); }

    // a scenario entity of one of its types (its base's `types`: the entity classes by type name), spawned unless not
    // (opts: kits.world addEntity's)
    add(def, opts) { return addEntity(this, this.types, def, opts); }

    get(id) { return this.byId.get(id); }
}

return { World };
});
