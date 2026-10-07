'use strict';
// Render extensions: what a renderer draws besides its own, contributed from outside it.

Features.kit('gpu', (engine, kit) => {
// A renderer of some kind ('portal'...) takes the extensions registered for that kind when it is made: any kit or
// feature part (which load before any world is made) can register one, and the renderer's own code doesn't change.
// register(kind, factory): factory(renderer) makes one extension per renderer (its own resources), an object with
//   name                        renderer.ext[name]
//   stencil: { slot: spec }     reserved in the renderer's StencilLayout with its own slots, before it resolves
//   init(renderer, ctx)         its resources (async); may add modules / layouts / buffers / blends to the pipeline ctx
//   pipelines(ctx)              its pipeline table (js/kits/gpu/pipelines.js), built into ext.pipes
//   ...and whatever the renderer kind's own contract asks (portal: overlay, info, commands; see its renderer.js)
const registry = new Map();

const RenderExtensions = {
    register(kind, factory) {
        if (!registry.has(kind)) registry.set(kind, []);
        registry.get(kind).push(factory);
    },

    for(kind) {
        return registry.get(kind) || [];
    },
};

return { RenderExtensions };
});
