'use strict';
// The origin world's entity types: any kit's whose base is a space entity (the kit manifest: the entities kit's bodies,
// props, fields, orbiters), drawn through the world's meshes (World.meshes, the common mesh interface).

Features.world('origin', (engine, kit) => {
const { kits } = engine;

// World entities: each built from a scenario definition ({ type, id, ... }) and spawned once, in scenario order, placed
// by World.resolve (kits.entities SpaceEntity)
const ENTITY_TYPES = kits.world.entityTypes('origin', { space: kits.entities.SpaceEntity });
const { Body } = ENTITY_TYPES.group('spaceTypes');

return { Body, ENTITY_TYPES };
});
