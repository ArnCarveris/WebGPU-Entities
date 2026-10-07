'use strict';
// Entity Cloud, as a feature of WebGPU Entities: volumetric clouds and a weather system (storm cells, precipitation
// shafts, lightning, buildings and buses that keep the rain off). The engine is the one from the WebGPU-EntityCloud
// demo; the host (js/engine/host.js) gives it its device, canvas target, input and HUD root, and builds its scenario
// from entities ("cloud.*", see js/engine/scenario-format.js). As the "atmosphere" of a composition it takes the other
// worlds into its scene before its volumetrics (Renderer.encodeInject).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.cloud (js/engine/features.js).
//
// Entity Cloud: volumetric clouds, storm cells and their precipitation shafts in WebGPU, as one static page.
//
//   1. Weather map (compute, every frame): a 2D map around the camera with cloud coverage, cloud top, precipitation and
//      virga, built from the layer state (large-scale noise advected by the wind) plus every live storm cell entity.
//   2. Cloud shadow map (compute): sun transmittance through the cloud slab, and the sky occlusion of the column above.
//   3. Ground state (compute): snow cover and wetness accumulate under precipitation and melt / dry afterwards.
//   4. Scene (render): sky, then the terrain (farm sections, pivots, towns, mountains) with cloud shadows, snow and wet ground,
//      then structures (houses, bus shelters, bridges, a bus station): meshes on the terrain, with boxes in the shaders that cast sun shadows
//      and keep rain and snow off the ground, the near-field drops and the shafts under roofs and decks (WGSL_SHELTER).
//   5. Volumetrics (compute, reduced resolution): one ray march through clouds (Perlin-Worley shape + Worley detail,
//      light march + multiple-scattering octaves), rain and snow shafts falling from the cloud base (slanted by the wind,
//      streaky curtains, virga evaporating before the ground, rain below the freezing level and snow above), and height
//      haze with crepuscular rays from the shadow map; then temporal reprojection. The light reaching the rain, snow
//      and haze (cloud shadow, shadow cast by the shafts themselves, sky light, lightning) comes from a froxel volume
//      filled just before the march.
//   6. Final (render): composite + tonemap, near-field rain streaks / snow flakes around the camera, the bus's windows,
//      lightning bolts, radar.
//
// On foot (Walker) the camera walks on the terrain and the structures and can board any of the buses (BusLine) that drive
// between the bus station and the village, each leaving at its own time. The cabin of the nearest (or the one ridden) is
// one box in the frame uniform: no rain, snow or volumetrics inside it.
//
// The world is data (the scenario JSON above). Every entity is a class in ENTITY_TYPES: terrain features stamp the heightmap
// and paint land use; structures build meshes on it; storm cells live, drift with the wind, rain and flash; spawners keep
// the sky populated.

Features.part('cloud', (engine, feature) => {
const { kits } = engine;
const { FeatureWorld } = kits.world, { HUD } = FeatureWorld;
const { NEAR, QUALITY, App, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these; view / setView: its camera's).
class CloudWorld extends FeatureWorld {
    constructor(fx) { super(fx, HUD.labels + HUD.toast); }

    createApp(fx) { return new App(fx); }

    // reversed-Z, infinite far plane, metres (the near plane comes in to 5 cm on foot)
    depth() {
        const r = this.app.renderer;
        return r.depthView && { view: r.depthView, kind: 'reversed', near: this.app.walker.active ? 0.05 : NEAR };
    }

    // walking is its Walker's (on the terrain as drawn, structures, into the buses); the engine switches it
    get moves() { return ['fly', 'walk']; }
    get move() { return this.app.walker.active ? 'walk' : 'fly'; }
    setMove(mode) { this.app.controls.setWalk(mode === 'walk'); }

    // its scenario's views (cloud.view): one each, or, following an entity with `each`, one per member of it (a bus line's
    // buses), named by `name` with {label} the member's, its sub line what the member is doing
    views() {
        const a = this.app, w = a.world;
        if (!w) return [];
        return (a.views || []).flatMap((v, i) => {
            const e = v.follow && w.get(v.follow);
            if (!v.each) return [{ key: i, name: v.name, go: () => a.controls.setView(i) }];
            return (e?.members || []).map((m, k) => ({ key: `${i}.${k}`, name: (v.name || '{label}').replace('{label}', m.label), sub: m.describe?.(),
                go: () => a.controls.jump(v, m) }));
        });
    }

    // the terrain as drawn, or a floor of a structure or a bus within a step of p
    ground(p) { const a = this.app; return a.world ? a.walker.floorAt(a, [...p], -Infinity) : null; }

    // its buildings' and buses' interiors shelter what is in them (the InteriorIndex, O(1))
    sheltered(p) { return this.app.world?.structures.interiors.sheltered(p) || null; }

    // what the sound beds, HUD panels and links read
    stats() {
        const a = this.app, w = a.world, c = w.weather.cur, cam = a.camera.pos;
        const { bus, dist: bd } = a.nearBus || { bus: null, dist: Infinity };     // Surroundings, from the InteriorIndex
        return {
            name: w.scenario.name, fps: a.fps, paused: a.paused, time: a.time, weather: w.weather.target, light: a.lightName,
            rain: a.near.rain, snow: a.near.snow, inside: !!a.indoors || !!a.inBus || !!a.forceIndoors, sheltered: !!a.sheltered, inBus: !!a.inBus,
            walking: a.walker.active, wind: Math.hypot(c.wind[0], c.wind[1]), agl: cam[1] - w.field.surface(cam[0], cam[2]),
            busDist: bd, busSpeed: bus ? bus.v : 0, riding: !!a.inBus && a.rideBus === bus,
            temperature: c.temperature, coverage: c.coverage, cells: w.storms.length, flashes: w.flashCount, veil: a.flashVeil,
        };
    }

    // the readout and every option (its menus), on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); }

    set(key, v) {
        const a = this.app;
        if (key === 'weather' && a.world.weather.states[v] && a.world.weather.target !== v) a.controls.setWeather(v);
        else if (key === 'light' && a.lightPresets[v] && a.lightName !== v) a.controls.pickLight(v);
        else if (key === 'paused') a.paused = !!v;
        else if (key === 'quality' && QUALITY[v]) a.controls.setQuality(+v);
        else if (key === 'timeScale' && +v > 0) a.timeScale = +v;
        else if (key === 'indoors') a.forceIndoors = !!v;
        else if (key === 'radar') a.radar = !!v;
    }
}

return { create: ctx => new CloudWorld(ctx) };
});
