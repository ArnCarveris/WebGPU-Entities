'use strict';
// The atmosphere's AppExtension (the one App, kits.world): owns the world, the camera and the settings, and runs the frame (update, then render) through its parts:
// its own (menus, commands, keys, HUD, the walker and its footsteps, surroundings, lights, frame uniform and renderer,
// the gpu kit's dynamic resolution), for which it is the host (world, camera, walker, renderer, settings, fx), and what is
// composed in: its extensions, the features' on in the world (their extensions.app: the structures' doors and lifts, the
// buses' wheel), then the world type's. The features' WorldExtensions (extensions.world) go to the world it makes.
//
// AppExtension: a class built with the app (new E(app)), kept as app.ext[E.key]; each hook optional: configure(cfg)
// (the scenario's render settings, before the renderer takes the world), load(world) (a new world), update(dt, io) (each
// frame, after the world's update), afterWalk(dt, io, now) (after the walker moved), sounds() (the frame's sound events),
// key(code) / click(hit) (KeyCommands), beforeJump / afterJump(v, e) (Controls.jump), syncMenus() (AppMenus), page(id)
// (phonePages), air() / lines() / label(e, d) (Hud), stats(out) and set(key, v) (the host's, through atmosphereWorld); the
// frame's: draws(fw, view), cabin(), shelter(fw, F, o) (FrameWriter), surround(p), shelters(p, dir) (Surroundings),
// lights(all, cam), lightMasks(lights, mask), writeFar(F, night, adapt), farLights(out) (LightWriter).

Features.kit('atmosphere', (engine, kit) => {
const { GpuChoice, Common, kits } = engine;
const { clamp, smoothstep, v3, PointerInput } = Common;
const { FirstPersonView } = kits.view;
const SLOW_ALT = { keys: ['AltLeft'], factor: 0.2 };       // Alt held: a fifth of the speed
const { Hud, AppMenus, Controls, KeyCommands, SPLASH_PARTICLES, RENDER_DEFAULTS, QUALITY, FRAME_BUDGET, RendererExtension, Surroundings, LightWriter, FrameWriter,
    Walker, Footsteps } = kit;
const { DynamicScale, Renderer } = kits.gpu;

class AppExtension {
    static key = 'atmosphere';
    // what it answers on the App (Common.Composite)
    static exposes = ['airAt', 'airHere', 'airHides', 'airShell', 'bloom', 'busFast', 'camera', 'canvas', 'cfg',
        'controls', 'doors', 'drive', 'flashVeil', 'flashlight', 'forceIndoors', 'fps', 'frame', 'frameNo',
        'frameWriter', 'froxels', 'fx', 'hud', 'inBus', 'indoors', 'input', 'inspect', 'keys', 'liftControl',
        'lightName', 'lightNames', 'lightPresets', 'lights', 'load', 'menus', 'mode', 'near', 'nearBus', 'paused',
        'probe', 'quality', 'radar', 'radarTop', 'renderer', 'reset', 'rideBus', 'rideCar', 'scenario', 'sheltered',
        'start', 'sun', 'sunAlong', 'tiles', 'time', 'timeScale', 'title', 'viewIndex', 'views', 'walker',
        'weatherTime', 'world'];

    // world(scenario): the world (World, with the world type's extensions); extensions: AppExtension classes; title: the
    // readout's
    constructor(app, fx, { world, extensions = [], title = 'ENTITIES' }) {
        this.app = app;
        this.fx = fx;
        this.createWorld = world;
        this.title = title;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(RendererExtension, fx);
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
        this.menus = new AppMenus(this.app);
        this.ext = {};
        this.worldExtensions = kits.gpu.extensionsOf(fx.features, 'world');
        app.compose([...kits.gpu.extensionsOf(fx.features, 'app'), ...extensions]);
        this.controls = new Controls(this.app);
        this.keys = new KeyCommands(this.app);
        this.surroundings = new Surroundings(this.app);
        this.footsteps = new Footsteps(this.app);
        this.lights = new LightWriter(this.app);
        this.frameWriter = new FrameWriter(this.app);
        this.dynamicScale = new DynamicScale(FRAME_BUDGET);
    }

    // how much of its air there is at p (1 all of it; render.airTop: the height over its ground's reference where it ends
    // and space begins, thinning out over render.airFade below it, by default a third of it; unset, it never ends)
    airAt(p) {
        const top = this.cfg?.airTop;
        if (!(top > 0) || !this.world) return 1;
        const fade = Math.max(this.cfg.airFade ?? top / 3, 1);
        return smoothstep(top, top - fade, this.world.curvature.altitude(p));
    }

    // how much its air hides, from an eye at p, a point d m away along dir (unit): nothing short of where the view ray
    // leaves its air (render.airTop, over the planet as drawn: the shell about the centre R + the eye's height below
    // it); past that, in space, what its sky hides (all of it by day, thinning out with the air about the eye, airAt;
    // nothing by night or under the moon: the night sky shows what lies beyond), or, past the planet, all of it. 0 .. 1;
    // 0 with no airTop
    airHides(p, dir, d) {
        const top = this.cfg?.airTop, sun = this.sun;
        if (!(top > 0) || !this.world || !sun) return 0;
        const air = this.airAt(p);
        if (air <= 0) return 0;
        const c = this.world.curvature, h = p[1] - c.reference;
        let out = Infinity, under = false;
        if (c.on) {
            // |(0, K, 0) + t dir| = r: t = -b ± sqrt(b² - K² + r²); the air's far side, and the ground's near one first
            const R = c.radius, K = R + h, b = K * dir[1], g = b * b - K * K + R * R;
            out = -b + Math.sqrt(Math.max(b * b - K * K + (R + top) * (R + top), 0));
            under = h > 0 && b < 0 && g >= 0;
        } else if (dir[1] > 0) out = (top - h) / dir[1];
        if (!(d > out)) return 0;
        if (under) return 1;
        return this.daySky() * air;
    }

    // how much its sky hides what lies beyond it: all by day, none by night or under the moon
    daySky() { const s = this.sun; return s.moon > 0 ? 0 : smoothstep(-0.1, 0.05, Math.sin(s.elevation)); }

    // airHides for the GPU (Renderer.encodeInject: the other worlds beyond its air drop out where its sky hides them):
    // [on (round), K (R + the eye's height), C ((R + top)² - K², exactly), top - height (flat)] and how much it hides
    // there (null: nothing, no airTop)
    airShell(p) {
        const top = this.cfg?.airTop;
        if (!(top > 0) || !this.world || !this.sun) return null;
        const c = this.world.curvature, h = p[1] - c.reference, R = c.radius;
        return { shell: [c.on ? 1 : 0, R + h, (top - h) * (2 * R + top + h), top - h], hides: this.daySky() * this.airAt(p) };
    }

    async start() {
        GpuChoice.probe();
        await this.renderer.init();
    }

    load(scenario) {
        // the ground the composition's other worlds cover (fx.footprints): its terrain makes room under each (bare clearings,
        // after its own stamps): a world with its own ground to its edges sinks the terrain inside them a little below its
        // lowest ground, the terrain meeting them at its own height; a building gets a pad at its floor
        const room = (this.fx.footprints || []).map(fp => ({
            type: 'clearing', label: '', pos: fp.pos, size: fp.size, yaw: fp.yaw, inset: fp.ground, bare: true,
            level: fp.floor - (fp.ground ? Math.max(2, 0.005 * Math.max(...fp.size)) : 0.05),
            blend: fp.ground ? clamp(0.12 * Math.min(...fp.size), 100, 300) : 150,
        }));
        if (room.length) scenario = { ...scenario, entities: [...(scenario.entities || []), ...room] };
        const world = this.createWorld(scenario, this.worldExtensions);
        this.world = world;
        // thunder from each flash, timed by its distance from the camera then
        world.lightning.onStrike = f => { const [lo, hi] = world.lightning.reach(f, this.camera.pos); this.fx.emit('thunder', { near: lo, far: hi, bolt: !!f.bolt }); };
        this.scenario = scenario;
        this.cfg = { ...RENDER_DEFAULTS, ...(scenario.render || {}) };
        this.quality = clamp(this.cfg.quality, 0, QUALITY.length - 1);
        this.timeScale = this.cfg.timeScale;
        this.radar = this.cfg.radar ?? false;       // off unless the scenario wants it: the screen stays clean
        this.app.each('configure', this.cfg);
        this.renderer.setWorld(world);
        this.app.each('load', world);
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
            this.keys.keyboard(io.pressed);
            this.keys.clicks(io.clicks);
            const before = this.lastCam || [...this.camera.pos];
            if (!this.walker.active && !locked) this.camera.control(dt, io, this.input.keys, this.fx.floor);

            const wdt = this.wdt = this.paused ? 0 : dt * this.timeScale;
            if (!this.paused) { this.time += dt; this.weatherTime += wdt; }
            w.busBoost = this.busFast ? 10 : 1;     // the bus menu's ×10: the buses run ten times as fast
            w.update(this.paused ? 0 : dt, wdt, this.time);
            this.app.each('update', dt, io);
            // on foot after the bus has moved, so a rider's eye is where the bus is this frame
            if (this.walker.active && !locked) this.walker.update(dt, io, this.input, this.app);
            this.app.each('afterWalk', dt, io, now);
            if (v3.len(v3.sub(before, this.camera.pos)) > 3000) this.reset = true;
            this.surroundings.update(dt);
            this.app.each('sounds');
            this.footsteps.update();
        }
        if (!render) return;
        // above its air (airAt), nothing of it: only what lies behind it (Renderer.encodeSpace)
        const air = this.airHere = this.airAt(this.camera.pos);
        if (air <= 0) {
            const enc = r.device.createCommandEncoder();
            r.encodeSpace(enc, 1, true);
            r.device.queue.submit([enc.finish()]);
            this.lastCam = [...this.camera.pos];
            this.frameNo++;
            this.hud.drawLabels(this.app);
            this.hud.update(this.app, now);
            return;
        }
        // the volumetric resolution: the preset's, or lower while the GPU time is over budget (a resize keeps the history)
        const q = QUALITY[this.quality];
        r.resize(q.dynamic && r.profiler.enabled ? this.dynamicScale.update(q, r.profiler.total, this.time) : q.scale);
        const fw = this.frameWriter;
        fw.write(dt, this.wdt ?? 0);
        const enc = r.device.createCommandEncoder();
        const total = this.near.rain + this.near.snow;
        const particles = total > 0.001 ?fw.splashStart + (this.near.rain > 0.02 ? SPLASH_PARTICLES : 0) : 0;
        // (from inside, with the outdoors out of sight through the portals: no volumetrics, no rain; FrameWriter.outdoors)
        const out = fw.outdoors?.seen !== false;
        r.air = this.airShell(this.camera.pos);
        r.render(enc, fw.probeTexel, out ? particles : 0, w.lightning.count, QUALITY[this.quality].interleave, fw.shadowSlices, this.froxels && out, this.mode !== 1 && out, this.tiles, this.bloom && this.cfg.bloom > 0);
        if (air < 1) r.encodeSpace(enc, 1 - air);
        r.device.queue.submit([enc.finish()]);
        r.weatherPass.afterSubmit();
        r.profiler.afterSubmit();
        fw.advance();
        this.lastCam = [...this.camera.pos];
        this.frameNo++;
        this.reset = false;
        this.hud.drawLabels(this.app);
        this.hud.update(this.app, now);
    }
}

return { AppExtension };
});
