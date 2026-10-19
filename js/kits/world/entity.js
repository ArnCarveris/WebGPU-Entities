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

// A world type's entity classes, by type name, from the kit manifest (Kits): every type whose implementation's base the
// world has and whose needs it provides (Kits.implsIn), made on first use by its kit's factory over the world's base:
// kits.<kit>.<factory>(bases[base], options[factory]), once per factory, so a world's classes are one set (instanceof
// holds between them). Reads as a table (types.storm, types[def.type]); group(factory) is a factory's whole set (the
// classes a world's code names). The kits must be loaded: the host loads each entity's before the world is built.
function entityTypes(world, bases, options = {}) {
    const made = new Map();
    const group = factory => {
        if (made.has(factory)) return made.get(factory);
        const impl = Object.values(Kits.IMPLS).flat().find(i => i.factory === factory);
        if (!impl) throw new Error(`${world}: no entity factory "${factory}" in the kit manifest`);
        const fn = engine.kits[impl.kit]?.[factory];
        if (typeof fn !== 'function') throw new Error(`${world}: kit "${impl.kit}" (with ${factory}) is not loaded`);
        const set = fn(bases[impl.base], options[factory]);
        made.set(factory, set);
        return set;
    };
    const resolve = type => {
        const impl = Kits.implsIn(world, type)[0];
        if (!impl) return undefined;
        const set = group(impl.factory);
        return impl.cls ? set[impl.cls] : set;
    };
    return new Proxy({ group }, { get: (t, k) => (k in t || typeof k !== 'string' ? t[k] : resolve(k)), has: (t, k) => !!Kits.implsIn(world, k).length });
}

// Builds the entity of scenario definition `def` from `types` (a world's entityTypes: type name -> class) and adds it to
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

return { Entity, addEntity, entityTypes };
});
