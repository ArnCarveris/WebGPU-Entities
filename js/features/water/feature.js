'use strict';
// Entity Water, as a feature of WebGPU Entities: a GPU shallow-water river simulation over a heightmap (after Filip
// Strugar's RiverSim) with surface-wave cascades, debris and screen-space water rendering. The engine is the one from
// the WebGPU-EntityWater demo; the host (js/engine/host.js) gives it its device, canvas target, input and HUD root, and
// builds its scenario from entities ("water.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.water (js/engine/features.js).
//
// Entity Water: a GPU shallow-water river simulation over a heightmap, after Filip Strugar's RiverSim
// (github.com/fstrugar/riversim), rebuilt as one static WebGPU page.
//
//   1. Flow sim (per step, compute): virtual-pipe style diffusion + acceleration along the water surface
//      gradient (8 neighbours), RiverSim's velocity regulation (linear / quadratic / depth-based friction),
//      water sources, then mass-conserving forward advection of depth and momentum by the velocity field.
//   2. Surface waves (per frame, compute): finite-difference wave maps in cascades that follow the camera,
//      advected by the flow velocity, excited by flow turbulence, plus an advected foam map.
//   3. Render: terrain (soft heightfield shadows, wet banks, caustics), then water with screen-space
//      refraction, depth absorption, sky reflection, flow-mapped detail normals and foam.
//
// The world is data (the scenario JSON above). Every entity is a class in ENTITY_TYPES: terrain features
// stamp the heightmap, water entities fill lakes, add sources / sinks, or emit floating debris.

Features.part('water', (engine, feature) => {
const { kits } = engine;
const { FeatureWorld } = kits.world, { HUD } = FeatureWorld;
const { NEAR, RENDER_MODES, Dam, App, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these; view / setView: its camera's).
class WaterWorld extends FeatureWorld {
    constructor(fx) { super(fx, HUD.labels + HUD.toast); }

    createApp(fx) { return new App(fx); }

    // reversed-Z, infinite far plane, metres
    depth() {
        const r = this.app.renderer;
        return r.depthView && { view: r.depthCView || r.depthView, kind: 'reversed', near: NEAR };
    }

    // its scenario's views (water.view)
    views() {
        const a = this.app;
        return (a.views || []).map((v, i) => ({ name: v.name, go: () => { a.viewIndex = i; a.jump(v); } }));
    }

    // the terrain, on the map
    ground(p) {
        const f = this.app.world?.field;
        return f && Math.max(Math.abs(p[0]), Math.abs(p[2])) <= f.size / 2 ? f.sample(p[0], p[2]) : null;
    }

    stats() {
        const a = this.app, w = a.world, f = w.field, st = a.flow.stats, cam = a.camera.pos;
        const ground = f.sample(cam[0], cam[2]);
        return {
            name: w.scenario.name, fps: a.fps, paused: a.paused,
            volume: st.volume, wet: st.wet * f.cell * f.cell, maxSpeed: st.maxSpeed, inflow: a.flow.inflow || 0,
            boost: w.boost, rain: w.rainOn, breached: w.entities.some(e => e instanceof Dam && e.target),
            settling: a.flow.warmupLeft > 0 ? 1 - a.flow.warmupLeft / a.flow.cfg.warmup : 1,
            light: a.lightName, mode: RENDER_MODES[a.mode], tool: a.tool ? a.tool.name : '', acting: a.acting,
            height: cam[1] - Math.max(ground, w.seaLevel ?? -1e4), debris: a.debris.count, steps: a.stepsPerFrame,
        };
    }

    // the readout and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); }

    set(key, v) {
        const a = this.app, w = a.world;
        if (key === 'rain') w.rainOn = !!v;
        else if (key === 'boost') w.boost = !!v;
        else if (key === 'paused') a.paused = !!v;
        else if (key === 'light' && a.lightNames.includes(v)) a.setLight(v);
        else if (key === 'breach') for (const d of w.entities) if (d instanceof Dam && !!d.target !== !!v) d.toggle();
    }
}

return { create: ctx => new WaterWorld(ctx) };
});
