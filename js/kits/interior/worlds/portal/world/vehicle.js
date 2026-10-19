'use strict';
// Vehicles on routes: the ship (the transit kit's shipType: a transit line's vehicle that can also be steered).

Features.world('portal', (engine, kit) => {
const Vehicle = engine.kits.transit.shipType();

return { Vehicle };
});
