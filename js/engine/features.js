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
// A world is what a scenario root entity of its type makes ({ type: "water" }): a kit offers it (the manifest's
// worlds), parts under js/kits/<kit>/worlds/<type>/ registered with Features.world(type, fn). They load only when a
// scenario has that world, after their kit and the kits the world uses; `kit` in them is the world's own exports over
// its kit's (a world part reads its kit's exports as kit.X too, and shadows none of them). The last part returns
// { create(ctx) }: one world of that type (a FeatureWorld, see Host.createInstance).

const Features = {
    // the kits as the manifest has them: { uses, parts, types, data, worlds }
    get KITS() { return Kits.KITS; },
    ENGINE_KITS: ['noise', 'view', 'gpu', 'gui'],
    worldParts: {},
    modules: {},
    kitParts: {},
    kitModules: {},
    kits: {},                   // the loaded kits' exports (engine.kits)

    kit(name, fn) { (this.kitParts[name] ??= []).push(fn); },
    world(type, fn) { (this.worldParts[type] ??= []).push(fn); },

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

    // a world type's module ({ create(ctx) }, over its kit's exports), once per page
    load(type, engine) {
        return (this.modules[type] ??= (async () => {
            const kit = this.kitOf(type);
            if (!kit) throw new Error(`unknown world type "${type}": no kit offers it`);
            const spec = this.KITS[kit].worlds[type];
            const base = await this.loadKit(kit, engine);
            for (const k of spec.uses ?? []) await this.loadKit(k, engine);
            const srcs = spec.parts.map(p => `js/kits/${kit}/worlds/${type}/${p}.js`);
            const world = await this.assemble(`world "${type}"`, srcs, () => this.worldParts[type], engine, Object.create(base));
            if (typeof world.create !== 'function') throw new Error(`world "${type}" has no create()`);
            return world;
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
