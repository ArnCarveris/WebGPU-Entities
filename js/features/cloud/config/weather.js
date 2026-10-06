'use strict';
// Weather defaults: the layer state, rain variants, cloud genus layers and time scales.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { clamp } = Common;

const WEATHER_DEFAULTS = {
    coverage: 0.3, base: 3000, top: 4500, density: 0.04, cirrus: 0.2, wind: [8, 0], temperature: 20, haze: 1,
    drizzle: 0, storms: 1, power: 1, lightning: 1, layers: {}, rain: 1, drops: 0.8,
};
// how fast rain falls (m/s) for a drop size between 0 (drizzle, fine droplets) and 1 (downpour, big drops)
const rainFall = drops => 2.5 + 7.5 * Math.pow(clamp(drops, 0, 1), 0.7);
// the rain variants N steps through (weather states of these names); "mixed rain" has them all at once along the bus route
const RAIN_VARIANTS = ['drizzle', 'light rain', 'medium rain', 'downpour', 'mixed rain'];
// cloud genus layers (scenario `clouds`): kind heap | sheet | cellular
const LAYER_DEFAULTS = {
    name: 'layer', kind: 'sheet', base: 2000, top: 2600, mapScale: 25000, shapeScale: 9000, stretch: 2, erosion: 0.2,
    density: 0.02, ambient: 1, precip: 0,
};
const LAYER_KINDS = { heap: 0, sheet: 1, cellular: 2 };
const TIME_SCALES = [1, 5, 10, 20, 40, 80, 160];

return { WEATHER_DEFAULTS, rainFall, RAIN_VARIANTS, LAYER_DEFAULTS, LAYER_KINDS, TIME_SCALES };
});
