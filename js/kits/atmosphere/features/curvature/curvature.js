'use strict';
// The outdoors drawn on a round planet (the scenario's `curvature` entity): the curvature kit's Curvature in the world in
// place of the core's flat one, and its WGSL in place of the flat stubs (CURVE). Without the entity the world is flat and
// none of it is loaded.

Features.feature('atmosphere/curvature', (engine, kit) => {
const { Curvature, CurvatureWGSL } = engine.kits.curvature;

class CurvatureWorld {
    static key = 'curvature';
    constructor(world) { this.world = world; }
    created() { const w = this.world; w.curvature = new Curvature(w.scenario.curvature, w.terrain.base); }
}

class CurvatureRenderer {
    wgsl(lib) { lib.replace('CURVE', CurvatureWGSL('F')); }
}

return { extensions: { world: CurvatureWorld, renderer: CurvatureRenderer } };
});
