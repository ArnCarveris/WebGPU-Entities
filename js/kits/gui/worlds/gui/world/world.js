'use strict';
// The facility's WorldExtension (the one World, kits.world): builds the facility and its entities and runs them.

Features.world('gui', (engine, kit) => {
const { kits } = engine;
const { MeshBuilder, MAX_LIGHTS } = engine.kits.gui;
const { ENTITY_TYPES, TerminalGUI } = kit;

// The facility: entities built from scenario data, shared facility state and actions. What the features on in its world
// add to it are the world's other extensions (their WorldExtensions, world.compose: new E(world) before its entities,
// kept as world.ext[E.key]): the radar feature's waves (world.waves).

// What a facility without the radar feature has for its waves (footsteps, doors, drones and the alarm emit them): none
const NO_WAVES = { list: [], emit() {}, prune() {} };

class WorldExtension {
    static key = 'gui';
    // what it answers on the World (Common.Composite)
    static exposes = ['alarm', 'alarmPulse', 'collide', 'frameState', 'game', 'guiKinds', 'guis', 'init', 'instances',
        'lampScale', 'lightsOn', 'log', 'mesh', 'meshes', 'ofType', 'placeLabel', 'pushLog', 'render', 'renderer',
        'scenario', 'setAlarm', 'setDoor', 'setLights', 'types', 'update', 'waves', 'writeInstances'];
    constructor(world, game, scenario) {
        this.world = world;
        this.types = ENTITY_TYPES;
        this.game = game;
        this.scenario = scenario;
        this.lightsOn = true;
        this.alarm = false;
        this.alarmPulse = 0;
        this.lampScale = 1;
        this.log = [...scenario.facility.log];
        this.waves = NO_WAVES;
        world.compose(kits.gpu.extensionsOf(game.fx.features, 'world'));
        this.modelMeshes = new Map();    // model name -> its renderer mesh (mesh())
        this.guis = [];

        this.instances = [];            // what entities draw: instance handles (meshes.instance), in the order they were made
        this.guiKinds = { terminal: TerminalGUI };     // the world's GUI kinds (a terminal's screen)
        // the common mesh interface (kits.mesh): instances of the scenario's models, made at init (when there is a
        // renderer), posed by matrix ({ matrix }; set(pose, i, { tint })), drawn every view unless opts.visible(ctx) says
        // not or the view is opts.owner's own (ctx.skip)
        this.meshes = {
            instance: (model, pose, opts = {}) => {
                const mesh = this.mesh(model), count = opts.count || 1, h = {
                    mesh, count, first: this.renderer.allocInstances(count), matrices: [], tints: [], owner: opts.owner, visible: opts.visible,
                    set: (p, i = 0, o = {}) => { h.matrices[i] = p.matrix; h.tints[i] = o.tint ?? null; },
                };
                if (pose) h.set(pose, 0, opts);
                this.instances.push(h);
                return h;
            },
        };
        for (const def of scenario.entities) world.add(def, { spawn: false });
        this.guis = this.world.entities.flatMap((e) => e.guis);
    }

    init(renderer) {
        this.renderer = renderer;
        for (const e of this.world.entities) e.init(renderer);
        for (const g of this.guis) g.attach(this.game);
    }

    ofType(Type) {
        return this.world.entities.filter((e) => e instanceof Type);
    }

    // Model meshes are shared between entities that use the same model
    mesh(name) {
        if (!this.modelMeshes.has(name)) {
            const parts = this.scenario.models[name];
            if (!parts) throw new Error(`No model "${name}"`);
            this.modelMeshes.set(name, this.game.renderer.createMesh(new MeshBuilder(this.game.renderer.worldMaterials).parts(parts)));
        }
        return this.modelMeshes.get(name);
    }

    // ---- facility actions (terminal, phone) ----
    pushLog(text) {
        this.log.push(text);
        if (this.log.length > 20) this.log.shift();
    }

    setDoor(id, open, source) {
        const door = this.world.get(id);
        if (!door.setOpen(open)) return;
        const name = door.name.toUpperCase();
        this.pushLog(open ? `${source} - ${name} OPENING` : `${name} SEALING...`);
        this.game.audio.door();
        this.waves.emit('door', door.position[0], door.position[2]);
    }

    setLights(on) {
        this.lightsOn = on;
        this.pushLog(on ? 'ILLUMINATION RESTORED' : 'ILLUMINATION CUT - AUX POWER ONLY');
    }

    setAlarm(on) {
        this.alarm = on;
        this.pushLog(on ? '!! EMERGENCY ALARM ENGAGED !!' : 'ALARM RESET BY OPERATOR');
    }

    // Named place nearest to a position (photo / video captions)
    placeLabel(x, z) {
        const { zones, spots } = this.scenario.places;
        const zone = zones.find((zn) => z < zn.zBelow);
        if (zone) return zone.name;
        return spots.reduce((best, sp) => (Math.hypot(sp.at[0] - x, sp.at[1] - z) < Math.hypot(best.at[0] - x, best.at[1] - z) ? sp : best)).name;
    }

    // ---- per frame ----
    update(dt, t) {
        this.alarmPulse = this.alarm ? Math.pow(0.5 + 0.5 * Math.sin(t * 7), 3) : 0;
        for (const e of this.world.entities) e.update(dt, t);
        this.waves.prune(t);
    }

    // Uniform inputs shared by every view this frame
    frameState(t) {
        const lights = [];
        for (const e of this.world.entities) e.lights(lights, t);
        while (lights.length < MAX_LIGHTS) lights.push([0, 0, 0, 0, 0, 0, 0, 0]);
        const f = this.game.scenario.facility || {};
        return { time: t, lightsOn: this.lightsOn, alarmPulse: this.alarmPulse, lights, fog: f.fog ?? 0.05, ambient: f.ambient ?? 0 };
    }

    writeInstances(renderer) {
        for (const h of this.instances) for (let i = 0; i < h.count; i++) renderer.setInstance(h.first + i, h.matrices[i], h.tints[i]);
        for (const g of this.guis) g.writeInstances(renderer);
    }

    // Draw the world into a scene pass: entity meshes (but an owner's in its own view), then every GUI surface
    render(pass, ctx) {
        for (const h of this.instances) {
            if ((h.owner && h.owner === ctx.skip) || (h.visible && !h.visible(ctx))) continue;
            pass.mesh(h.mesh, h.first, h.count);
        }
        for (const g of this.guis) g.render(pass);
    }

    collide(p) {
        for (const e of this.world.entities) e.collide(p);
    }
}

return { WorldExtension };
});
