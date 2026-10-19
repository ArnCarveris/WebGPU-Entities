'use strict';
// AtmosphereWorld: a world under this kit's sky as one world of the engine (js/engine/host.js calls these; view /
// setView: its camera's). A world type is a spec, not a subclass: { world(scenario): its World (with its
// WorldExtensions), extensions: its AppExtensions, title } (the cloud kit's `cloud`). As the "atmosphere" of a
// composition it takes the other worlds into its scene before its volumetrics (Renderer.encodeInject).

Features.kit('atmosphere', (engine, kit) => {
const { kits } = engine;
const { FeatureWorld } = kits.world, { HUD } = FeatureWorld;
const { NEAR, QUALITY, App, phonePages } = kit;

class AtmosphereWorld extends FeatureWorld {
    constructor(fx, spec) {
        super(fx, HUD.labels + HUD.toast);
        this.spec = spec;
    }

    createApp(fx) { return new App(fx, this.spec); }

    // reversed-Z, infinite far plane, metres (the near plane comes in to 5 cm on foot)
    depth() {
        const r = this.app.renderer;
        return r.depthSampleView && { view: r.depthSampleView, kind: 'reversed', near: this.app.walker.active ? 0.05 : NEAR };
    }

    // walking is its Walker's (on the terrain as drawn, structures, into the buses); the engine switches it
    get moves() { return ['fly', 'walk']; }
    get move() { return this.app.walker.active ? 'walk' : 'fly'; }
    setMove(mode) { this.app.controls.setWalk(mode === 'walk'); }

    // its scenario's views (`view` entities): one each, or, following an entity with `each`, one per member of it (a bus line's
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

    // what its world's extensions say shelters p (the structures feature's: its buildings' and buses' interiors, the
    // InteriorIndex, O(1))
    sheltered(p) {
        for (const x of this.app.world?.extensions || []) { const s = x.sheltered?.(p); if (s) return s; }
        return null;
    }

    // what the sound beds, HUD panels and links read (and what the extensions add: the buses' busDist, busSpeed...)
    stats() {
        const a = this.app, w = a.world, c = w.weather.cur, cam = a.camera.pos;
        const out = {
            name: w.scenario.name, fps: a.fps, paused: a.paused, time: a.time, weather: w.weather.target, light: a.lightName,
            rain: a.near.rain, snow: a.near.snow, inside: !!a.indoors || !!a.inBus || !!a.forceIndoors, sheltered: !!a.sheltered, inBus: !!a.inBus,
            walking: a.walker.active, wind: Math.hypot(c.wind[0], c.wind[1]), agl: cam[1] - w.field.surface(cam[0], cam[2]),
            temperature: c.temperature, coverage: c.coverage, flashes: w.flashCount, veil: a.flashVeil,
        };
        for (const x of a.extensions) x.stats?.(out);
        return out;
    }

    // the readout and every option (its menus), on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); }

    // its planned buildings' portal visibility (the building kit's RoomVis): floor map, traversal, frames on the handheld
    get inspector() { return this.app?.frameWriter?.roomVis?.inspector || null; }

    set(key, v) {
        const a = this.app;
        if (a.extensions.some(x => x.set?.(key, v))) return;
        if (key === 'weather' && a.world.weather.states[v] && a.world.weather.target !== v) a.controls.setWeather(v);
        else if (key === 'light' && a.lightPresets[v] && a.lightName !== v) a.controls.pickLight(v);
        else if (key === 'paused') a.paused = !!v;
        else if (key === 'quality' && QUALITY[v]) a.controls.setQuality(+v);
        else if (key === 'timeScale' && +v > 0) a.timeScale = +v;
        else if (key === 'indoors') a.forceIndoors = !!v;
        else if (key === 'radar') a.radar = !!v;
    }
}

return { AtmosphereWorld };
});
