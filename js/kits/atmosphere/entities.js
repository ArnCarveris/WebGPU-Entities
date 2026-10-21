'use strict';
// The cloud world's entity types: any kit's whose base is a terrain entity and whose needs this world provides
// (structures, weather: the kit manifest), made over the cloud's entity base.

Features.world('cloud', (engine, kit) => {
const { kits } = engine;

// The cloud's entities stand on its heightfield (kits.terrain TerrainEntity: stamp, build, spawn, update(dt, wdt, t),
// features, cell); labels 300 m over the ground.
class Entity extends kits.terrain.TerrainEntity {
    get labelLift() { return 300; }
}

const ENTITY_TYPES = kits.world.entityTypes('cloud', { terrain: Entity }, { terrainTypes: { peakLabel: 100, lake: { radius: 1000 } } });
const { Town } = ENTITY_TYPES.group('terrainTypes');
const { StormCell, Supercell, SquallLine, Spawner } = ENTITY_TYPES.group('weatherTypes');
const { HURRICANE, TORNADO } = kits.weather;

return { Entity, ENTITY_TYPES, Town, StormCell, Supercell, SquallLine, Spawner, HURRICANE, TORNADO };
});
