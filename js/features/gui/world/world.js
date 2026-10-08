'use strict';
// The world: builds the facility and its entities and runs them.

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { clamp, MeshBuilder, MAX_LIGHTS } = engine.kits.gui;
const { ENTITY_TYPES, TerminalGUI } = feature;

// The facility: entities built from scenario data, shared facility state and actions.

// Expanding rings for the phone radar (footsteps, drone pings, alarm, doors)
class SoundWaves {
    constructor(kinds) {
        this.kinds = kinds;         // kind -> { speed, life, color }
        this.list = [];
    }

    emit(kind, x, z, strength = 1) {
        const k = this.kinds[kind];
        this.list.push({
            kind, x, z, t0: performance.now() / 1000, life: k.life, color: k.color,
            speed: k.speed * (kind === 'step' ? strength : 1),
            alpha: kind === 'step' ? clamp(0.5 + strength * 0.35, 0, 1) : 0.8
        });
    }

    prune(t) {
        this.list = this.list.filter((w) => t - w.t0 < w.life);
    }
}

class World {
    constructor(game, scenario) {
        this.game = game;
        this.scenario = scenario;
        this.lightsOn = true;
        this.alarm = false;
        this.alarmPulse = 0;
        this.lampScale = 1;
        this.log = [...scenario.facility.log];
        this.waves = new SoundWaves(scenario.waves);
        this.entities = [];
        this.byId = new Map();
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
        for (const def of scenario.entities) kits.world.addEntity(this, ENTITY_TYPES, def, { spawn: false });
        this.guis = this.entities.flatMap((e) => e.guis);
    }

    init(renderer) {
        this.renderer = renderer;
        for (const e of this.entities) e.init(renderer);
        for (const g of this.guis) g.attach(this.game);
    }

    get(id) {
        const e = this.byId.get(id);
        if (!e) throw new Error(`No entity "${id}"`);
        return e;
    }

    ofType(Type) {
        return this.entities.filter((e) => e instanceof Type);
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
        const door = this.get(id);
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
        for (const e of this.entities) e.update(dt, t);
        this.waves.prune(t);
    }

    // Uniform inputs shared by every view this frame
    frameState(t) {
        const lights = [];
        for (const e of this.entities) e.lights(lights, t);
        while (lights.length < MAX_LIGHTS) lights.push([0, 0, 0, 0, 0, 0, 0, 0]);
        const f = this.game.scenario.facility || {};
        return { time: t, lightsOn: this.lightsOn, alarmPulse: this.alarmPulse, lights, fog: f.fog ?? 0.05, ambient: f.ambient ?? 0 };
    }

    writeInstances(renderer) {
        for (const h of this.instances) for (let i = 0; i < h.count; i++) renderer.setInstance(h.first + i, h.matrices[i], h.tints[i]);
        for (const g of this.guis) g.writeInstances(renderer);
    }

    // Draw the world into a scene pass: entity meshes (but an owner's in its own view), then every GUI surface (anchor + GUI)
    render(pass, ctx) {
        for (const h of this.instances) {
            if ((h.owner && h.owner === ctx.skip) || (h.visible && !h.visible(ctx))) continue;
            pass.mesh(h.mesh, h.first, h.count);
        }
        for (const g of this.guis) g.render(pass);
    }

    collide(p) {
        for (const e of this.entities) e.collide(p);
    }
}

return { World };
});
