'use strict';
// The portal world's entity types: any kit's whose base is a sector entity (the kit manifest: the entities kit's props,
// screens, lamps, stairs, hulls, helms, doors, drones and security cameras), drawn through the world's meshes
// (World.meshes, the common mesh interface).

Features.world('portal', (engine, kit) => {
const { kits } = engine;

// World entities (kits.entities SectorEntity: spawn, link once every entity and vehicle exists, update(dt, t, actors))
const ENTITY_TYPES = kits.world.entityTypes('portal', { sector: kits.entities.SectorEntity });

return { ENTITY_TYPES };
});
