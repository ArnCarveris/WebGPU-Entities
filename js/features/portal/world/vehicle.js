'use strict';
// Vehicles on routes: the ship (the transit kit's shipType: a transit line's vehicle that can also be steered).

Features.part('portal', (engine, feature) => {
const Vehicle = engine.kits.transit.shipType();

return { Vehicle };
});
