'use strict';
// Features: the six engines this repo merges, each a folder of parts under js/features/<name>/, one responsibility per
// part (config, a shader set, the entities of one kind, the renderer, the HUD...). A part registers itself with
// Features.part(name, fn); fn(engine, feature) runs once, in load order, and returns what it offers the parts after it,
// which pick it from `feature` (a part that needs something from a later one reads `feature.X` when it runs). The
// last part, <name>/feature.js, returns { create(ctx) }: create builds one world of that feature (a FeatureInstance,
// see Host.createInstance for ctx and the methods the host calls). Each part keeps its own function scope, so the
// features' globals never collide. Parts load on demand (<script> tags, so pages opened from disk work too) and only
// for the features a scenario uses.
//
// What is not one feature's own lives in kits: generic building blocks (js/kits/<kit>/, parts registered with
// Features.kit(kit, fn)) that any feature can use. A feature lists its kits in USES; they load before its parts, and
// their exports are engine.kits.<kit> (a kit may use the kits listed before it in its `uses`). The engine's own scripts
// use ENGINE_KITS, which the host loads at boot, through Features.kits. Smaller shared helpers (math, GPU, text) are
// js/engine/common.js's.

const Features = {
    // kit: { uses (kits it builds on), parts }
    KITS: {
        noise: { parts: ['random', 'value', 'wgsl'] },
        view: { parts: ['first-person'] },
        world: { parts: ['entity', 'hud', 'pages', 'feature-world'] },
        entities: { uses: ['noise'], parts: ['spin', 'camera', 'door', 'light', 'drone'] },
        terrain: { uses: ['world', 'noise'], parts: ['heightfield', 'stamps'] },
        interior: { parts: ['origin', 'vis-area', 'interior'] },
        transit: { uses: ['interior'], parts: ['paths', 'line'] },
        gpu: { parts: ['stencil', 'pipelines', 'extensions'] },
        gui: {
            uses: ['noise', 'gpu'],
            parts: [
                'math', 'materials', 'geometry', 'shaders', 'renderer', 'atlas', 'device-context', 'entity-gui', 'interaction',
                'phone-gui', 'phone-apps', 'paint-shader', 'paint-canvas', 'easel-gui', 'views', 'media', 'cctv', 'phone-camera',
                'iptv', 'apps/camera', 'apps/gallery', 'apps/viewer', 'apps/tv', 'media-phone',
            ],
        },
    },
    ENGINE_KITS: ['noise', 'view', 'gpu', 'gui'],
    USES: {
        cloud: ['noise', 'view', 'world', 'terrain', 'interior', 'transit'],
        water: ['noise', 'view', 'world', 'terrain'],
        origin: ['noise', 'world', 'entities'],
        imposter: ['noise', 'view', 'world', 'entities'],
        portal: ['noise', 'view', 'world', 'entities', 'interior', 'transit', 'gpu', 'gui'],
        gui: ['noise', 'view', 'world', 'entities', 'interior', 'gpu', 'gui'],
    },
    PARTS: {
        cloud: [
            'config/limits', 'config/quality', 'config/weather', 'config/bus', 'config/buildings', 'util/half', 'terrain/heightfield', 'gpu/bindings', 'shaders/common', 'shaders/shelter',
            'shaders/occupancy', 'shaders/noise', 'shaders/weather', 'shaders/volumetrics', 'shaders/scene',
            'shaders/final', 'entities/terrain', 'structures/frame', 'structures/palette', 'structures/solids',
            'structures/shelter-boxes', 'structures/doors', 'structures/buildings', 'structures/fixtures',
            'structures/structures', 'entities/settlements', 'entities/bus', 'entities/bus-line', 'entities/storms',
            'entities/types', 'weather/weather', 'weather/lightning', 'world', 'gpu/passes', 'gpu/profiler',
            'gpu/renderer', 'walker', 'hud', 'app/menus', 'app/cloud-picker', 'app/controls', 'app/key-commands',
            'app/doors', 'app/surroundings', 'app/sound-events', 'app/light-writer', 'app/frame-writer', 'app/app',
            'phone-pages', 'feature',
        ],
        water: [
            'config', 'terrain/heightfield', 'shaders/flow', 'shaders/waves', 'shaders/debris', 'shaders/render',
            'gpu/helpers', 'entities/terrain', 'entities/water', 'entities/types', 'world', 'sim/flow', 'sim/waves',
            'sim/debris', 'renderer', 'tools', 'hud', 'app', 'phone-pages', 'feature',
        ],
        origin: [
            'core/config', 'core/math', 'core/world-pos', 'core/origin', 'render/mesh', 'render/materials',
            'render/instances', 'render/shaders', 'render/renderer', 'world/entities', 'world/world', 'game/floating',
            'game/camera', 'game/hud', 'game/app', 'phone-pages', 'feature',
        ],
        imposter: [
            'core/config', 'core/util', 'core/math', 'core/octahedral', 'assets/textures',
            'assets/materials', 'assets/geometry', 'gpu/mesh', 'assets/models', 'assets/loaders', 'shaders/common',
            'shaders/mesh', 'shaders/bake', 'shaders/cull', 'shaders/imposter', 'shaders/overlay', 'gpu/atlas',
            'gpu/baker', 'gpu/renderer', 'world/lighting', 'world/archetype', 'world/entities', 'world/world',
            'game/camera', 'game/hud', 'game/game', 'phone-pages', 'feature',
        ],
        portal: [
            'core/config', 'core/math', 'core/geometry2d', 'core/frustum', 'render/mesh', 'render/materials',
            'render/shaders', 'render/renderer', 'render/gui-pass', 'render/frame-builder', 'render/debug-lines', 'vis/object-trees',
            'vis/portal-vis', 'world/collision', 'world/area', 'world/portal', 'world/light-transport', 'world/architecture', 'world/outdoors',
            'world/nav-graph', 'world/vehicle', 'world/power', 'gui/screens', 'world/entities', 'world/world', 'game/player', 'game/input',
            'game/hud', 'game/minimap', 'game/media', 'game/game', 'phone-pages', 'feature',
        ],
        gui: [
            'core/audio', 'gui/terminal-gui', 'world/entities', 'gui/apps/radar', 'world/world', 'game/player',
            'game/input', 'game/bindings', 'game/game', 'feature',
        ],
    },
    parts: {},
    modules: {},
    kitParts: {},
    kitModules: {},
    kits: {},                   // the loaded kits' exports (engine.kits)

    part(name, fn) { (this.parts[name] ??= []).push(fn); },
    kit(name, fn) { (this.kitParts[name] ??= []).push(fn); },

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

    load(name, engine) {
        return (this.modules[name] ??= this.build(name, engine));
    },

    async build(name, engine) {
        const parts = this.PARTS[name];
        if (!parts) throw new Error(`unknown feature "${name}"`);
        for (const k of this.USES[name] ?? []) await this.loadKit(k, engine);
        const feature = await this.assemble(`feature "${name}"`, parts.map(p => `js/features/${name}/${p}.js`), () => this.parts[name], engine);
        if (typeof feature.create !== 'function') throw new Error(`feature "${name}" has no create()`);
        return feature;
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
    async assemble(what, srcs, registered, engine) {
        await Promise.all(srcs.map(src => this.script(src)));
        const fns = registered() ?? [];
        if (fns.length !== srcs.length) throw new Error(`${what}: ${fns.length} of ${srcs.length} parts registered`);
        const out = {};
        for (const fn of fns) Object.assign(out, fn(engine, out));
        return out;
    },
};
