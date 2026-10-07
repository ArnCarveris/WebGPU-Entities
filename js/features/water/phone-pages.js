'use strict';
// The phone pages (js/engine/handheld.js): the readout, the tools and every option of the water world.

Features.part('water', (engine, feature) => {
const { kits } = engine;
const { Pages } = kits.world;
const { RENDER_MODES, Dam } = feature;

// the readout and every option, on the engine's handheld (js/engine/handheld.js)
function phonePages(a) {
    const w = a.world;
    if (!w) return [];
    const key = code => () => a.handleKeys([code]);
    const dams = w.entities.filter(e => e instanceof Dam);
    return [
        Pages.status('Flow sim, water, waves, debris', [[0, 122, 255], 'W'], a.hud),
        { id: 'options', title: 'Options', sub: `${a.tool ? a.tool.name : 'no tool'} · ${RENDER_MODES[a.mode]} · ${a.lightName}`, icon: [[48, 176, 199], 'O'], sections: [
            { header: 'TOOL', cells: [
                a.tools.length && { choice: 'Tool', options: a.tools.map(t => ({ label: t.name, sub: `key ${t.key}` })), index: a.tools.indexOf(a.tool),
                    pick: i => a.handleKeys([`Digit${a.tools[i].key}`]) },
                { slider: 'Brush', value: a.brush, min: 4, max: 200, fmt: v => `${v.toFixed(0)} m`, set: v => { a.brush = v; } }],
                footer: 'Right drag (or Ctrl + drag) on the terrain uses the tool; [ ] sizes the brush.' },
            { header: 'WATER', cells: [
                { toggle: 'Boost springs', on: w.boost, set: key('KeyB') },
                { toggle: 'Rain', on: w.rainOn, set: key('KeyR') },
                dams.length && { toggle: 'Dams breached', on: dams.some(d => d.target), set: key('KeyX') },
                { action: 'Reset water', run: key('KeyN') },
                { slider: 'Sim steps / frame', value: a.stepsPerFrame, min: 0, max: 256, fmt: v => v.toFixed(0), set: v => { a.stepsPerFrame = Math.round(v); } },
                Pages.paused(a)] },
            { header: 'VIEW', cells: [
                { choice: 'Render', options: RENDER_MODES, index: a.mode, pick: i => { a.mode = i; } },
                a.lightNames.length > 1 && { choice: 'Lighting', options: a.lightNames, index: a.lightNames.indexOf(a.lightName), pick: i => a.setLight(a.lightNames[i]) },
                Pages.labels(a.hud)] },
        ] },
    ];
}

return { phonePages };
});
