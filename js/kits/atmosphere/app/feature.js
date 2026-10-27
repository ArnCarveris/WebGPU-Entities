'use strict';
// atmosphereWorld(type): a world under this kit's sky as one world of the engine, the hooks of its Site
// (js/engine/host.js calls these; view / setView: its camera's). A world type is a spec, not a subclass: { world(scenario,
// features): the one World with its WorldExtensions, extensions: its AppExtensions, title } (the cloud world's `cloud`). In a
// frame it shares, its scene is every site's (Renderer.share): its clouds, rain, haze and post cover them all.

Features.kit('atmosphere', (engine, kit) => {
const { kits } = engine;
const { Site } = kits.world, { HUD } = Site;
const { NEAR, QUALITY, AppExtension, phonePages } = kit;

// the world of a world type (type: its spec) as the engine runs it (a Site's hooks)
const atmosphereWorld = type => ({
    hud: HUD.labels + HUD.toast,
    app: (app, fx) => app.extend(AppExtension, fx, type),
    // with other sites, it makes room in its terrain for their ground (fx.footprints): it is built after them
    makesRoom: true,

    // walking is its Walker's (on the terrain as drawn, structures, into the buses); the engine switches it
    get moves() { return ['fly', 'walk']; },
    get move() { return this.app.walker.active ? 'walk' : 'fly'; },
    setMove(mode) { this.app.controls.setWalk(mode === 'walk'); },

    // the keys there are (Site.keys): moving, on foot or flying; E at a door, lift or seat, F at a bus's wheel
    get keys() {
        const a = this.app, keys = a.walker.active ? [...Site.WALK_KEYS, ['Alt', 'slow']]
            : [...Site.FLY_KEYS, ['Alt', 'slow']];
        if (a.doors || a.liftControl) keys.push(['E', 'use']);
        if (a.drive) keys.push(['F', 'drive a bus']);
        return keys;
    },

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
    },

    // the terrain as drawn, or a floor of a structure or a bus within a step of p
    ground(p) { const a = this.app; return a.world ? a.walker.floorAt(a, [...p], -Infinity) : null; },

    // what its world's extensions say shelters p (the structures feature's: its buildings' and buses' interiors, the
    // InteriorIndex, O(1))
    sheltered(p) {
        return this.app.world?.first('sheltered', p) || null;
    },

    // what the sound beds, HUD panels and links read (and what the extensions add: the buses' busDist, busSpeed...)
    stats() {
        const a = this.app, w = a.world, c = w.weather.cur, cam = a.camera.pos;
        const out = {
            name: w.scenario.name, fps: a.fps, paused: a.paused, time: a.time, weather: w.weather.target, light: a.lightName,
            rain: a.near.rain, snow: a.near.snow, inside: !!a.indoors || !!a.inBus || !!a.forceIndoors, sheltered: !!a.sheltered, inBus: !!a.inBus,
            walking: a.walker.active, wind: Math.hypot(c.wind[0], c.wind[1]), agl: cam[1] - w.field.surface(cam[0], cam[2]),
            temperature: c.temperature, coverage: c.coverage, flashes: w.flashCount, veil: a.flashVeil, air: a.airHere ?? 1,
        };
        a.each('stats', out);
        return out;
    },

    // the readout and every option (its menus), on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); },

    // its planned buildings' portal visibility (the building kit's RoomVis): floor map, traversal, frames on the handheld
    get inspector() { return this.app?.frameWriter?.roomVis?.inspector || null; },

    // its sun (or moon by night), what lights the other sites (the host's world.sunlight): { toward(p) (the direction to
    // it from p: the same everywhere), color (its radiance), zenith, horizon, ambient (its sky's), exposure }, in its own
    // radiance
    sunlight() {
        const a = this.app, s = a?.sun, w = a?.world;
        if (!s || !w) return null;
        const sky = kits.weather.Sky.compute(s.azimuth, s.elevation, s.intensity, w.weather.cur, s.moon);
        return { toward: () => sky.dir, color: sky.sun, zenith: sky.zenith, horizon: sky.horizon, ambient: sky.ambient, exposure: s.exposure };
    },

    // how much it hides a point beyond it: the walls of the interior p is in (AppExtension.hides), its air (airHides: its
    // daytime sky what is in space)
    veil(p, dir, d) { const a = this.app; return !a ? 0 : a.first('hides', p, dir, d) ? 1 : a.airHides(p, dir, d); },

    // the ground it covers (Site.footprint): its terrain's map, with its colour from afar (groundAlbedo): a planet
    // another site stands on shows it there
    footprint() {
        const w = this.app?.world, f = w?.field;
        return f ? { lo: [f.origin, f.origin], hi: [f.origin + f.size, f.origin + f.size], floor: f.base, ground: true, albedo: kit.groundAlbedo(w.terrain) } : null;
    },

    set(key, v) {
        const a = this.app;
        if (a.first('set', key, v)) return;
        if (key === 'weather' && a.world.weather.states[v] && a.world.weather.target !== v) a.controls.setWeather(v);
        else if (key === 'light' && a.lightPresets[v] && a.lightName !== v) a.controls.pickLight(v);
        else if (key === 'paused') a.paused = !!v;
        else if (key === 'quality' && QUALITY[v]) a.controls.setQuality(+v);
        else if (key === 'timeScale' && +v > 0) a.timeScale = +v;
        else if (key === 'indoors') a.forceIndoors = !!v;
        else if (key === 'sunDir' && Array.isArray(v)) a.controls.follow(v);
        else if (key === 'radar') a.radar = !!v;
    },
});

return { atmosphereWorld };
});
