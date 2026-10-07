'use strict';
// The phone pages (js/engine/handheld.js): the readout and the rebasing options of the origin world (its bookmarks are
// the engine's View).

Features.part('origin', (engine, feature) => {
const { kits } = engine;
const { Pages } = kits.world;
// the readout and every option, on the engine's handheld (js/engine/handheld.js)
function phonePages(a) {
    const f = a.floating;
    if (!a.world) return [];
    const key = code => () => a.handleKeys([code]);
    return [
        Pages.status('Camera, origin matrix, rebasing', [[88, 86, 214], 'O'], a.hud),
        { id: 'options', title: 'Origin', sub: `rebasing ${[f.translate && 'T', f.rotate && 'R', f.scale && 'G'].filter(Boolean).join(' ') || 'off'} · density ×${a.density}`, icon: [[48, 176, 199], 'R'], sections: [
            { header: 'REBASING', cells: [
                { toggle: 'Translation', on: f.translate, set: key('KeyT') },
                { toggle: 'Rotation', on: f.rotate, set: key('KeyR') },
                { toggle: 'Scale', on: f.scale, set: key('KeyG') },
                { toggle: 'Every frame', on: f.everyFrame, set: key('KeyO') }],
                footer: 'p\' = R^T (p - T) / s: what the GPU sees stays near zero however far the camera goes.' },
            { header: 'FIELD', cells: [
                { choice: 'Density', options: [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8].map(d => `×${d < 1 ? `1/${1 / d}` : d}`), index: Math.round(Math.log2(a.density)) + 4,
                    pick: i => { const d = 2 ** (i - 4); if (d !== a.density) { a.density = d; a.load(a.scenario, true); } } }] },
            { header: 'VIEW', cells: [
                Pages.labels(a.hud),
                Pages.paused(a)] },
        ] },
    ];
}

return { phonePages };
});
