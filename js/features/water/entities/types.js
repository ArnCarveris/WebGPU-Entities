'use strict';
// The scenario's entity types, by name.

Features.part('water', (engine, feature) => {
const { Tilt, Hills, Mountain, Valley, Basin, Coast, Dam, Sea, Lake, Spring, Drain, Rain, Debris } = feature;

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

return { ENTITY_TYPES };
});
