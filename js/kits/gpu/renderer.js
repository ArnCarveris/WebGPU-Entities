'use strict';
// Renderer: the one renderer every world type (and the handheld) draws with (Common.Composite). What a type makes of it is
// its RendererExtension (the atmosphere's, the water's, the gui kit's...), which answers for it what it exposes: init(),
// its pipelines, resize and render.

Features.kit('gpu', (engine, kit) => {
const { Composite } = engine.Common;

class Renderer {
    // E: its own RendererExtension, new E(renderer, ...args): it keeps the renderer (this.renderer = renderer) and
    // composes in its features' (renderer.compose(list): new F(renderer), renderer.ext[F.key])
    constructor(E, ...args) {
        const renderer = Composite.of(this);
        Composite.own(renderer, E, ...args);
        return renderer;
    }

    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // its extensions' hooks, in compose order (Common.Composite): every one's, the first truthy result, the largest
    // number, every result
    each(name, ...args) { return Composite.each(this, name, ...args); }
    first(name, ...args) { return Composite.first(this, name, ...args); }
    most(name, ...args) { return Composite.most(this, name, ...args); }
    all(name, ...args) { return Composite.all(this, name, ...args); }
}

return { Renderer };
});
