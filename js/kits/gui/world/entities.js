'use strict';
// The gui world's entity types: any kit's whose base is a fixture entity (the kit manifest: the entities kit's doors,
// lamps, beacons, lights, drones, cameras, the avatar, terminals and easels), drawn through the world's meshes
// (World.meshes, the common mesh interface).

Features.world('gui', (engine, kit) => {
const { kits } = engine;

// World entities (kits.entities FixtureEntity), each constructed from a scenario definition ({ type, id, ... })
const ENTITY_TYPES = kits.world.entityTypes('gui', { fixture: kits.entities.FixtureEntity });
const { SecurityCamera, Easel } = ENTITY_TYPES.group('fixtureTypes');

return { SecurityCamera, Easel, ENTITY_TYPES };
});
