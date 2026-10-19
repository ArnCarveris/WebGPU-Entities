'use strict';
// World: the one world every world type is (Common.Composite). What a type makes of it is its WorldExtension (the
// atmosphere's, the water's, the facility's...), which mounts itself on it and answers for it: its terrain, its systems,
// its update. The World holds what every world has: its entities, by id.

Features.kit('world', (engine, kit) => {
const { Composite } = engine.Common;
const { addEntity } = kit;

class World {
    // Base: the world type's WorldExtension, new Base(world, ...args): it mounts itself (this.world = world.mount(this)),
    // builds the world and composes in its features' (world.compose(list): new E(world), world.ext[E.key])
    constructor(Base, ...args) {
        const world = Composite.of(this);
        this.entities = [];
        this.byId = new Map();
        new Base(world, ...args);
        return world;
    }

    mount(base) { return Composite.mount(this, base); }
    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // a scenario entity of one of its types (its base's `types`: the entity classes by type name), spawned unless not
    // (opts: kits.world addEntity's)
    add(def, opts) { return addEntity(this, this.types, def, opts); }

    get(id) { return this.byId.get(id); }
}

return { World };
});
