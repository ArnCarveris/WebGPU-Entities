'use strict';
// Features: the six engines this repo merges, one script each under js/features/. A feature script registers itself
// with Features.define(name, factory); its whole engine (classes, WGSL, helpers) lives inside the factory's scope, so
// the features' globals never collide. Scripts load on demand (a <script> tag, so pages opened from disk work too) and
// only for the features a scenario uses.
//
// factory(engine) runs once and returns { create(ctx) }: create builds one world of that feature (a FeatureInstance,
// see Host.createInstance for ctx and the methods the host calls).

const Features = {
    SCRIPTS: {
        cloud: ['js/features/cloud.js'],
        water: ['js/features/water.js'],
        origin: ['js/features/origin.js'],
        imposter: ['js/features/imposter.js'],
        portal: ['js/features/portal.js'],
        gui: ['js/features/gui.js'],
    },
    factories: {},
    modules: {},

    define(name, factory) { this.factories[name] = factory; },

    script(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`could not load ${src}`));
            document.head.appendChild(el);
        });
    },

    async load(name, engine) {
        if (this.modules[name]) return this.modules[name];
        const scripts = this.SCRIPTS[name];
        if (!scripts) throw new Error(`unknown feature "${name}"`);
        for (const src of scripts) await this.script(src);
        const factory = this.factories[name];
        if (!factory) throw new Error(`${scripts.join(', ')} did not define feature "${name}"`);
        return (this.modules[name] = factory(engine));
    },
};
