'use strict';
// Surface waves (the scenario's `waves` with its layers): finite-difference wave maps in cascades that follow the camera,
// advected by the flow, excited by its turbulence, with an advected foam map; the surface samples them (fsWater). Without
// them the surface is calm (the core's stand-ins: no layers, WGSL waves() 0).

Features.feature('hydrology/water/waves', (engine, kit) => {
const { WaveCascade, WGSL_WAVE_SAMPLE } = kit;

class WavesApp {
    static key = 'waves';
    constructor(app) { this.app = app; }
    load(scenario) { const a = this.app; a.waves = new WaveCascade(a.renderer.device, a.flow, scenario.waves); }
}

class WavesRenderer {
    static key = 'waves';
    wgsl(lib) { lib.replace('WAVES', WGSL_WAVE_SAMPLE); }
}

return { extensions: { app: WavesApp, renderer: WavesRenderer } };
});
