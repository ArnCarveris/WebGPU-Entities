'use strict';
// The scenario's entity types, by name.

Features.part('cloud', (engine, feature) => {
const {
    Tilt, Hills, Mountain, Range, River, Lake, Town, Forest, Village, BusStation, BusLine, StormCell, Supercell,
    SquallLine, Spawner, Clearing,
} = feature;

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
    bus: BusLine,
    storm: StormCell,
    supercell: Supercell,
    squall: SquallLine,
    spawner: Spawner,
};

return { ENTITY_TYPES };
});
