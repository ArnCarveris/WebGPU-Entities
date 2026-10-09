'use strict';
// EntityTypes: every entity type a scenario may use, by name. Types belong to the kits, not to the features: a scenario
// says { "type": "light" }, not "cloud.light", and the feature world that takes it is the one named by `of`, or the only
// world of the scenario that has that type (ScenarioFormat). A feature takes a type through its schema (a config block,
// a map, a list, or an entity class, ScenarioFormat.SCHEMAS); a new type is added here first.
//
// `kit` names the kit whose code implements it (js/kits/<kit>/): every entity class is a kit's, made over the feature
// world's own entity base by a factory of that kit (kits.terrain.terrainTypes(Base, opts), kits.entities.sectorTypes(Base,
// deps)...; a feature's entities/types part only wires them). Types without a kit are data the feature's engine reads
// (config blocks, presets, materials). `about` says what it is. One name may mean a little more in one feature than in another (a `light` is a lighting preset in
// cloud/water/imposter and a light source in portal/gui): in a scenario with both, `of` says which world it is for.
//
// Plain script (not a kit part): the scenario format reads it before any kit loads, in the page and in node tools.

const EntityTypes = (() => {
    const TYPES = {};
    const def = (kit, types) => { for (const [type, about] of Object.entries(types)) TYPES[type] = kit ? { kit, about } : { about }; };

    // the engine's own (js/engine): not taken by a world, except `camera` / `view` with `of` (a world's camera block,
    // a world's own viewpoint)
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

    def('terrain', {
        terrain: 'the heightfield (size, resolution, base shape); imposter: a mesh terrain (meshTerrain)',
        tilt: 'a plane tilting the ground', hills: 'rolling noise hills', mountain: 'a peak', range: 'a ridge of peaks along a line',
        lake: 'a bowl filled to a level', clearing: 'levels the ground in a rectangle or disc (inset: meets its edges at their height)',
        river: 'a river channel', valley: 'a carved valley', basin: 'a basin', coast: 'a coastline', dam: 'a dam wall (breaches)',
        town: "a town's built-up ground (land use)", forest: 'woods (land use)',
    });
    def('hydrology', { sea: 'sea level', spring: 'a water source', drain: 'a water sink', rain: 'rain over an area', debris: 'floating debris' });
    def('weather', { storm: 'a storm cell', supercell: 'a supercell', squall: 'a squall line', spawner: 'spawns storm cells' });
    def('settlement', { village: 'a village on a road', busStation: "a town's bus station", skyscraper: 'a skyscraper: sky lobbies, lifts, an observation deck' });
    def('transit', { bus: 'a bus line with its fleet', vehicle: 'a vehicle on a route (portal: the freighter)' });
    def('interior', {
        building: 'a building archetype (storeys, windows, doors, furniture)',
        area: 'a vis area (room) with its lights', visPortal: 'a vis portal (door, window, hatch) between areas',
    });
    def('entities', {
        light: 'a light: a lighting preset (cloud, water, imposter) or a light source (portal, gui)',
        door: 'a door (auto, locked, sliding)', drone: 'a patrolling or wandering drone',
        securityCamera: 'a security camera (sweep, feed)', lamp: 'a swinging lamp', alarmBeacon: 'a spinning alarm beacon',
        prop: 'a placed model', static: 'a static model', body: 'a celestial body', orbiter: 'a body on an orbit',
        field: 'a scattered field of props', scatter: 'props scattered over the terrain', compare: 'mesh vs imposter comparison row',
        stairs: 'stairs', hull: 'a vehicle hull', helm: 'a vehicle helm', avatar: 'an avatar', terminal: 'a terminal with an EntityGUI',
        easel: 'a paintable easel',
    });
    def(null, { occluder: 'an occluder box', material: 'a material', model: 'a model (parts)' });
    def('gui', {
        cctv: 'CCTV feeds', media: 'phone camera and gallery', iptv: 'IPTV channels', phone: 'the phone\'s apps and pages',
        radar: 'the radar app',
    });
    def('view', { player: 'the player (FirstPersonView: start, speeds, walk)' });
    def(null, {
        lighting: 'which lighting preset starts, and lighting settings', environment: 'the starting environment preset',
        bookmark: 'a bookmarked place', start: 'the starting bookmark', tool: 'a tool on a key', minimap: 'the minimap',
        outdoor: 'the outdoors (fog, sun)', facility: 'facility state (log)', places: 'named zones', waves: 'waves (water: surface waves; gui: radar pings)',
    });
    def(null, {
        render: 'render settings', weather: 'weather settings and the starting state', weatherState: 'a weather state',
        cloudLayer: 'a cloud layer', hurricane: 'a hurricane', streetLights: 'street light settings',
        sim: 'water simulation settings', waterShading: 'water shading (colour, absorption, refraction, foam)',
        floatingOrigin: 'floating origin settings (distance, angle, scale)', lod: 'LOD settings', shadows: 'shadow settings',
        imposterAtlas: 'imposter atlas settings (grid, resolution, mode)', drop: 'dropping a model file into the scene',
    });

    for (const t of Object.keys(ENGINE)) if (!TYPES[t]) TYPES[t] = { engine: true, about: ENGINE[t] };
    for (const t of ['camera', 'view']) TYPES[t].engine = true;

    const has = type => Object.prototype.hasOwnProperty.call(TYPES, type);
    const isEngine = type => !!(has(type) && TYPES[type].engine);
    return { TYPES, ENGINE, has, isEngine };
})();

if (typeof module !== 'undefined') module.exports = EntityTypes;
