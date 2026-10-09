'use strict';
// The phone pages (js/engine/handheld.js): the readout and the player's actions of the portal world. Its floor map,
// portal traversal and visibility options are its VisInspector's (the interior kit's), as in every world of areas.

Features.part('portal', (engine, feature) => {
const { kits } = engine;
const { Pages } = kits.world;

function phonePages(g) {
    const o = g.opts, P = g.player;
    if (!g.world || !P) return [];
    const key = code => () => g.onKey(code);
    return [
        Pages.status('Visibility, traversal, player', [[255, 149, 0], 'P'], g.hud),
        { id: 'player', title: 'Player', sub: o.walk ? 'walking' : 'flying', icon: [[88, 86, 214], 'F'], sections: [
            { cells: [
                { action: 'Door at hand / the helm', run: key('KeyF') },
                { action: 'Reset', run: key('KeyR') }] },
        ] },
    ];
}

return { phonePages };
});
