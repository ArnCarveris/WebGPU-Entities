'use strict';
// Vehicles on routes (the scenario's `vehicles`: the freighter): the transit kit's shipType, a transit line's vehicle that
// can also be steered; sailed, boarded and driven, its route on the map. Without them the world has none (World.vehicles
// empty: nothing claims areas, rides or docks).

Features.feature('interior/portal/vehicles', (engine, kit) => {
const Vehicle = engine.kits.transit.shipType();

// the world's: its vehicles, made after its entities (each then claims what is inside its hull)
class VehiclesWorld {
    static key = 'vehicles';
    constructor(world) { this.world = world; }
    vehicles() { return (this.world.scn.vehicles || []).map(d => new Vehicle(this.world, d)); }
}

// the game's: their routes on the visibility inspector's map
class VehiclesApp {
    static key = 'vehicles';
    constructor(app) { this.app = app; }

    mapUnder(c, { path }) {
        for (const veh of this.app.world.vehicles) {
            c.setLineDash([3, 4]); c.strokeStyle = 'rgba(160,200,230,0.35)'; c.lineWidth = 1;
            path(veh.route.samples.map(sm => sm.p)); c.stroke();
            c.setLineDash([]);
        }
    }
}

return { Vehicle, extensions: { world: VehiclesWorld, app: VehiclesApp } };
});
