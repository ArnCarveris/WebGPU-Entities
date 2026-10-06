'use strict';
// The app's menus (shown on the engine's handheld): each option of the world as a Menu, kept in step with the app.

Features.part('cloud', (engine, feature) => {
const { GpuChoice } = engine;
const { QUALITY, RENDER_MODES, FROXEL, RAIN_VARIANTS, TIME_SCALES, TORNADO, Supercell, HURRICANE, Menu } = feature;

// weather and rain (pick one), the persistent clouds (show any of them), tornado and hurricane; the view; the graphics
class AppMenus {
    constructor(app) {
        this.app = app;
        const menu = (name, title) => new Menu(name, title);
        this.weather = menu('weather', 'weather state');
        this.rain = menu('rain', 'rain variants');
        this.time = menu('time', 'how fast the weather runs');
        this.clouds = menu('clouds', 'persistent clouds to show');
        this.tornado = menu('tornado', "tornado under the supercell's wall cloud");
        this.hurricane = menu('hurricane', 'hurricane with an eye (Saffir-Simpson category)');
        this.view = menu('view', 'jump to a viewpoint');
        this.move = menu('move', 'fly, or walk on the ground below');
        this.bus = menu('bus', 'go to a bus');
        this.lighting = menu('lighting', 'lighting preset');
        this.quality = menu('quality', 'graphics quality');
        this.render = menu('render', 'render mode');
        this.gpu = menu('gpu', 'GPU features and timings');
    }

    sync() {
        const a = this.app, w = a.world, c = a.controls, cl = a.clouds;
        if (!w) return;
        const wx = w.weather, radio = (label, on, pick) => ({ label, kind: 'radio', on, pick });
        const rain = RAIN_VARIANTS.filter(n => wx.states[n]), isRain = rain.includes(wx.target);
        this.weather.set(`${isRain ? 'rain' : wx.target}${wx.cycle.enabled ? ' (auto)' : ''}`, [
            ...wx.names.filter(n => !rain.includes(n)).map(n => radio(n, n === wx.target, () => c.setWeather(n))),
            { sep: true },
            { label: 'auto cycle', kind: 'check', on: wx.cycle.enabled, pick: () => c.toggleCycle() },
        ]);
        this.rain.set(isRain ? wx.target : 'none', rain.map(n => radio(n, n === wx.target, () => c.setWeather(n))), rain.length > 0);
        this.time.set(`×${a.timeScale}${a.paused ? ' (paused)' : ''}`, TIME_SCALES.map(t => radio(`×${t}`, t === a.timeScale, () => c.setTimeScale(t))));
        const P = cl.persistent, shown = P.filter(e => !e.off);
        this.clouds.set(shown.length === P.length ? 'all' : !shown.length ? 'none' : shown.length === 1 ? cl.name(shown[0]) : `${shown.length} of ${P.length}`,
            P.map((e, i) => ({ label: cl.label(e), kind: 'check', on: !e.off, pick: () => cl.set(i, !!e.off) })), P.length > 0);
        const cats = (list, cur, set) => list.map((k, i) => radio(k ? `${k.name} · ${k.kmh} km/h` : 'off', i === cur, () => set(i)));
        this.tornado.set(TORNADO[w.tornadoCat]?.name || 'off', cats(TORNADO, w.tornadoCat, k => c.setTornado(k)), w.entities.some(e => e instanceof Supercell));
        this.hurricane.set(HURRICANE[w.hurricaneCat]?.name || 'off', cats(HURRICANE, w.hurricaneCat, k => c.setHurricane(k)));

        const views = a.views || [];             // (not yet while a scenario loads)
        this.view.set(views[a.viewIndex]?.name || 'none', views.map((v, i) => radio(v.name, i === a.viewIndex, () => c.setView(i))), views.length > 0);
        this.move.set(a.walker.active ? 'walk' : 'fly', [radio('fly', !a.walker.active, () => c.setWalk(false)), radio('walk', a.walker.active, () => c.setWalk(true))]);
        const aboard = a.walker.active && a.walker.bus;
        this.bus.set(aboard ? aboard.label : 'none', [
            ...w.buses.map((b, i) => radio(b.label, b === aboard, () => c.toBus(i))),
            { sep: true },
            { label: 'buses ×10', kind: 'check', on: a.busFast, pick: () => { a.busFast = !a.busFast; this.sync(); } },
        ], w.buses.length > 0);
        const lights = a.lightNames || [];
        this.lighting.set(a.lightName, lights.map(n => radio(n, n === a.lightName, () => c.pickLight(n))), lights.length > 1);
        this.quality.set(QUALITY[a.quality].name, QUALITY.map((q, i) => radio(`${q.name} · ${q.scale * 100}% · ${q.steps} steps`, i === a.quality, () => c.setQuality(i))));
        this.render.set(RENDER_MODES[a.mode], RENDER_MODES.map((m, i) => radio(m, i === a.mode, () => c.setMode(i))));
        const prof = a.renderer.profiler, names = GpuChoice.names || {};
        this.gpu.set([a.froxels && 'froxels', a.tiles && 'tiles', a.bloom && 'bloom'].filter(Boolean).join(' + ') || 'basic', [
            // the adapter (picking one reloads the page), each with the GPU it gets here; one with none can't be picked
            ...GpuChoice.CHOICES.map(ch => names[ch.id] === null ? { label: ch.label, kind: 'info', key: 'none' }
                : { label: ch.label, kind: 'radio', on: ch.id === GpuChoice.id, key: names[ch.id] || '', pick: () => GpuChoice.pick(ch.id) }),
            { sep: true },
            { label: `froxel lighting ${FROXEL.join('×')}`, kind: 'check', on: a.froxels, pick: () => c.toggleFroxels() },
            { label: 'cloud tile pre-pass', kind: 'check', on: a.tiles, pick: () => c.toggleTiles() },
            { label: 'bloom', kind: 'check', on: a.bloom, pick: () => c.toggleBloom() },
            { sep: true },
            ...(prof.enabled ? [['total', prof.total], ...Object.entries(prof.ms)].map(([n, v]) => ({ label: n, kind: 'info', key: `${v.toFixed(1)} ms` }))
                : [{ label: 'no timestamp queries on this adapter', kind: 'info' }]),
        ]);
    }
}

return { AppMenus };
});
