'use strict';
// The imposter world's entity types: any kit's whose base is a ground entity (the kit manifest: the terrain kit's mesh
// terrain, the entities kit's ground props), drawn through the world's meshes (World.meshes, the common mesh interface).

Features.world('imposter', (engine, kit) => {
const { kits } = engine;

// Each is constructed from a scenario definition ({ type, id, ... }) and spawned once, in scenario order (kits.world's
// Entity).
const ENTITY_TYPES = kits.world.entityTypes('imposter', { ground: kits.world.Entity });

return { ENTITY_TYPES };
});
