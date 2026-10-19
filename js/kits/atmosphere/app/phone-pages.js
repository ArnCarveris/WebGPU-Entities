'use strict';
// The phone pages (js/engine/handheld.js): the readout and every option of the world, from its app's menus. An app
// extension adds to a page (page(id): { cells (into its first section), sections } or null).

Features.kit('atmosphere', (engine, kit) => {
const { kits } = engine;
const { Pages } = kits.world;

function phonePages(a) {
    if (!a.world) return [];
    a.menus.sync();
    const m = a.menus, key = code => () => a.keys.handle([code]);
    const extra = id => {
        const out = { cells: [], sections: [] };
        for (const x of a.extensions) { const p = x.page?.(id); if (p) { out.cells.push(...(p.cells || [])); out.sections.push(...(p.sections || [])); } }
        return out;
    };
    const wx = extra('weather'), vw = extra('view'), gx = extra('graphics');
    return [
        Pages.status('Weather, sky, air, where you are', [[48, 176, 199], 'C'], a.hud),
        { id: 'weather', title: 'Weather', sub: `${m.weather.summary} · ×${a.timeScale}`, icon: [[0, 122, 255], 'W'], sections: [
            { cells: [...m.weather.cells('Weather'), ...m.rain.cells('Rain'), ...m.time.cells('Weather time'), ...wx.cells, Pages.paused(a)] },
            ...wx.sections,
        ] },
        { id: 'view', title: 'View', sub: `${a.walker.active ? 'walking' : 'flying'} · ${a.lightName}`, icon: [[255, 149, 0], 'V'], sections: [
            { cells: [...m.lighting.cells('Lighting'), ...vw.cells] },
            { cells: [
                { toggle: 'Flashlight', on: a.flashlight, set: key('KeyL') },
                { toggle: 'Radar', on: a.radar, set: v => { a.radar = v; } },
                Pages.labels(a.hud)],
              footer: 'Views (and the buses) are on the engine\'s View.' },
            ...vw.sections,
        ] },
        { id: 'graphics', title: 'Graphics', sub: `${m.quality.summary} · ${m.gpu.summary}`, icon: [[142, 142, 147], 'G'], sections: [
            { cells: [...m.quality.cells('Quality'), ...m.render.cells('Render'), ...gx.cells] },
            { header: 'GPU', cells: m.gpu.cells('GPU', { radios: false }), footer: 'The adapter itself is the engine\'s GPU option.' },
            ...gx.sections,
        ] },
    ];
}

return { phonePages };
});
