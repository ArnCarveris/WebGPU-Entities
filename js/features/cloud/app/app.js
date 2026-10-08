'use strict';
// The app: owns the world, the camera and the settings, and runs the frame (update, then render) through its parts:
// menus, the cloud picker, the commands, keys, doors, the camera's surroundings, sound events, lights and the frame
// uniform.

Features.part('cloud', (engine, feature) => {
const { GpuChoice, Common, kits } = engine;
const { clamp, v3, PointerInput } = Common;
const { FirstPersonView } = kits.view;
const SLOW_ALT = { keys: ['AltLeft'], factor: 0.2 };       // Alt held: a fifth of the speed
const {
    SPLASH_PARTICLES, RENDER_DEFAULTS, QUALITY, FRAME_BUDGET, World, Renderer, Walker, Hud, AppMenus, CloudPicker, Controls,
    KeyCommands, DoorControl, Surroundings, SoundEvents, LightWriter, FrameWriter,
} = feature;

// Dynamic resolution: the volumetric scale between the preset's (q.scale) and its floor (q.dynamic), stepped by 0.05 to
// keep the GPU time per frame (the profiler's, smoothed) under FRAME_BUDGET. Down at once by as much as the overshoot
// needs (the volumetrics cost about the scale squared); up a step only when that estimate of the next step's cost (an
// overestimate: part of the frame does not scale) still leaves a margin, and at most every half second, so it settles
// instead of hunting. Dense weather (snow squalls, downpours) is soft: a lower scale hardly shows.
class DynamicScale {
    constructor() { this.scale = 0; this.at = -1e9; }
    update(q, gpuMs, now) {
        if (!this.scale || this.scale > q.scale || this.scale < q.dynamic) this.scale = q.scale;
        if (gpuMs > 0 && now - this.at > 0.5) {
            let s = this.scale;
            if (gpuMs > FRAME_BUDGET) s = Math.floor(s * Math.sqrt(FRAME_BUDGET / gpuMs) * 20) / 20;
            else if (gpuMs * ((s + 0.05) / s) ** 2 < FRAME_BUDGET * 0.95) s = s + 0.05;
            s = Math.min(q.scale, Math.max(q.dynamic, Math.round(s * 20) / 20));
            if (s !== this.scale) { this.scale = s; this.at = now; }
        }
        return this.scale;
    }
}

class App {
    constructor(fx) {
        this.fx = fx;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new PointerInput(fx.io);
        this.hud = new Hud(fx.ui);
        this.camera = new FirstPersonView({ pos: [0, 3000, 0], speed: 400, wheel: { step: 1.25, min: 5, max: 20000 }, clearance: 1.5, ceiling: 25000, slow: SLOW_ALT });
        this.walker = new Walker();
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
        this.clouds = new CloudPicker(this);
        this.controls = new Controls(this);
        this.keys = new KeyCommands(this);
        this.doors = new DoorControl(this);
        this.surroundings = new Surroundings(this);
        this.sounds = new SoundEvents(this);
        this.lights = new LightWriter(this);
        this.frameWriter = new FrameWriter(this);
        this.dynamicScale = new DynamicScale();
    }

    async start() {
        GpuChoice.probe();
        await this.renderer.init();
    }

    load(scenario) {
        const world = new World(scenario);
        this.world = world;
        // thunder from each flash, timed by its distance from the camera then
        world.lightning.onStrike = f => { const [lo, hi] = world.lightning.reach(f, this.camera.pos); this.fx.emit('thunder', { near: lo, far: hi, bolt: !!f.bolt }); };
        this.scenario = scenario;
        this.cfg = { ...RENDER_DEFAULTS, ...(scenario.render || {}) };
        this.quality = clamp(this.cfg.quality, 0, QUALITY.length - 1);
        this.timeScale = this.cfg.timeScale;
        this.radar = this.cfg.radar ?? false;       // off unless the scenario wants it: the screen stays clean
        this.renderer.setWorld(world);
        this.clouds.reset(world);
        const L = scenario.lighting || {};
        this.lightPresets = L.presets || { default: {} };
        this.lightNames = Object.keys(this.lightPresets);
        this.controls.setLight(this.lightPresets[L.start] ? L.start : this.lightNames[0]);
        this.views = scenario.views || [];
        this.viewIndex = 0;
        this.walker = new Walker();
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
            if (!this.paused) w.lightning.around(w, this.camera.pos, dt);
            // on foot after the bus has moved, so a rider's eye is where the bus is this frame
            if (this.walker.active && !locked) this.walker.update(dt, io, this.input, this);
            this.doors.update(dt, io);
            if (v3.len(v3.sub(before, this.camera.pos)) > 3000) this.reset = true;
            this.surroundings.update();
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
        const particles = total > 0.005 ? fw.splashStart + (this.near.rain > 0.02 ? SPLASH_PARTICLES : 0) : 0;
        r.render(enc, fw.probeTexel, particles, w.lightning.count, QUALITY[this.quality].interleave, fw.shadowSlices, this.froxels, this.mode !== 1, this.tiles, this.bloom && this.cfg.bloom > 0);
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
