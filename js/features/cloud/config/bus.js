'use strict';
// The bus: its body dimensions in its own frame and liveries (the transit kit's), and its material flags.

Features.part('cloud', (engine, feature) => {
// the bus's dimensions and liveries are the transit kit's (kits.transit BUS, BUS_LIVERIES)
const { BUS, BUS_LIVERIES } = engine.kits.transit;
const BUS_DRAW = 5000;       // m: buses further from the camera are not drawn (a 12 m bus is a few pixels there)
const BUS_IN = 64;           // material flag: inside the cabin (lit through its windows and by its lamps, see fsBus)
const BUS_LEAF = [8, 16];    // material flags: door leaves that slide toward -x / +x as the doors open (busVertex)

return { BUS, BUS_LIVERIES, BUS_DRAW, BUS_IN, BUS_LEAF };
});
