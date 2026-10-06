'use strict';
// The phone pages (js/engine/handheld.js): the minimap, the readout and the visibility options of the portal world.

Features.part('portal', (engine, feature) => {
const { MASK_MODES } = feature;

// the readout, the minimap and every option, on the engine's handheld (js/engine/handheld.js)
function phonePages(g) {
    const o = g.opts, P = g.player;
    if (!g.world || !P) return [];
    const key = code => () => g.onKey(code);
    return [
        { id: 'map', title: 'Map', sub: `${o.island ? 'the island' : 'around you'} · tap to teleport`, icon: [[52, 199, 89], 'M'], sections: [
            { cells: [
                o.map ? { image: g.mapCanvas, aspect: 1, click: (u, v) => g.minimap.click(u, v) } : { text: 'The minimap is off.' },
                { toggle: 'Minimap', on: o.map, set: v => { o.map = v; } },
                { toggle: 'Whole island', on: o.island, set: v => { o.island = v; } }],
              footer: 'Portals: green passed, cyan sky only, amber culled, red closed, violet occluder.' }] },
        { id: 'status', title: 'Status', sub: 'Visibility, traversal, player', icon: [[255, 149, 0], 'P'], sections: Handheld.panel(g.hud.lines) },
        { id: 'options', title: 'Portals', sub: `culling ${o.culling ? 'on' : 'off'} · ${o.mode} · ${o.walk ? 'walk' : 'fly'}`, icon: [[48, 176, 199], 'V'], sections: [
            { header: 'VISIBILITY', cells: [
                { toggle: 'Portal culling', on: o.culling, set: key('Digit1') },
                { toggle: 'Freeze visibility', on: o.freeze, set: key('Digit2') },
                { choice: 'Masking', options: MASK_MODES, index: MASK_MODES.indexOf(o.mode), pick: i => { o.mode = MASK_MODES[i]; } },
                { toggle: 'Occluders', on: o.occluders, set: key('Digit6') }] },
            { header: 'DEBUG LINES', cells: [
                { toggle: 'Portal lines', on: o.portals, set: v => { o.portals = v; } },
                { toggle: 'Area volumes', on: o.volumes, set: v => { o.volumes = v; } }] },
            { header: 'PLAYER', cells: [
                { toggle: 'Walk (off: fly)', on: o.walk, set: key('KeyV') },
                { action: 'Door at hand / the helm', run: key('KeyF') },
                { action: 'Reset', run: key('KeyR') }] },
        ] },
    ];
}

return { phonePages };
});
