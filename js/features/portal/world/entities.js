'use strict';
// The scenario's entity types, by name: the entities kit's sector types (props, screens, lamps, stairs, hulls, helms,
// doors, drones and security cameras), drawn through the world's meshes (World.meshes, the common mesh interface).

Features.part('portal', (engine, feature) => {
const { kits } = engine;

// World entities (kits.entities SectorEntity: spawn, link once every entity and vehicle exists, update(dt, t, actors))
const Entity = kits.entities.SectorEntity;
const { SecurityCamera, Prop, Lamp, Stairs, Hull, Helm, Door, Drone } = kits.entities.sectorTypes(Entity);

const ENTITY_TYPES = {
    securityCamera: SecurityCamera,
    prop: Prop,
    light: Lamp,
    stairs: Stairs,
    hull: Hull,
    helm: Helm,
    door: Door,
    drone: Drone,
};

return { ENTITY_TYPES };
});
