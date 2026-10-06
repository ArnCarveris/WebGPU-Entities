'use strict';
// The structures' lamps (colour, intensity, reach, cone) and colours.

Features.part('cloud', (engine, feature) => {

// lights by night (Fixtures.lamp, LightWriter.write): colour, intensity (adapted to the exposure: the eye adapts to
// them), range (m), size (m: its falloff softens within about that of it), and a spot's cone (degrees off its axis: edge, core)
const LAMPS = {
    sodium: { color: [1.0, 0.58, 0.24], intensity: 85, range: 34, size: 0.6 },     // the village's street lamps
    led: { color: [0.90, 0.94, 1.0], intensity: 55, range: 34, size: 0.6 },        // the bus station's forecourt
    canopy: { color: [1.0, 0.95, 0.86], intensity: 30, range: 16, size: 1.2 },      // under the station's canopy
    porch: { color: [1.0, 0.76, 0.48], intensity: 6, range: 10, size: 0.5 },        // over a door
    shelter: { color: [0.92, 0.96, 1.0], intensity: 1.6, range: 8, size: 1.0 },       // under the bus shelter's roof
    headlight: { color: [1.0, 0.95, 0.86], intensity: 600, range: 75, size: 0.3, cone: [32, 10] },
    tail: { color: [1.0, 0.06, 0.03], intensity: 2.2, range: 7, size: 0.4 },
    cabin: { color: [1.0, 0.93, 0.80], intensity: 6, range: 9, size: 1.2 },        // a bus's cabin, out through its windows
    flashlight: { color: [1.0, 0.94, 0.84], intensity: 30, range: 60, size: 0.8, cone: [22, 6] },
};

const STRUCT_COLORS = {
    walls: [[0.78, 0.74, 0.66], [0.74, 0.72, 0.68], [0.70, 0.55, 0.38], [0.56, 0.32, 0.25], [0.58, 0.63, 0.64], [0.68, 0.64, 0.50]],
    roofs: [[0.40, 0.15, 0.11], [0.22, 0.23, 0.25], [0.32, 0.23, 0.17], [0.28, 0.31, 0.28]],
    plinth: [0.30, 0.29, 0.28], door: [0.22, 0.14, 0.09], window: [0.06, 0.08, 0.10], brick: [0.36, 0.20, 0.16],
    asphalt: [0.12, 0.12, 0.13], paint: [0.72, 0.72, 0.66], gravel: [0.40, 0.37, 0.32], concrete: [0.50, 0.49, 0.47],
    stone: [0.46, 0.43, 0.40], wood: [0.36, 0.25, 0.16], metal: [0.24, 0.26, 0.27], glass: [0.36, 0.42, 0.45], sign: [0.85, 0.70, 0.12],
};

return { LAMPS, STRUCT_COLORS };
});
