'use strict';
// The phone pages (js/engine/handheld.js): the readout, bookmarks and the rebasing options of the origin world.

Features.part('origin', (engine, feature) => {
// the readout and every option, on the engine's handheld (js/engine/handheld.js)
function phonePages(a) {
    const f = a.floating;
    if (!a.world) return [];
    const key = code => () => a.handleKeys([code]);
    const B = a.bookmarks;
    return [
        { id: 'status', title: 'Status', sub: 'Camera, origin matrix, rebasing', icon: [[88, 86, 214], 'O'], sections: Handheld.panel(a.hud.lines) },
        B.length && { id: 'places', title: 'Places', sub: `${B.length} bookmarks`, icon: [[255, 149, 0], 'B'], sections: [
            { cells: B.map(b => ({ action: b.name, key: `bookmark ${b.key}`, run: () => a.jump(b) })), footer: 'The number keys jump there too.' }] },
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
                { toggle: 'Labels', on: a.hud.showLabels, set: v => { a.hud.showLabels = v; } },
                { toggle: 'Paused', on: a.paused, set: v => { a.paused = v; } }] },
        ] },
    ].filter(Boolean);
}

return { phonePages };
});
