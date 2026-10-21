'use strict';
// Storms: the cloud's extension of the atmosphere kit's World (world.ext.storms): the storm cells, supercells, squall
// lines and spawners among its entities, the clouds the scenario places itself (which the cloud picker shows and
// hides), a hurricane with an eye and a tornado under a supercell.

Features.world('cloud', (engine, kit) => {
const { Common } = engine;
const { smoothstep } = Common;
const { StormCell, Supercell, HURRICANE, SquallLine, Spawner } = kit;

class Storms {
    static key = 'storms';

    constructor(world) {
        this.world = world;
        this.hurricanePos = this.centre();
        this.hurricaneCat = 0;           // 0 off
        this.tornadoCat = 0;             // 0 off
    }

    // (the lit town by default where the hurricane is)
    centre() { return this.world.scenario.hurricane?.pos || [0, 0]; }
    // the persistent clouds hidden until the cloud picker (or a view on one) shows them
    spawned() { for (const e of this.persistent) this.setOff(e, true); }

    get cells() { return this.world.entities.filter(e => e instanceof StormCell); }
    get spawner() { return this.world.entities.find(e => e instanceof Spawner); }

    // the clouds the scenario places itself (supercells, squall lines, pinned or held cells), which the cloud picker
    // can hide and show again; a squall line's own cells go with it
    get persistent() {
        const es = this.world.entities, owned = new Set(es.flatMap(e => e.cells || []));
        return es.filter(e => !owned.has(e) && (e instanceof SquallLine || (e instanceof StormCell && (e.def.pinned || e.def.hold))));
    }

    setOff(e, off) {
        e.off = off;
        for (const c of e.cells || []) c.off = off;
    }

    // the supercell the tornado hangs from: the first one showing
    get tornadoHost() {
        if (!this.tornadoCat) return null;
        return this.world.entities.find(e => e instanceof Supercell && !e.off && e.state.coverage >= 0.05) || null;
    }

    advance(dt, wdt) {
        // a hurricane organises over some seconds (its eye contracting) and turns, faster the stronger it is
        this.hurricaneGrow = this.hurricaneCat ? Math.min(1, (this.hurricaneGrow || 0) + dt / 10) : 0;
        if (this.hurricaneCat) this.hurricaneTurn = ((this.hurricaneTurn || 0) + wdt * HURRICANE[this.hurricaneCat].wind / (HURRICANE[this.hurricaneCat].eye * 2)) % (Math.PI * 2000);
        // a tornado touches down over some seconds, and lifts at once
        this.tornadoGrow = this.tornadoHost ? Math.min(1, (this.tornadoGrow || 0) + dt / 8) : 0;
    }

    // the tornado for the GPU: its host's
    features(out) {
        const host = this.tornadoHost;
        if (host) out.tornado = host.tornado(this.tornadoCat, this.tornadoGrow);
    }

    // the hurricane for the GPU (12 floats, see the weather pass and hurricaneKeep)
    hurricane(maxTop) {
        if (!this.hurricaneCat || this.hurricaneGrow <= 0) return null;
        const k = HURRICANE[this.hurricaneCat], g = this.hurricaneGrow, base = this.world.weather.cur.base;
        const top = Math.max(Math.min(k.top, maxTop - 300), base + 3000);
        return [...this.hurricanePos, k.eye * (1.6 - 0.6 * smoothstep(0, 1, g)), smoothstep(0, 1, g),
            top, this.hurricaneTurn, k.bands, k.outer,
            k.precip, Math.min(k.bandTop, top - 1000), k.eyeFloor, k.ragged];
    }
}

return { Storms };
});
