'use strict';
// Features: the kits this repo is built of, and the worlds they offer.
//
// A kit is a folder of parts under js/kits/<kit>/, one responsibility per part (config, a shader set, the entities of
// one kind, a renderer...). A part registers itself with Features.kit(kit, fn); fn(engine, kit) runs once, in load
// order, and returns what it offers the parts after it, which pick it from `kit` (a part that needs something from a
// later one reads `kit.X` when it runs). Each part keeps its own function scope, so globals never collide. A kit lists
// the kits it builds on in `uses`; they load before it, and its exports are engine.kits.<kit>. Parts load on demand
// (<script> tags, so pages opened from disk work too). The engine's own scripts use ENGINE_KITS, which the host loads
// at boot, through Features.kits. Smaller shared helpers (math, GPU, text) are js/engine/common.js's.
//
// A world is what a scenario root entity of its type makes ({ type: "water" }): a kit offers it in `worlds`
// ({ <type>: { uses, parts } }), parts under js/kits/<kit>/worlds/<type>/ registered with Features.world(type, fn).
// They load only when a scenario has that world, after their kit and the kits the world uses; `kit` in them is the
// world's own exports over its kit's (a world part reads its kit's exports as kit.X too, and shadows none of them).
// The last part returns { create(ctx) }: one world of that type (a FeatureWorld, see Host.createInstance).

const Features = {
    // kit: { uses (kits it builds on), parts, worlds (the world types it offers: { uses, parts }) }
    KITS: {
        noise: { parts: ['random', 'value', 'wgsl'] },
        mesh: { parts: ['geometry', 'builder', 'interface', 'tiled'] },
        view: { parts: ['first-person'] },
        world: { parts: ['entity', 'hud', 'pages', 'feature-world'] },
        entities: {
            uses: ['noise', 'world', 'mesh', 'gui'],
            parts: ['spin', 'camera', 'door', 'light', 'drone', 'space', 'ground-props', 'sectors', 'fixtures'],
            worlds: {
                // Entity Origin: a real-scale solar system under a floating origin
                origin: {
                    parts: [
                        'core/config', 'core/math', 'core/world-pos', 'core/origin', 'render/mesh', 'render/materials',
                        'render/instances', 'render/shaders', 'render/renderer', 'world/entities', 'world/world', 'game/floating',
                        'game/camera', 'game/hud', 'game/app', 'phone-pages', 'feature',
                    ],
                },
            },
        },
        terrain: { uses: ['world', 'noise', 'gpu'], parts: ['heightfield', 'stamps', 'channels', 'landuse', 'mesh-terrain', 'land-field', 'terrain-lod'] },
        hydrology: {
            uses: ['terrain'],
            parts: ['sources'],
            worlds: {
                // Entity Water: a GPU shallow-water river simulation with surface-wave cascades and debris
                water: {
                    uses: ['noise', 'view', 'world', 'terrain'],
                    parts: [
                        'config', 'terrain/heightfield', 'shaders/flow', 'shaders/waves', 'shaders/debris', 'shaders/render',
                        'gpu/helpers', 'entities/types', 'world', 'sim/flow', 'sim/waves',
                        'sim/debris', 'renderer', 'tools', 'hud', 'app', 'phone-pages', 'feature',
                    ],
                },
            },
        },
        weather: { uses: ['noise'], parts: ['storms', 'climate', 'sky', 'lightning'] },
        interior: {
            uses: ['mesh'],
            parts: ['origin', 'vis-area', 'frustum', 'trees', 'areas', 'area-set', 'portal-vis', 'vis-debug', 'area-map', 'vis-inspector', 'floorplan', 'interior'],
            worlds: {
                // Entity Portal: a bunker compound of areas and portals, stencil-masked traversal, a freighter, drones
                portal: {
                    uses: ['noise', 'view', 'world', 'entities', 'transit', 'building', 'gpu', 'gui'],
                    parts: [
                        'core/config', 'core/math', 'core/geometry2d', 'core/frustum', 'render/mesh', 'render/materials',
                        'render/shaders', 'render/renderer', 'render/gui-pass', 'render/frame-builder', 'vis/object-trees',
                        'vis/portal-vis', 'world/collision', 'world/area', 'world/portal', 'world/light-transport', 'world/architecture', 'world/outdoors',
                        'world/nav-graph', 'world/vehicle', 'world/power', 'gui/screens', 'world/entities', 'world/world', 'game/player', 'game/input',
                        'game/hud', 'game/media', 'game/game', 'phone-pages', 'feature',
                    ],
                },
            },
        },
        transit: { uses: ['interior', 'mesh', 'gui'], parts: ['paths', 'line', 'bus', 'ship', 'elevator', 'lifts', 'lift-interaction', 'drive-control'] },
        building: { uses: ['noise', 'mesh', 'interior', 'transit', 'gui'], parts: ['library', 'core', 'furnish', 'floors', 'ladders', 'planned', 'sectors', 'doors', 'room-vis', 'lift-control'] },
        settlement: {
            uses: ['noise', 'mesh', 'interior', 'transit', 'building'],
            parts: [
                'settlements', 'structures/limits', 'structures/palette', 'structures/solids', 'structures/shelter-boxes', 'structures/doors',
                'structures/buildings', 'structures/fixtures', 'structures/structures', 'structures/meshes', 'structures/walker',
                'structures/door-control', 'structures/sound-events',
            ],
        },
        // a round planet's surface out of a flat world, O(1) per point (the outdoors as drawn: renderers, culling)
        curvature: { parts: ['curvature'] },
        // a real place (tools/geo-import.mjs's data, ScenarioData): its ground, roads, buildings and place names as entities
        geo: { uses: ['noise', 'world', 'mesh', 'terrain'], parts: ['data', 'curves', 'roads', 'buildings', 'types'] },
        // octahedral imposters for any renderer: bake a mesh into a light-agnostic G-buffer atlas, draw instances as
        // imposters from it (WGSL pieces), cull them into LOD lists feeding indirect draws (docs/imposter.md)
        imposter: {
            parts: ['octahedral', 'atlas', 'shaders', 'gpu', 'baker', 'lists'],
            worlds: {
                // Entity Imposter: a valley of meshes and their octahedral imposters, LOD-culled on the GPU
                imposter: {
                    uses: ['noise', 'view', 'world', 'terrain', 'entities'],
                    parts: [
                        'core/config', 'core/util', 'core/math', 'assets/textures',
                        'assets/materials', 'assets/geometry', 'gpu/mesh', 'assets/models', 'assets/loaders', 'shaders/common',
                        'shaders/mesh', 'shaders/cull', 'shaders/imposter', 'shaders/overlay', 'gpu/renderer', 'world/lighting', 'world/archetype', 'world/entities', 'world/world',
                        'game/camera', 'game/hud', 'game/game', 'phone-pages', 'feature',
                    ],
                },
            },
        },
        gpu: { parts: ['stencil', 'pipelines', 'extensions', 'lines', 'half', 'profiler', 'dynamic-scale'] },
        gui: {
            uses: ['noise', 'gpu'],
            parts: [
                'math', 'materials', 'geometry', 'gui-mode', 'shaders', 'renderer', 'atlas', 'device-context', 'entity-gui', 'gui-schedule', 'interaction', 'gui-targets', 'world-gui',
                'phone-gui', 'phone-apps', 'paint-shader', 'paint-canvas', 'easel-gui', 'views', 'media', 'cctv', 'phone-camera',
                'iptv', 'apps/camera', 'apps/gallery', 'apps/viewer', 'apps/tv', 'media-phone',
            ],
            worlds: {
                // Entity GUI: a facility of world-space GUIs (terminals, CCTV, easels) walked by a player
                gui: {
                    uses: ['view', 'world', 'entities', 'interior'],
                    parts: [
                        'core/audio', 'gui/terminal-gui', 'world/entities', 'gui/apps/radar', 'world/world', 'game/player',
                        'game/input', 'game/bindings', 'game/game', 'feature',
                    ],
                },
            },
        },
        // the volumetric atmosphere (clouds, precipitation, haze, lightning) over a terrain and its structures: its renderer
        // and what it writes each frame, the World under it (WorldExtensions compose a world type in), its App (with
        // AppExtensions) and the engine adapter (AtmosphereWorld)
        atmosphere: {
            uses: ['noise', 'view', 'world', 'gpu', 'gui', 'mesh', 'interior', 'transit', 'building', 'settlement', 'terrain', 'weather', 'curvature', 'imposter'],
            parts: [
                'limits', 'quality', 'bindings', 'shaders/common', 'shaders/shelter', 'shaders/occupancy', 'shaders/noise', 'shaders/weather',
                'shaders/volumetrics', 'shaders/scene', 'shaders/vegetation', 'shaders/final', 'passes', 'vegetation', 'renderer', 'far-lights', 'surroundings', 'light-writer',
                'frame-writer', 'world', 'app/hud', 'app/menus', 'app/controls', 'app/key-commands', 'app/app', 'app/phone-pages', 'app/feature',
            ],
            worlds: {
                // Entity Cloud: its entity types, its World extension (Storms: cells, hurricane, tornado) and App extension
                // (Clouds: the cloud picker, storm keys, menus, readout), composed onto this kit's World, App and adapter
                cloud: { uses: ['geo'], parts: ['entities', 'storms', 'clouds', 'world-type'] },
            },
        },
    },
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
    kitOf(type) { return Object.keys(this.KITS).find(k => this.KITS[k].worlds?.[type]) || null; },

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
