'use strict';
// App: the one app every world type runs as (Common.Composite): what FeatureWorld's spec.app(fx) makes. What a type
// makes of it is its AppExtension (the atmosphere's, the water's, the facility's game...), which mounts itself on it and
// answers for it: start(), frame(now, dt, opts), load(native), its camera, its renderer and its world.

Features.kit('world', (engine, kit) => {
const { Composite } = engine.Common;

class App {
    // Base: the world type's AppExtension, new Base(app, ...args): it mounts itself (this.app = app.mount(this)) and
    // composes in its features' (app.compose(list): new E(app), app.ext[E.key])
    constructor(Base, ...args) {
        const app = Composite.of(this);
        new Base(app, ...args);
        return app;
    }

    mount(base) { return Composite.mount(this, base); }
    compose(list, ...args) { return Composite.compose(this, list, ...args); }
}

return { App };
});
