'use strict';
// Kits: the one description of every kit, read by the loader (Features), the scenario format (ScenarioFormat) and the
// worlds (their entity classes). Nothing else lists kits, types or worlds.
//
//   <kit>: {
//     about, uses (the kits it builds on), parts (js/kits/<kit>/<part>.js, in load order),
//     types:  entity types it implements, by factory: <factory>: { base, needs, types: { <type>: [Class, about, { uses }] } }
//             kits.<kit>.<factory>(Base, options) makes the classes over a world's entity base (Base: the world's
//             `bases[base]`); a world takes the types of every factory whose base it has and whose `needs` it provides.
//             A factory that returns one class (not a set of them) names none ([null, about]). A type's `uses`: kits it
//             needs beyond its kit's (an easel's paint), loaded only with an entity of it.
//     data:   data types it reads (config blocks, presets, plans): { <type>: about }; a world with one of them loads it
//     worlds: the world types it offers: <type>: { title, about, uses, parts, bases, provides, schema, implicit }
//             parts: js/kits/<kit>/worlds/<type>/<part>.js (Features.world); bases: the entity bases it has (names);
//             provides: what else its entity types may need of it (structures, weather, water...); schema: how its
//             data types map onto its native layout (ScenarioFormat); implicit: how it joins a scenario that has none of
//             it but entities only it takes (an entity of any kit works in any scenario): { root (fields of its root when
//             it joins other worlds: a sky's layer role), entities (what it has unless the scenario says: a ground) }.
//             A world may have features of its own (features, as a kit's below: parts under its folder's features/<name>/,
//             registered as Features.feature('<kit>/<world>/<name>', fn), over the world's exports).
//     features: what its worlds are made of beyond their core, each built only when a world's data asks for it:
//             <name>: { about, uses, parts, when, requires }. parts: js/kits/<kit>/features/<name>/<part>.js
//             (Features.feature('<kit>/<name>', fn)), loaded with the kits it uses. when: { types (any of these entity
//             types), needs (an entity whose implementation needs one of these), data (any of these paths of the
//             world's native data is set; through a list, in any of its items: entities.screen), features (any of these
//             features is on) }; requires: features it builds on
//             (on with it). A root entity's `features: { <name>: true | false }` turns one on or off whatever its data.
//   }
//
// ENGINE: the engine's own entity types (js/engine). Plain script, not a kit part: the scenario format reads it before
// any kit loads, in the page and in node tools (module.exports).

const Kits = (() => {
    const ENGINE = {
        include: 'splices another scenario\'s entities in its place',
        camera: 'which world drives the camera, or the engine\'s free camera; with `of`: that world\'s camera settings',
        view: 'a viewpoint in composition space; with `of`: one of that world\'s views (`each` + `follow` per member)',
        link: 'sets a world parameter from an expression',
        handheld: 'the engine\'s handheld phone',
        'handheld.page': 'a page of the handheld',
        'hud.toast': 'a message once the scenario starts',
        'sound.master': 'master gain', 'sound.bed': 'a looped sound', 'sound.cue': 'a one-shot sound',
    };

    const KITS = {
        noise: { about: 'random numbers, value noise, fbm, their WGSL', parts: ['random', 'value', 'wgsl'] },
        mesh: {
            about: 'the common mesh interface every world draws through: geometry, a builder, tiled meshes',
            parts: ['geometry', 'builder', 'interface', 'tiled'],
            data: { material: 'a material', model: 'a model (parts)' },
        },
        view: {
            about: 'the first-person view (fly / walk) every camera is',
            parts: ['first-person'],
            data: { player: 'the player (FirstPersonView: start, speeds, walk)' },
        },
        world: {
            about: 'entity bases, HUD layers, pages and the FeatureWorld adapter every world is',
            parts: ['entity', 'hud', 'pages', 'feature-world'],
            data: { lighting: 'which lighting preset starts, and lighting settings', light: 'a lighting preset (sun, sky, fog...)' },
        },
        entities: {
            about: 'the shared entity kinds (spin, cameras, doors, lights, drones) and the entity sets of space, ground, sector and fixture worlds',
            uses: ['noise', 'world', 'mesh', 'gui'],
            parts: ['spin', 'camera', 'door', 'light', 'drone', 'space', 'ground-props', 'sectors', 'fixtures'],
            types: {
                spaceTypes: {
                    base: 'space',
                    types: {
                        body: ['Body', 'a celestial body'], prop: ['Prop', 'a placed model (on a body: lat / lon / alt)'],
                        field: ['Field', 'a scattered field of props'], orbiter: ['Orbiter', 'a body on an orbit'],
                    },
                },
                groundProps: {
                    base: 'ground',
                    types: {
                        prop: ['Prop', 'a placed model on the ground'], scatter: ['Scatter', 'props scattered over the terrain'],
                        compare: ['Compare', 'mesh vs imposter comparison row'],
                    },
                },
                sectorTypes: {
                    base: 'sector',
                    types: {
                        securityCamera: ['SecurityCamera', 'a security camera (sweep, feed)', { uses: ['media'] }], prop: ['Prop', 'a placed model (with screens)'],
                        light: ['Lamp', 'a light source'], stairs: ['Stairs', 'stairs'], hull: ['Hull', 'a vehicle hull'], helm: ['Helm', 'a vehicle helm'],
                        door: ['Door', 'a door (auto, locked, sliding)'], drone: ['Drone', 'a patrolling or wandering drone'],
                    },
                },
                fixtureTypes: {
                    base: 'fixture',
                    types: {
                        static: ['ModelEntity', 'a static model'], door: ['SlidingDoor', 'a sliding door (auto, locked)'],
                        lamp: ['SwingingLamp', 'a swinging lamp'], alarmBeacon: ['AlarmBeacon', 'a spinning alarm beacon'],
                        light: ['PointLight', 'a light source'], drone: ['PatrolDrone', 'a patrolling drone'],
                        securityCamera: ['SecurityCamera', 'a security camera (sweep, feed)', { uses: ['media'] }], avatar: ['Avatar', 'an avatar'],
                        terminal: ['Terminal', 'a terminal with an EntityGUI'], easel: ['Easel', 'a paintable easel', { uses: ['paint'] }],
                    },
                },
            },
            worlds: {
                origin: {
                    title: 'Entity Origin',
                    about: 'a real-scale solar system under a floating origin',
                    parts: [
                        'core/config', 'core/math', 'core/world-pos', 'core/origin', 'render/mesh', 'render/materials',
                        'render/instances', 'render/shaders', 'render/renderer', 'world/entities', 'world/world', 'game/floating',
                        'game/camera', 'game/hud', 'game/app', 'phone-pages', 'feature',
                    ],
                    bases: ['space'],
                    schema: {
                        config: ['start', 'camera', 'origin', 'lighting'],
                        rename: { origin: 'floatingOrigin' },
                        maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
                        lists: { bookmarks: 'bookmark' },
                    },
                    data: { bookmark: 'a bookmarked place', start: 'the starting bookmark', floatingOrigin: 'floating origin settings (distance, angle, scale)' },
                },
            },
        },
        terrain: {
            about: 'heightfields and what shapes them (stamps, channels, land use), mesh terrain, the land field and its LOD',
            uses: ['world', 'noise', 'gpu'],
            parts: ['heightfield', 'stamps', 'channels', 'landuse', 'mesh-terrain', 'land-field', 'terrain-lod'],
            types: {
                terrainTypes: {
                    base: 'terrain',
                    types: {
                        tilt: ['Tilt', 'a plane tilting the ground'], hills: ['Hills', 'rolling noise hills'], mountain: ['Mountain', 'a peak'],
                        range: ['Range', 'a ridge of peaks along a line'], lake: ['Lake', 'a bowl filled to a level'],
                        clearing: ['Clearing', 'levels the ground in a rectangle or disc (inset: meets its edges at their height)'],
                        river: ['River', 'a river channel'], valley: ['Valley', 'a carved valley'], basin: ['Basin', 'a basin'],
                        coast: ['Coast', 'a coastline'], dam: ['Dam', 'a dam wall (breaches)'],
                        town: ['Town', "a town's built-up ground (land use)"], forest: ['Forest', 'woods (land use)'],
                    },
                },
                meshTerrain: { base: 'ground', types: { terrain: [null, 'a mesh terrain'] } },
            },
            data: { terrain: 'the heightfield (size, resolution, base shape)' },
        },
        hydrology: {
            about: 'water sources and sinks on a terrain; the water world simulates them',
            uses: ['terrain'],
            parts: ['sources'],
            types: {
                hydrologyTypes: {
                    base: 'terrain', needs: ['water'],
                    types: {
                        sea: ['Sea', 'sea level'], spring: ['Spring', 'a water source'], drain: ['Drain', 'a water sink'],
                        rain: ['Rain', 'rain over an area'], debris: ['Debris', 'floating debris'],
                    },
                },
            },
            worlds: {
                water: {
                    title: 'Entity Water',
                    about: 'a GPU shallow-water river simulation with surface-wave cascades and debris',
                    uses: ['noise', 'view', 'world', 'terrain'],
                    parts: [
                        'config', 'terrain/heightfield', 'shaders/flow', 'shaders/render', 'gpu/helpers', 'entities/types', 'world',
                        'sim/flow', 'renderer', 'tools', 'hud', 'app', 'phone-pages', 'feature',
                    ],
                    bases: ['terrain'],
                    provides: ['water'],
                    // (its own, over its parts' exports: js/kits/hydrology/worlds/water/features/)
                    features: {
                        waves: {
                            about: 'surface waves: wave maps in cascades that follow the camera, carried by the flow, with foam',
                            parts: ['shaders', 'cascade', 'waves'], when: { data: ['waves'] },
                        },
                        debris: { about: 'floating debris: logs on the GPU, carried by the flow', parts: ['shaders', 'system', 'debris'], when: { types: ['debris'] } },
                    },
                    schema: {
                        config: ['terrain', 'sim', 'waves', 'water', 'lighting'],
                        rename: { water: 'waterShading' },
                        maps: { lighting: { type: 'light', except: ['start'] } },
                        lists: { tools: 'tool', views: 'view' },
                    },
                    data: {
                        sim: 'water simulation settings', waves: 'surface waves', tool: 'a tool on a key',
                        waterShading: 'water shading (colour, absorption, refraction, foam)',
                    },
                },
            },
        },
        weather: {
            about: 'storm cells, the climate, the sky and cloud layers, lightning',
            uses: ['noise'],
            parts: ['storms', 'climate', 'sky', 'lightning'],
            types: {
                weatherTypes: {
                    base: 'terrain', needs: ['weather'],
                    types: {
                        storm: ['StormCell', 'a storm cell'], supercell: ['Supercell', 'a supercell'],
                        squall: ['SquallLine', 'a squall line'], spawner: ['Spawner', 'spawns storm cells'],
                    },
                },
            },
            data: {
                weather: 'weather settings and the starting state', weatherState: 'a weather state', cloudLayer: 'a cloud layer',
                hurricane: 'a hurricane',
            },
        },
        interior: {
            about: 'interiors: origins, vis areas and portals, portal visibility, floor plans',
            uses: ['mesh'],
            parts: ['origin', 'vis-area', 'frustum', 'trees', 'areas', 'area-set', 'portal-vis', 'vis-debug', 'area-map', 'vis-inspector', 'floorplan', 'interior'],
            data: {
                building: 'a building archetype (storeys, windows, doors, furniture)', area: 'a vis area (room) with its lights',
                visPortal: 'a vis portal (door, window, hatch) between areas', occluder: 'an occluder box',
            },
            worlds: {
                portal: {
                    title: 'Entity Portal',
                    about: 'a bunker compound of areas and portals, stencil-masked traversal, a freighter, drones',
                    uses: ['noise', 'view', 'world', 'entities', 'transit', 'building', 'gpu', 'gui'],
                    parts: [
                        'core/config', 'core/math', 'core/geometry2d', 'core/frustum', 'render/mesh', 'render/materials',
                        'render/shaders', 'render/renderer', 'render/frame-builder', 'vis/object-trees',
                        'vis/portal-vis', 'world/collision', 'world/area', 'world/portal', 'world/architecture', 'world/outdoors',
                        'world/power', 'world/entities', 'world/world', 'game/player', 'game/input',
                        'game/hud', 'game/game', 'phone-pages', 'feature',
                    ],
                    bases: ['sector'],
                    // (its own, over its parts' exports: js/kits/interior/worlds/portal/features/)
                    features: {
                        screens: {
                            about: 'world-space GUI screens on the props (consoles, generators, the bridge): their GUIs, drawn in the portal pass, the cursor on them',
                            parts: ['screens', 'gui-pass', 'feature'], when: { data: ['entities.screen'] },
                        },
                        media: {
                            about: 'CCTV over the security cameras, the phone camera and IPTV, on the screens and the handheld',
                            uses: ['media'], requires: ['screens'], parts: ['media'], when: { types: ['securityCamera'], data: ['cctv', 'media', 'iptv'] },
                        },
                        vehicles: { about: 'vehicles on routes (the freighter): sailed, boarded and steered, their routes on the map', parts: ['vehicles'], when: { data: ['vehicles'] } },
                        lightTransport: {
                            about: "light through portals: the neighbouring areas' lamps and the sun shining in through doors, windows and hatches",
                            parts: ['shaders', 'light-transport'], when: { data: ['portals'] },
                        },
                        drones: { about: 'drones flying the areas: their navigation graph over areas and portals, on the map', parts: ['nav-graph', 'drones'], when: { types: ['drone'] } },
                    },
                    schema: {
                        config: ['camera', 'player', 'minimap', 'outdoor', 'cctv', 'media', 'iptv'],
                        maps: { materials: { type: 'material' }, models: { type: 'model' }, buildings: { type: 'building' }, ...plans() },
                        lists: { areas: 'area', portals: 'visPortal', occluders: 'occluder', vehicles: 'vehicle', views: 'view', structures: 'structure' },
                    },
                    data: { minimap: 'the minimap', outdoor: 'the outdoors (fog, sun)' },
                },
            },
        },
        transit: {
            about: 'routes, lines and the vehicles on them (buses, ships), lifts',
            uses: ['interior', 'mesh', 'gui'],
            parts: ['paths', 'line', 'bus', 'ship', 'elevator', 'lifts', 'lift-interaction', 'drive-control'],
            types: { busTypes: { base: 'terrain', needs: ['structures'], types: { bus: ['BusLine', 'a bus line with its fleet'] } } },
            data: { vehicle: 'a vehicle on a route (the freighter)' },
        },
        building: {
            about: 'buildings as floor-plan compositions: plans, cores, furnishing, floors, lifts',
            uses: ['noise', 'mesh', 'interior', 'transit', 'gui'],
            parts: ['library', 'core', 'furnish', 'floors', 'ladders', 'planned', 'sectors', 'doors', 'room-vis', 'lift-control'],
            // floor plans: data, kept in scenarios/plans/ and included where a world builds from them
            data: {
                buildingPlan: 'a building as a floor-plan composition: sections of storeys (storeyPlans), its core (corePlan), its lift groups',
                storeyPlan: 'a storey layout: bands of rooms and corridors round the core, or a hall',
                corePlan: 'a core: stairwell, lift banks (shafts with their technical space, pit, overrun, ladder), lift lobby',
                roomType: 'a kind of room: its furniture, lamps, colours',
                furniture: 'a furniture item: footprint and parts', furnishing: "an unplanned archetype's furniture per storey",
                structure: 'a building placed from a buildingPlan (any world that builds from plans)',
            },
        },
        settlement: {
            about: 'villages, bus stations, skyscrapers and the structures they build (solids, shelters, doors, buildings)',
            uses: ['noise', 'mesh', 'interior', 'transit', 'building'],
            parts: [
                'settlements', 'structures/limits', 'structures/palette', 'structures/solids', 'structures/shelter-boxes', 'structures/doors',
                'structures/buildings', 'structures/fixtures', 'structures/structures', 'structures/meshes', 'structures/door-control',
            ],
            types: {
                settlementTypes: {
                    base: 'terrain', needs: ['structures'],
                    types: {
                        village: ['Village', 'a village on a road'], busStation: ['BusStation', "a town's bus station"],
                        skyscraper: ['Skyscraper', 'a skyscraper built from a buildingPlan, its plaza round it'],
                        structure: ['Structure', 'a building placed from a buildingPlan'],
                    },
                },
            },
            data: { streetLights: 'street light settings' },
        },
        curvature: {
            about: "a round planet's surface out of a flat world, O(1) per point (the outdoors as drawn: renderers, culling)",
            parts: ['curvature'],
            data: { curvature: 'the outdoors drawn on a round planet (radius, on, reference): O(1) per point, the world itself stays flat' },
        },
        geo: {
            about: "a real place (tools/geo-import.mjs's data, ScenarioData): its ground, roads, buildings and place names as entities",
            uses: ['noise', 'world', 'mesh', 'terrain'],
            parts: ['data', 'curves', 'roads', 'buildings', 'types'],
            types: {
                // a real place, imported by tools/geo-import.mjs into scenarios/data/<region>/ (an entity's `data` names it)
                geoTypes: {
                    base: 'terrain', needs: ['structures'],
                    types: {
                        geoTerrain: ['GeoTerrain', "a real place's ground: its heights and land cover (built-up, woods, water) from data"],
                        geoRoads: ['GeoRoads', "a real place's roads from data: ribbons with rounded curves on the ground, bridges, markings"],
                        geoBuildings: ['GeoBuildings', "a real place's buildings from data: their footprints stood up to their heights, flat or hipped roofs"],
                        geoCanopy: ['GeoCanopy', "a real place's tree canopy from data (cover and height): where the plants grow and how tall"],
                        geoCoast: ['GeoCoast', "a real place's coastline from data (distance to it, 18 m grid): the shore drawn along it, beaches and surf"],
                        geoPlaces: ['GeoPlaces', "a real place's names from data (towns, peaks...) as place labels"], place: ['Place', 'a named place (its label)'],
                    },
                },
            },
        },
        imposter: {
            about: 'octahedral imposters for any renderer: bake a mesh into a light-agnostic G-buffer atlas, draw instances as imposters from it, cull them into LOD lists (docs/imposter.md)',
            parts: ['octahedral', 'atlas', 'shaders', 'gpu', 'baker', 'lists'],
            worlds: {
                imposter: {
                    title: 'Entity Imposter',
                    about: 'a valley of meshes and their octahedral imposters, LOD-culled on the GPU',
                    uses: ['noise', 'view', 'world', 'terrain', 'entities'],
                    parts: [
                        'core/config', 'core/util', 'core/math', 'assets/textures',
                        'assets/materials', 'assets/geometry', 'gpu/mesh', 'assets/models', 'assets/loaders', 'shaders/common',
                        'shaders/mesh', 'shaders/cull', 'shaders/imposter', 'shaders/overlay', 'shaders/library', 'gpu/renderer', 'world/lighting', 'world/archetype',
                        'world/entities', 'world/world', 'game/camera', 'game/hud', 'game/game', 'phone-pages', 'feature',
                    ],
                    bases: ['ground'],
                    // (its own: js/kits/imposter/worlds/imposter/features/)
                    features: {
                        shadows: {
                            about: 'cascaded sun shadows: caster lists per cascade, meshes and imposters drawn into a depth array, sampled with PCF',
                            parts: ['shaders', 'shadows'], when: { data: ['shadows'] },
                        },
                    },
                    schema: {
                        config: ['camera', 'environment', 'lod', 'shadows', 'imposter', 'drop'],
                        rename: { imposter: 'imposterAtlas' },
                        maps: { lighting: { type: 'light' }, materials: { type: 'material' }, models: { type: 'model' } },
                        lists: { views: 'view' },
                    },
                    data: {
                        environment: 'the starting environment preset', lod: 'LOD settings', shadows: 'shadow settings',
                        imposterAtlas: 'imposter atlas settings (grid, resolution, mode)', drop: 'dropping a model file into the scene',
                    },
                },
            },
        },
        gpu: {
            about: 'stencil layouts, pipeline tables, render extensions, WGSL libraries, lines, half floats, profiling, dynamic scale',
            parts: ['stencil', 'pipelines', 'extensions', 'wgsl-library', 'lines', 'half', 'profiler', 'dynamic-scale'],
        },
        gui: {
            about: 'EntityGUI: world-space GUIs (their renderer, atlas, schedule, interaction, render-target fallback) and the phone',
            uses: ['noise', 'gpu'],
            parts: [
                'math', 'materials', 'geometry', 'gui-mode', 'shaders', 'renderer', 'atlas', 'device-context', 'entity-gui', 'gui-schedule', 'interaction', 'gui-targets', 'world-gui',
                'phone-gui', 'phone-apps',
            ],
            data: { phone: "the phone's apps and pages", radar: 'the radar app' },
            worlds: {
                gui: {
                    title: 'Entity GUI',
                    about: 'a facility of world-space GUIs (terminals, CCTV, easels) walked by a player',
                    uses: ['view', 'world', 'entities', 'interior'],
                    parts: [
                        'core/audio', 'gui/terminal-gui', 'world/entities', 'world/world', 'game/player',
                        'game/input', 'game/bindings', 'game/game', 'feature',
                    ],
                    bases: ['fixture'],
                    // (its own: js/kits/gui/worlds/gui/features/)
                    features: {
                        paint: { about: "easels: their paint canvases, stamped on the GPU before the frame's passes", uses: ['paint'], parts: ['paint'], when: { types: ['easel'] } },
                        radar: { about: 'the phone radar: the waves of footsteps, doors, drones and the alarm, and its app', parts: ['radar-app', 'radar'], when: { data: ['waves', 'radar'] } },
                        media: {
                            about: 'CCTV over the security cameras, the phone camera and its gallery, IPTV: their views and phone apps',
                            uses: ['media'], parts: ['media'], when: { types: ['securityCamera'], data: ['cctv', 'media', 'iptv'] },
                        },
                    },
                    schema: {
                        config: ['player', 'facility', 'cctv', 'media', 'iptv', 'waves', 'radar', 'places', 'phone'],
                        maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
                        lists: { views: 'view' },
                    },
                    data: { facility: 'facility state (log)', places: 'named zones', waves: 'radar pings' },
                },
            },
        },
        // the media of a world of EntityGUIs: views into it (ViewTarget), CCTV over its security cameras, the phone's camera and
        // gallery, IPTV, and their phone apps; the world is their scene (views.js: renderView)
        media: {
            about: 'views into a world, CCTV, the phone camera and its gallery, IPTV, and their phone apps',
            uses: ['gui'],
            parts: ['shadings', 'views', 'media', 'cctv', 'phone-camera', 'iptv', 'apps/camera', 'apps/gallery', 'apps/viewer', 'apps/tv', 'media-phone'],
            data: { cctv: 'CCTV feeds', media: 'phone camera and gallery', iptv: 'IPTV channels' },
        },
        // paintable surfaces: an easel's GUI and its paint canvas (stamped on the GPU)
        paint: { about: 'paint canvases and the easel GUI over them', uses: ['noise', 'gui'], parts: ['paint-shader', 'paint-canvas', 'easel-gui'] },
        atmosphere: {
            about: 'the volumetric atmosphere (clouds, precipitation, haze, lightning) over a terrain and its structures: its renderer and what it writes each frame, the World under it (WorldExtensions), its App (AppExtensions) and the engine adapter (atmosphereWorld)',
            uses: ['noise', 'view', 'world', 'gpu', 'terrain', 'weather'],
            parts: [
                'limits', 'quality', 'bindings', 'shaders/common', 'shaders/shelter', 'shaders/occupancy', 'shaders/noise', 'shaders/weather',
                'shaders/volumetrics', 'shaders/scene', 'shaders/forest', 'shaders/final', 'shaders/library', 'passes', 'renderer', 'surroundings', 'light-writer',
                'frame-writer', 'world', 'walker', 'app/hud', 'app/menus', 'app/controls', 'app/key-commands', 'app/app', 'app/phone-pages', 'app/feature',
            ],
            data: { render: 'render settings' },
            features: {
                curvature: { about: 'the outdoors drawn on a round planet', uses: ['curvature'], parts: ['curvature'], when: { data: ['curvature'] } },
                structures: {
                    about: 'what the entities build: buildings with interiors, lifts and doors, villages, stations, roads; their lamps, the distant lights, their sun and rain shadows',
                    uses: ['mesh', 'interior', 'transit', 'building', 'settlement'], parts: ['shaders', 'far-lights', 'renderer', 'structures'],
                    when: { needs: ['structures'], data: ['buildings', 'plans', 'streetLights'] },
                },
                vegetation: {
                    about: 'plants scattered about the eye: meshes near, octahedral imposters further, the canopy carpet beyond',
                    uses: ['imposter'], parts: ['shaders', 'pass', 'vegetation'], when: { data: ['terrain.vegetation'] },
                },
                buses: {
                    about: 'bus lines and their fleets: drawn, boarded, ridden and driven, their lights and sounds',
                    uses: ['transit'], requires: ['structures'], parts: ['shaders', 'renderer', 'buses'], when: { types: ['bus'] },
                },
            },
            worlds: {
                // its entity types, its World extension (Storms: cells, hurricane, tornado) and App extension (Clouds: the
                // cloud picker, storm keys, menus, readout), composed onto this kit's World, App and adapter
                cloud: {
                    title: 'Entity Cloud',
                    about: 'volumetric clouds and weather over a terrain with its towns, buildings and buses',
                    parts: ['entities', 'storms', 'clouds', 'world-type'],
                    bases: ['terrain'],
                    provides: ['structures', 'weather'],
                    schema: {
                        config: ['terrain', 'render', 'weather', 'lighting', 'hurricane', 'streetLights', 'curvature'],
                        maps: { 'weather.states': { type: 'weatherState' }, 'lighting.presets': { type: 'light' }, buildings: { type: 'building' }, ...plans() },
                        lists: { clouds: 'cloudLayer', views: 'view' },
                    },
                    // what any scenario gets with a weather entity and no sky: this world over the others, on a calm plain at
                    // sea level (the worlds it joins stand on their own ground)
                    implicit: {
                        root: { layer: { role: 'atmosphere' } },
                        entities: [{ type: 'terrain', base: -2, size: 64000, resolution: 256, style: 'natural', outside: 'sea' }],
                    },
                },
            },
        },
    };

    // the building kit's plan data, as a world that builds from plans maps it
    function plans() {
        return {
            'plans.buildings': { type: 'buildingPlan' }, 'plans.storeys': { type: 'storeyPlan' }, 'plans.cores': { type: 'corePlan' },
            'plans.rooms': { type: 'roomType' }, 'plans.furniture': { type: 'furniture' }, 'plans.furnishings': { type: 'furnishing' },
        };
    }

    // ------------------------------------------------------------------------------------------- derived
    // worlds by type: { kit, ...spec }
    const WORLDS = {};
    for (const [kit, k] of Object.entries(KITS)) for (const [type, w] of Object.entries(k.worlds || {})) {
        if (WORLDS[type]) throw new Error(`world "${type}" offered by kits ${WORLDS[type].kit} and ${kit}`);
        WORLDS[type] = { kit, type, uses: [], bases: [], provides: [], data: {}, ...w };
    }

    // entity implementations by type: [{ kit, factory, base, needs, cls, about }]
    const IMPLS = {};
    for (const [kit, k] of Object.entries(KITS)) for (const [factory, f] of Object.entries(k.types || {}))
        for (const [type, [cls, about, opts = {}]] of Object.entries(f.types)) (IMPLS[type] ??= []).push({ kit, factory, base: f.base, needs: f.needs || [], uses: opts.uses || [], cls, about });

    // data types: type -> [kit or kit/world]
    const DATA = {};
    for (const [kit, k] of Object.entries(KITS)) {
        for (const [type, about] of Object.entries(k.data || {})) (DATA[type] ??= []).push({ kit, about });
        for (const [w, spec] of Object.entries(k.worlds || {})) for (const [type, about] of Object.entries(spec.data || {})) (DATA[type] ??= []).push({ kit, world: w, about });
    }

    // the implementations of `type` a world of type `world` takes: its base, and every need provided
    const implsIn = (world, type) => {
        const w = WORLDS[world];
        return (IMPLS[type] || []).filter(i => w.bases.includes(i.base) && i.needs.every(n => w.provides.includes(n)));
    };

    // the kits an entity of `type` needs loaded in a world of type `world`: its implementation's kit and what the type uses
    // beyond it (each with what it uses), or the kits that read it, a data type
    const kitsFor = (world, type) => [...new Set([...implsIn(world, type).flatMap(i => [i.kit, ...i.uses]),
        ...(DATA[type] || []).filter(d => !d.world).map(d => d.kit)])];

    const has = type => type in ENGINE || type in IMPLS || type in DATA || type in WORLDS;
    const isEngine = type => type in ENGINE;

    // The features of a world of type `world` its data asks for, in the manifest's order (each after those it requires):
    // native its native data, types its entities' types, overrides { <name>: bool } (its root's `features`)
    // a world's features: its kit's, then its own (names unique between them)
    const featuresIn = world => {
        const k = KITS[WORLDS[world].kit].features || {}, w = WORLDS[world].features || {};
        for (const n of Object.keys(w)) if (n in k) throw new Error(`world "${world}": feature "${n}" is its kit's too`);
        return { ...k, ...w };
    };

    // where a world's feature is: { spec, kit, world (the world type for one of its own, else null) }
    const featureOf = (world, name) => {
        const W = WORLDS[world], own = W.features?.[name];
        const spec = own || KITS[W.kit].features?.[name];
        if (!spec) throw new Error(`world "${world}" has no feature "${name}"`);
        return { spec, kit: W.kit, world: own ? world : null };
    };

    function featuresOf(world, native, types, overrides = {}) {
        const all = featuresIn(world);
        const set = (v => (v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
        // a path through a list is what its items have there (entities.screen: its entities' screens), set if any is
        const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : Array.isArray(a) && !/^\d+$/.test(k) ? a.map(x => x?.[k]).filter(set) : a[k]), o);
        const needs = new Set(types.flatMap(t => implsIn(world, t).flatMap(i => i.needs)));
        const on = new Set();
        for (let changed = true; changed;) {
            changed = false;
            for (const [name, f] of Object.entries(all)) {
                if (on.has(name) || overrides[name] === false) continue;
                const w = f.when || {};
                const want = overrides[name] === true || (w.types || []).some(t => types.includes(t)) || (w.needs || []).some(n => needs.has(n)) ||
                    (w.data || []).some(p => set(get(native, p))) || (w.features || []).some(x => on.has(x)) ||
                    Object.entries(all).some(([o, g]) => on.has(o) && (g.requires || []).includes(name));
                if (want) { on.add(name); changed = true; }
            }
        }
        for (const name of on) for (const r of all[name].requires || []) if (!on.has(r)) throw new Error(`feature "${name}" requires "${r}", which is off`);
        return Object.keys(all).filter(n => on.has(n));
    }

    return { ENGINE, KITS, WORLDS, IMPLS, DATA, implsIn, kitsFor, featuresOf, featureOf, has, isEngine };
})();

if (typeof module !== 'undefined') module.exports = Kits;
