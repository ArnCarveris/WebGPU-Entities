'use strict';
// The phone pages (js/engine/handheld.js): the readout and every option of the cloud world, from its app's menus.

Features.part('cloud', (engine, feature) => {
const { kits } = engine;
const { Pages } = kits.world;
// the readout and every option (its menus), on the engine's handheld (js/engine/handheld.js)
function phonePages(a) {
    if (!a.world) return [];
    a.menus.sync();
    const m = a.menus, key = code => () => a.keys.handle([code]);
    return [
        Pages.status('Weather, sky, air, where you are', [[48, 176, 199], 'C'], a.hud),
        { id: 'weather', title: 'Weather', sub: `${m.weather.summary} · ×${a.timeScale}`, icon: [[0, 122, 255], 'W'], sections: [
            { cells: [...m.weather.cells('Weather'), ...m.rain.cells('Rain'), ...m.time.cells('Weather time'),
                { action: 'Lightning strike', run: key('KeyK') }, Pages.paused(a)] },
            { header: 'CLOUDS', cells: m.clouds.cells('Clouds') },
            { header: 'STORMS', cells: [...m.tornado.cells('Tornado'), ...m.hurricane.cells('Hurricane')],
                footer: 'Right click (or Ctrl + click) on the ground grows a storm cell there.' },
        ] },
        { id: 'view', title: 'View', sub: `${a.walker.active ? 'walking' : 'flying'} · ${a.lightName}`, icon: [[255, 149, 0], 'V'], sections: [
            { cells: [...m.lighting.cells('Lighting'), a.world.buses.length && { toggle: 'Buses ×10', on: a.busFast, set: v => { a.busFast = v; } }] },
            { cells: [
                { toggle: 'Flashlight', on: a.flashlight, set: key('KeyL') },
                { toggle: 'Radar', on: a.radar, set: v => { a.radar = v; } },
                Pages.labels(a.hud)],
              footer: 'The arrow keys move the sun. Views (and the buses) are on the engine\'s View.' },
        ] },
        { id: 'graphics', title: 'Graphics', sub: `${m.quality.summary} · ${m.gpu.summary}`, icon: [[142, 142, 147], 'G'], sections: [
            { cells: [...m.quality.cells('Quality'), ...m.render.cells('Render')] },
            { header: 'GPU', cells: m.gpu.cells('GPU', { radios: false }), footer: 'The adapter itself is the engine\'s GPU option.' },
        ] },
    ];
}

return { phonePages };
});
