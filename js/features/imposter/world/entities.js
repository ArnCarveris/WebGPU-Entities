'use strict';
// The scenario's entity types, by name: the terrain kit's mesh terrain and the entities kit's ground props, drawn
// through the world's meshes (World.meshes, the common mesh interface).

Features.part('imposter', (engine, feature) => {
const { kits } = engine;

// Each is constructed from a scenario definition ({ type, id, ... }) and spawned once, in scenario order (kits.world's
// Entity).
const { Entity } = kits.world;
const Terrain = kits.terrain.meshTerrain(Entity);
const { Prop, Compare, Scatter } = kits.entities.groundProps(Entity);

const ENTITY_TYPES = { terrain: Terrain, prop: Prop, compare: Compare, scatter: Scatter };

return { ENTITY_TYPES };
});
