'use strict';
// The base of every world's entities.

Features.kit('world', (engine, kit) => {
// An entity built from a scenario definition ({ type, id, label, ... }) by its world, which calls spawn() once (in
// scenario order) and update() per frame. A feature's own base extends this with the hooks its world calls.
// An entity made of moving parts lists them as `members` (each with a label, and what it offers a view: describe(),
// focus, spots, board(app, spot)): a view entity that follows it with `each` is one view per member.
class Entity {
    constructor(def, world) {
        this.def = def;
        this.world = world;
        this.id = def?.id ?? null;
        this.label = def?.label || '';
    }

    spawn() {}
    update(dt, t) {}
}

// Builds the entity of scenario definition `def` from `types` (a feature's ENTITY_TYPES: type name -> class) and adds it to
// world.entities (and world.byId, if the world keeps one) before it spawns, so whatever its spawn() adds comes after it.
// An unknown type throws, or with `warnings` (a list) is reported there and skipped. `spawn: false` leaves spawning to
// the world (one that runs build passes over every entity first); `tolerant` (with warnings) also reports an entity that
// fails to build or spawn, and drops it.
function addEntity(world, types, def, { spawn = true, warnings = null, tolerant = false } = {}) {
    const Type = types[def.type];
    if (!Type) {
        const msg = `unknown entity type "${def.type}"`;
        if (warnings) { warnings.push(msg); return null; }
        throw new Error(msg);
    }
    let e = null;
    try {
        e = new Type(def, world);
        world.entities.push(e);
        if (e.id && world.byId) world.byId.set(e.id, e);
        if (spawn) e.spawn();
        return e;
    } catch (err) {
        if (!(tolerant && warnings)) throw err;
        if (e) {
            world.entities.splice(world.entities.indexOf(e), 1);
            if (e.id && world.byId?.get(e.id) === e) world.byId.delete(e.id);
        }
        warnings.push(`${def.type} "${def.id || def.model || ''}": ${err.message}`);
        return null;
    }
}

return { Entity, addEntity };
});
