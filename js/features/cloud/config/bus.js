'use strict';
// The bus: its body dimensions in its own frame, liveries and material flags.

Features.part('cloud', (engine, feature) => {
// The bus (BusLine) in its own frame: x forward (the front at +hl), y up from the road, z to its right, where the doors are.
// The side windows fill `bays` bays of `bay` m from bay0, a pillar between each; the front door fills bay 7, the middle
// door bay 3. Its body, from the skirt to the roof, is the cabin: no rain, snow or volumetrics inside it (inCabin in WGSL)
const BUS = {
    hl: 6, hw: 1.27, floor: 0.36, ceil: 2.5, roof: 2.92, skirt: 0.3, winLo: 1.05, winHi: 2.25, bay0: -5.65, bay: 1.4125, bays: 8,
    pillar: 0.12, doorBays: [7, 3], axleF: 3.4, axleR: -3.1, wheel: 0.5, wall: 0.07,
};
// liveries of the buses at a bus station, and of a bus line's buses after its first (BusLine)
const BUS_LIVERIES = [[0.16, 0.36, 0.18], [0.70, 0.66, 0.58], [0.14, 0.30, 0.48], [0.62, 0.16, 0.12]];
const BUS_DRAW = 5000;       // m: buses further from the camera are not drawn (a 12 m bus is a few pixels there)
const BUS_IN = 64;           // material flag: inside the cabin (lit through its windows and by its lamps, see fsBus)
const BUS_LEAF = [8, 16];    // material flags: door leaves that slide toward -x / +x as the doors open (busVertex)

return { BUS, BUS_LIVERIES, BUS_DRAW, BUS_IN, BUS_LEAF };
});
