'use strict';
// The phone pages (js/engine/handheld.js): the readout and every option of the cloud world, from its app's menus.

Features.part('cloud', (engine, feature) => {
// the readout and every option (its menus), on the engine's handheld (js/engine/handheld.js)
function phonePages(a) {
    if (!a.world) return [];
    a.menus.sync();
    const m = a.menus, key = code => () => a.keys.handle([code]);
    return [
        { id: 'status', title: 'Status', sub: 'Weather, sky, air, where you are', icon: [[48, 176, 199], 'C'], sections: Handheld.panel(a.hud.lines) },
        { id: 'weather', title: 'Weather', sub: `${m.weather.summary} · ×${a.timeScale}`, icon: [[0, 122, 255], 'W'], sections: [
            { cells: [...m.weather.cells('Weather'), ...m.rain.cells('Rain'), ...m.time.cells('Weather time'),
                { action: 'Lightning strike', run: key('KeyK') }, { toggle: 'Paused', on: a.paused, set: v => { a.paused = v; } }] },
            { header: 'CLOUDS', cells: m.clouds.cells('Clouds') },
            { header: 'STORMS', cells: [...m.tornado.cells('Tornado'), ...m.hurricane.cells('Hurricane')],
                footer: 'Right click (or Ctrl + click) on the ground grows a storm cell there.' },
        ] },
        { id: 'view', title: 'View', sub: `${m.move.summary} · ${a.lightName}`, icon: [[255, 149, 0], 'V'], sections: [
            { cells: [...m.view.cells('View'), ...m.move.cells('Move'), ...m.bus.cells('Bus'), ...m.lighting.cells('Lighting')] },
            { cells: [
                { toggle: 'Flashlight', on: a.flashlight, set: key('KeyL') },
                { toggle: 'Radar', on: a.radar, set: v => { a.radar = v; } },
                { toggle: 'Labels', on: a.hud.showLabels, set: v => { a.hud.showLabels = v; } }],
              footer: 'The arrow keys move the sun.' },
        ] },
        { id: 'graphics', title: 'Graphics', sub: `${m.quality.summary} · ${m.gpu.summary}`, icon: [[142, 142, 147], 'G'], sections: [
            { cells: [...m.quality.cells('Quality'), ...m.render.cells('Render')] },
            { header: 'GPU', cells: m.gpu.cells('GPU', { radios: false }), footer: 'The adapter itself is the engine\'s GPU option.' },
        ] },
    ];
}

return { phonePages };
});
