'use strict';
// Drones (drone entities, js/kits/entities/sectors.js): they fly the world's navigation graph (world.nav), the other drones
// are actors to them as the player is, and they show on the map. Without drones there is no graph.

Features.feature('interior/portal/drones', (engine, kit) => {
const { NavGraph } = kit;

// the world's: its navigation graph, and the drones as actors (World.update)
class DronesWorld {
    static key = 'drones';
    constructor(world) {
        this.world = world;
        world.nav = new NavGraph(world);
    }
    actors() { return this.world.drones.map(d => d.pos); }
}

// the game's: the drones on the visibility inspector's map
class DronesApp {
    static key = 'drones';
    constructor(app) { this.app = app; }

    mapOver(c, { X, Y }) {
        c.fillStyle = '#ff5a40';
        for (const d of this.app.world.drones) { c.beginPath(); c.arc(X(d.pos[0]), Y(d.pos[2]), 3.5, 0, Math.PI * 2); c.fill(); }
    }
}

return { extensions: { world: DronesWorld, app: DronesApp } };
});
