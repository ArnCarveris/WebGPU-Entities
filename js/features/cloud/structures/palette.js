'use strict';
// The structures' lamps (colour, intensity, reach, cone) and colours (the mesh kit's).

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
    room: { color: [1.0, 0.86, 0.66], intensity: 40, range: 16, size: 0.35 },      // a lit storey, out through its windows and doors (size: x its smaller half size)
    flashlight: { color: [1.0, 0.94, 0.84], intensity: 30, range: 60, size: 0.8, cone: [22, 6] },
};

// the structures' colours (walls, roofs, roads, materials): the mesh kit's
const STRUCT_COLORS = engine.kits.mesh.PALETTE;

return { LAMPS, STRUCT_COLORS };
});
