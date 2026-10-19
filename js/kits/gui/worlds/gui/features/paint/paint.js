'use strict';
// Easels (easel entities, the paint kit): their paint canvases, stamped on the GPU before the frame's passes. Without
// them the paint kit doesn't load.

Features.feature('gui/gui/paint', (engine, kit) => {
const { Easel } = kit.ENTITY_TYPES.group('fixtureTypes');

// the game's: the canvases' strokes, first of the frame's passes
class PaintGame {
    static key = 'paint';
    constructor(game) { this.game = game; }
    passes(r) { for (const easel of this.game.world.ofType(Easel)) easel.canvas.flush(r); }
}

return { extensions: { app: PaintGame } };
});
