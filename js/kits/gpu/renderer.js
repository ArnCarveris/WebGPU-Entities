'use strict';
// Renderer: the one renderer every world type (and the handheld) draws with (Common.Composite). What a type makes of it is
// its RendererExtension (the atmosphere's, the water's, the gui kit's...), which mounts itself on it and answers for it:
// init(), its pipelines, resize and render.

Features.kit('gpu', (engine, kit) => {
const { Composite } = engine.Common;

class Renderer {
    // Base: the RendererExtension, new Base(renderer, ...args): it mounts itself (this.renderer = renderer.mount(this))
    // and composes in its features' (renderer.compose(list): new E(renderer), renderer.ext[E.key])
    constructor(Base, ...args) {
        const renderer = Composite.of(this);
        new Base(renderer, ...args);
        return renderer;
    }

    mount(base) { return Composite.mount(this, base); }
    compose(list, ...args) { return Composite.compose(this, list, ...args); }
}

return { Renderer };
});
