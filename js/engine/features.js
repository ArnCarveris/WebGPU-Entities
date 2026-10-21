'use strict';
// Features: loads kits and the worlds they offer, as the kit manifest (js/kits/manifest.js, Kits) describes them.
//
// A kit is a folder of parts under js/kits/<kit>/, one responsibility per part (config, a shader set, the entities of
// one kind, a renderer...). A part registers itself with Features.kit(kit, fn); fn(engine, kit) runs once, in load
// order, and returns what it offers the parts after it, which pick it from `kit` (a part that needs something from a
// later one reads `kit.X` when it runs). Each part keeps its own function scope, so globals never collide. A kit's
// `uses` load before it, and its exports are engine.kits.<kit>. Parts load on demand (<script> tags, so pages opened
// from disk work too): a kit when a world or another kit uses it, or when an entity of the scenario is one of its
// types (Host.createWorlds: ScenarioFormat.kitsOf). The engine's own scripts use ENGINE_KITS, which the host loads at
// boot, through Features.kits. Smaller shared helpers (math, GPU, text) are js/engine/common.js's.
//
// A site of a kit is, for now, one world of the kit's site type (the manifest's `site`: { type: "water", parts }): its
// parts, js/kits/<kit>/<part>.js registered with Features.world(type, fn), load only when a scenario has a site of that
// kit, after the kit and the kits the site uses; `kit` in them is the site parts' own exports over the kit's (a site
// part reads its kit's exports as kit.X too, and shadows none of them). The last part returns { spec }: what a site of
// that type is to the host (the hooks of its Site, js/kits/world/site.js).
//
// A feature is what a kit's sites are made of beyond their core, built only when a site's data asks for it (the
// manifest's features: when / requires, Kits.featuresOf): parts under js/kits/<kit>/features/<name>/ registered with
// Features.feature('<kit>/<name>', fn), loaded with the kits it uses before the world is built; `kit` in them is the
// feature's exports over its kit's and its required features'. The world gets the features on as fx.features.

const Features = {
    // the kits as the manifest has them: { uses, parts, types, data, site, features }
    get KITS() { return Kits.KITS; },
    ENGINE_KITS: ['noise', 'view', 'gpu', 'gui', 'world'],
    worldParts: {},
    featureParts: {},
    featureModules: {},
    modules: {},
    kitParts: {},
    kitModules: {},
    kits: {},                   // the loaded kits' exports (engine.kits)

    kit(name, fn) { (this.kitParts[name] ??= []).push(fn); },
    world(type, fn) { (this.worldParts[type] ??= []).push(fn); },
    feature(key, fn) { (this.featureParts[key] ??= []).push(fn); },

    // scripts added with async = false download in parallel and run in the order they were added
    script(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.async = false;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`could not load ${src}`));
            document.head.appendChild(el);
        });
    },

    // the kit offering world type `type`, or null
    kitOf(type) { return Kits.WORLDS[type]?.kit || null; },

    // a world type's module ({ spec }, over its kit's exports), once per page
    load(type, engine) {
        return (this.modules[type] ??= (async () => {
            const kit = this.kitOf(type);
            if (!kit) throw new Error(`unknown world type "${type}": no kit offers it`);
            const spec = this.KITS[kit].site;
            const base = await this.loadKit(kit, engine);
            for (const k of spec.uses ?? []) await this.loadKit(k, engine);
            const srcs = spec.parts.map(p => `js/kits/${kit}/${p}.js`);
            const world = await this.assemble(`world "${type}"`, srcs, () => this.worldParts[type], engine, Object.create(base));
            if (!world.spec) throw new Error(`world "${type}" has no spec`);
            return world;
        })());
    },

    // A feature of site type `type` (its kit's, KITS[kit].features[name], or its site's own, site.features[name]), once
    // per page: the kits it uses, the features it requires, then its parts (js/kits/<kit>/features/<name>/, registered
    // with Features.feature('<kit>/<name>', fn); a site's own as '<kit>/<type>/<name>'), over its kit's exports (a
    // site's own: its site parts') and the required features'
    loadFeature(type, name, engine) {
        const { spec, kit, world } = Kits.featureOf(type, name);
        const key = world ? `${kit}/${world}/${name}` : `${kit}/${name}`;
        return (this.featureModules[key] ??= (async () => {
            const base = world ? await this.load(world, engine) : await this.loadKit(kit, engine);
            for (const k of spec.uses ?? []) await this.loadKit(k, engine);
            const under = Object.create(base);
            for (const r of spec.requires ?? []) Object.assign(under, await this.loadFeature(type, r, engine));
            const dir = `js/kits/${kit}/features/${name}`;
            return this.assemble(`feature "${key}"`, spec.parts.map(p => `${dir}/${p}.js`), () => this.featureParts[key], engine, Object.create(under));
        })());
    },

    // a kit, once per page: its exports land in Features.kits[name] (engine.kits)
    loadKit(name, engine) {
        return (this.kitModules[name] ??= (async () => {
            const kit = this.KITS[name];
            if (!kit) throw new Error(`unknown kit "${name}"`);
            for (const k of kit.uses ?? []) await this.loadKit(k, engine);
            const built = await this.assemble(`kit "${name}"`, kit.parts.map(p => `js/kits/${name}/${p}.js`), () => this.kitParts[name], engine);
            this.kits[name] = built;
            return built;
        })());
    },

    // load the scripts, then run the part functions they registered, in order, each given what the earlier ones returned
    async assemble(what, srcs, registered, engine, out = {}) {
        await Promise.all(srcs.map(src => this.script(src)));
        const fns = registered() ?? [];
        if (fns.length !== srcs.length) throw new Error(`${what}: ${fns.length} of ${srcs.length} parts registered`);
        for (const fn of fns) Object.assign(out, fn(engine, out));
        return out;
    },
};
