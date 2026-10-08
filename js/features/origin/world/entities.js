'use strict';
// The scenario's entity types, by name: the entities kit's space types (bodies, props, fields, orbiters), drawn through
// the world's meshes (World.meshes, the common mesh interface).

Features.part('origin', (engine, feature) => {
const { kits } = engine;

// World entities: each built from a scenario definition ({ type, id, ... }) and spawned once, in scenario order, placed
// by World.resolve (kits.entities SpaceEntity)
const Entity = kits.entities.SpaceEntity;
const { Body, Prop, Field, Orbiter } = kits.entities.spaceTypes(Entity);

const ENTITY_TYPES = {
    body: Body,
    prop: Prop,
    field: Field,
    orbiter: Orbiter,
};

return { Body, ENTITY_TYPES };
});
