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

return { Entity };
});
