'use strict';
// Weather defaults and limits: the layer state, rain variants, cloud genus layers, time scales, and the budgets the
// weather state is sized by (layers, flashes, rain zones; a renderer's buffers take them as they are).

Features.kit('weather', (engine, kit) => {
const { Common } = engine;
const { clamp } = Common;

const MAX_LAYERS = 4;
const MAX_FLASHES = 6;
const MAX_BOLT_SEGS = 768;
const MAX_RAIN_ZONES = 64;           // points along the bus route with their own rain rate (RainZones, mixed rain)
const ZONE_STEP = 300, ZONE_RADIUS = 380;  // m between them, how far each one's rain reaches
const CLEAR_RADIUS = 450, CLEAR_WIDE = 3;   // a clear stretch's opening: m past its ends along the route, x that across it

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

return {
    MAX_LAYERS, MAX_FLASHES, MAX_BOLT_SEGS, MAX_RAIN_ZONES, ZONE_STEP, ZONE_RADIUS, CLEAR_RADIUS, CLEAR_WIDE,
    WEATHER_DEFAULTS, rainFall, RAIN_VARIANTS, LAYER_DEFAULTS, LAYER_KINDS, TIME_SCALES,
};
});
