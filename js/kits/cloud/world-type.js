'use strict';
// The cloud world (Entity Cloud): volumetric clouds and a weather system (storm cells, precipitation shafts, lightning,
// buildings and buses that keep the rain off). A scenario's `cloud` root entity makes one: the engine finds the world
// type in this kit (Features.KITS.cloud.worlds) and loads it with the kits it uses. It is composed, not derived: the
// atmosphere kit's World (terrain, structures, buses, weather, lightning) with this kit's entity types and its Storms,
// the atmosphere kit's App and adapter (AtmosphereWorld) with its Clouds.

Features.kit('cloud', (engine, kit) => {
const { World, AtmosphereWorld } = engine.kits.atmosphere;
const { ENTITY_TYPES, Town, Storms, Clouds } = kit;

const cloud = {
    title: 'ENTITY CLOUD',
    world: scenario => new World(scenario, { types: ENTITY_TYPES, town: Town, extensions: [Storms] }),
    extensions: [Clouds],
};

// the world types this kit offers (a scenario root entity of that type): { create(ctx) } each
return { cloud, worlds: { cloud: { create: ctx => new AtmosphereWorld(ctx, cloud) } } };
});
