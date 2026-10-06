'use strict';
// Features: the six engines this repo merges, each a folder of parts under js/features/<name>/, one responsibility per
// part (config, a shader set, the entities of one kind, the renderer, the HUD...). A part registers itself with
// Features.part(name, fn); fn(engine, feature) runs once, in load order, and returns what it offers the parts after it,
// which pick it from `feature` (a part that needs something from a later one reads `feature.X` when it runs). The
// last part, <name>/feature.js, returns { create(ctx) }: create builds one world of that feature (a FeatureInstance,
// see Host.createInstance for ctx and the methods the host calls). Each part keeps its own function scope, so the
// features' globals never collide. Parts load on demand (<script> tags, so pages opened from disk work too) and only
// for the features a scenario uses.

const Features = {
    PARTS: {
        cloud: [
            'config/limits', 'config/quality', 'config/weather', 'config/bus', 'config/buildings', 'util/half',
            'util/format', 'terrain/heightfield', 'gpu/bindings', 'shaders/common', 'shaders/shelter',
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
            'core/config', 'core/util', 'core/math', 'core/noise', 'core/octahedral', 'assets/textures',
            'assets/materials', 'assets/geometry', 'gpu/mesh', 'assets/models', 'assets/loaders', 'shaders/common',
            'shaders/mesh', 'shaders/bake', 'shaders/cull', 'shaders/imposter', 'shaders/overlay', 'gpu/atlas',
            'gpu/baker', 'gpu/renderer', 'world/lighting', 'world/archetype', 'world/entities', 'world/world',
            'game/camera', 'game/hud', 'game/game', 'phone-pages', 'feature',
        ],
        portal: [
            'core/config', 'core/math', 'core/geometry2d', 'core/frustum', 'render/mesh', 'render/materials',
            'render/shaders', 'render/renderer', 'render/frame-builder', 'render/debug-lines', 'vis/object-trees',
            'vis/portal-vis', 'world/collision', 'world/area', 'world/portal', 'world/architecture', 'world/outdoors',
            'world/nav-graph', 'world/vehicle', 'world/entities', 'world/world', 'game/player', 'game/input',
            'game/hud', 'game/minimap', 'game/game', 'phone-pages', 'feature',
        ],
        gui: [
            'core/audio', 'render/paint-shader', 'gui/terminal-gui', 'gui/easel-gui', 'systems/paint-canvas',
            'world/entities', 'gui/apps/radar', 'gui/apps/camera', 'gui/apps/gallery', 'gui/apps/viewer', 'gui/apps/tv',
            'systems/cctv', 'systems/media', 'systems/phone-camera', 'systems/iptv', 'world/world', 'game/player',
            'game/input', 'game/interaction', 'game/bindings', 'game/game', 'feature',
        ],
    },
    parts: {},
    modules: {},

    part(name, fn) { (this.parts[name] ??= []).push(fn); },

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
        await Promise.all(parts.map(p => this.script(`js/features/${name}/${p}.js`)));
        const fns = this.parts[name] ?? [];
        if (fns.length !== parts.length) throw new Error(`feature "${name}": ${fns.length} of ${parts.length} parts registered`);
        const feature = {};
        for (const fn of fns) Object.assign(feature, fn(engine, feature));
        if (typeof feature.create !== 'function') throw new Error(`feature "${name}" has no create()`);
        return feature;
    },
};
