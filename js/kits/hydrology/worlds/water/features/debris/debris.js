'use strict';
// Floating debris (the scenario's `debris` entities: emitters of logs): particles on the GPU, carried by the flow and
// respawned at their emitters, drawn as boxes on the water. Without them, none of it is made.

Features.feature('hydrology/water/debris', (engine, kit) => {
const { DebrisSystem, WGSL_DEBRIS } = kit;

class DebrisApp {
    static key = 'debris';
    constructor(app) { this.app = app; }
    load() { const a = this.app; a.debris = new DebrisSystem(a.renderer.device, a.flow, a.world); }
}

class DebrisRenderer {
    static key = 'debris';
    constructor(r) { this.r = r; }

    wgsl(lib, modules) {
        lib.define('DEBRIS', WGSL_DEBRIS);
        modules.surface.push('DEBRIS');
    }

    pipelines({ surface, layoutB, pipe }) {
        this.pDebris = pipe(layoutB, surface, 'vsDebris', 'fsDebris', this.r.format, { write: false, compare: 'greater' }, { cull: 'back' });
    }

    // the logs, on the water
    surface(b) { if (this.r.debrisCount) { b.setPipeline(this.pDebris); b.draw(36, this.r.debrisCount); } }
}

return { extensions: { app: DebrisApp, renderer: DebrisRenderer } };
});
