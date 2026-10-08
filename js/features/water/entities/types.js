'use strict';
// The scenario's entity types, by name: the kits' (terrain, hydrology), over the water's entity base.

Features.part('water', (engine, feature) => {
const { kits } = engine;

// The water's entities stand on its heightfield (kits.terrain TerrainEntity: stamp, fill, spawn, sources, update(dt, t));
// labels 16 m over the ground.
class Entity extends kits.terrain.TerrainEntity {}

const { Tilt, Hills, Mountain, Lake, Valley, Basin, Coast, Dam } = kits.terrain.terrainTypes(Entity, { peakLabel: 10, lake: { label: 12 } });
const { Sea, Spring, Drain, Rain, Debris } = kits.hydrology.hydrologyTypes(Entity);

const ENTITY_TYPES = {
    tilt: Tilt,
    hills: Hills,
    mountain: Mountain,
    valley: Valley,
    basin: Basin,
    coast: Coast,
    dam: Dam,
    sea: Sea,
    lake: Lake,
    spring: Spring,
    drain: Drain,
    rain: Rain,
    debris: Debris,
};

return { Entity, ENTITY_TYPES, Lake, Dam, Sea, Spring };
});
