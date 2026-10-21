'use strict';
// The cloud world (Entity Cloud): volumetric clouds and a weather system (storm cells, precipitation shafts, lightning,
// buildings and buses that keep the rain off). A scenario's `cloud` root entity makes one: the engine finds the world
// in the atmosphere kit (js/kits/manifest.js: atmosphere.worlds.cloud) and loads its parts with the kits it uses. It is
// composed, not derived: the one World with the atmosphere kit's WorldExtension (terrain, structures, buses, weather,
// lightning), this world's entity types and its Storms; the one App with the atmosphere kit's AppExtension and adapter
// (atmosphereWorld) and its Clouds.

Features.world('cloud', (engine, kit) => {
const { WorldExtension, atmosphereWorld, ENTITY_TYPES, Town, Storms, Clouds } = kit;

const cloud = {
    title: 'ENTITY CLOUD',
    // (the features' WorldExtensions first)
    world: (world, scenario, features = []) => world.extend(WorldExtension, scenario, { types: ENTITY_TYPES, town: Town, extensions: [...features, Storms] }),
    extensions: [Clouds],
};

return { cloud, spec: atmosphereWorld(cloud) };
});
