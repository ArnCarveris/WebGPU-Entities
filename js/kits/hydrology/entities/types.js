'use strict';
// The water world's entity types: any kit's whose base is a terrain entity and whose needs this world provides (water:
// the kit manifest), made over the water's entity base.

Features.world('water', (engine, kit) => {
const { kits } = engine;

// The water's entities stand on its heightfield (kits.terrain TerrainEntity: stamp, fill, spawn, sources, update(dt, t));
// labels 16 m over the ground.
class Entity extends kits.terrain.TerrainEntity {}

const ENTITY_TYPES = kits.world.entityTypes('water', { terrain: Entity }, { terrainTypes: { peakLabel: 10, lake: { label: 12 } } });
const { Lake, Dam } = ENTITY_TYPES.group('terrainTypes');
const { Sea, Spring } = ENTITY_TYPES.group('hydrologyTypes');

return { Entity, ENTITY_TYPES, Lake, Dam, Sea, Spring };
});
