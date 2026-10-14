'use strict';
// The app's menus (shown on the engine's handheld): each option of the world as a Menu, kept in step with the app.
// An app extension keeps its own menus (made with menu(name, title)) and fills them in syncMenus().

Features.kit('atmosphere', (engine, kit) => {
const { GpuChoice, kits } = engine;
const { Menu } = kits.world;
const { QUALITY, RENDER_MODES, FROXEL } = kit;
const { RAIN_VARIANTS, TIME_SCALES } = kits.weather;

// weather and rain (pick one), how fast the weather runs; the lighting; the graphics
class AppMenus {
    constructor(app) {
        this.app = app;
        const menu = this.menu;
        this.weather = menu('weather', 'weather state');
        this.rain = menu('rain', 'rain variants');
        this.time = menu('time', 'how fast the weather runs');
        this.lighting = menu('lighting', 'lighting preset');
        this.quality = menu('quality', 'graphics quality');
        this.render = menu('render', 'render mode');
        this.gpu = menu('gpu', 'GPU features and timings');
    }

    menu(name, title) { return new Menu(name, title); }

    sync() {
        const a = this.app, w = a.world, c = a.controls;
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
        for (const x of a.extensions) x.syncMenus?.();

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
            { label: 'Planet curvature', kind: 'slider', value: a.world.curvature.amount, min: 0, max: 1, fmt: v => a.world.curvature.describe(v), set: v => c.setCurvature(v) },
            { sep: true },
            ...(prof.enabled ? [['total', prof.total], ...Object.entries(prof.ms)].map(([n, v]) => ({ label: n, kind: 'info', key: `${v.toFixed(1)} ms` }))
                : [{ label: 'no timestamp queries on this adapter', kind: 'info' }]),
        ]);
    }
}

return { AppMenus };
});
