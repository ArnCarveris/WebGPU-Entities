'use strict';
// The cloud world (Entity Cloud): volumetric clouds and a weather system (storm cells, precipitation shafts, lightning,
// buildings and buses that keep the rain off). A scenario's `cloud` root entity makes one: the engine finds the world
// in the atmosphere kit (js/kits/manifest.js: atmosphere.worlds.cloud) and loads its parts with the kits it uses. It is
// composed, not derived: the atmosphere kit's World (terrain, structures, buses, weather, lightning) with this world's
// entity types and its Storms, the atmosphere kit's App and adapter (AtmosphereWorld) with its Clouds.

Features.world('cloud', (engine, kit) => {
const { World, AtmosphereWorld, ENTITY_TYPES, Town, Storms, Clouds } = kit;

const cloud = {
    title: 'ENTITY CLOUD',
    // (the features' WorldExtensions first)
    world: (scenario, features = []) => new World(scenario, { types: ENTITY_TYPES, town: Town, extensions: [...features, Storms] }),
    extensions: [Clouds],
};

return { cloud, create: ctx => new AtmosphereWorld(ctx, cloud) };
});
