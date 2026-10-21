'use strict';
// App: the one app every world type runs as (Common.Composite): what a Site's spec.app(app, fx) extends. What a type
// makes of it is its AppExtension (the atmosphere's, the water's, the facility's game...), which answers for it what it
// exposes: start(), frame(now, dt, opts), load(native), its camera, its renderer and its world.

Features.kit('world', (engine, kit) => {
const { Composite } = engine.Common;

class App {
    // E: its own AppExtension, new E(app, ...args) (or later: app.extend(E, ...args)): it keeps the app (this.app = app)
    // and composes in its features' (app.compose(list): new F(app), app.ext[F.key])
    constructor(E, ...args) {
        const app = Composite.of(this);
        if (E) Composite.own(app, E, ...args);
        return app;
    }

    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // its own extension, on an app made empty (new App()); one kept beside it (Common.Composite)
    extend(E, ...args) { Composite.own(this, E, ...args); return this; }
    attach(key, E, ...args) { return Composite.attach(this, key, E, ...args); }

    // its extensions' hooks, in compose order (Common.Composite): every one's, the first truthy result, the largest
    // number, every result
    each(name, ...args) { return Composite.each(this, name, ...args); }
    first(name, ...args) { return Composite.first(this, name, ...args); }
    most(name, ...args) { return Composite.most(this, name, ...args); }
    all(name, ...args) { return Composite.all(this, name, ...args); }
}

return { App };
});
