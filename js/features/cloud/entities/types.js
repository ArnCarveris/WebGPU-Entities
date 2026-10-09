'use strict';
// The scenario's entity types, by name: the kits' (terrain, settlement, transit, weather), over the cloud's entity base.

Features.part('cloud', (engine, feature) => {
const { kits } = engine;

// The cloud's entities stand on its heightfield (kits.terrain TerrainEntity: stamp, build, spawn, update(dt, wdt, t),
// features, cell); labels 300 m over the ground.
class Entity extends kits.terrain.TerrainEntity {
    get labelLift() { return 300; }
}

const { Tilt, Hills, Mountain, Range, River, Lake, Clearing, Town, Forest } = kits.terrain.terrainTypes(Entity, { peakLabel: 100, lake: { radius: 1000 } });
const { Village, BusStation, Skyscraper, Structure } = kits.settlement.settlementTypes(Entity);
const { Bus, BusLine } = kits.transit.busTypes(Entity);
const { StormCell, Supercell, SquallLine, Spawner } = kits.weather.weatherTypes(Entity);
const { HURRICANE, TORNADO } = kits.weather;

const ENTITY_TYPES = {
    clearing: Clearing,
    tilt: Tilt,
    hills: Hills,
    mountain: Mountain,
    range: Range,
    river: River,
    lake: Lake,
    town: Town,
    forest: Forest,
    village: Village,
    busStation: BusStation,
    skyscraper: Skyscraper,
    structure: Structure,
    bus: BusLine,
    storm: StormCell,
    supercell: Supercell,
    squall: SquallLine,
    spawner: Spawner,
};

return { Entity, ENTITY_TYPES, Town, River, Bus, BusLine, StormCell, Supercell, SquallLine, Spawner, HURRICANE, TORNADO };
});
