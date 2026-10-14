'use strict';
// The app: owns the world, the camera and the settings, and runs the frame (update, then render) through its parts:
// its own (menus, commands, keys, HUD), the kits' (the settlement kit's walker, doors and sound events, the building
// kit's lifts, this kit's surroundings, lights, frame uniform and renderer, the gpu kit's dynamic resolution), for which
// it is the host (world, camera, walker, renderer, settings, fx), and what a world type composes in: its extensions.
//
// AppExtension: a class built with the app (new E(app)), kept as app.ext[E.key]; each hook optional: load(world) (a
// new world), update(dt, io) (each frame, after the world's update), key(code) / click(hit) (KeyCommands), beforeJump /
// afterJump(v, e) (Controls.jump), syncMenus() (AppMenus), page(id) (phonePages), air() / label(e, d) (Hud), stats(out)
// and set(key, v) (the host's, through AtmosphereWorld).

Features.kit('atmosphere', (engine, kit) => {
const { GpuChoice, Common, kits } = engine;
const { clamp, v3, PointerInput } = Common;
const { FirstPersonView } = kits.view;
const SLOW_ALT = { keys: ['AltLeft'], factor: 0.2 };       // Alt held: a fifth of the speed
const { Hud, AppMenus, Controls, KeyCommands, SPLASH_PARTICLES, RENDER_DEFAULTS, QUALITY, FRAME_BUDGET, Renderer, Surroundings, LightWriter, FrameWriter } = kit;
const { Walker, DoorControl, SoundEvents, DOOR_REACH } = kits.settlement;
const { LiftControl } = kits.building;
const { DynamicScale } = kits.gpu;

class App {
    // the world-space GUIs drawn this frame (FrameWriter): the lifts' panels
    get panels() { return this.liftControl.shown; }

    // world(scenario): the world (World, with the world type's extensions); extensions: AppExtension classes; title: the
    // readout's
    constructor(fx, { world, extensions = [], title = 'ENTITIES' }) {
        this.fx = fx;
        this.createWorld = world;
        this.title = title;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new PointerInput(fx.io);
        this.hud = new Hud(fx.ui);
        this.camera = new FirstPersonView({ pos: [0, 3000, 0], speed: 400, wheel: { step: 1.25, min: 5, max: 20000 }, clearance: 1.5, ceiling: 25000, slow: SLOW_ALT });
        this.walker = new Walker();
        this.drive = new kits.transit.DriveControl(this);     // F: at the wheel of a bus
        this.time = 0;
        this.weatherTime = 0;
        this.paused = false;
        this.fps = 60;
        this.mode = 0;
        this.radar = false;          // R, or the handheld: the storm radar over the view (render.radar)
        this.flashlight = false;     // L: a torch in hand, along the view
        this.froxels = true;
        this.tiles = true;
        this.bloom = true;           // O
        this.busFast = false;        // the buses' ×10 latched from the bus menu (else while Z is held)
        this.frameNo = 0;
        this.reset = true;
        // where the camera is (Surroundings)
        this.near = { rain: 0, snow: 0 };
        this.sheltered = false;
        this.flashVeil = 0;
        this.probe = { coverage: 0, top: 0, precip: 0, virga: 0, cover: 0 };
        // its parts
        this.menus = new AppMenus(this);
        this.ext = {};
        this.extensions = extensions.map(E => (this.ext[E.key] = new E(this)));
        this.controls = new Controls(this);
        this.keys = new KeyCommands(this);
        this.doors = new DoorControl(this, { moved: () => { this.renderer.writeDoors(this.world.structures.doors.mesh()); this.renderer.writeBuildings(this.world.structures.buildings); } });
        this.liftControl = new LiftControl(this, { reach: DOOR_REACH, cars: () => this.frameWriter.roomVis?.cars, view: () => this.frameWriter.view() });
        this.surroundings = new Surroundings(this);
        this.sounds = new SoundEvents(this);
        this.lights = new LightWriter(this);
        this.frameWriter = new FrameWriter(this);
        // the portal visibility's inspector (the building kit's RoomVis has one: floor map, traversal, frames): a tap on
        // the map walks (or flies) the camera there, onto the floor of the area tapped
        this.inspect = { map: { teleport: (x, z, area) => {
            const A = this.world.structures.areas.areas[area], y = A ? A.y : this.camera.pos[1] - (this.walker.active ? 1.62 : 0);
            if (this.walker.active) this.walker.place(this, x, z, y + 0.05);
            else this.camera.pos = [x, y + 1.62, z];
        } } };
        this.dynamicScale = new DynamicScale(FRAME_BUDGET);
    }

    async start() {
        GpuChoice.probe();
        await this.renderer.init();
    }

    load(scenario) {
        const world = this.createWorld(scenario);
        this.world = world;
        // thunder from each flash, timed by its distance from the camera then
        world.lightning.onStrike = f => { const [lo, hi] = world.lightning.reach(f, this.camera.pos); this.fx.emit('thunder', { near: lo, far: hi, bolt: !!f.bolt }); };
        this.scenario = scenario;
        this.cfg = { ...RENDER_DEFAULTS, ...(scenario.render || {}) };
        this.quality = clamp(this.cfg.quality, 0, QUALITY.length - 1);
        this.timeScale = this.cfg.timeScale;
        this.radar = this.cfg.radar ?? false;       // off unless the scenario wants it: the screen stays clean
        this.renderer.setGui(this.cfg.gui || {});
        this.renderer.setWorld(world);
        for (const x of this.extensions) x.load?.(world);
        const L = scenario.lighting || {};
        this.lightPresets = L.presets || { default: {} };
        this.lightNames = Object.keys(this.lightPresets);
        this.controls.setLight(this.lightPresets[L.start] ? L.start : this.lightNames[0]);
        this.views = scenario.views || [];
        this.viewIndex = 0;
        this.walker = new Walker();
        this.drive.vehicle = null;
        if (this.views[0]) this.controls.jump(this.views[0]);
        this.reset = true;
    }

    // update: input, camera, weather, buses, doors, what falls on the camera; render: the frame. The host runs both, or
    // (in a composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        const r = this.renderer, w = this.world, locked = this.fx.cameraLocked;
        if (update) {
            if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
            const io = this.input.consume();
            this.keys.handle(io.pressed);
            this.keys.clicks(io.clicks);
            const before = this.lastCam || [...this.camera.pos];
            if (!this.walker.active && !locked) this.camera.control(dt, io, this.input.keys, this.fx.floor);
            this.keys.sun(dt);

            const wdt = this.wdt = this.paused ? 0 : dt * this.timeScale;
            if (!this.paused) { this.time += dt; this.weatherTime += wdt; }
            w.busBoost = this.busFast || this.input.keys.has('KeyZ') ? 10 : 1;     // hold Z (or the bus menu): the buses run ten times as fast
            w.update(this.paused ? 0 : dt, wdt, this.time);
            for (const x of this.extensions) x.update?.(dt, io);
            // on foot after the bus has moved, so a rider's eye is where the bus is this frame
            if (this.walker.active && !locked) this.walker.update(dt, io, this.input, this);
            this.drive.update(this.input.keys);
            this.liftControl.update(dt, io, now);
            this.doors.update(dt, io);
            if (v3.len(v3.sub(before, this.camera.pos)) > 3000) this.reset = true;
            this.surroundings.update(dt);
            this.sounds.update();
        }
        if (!render) return;
        // the volumetric resolution: the preset's, or lower while the GPU time is over budget (a resize keeps the history)
        const q = QUALITY[this.quality];
        r.resize(q.dynamic && r.profiler.enabled ? this.dynamicScale.update(q, r.profiler.total, this.time) : q.scale);
        const fw = this.frameWriter;
        fw.write(dt, this.wdt ?? 0);
        const enc = r.device.createCommandEncoder();
        const total = this.near.rain + this.near.snow;
        const particles = total > 0.001 ?fw.splashStart + (this.near.rain > 0.02 ? SPLASH_PARTICLES : 0) : 0;
        // (from inside, with the outdoors out of sight through the portals: no volumetrics, no rain)
        const out = fw.outdoors?.seen !== false;
        r.render(enc, fw.probeTexel, out ? particles : 0, w.lightning.count, QUALITY[this.quality].interleave, fw.shadowSlices, this.froxels && out, this.mode !== 1 && out, this.tiles, this.bloom && this.cfg.bloom > 0);
        r.device.queue.submit([enc.finish()]);
        r.weatherPass.afterSubmit();
        r.profiler.afterSubmit();
        fw.advance();
        this.lastCam = [...this.camera.pos];
        this.frameNo++;
        this.reset = false;
        this.hud.drawLabels(this);
        this.hud.update(this, now);
    }
}

return { App };
});
