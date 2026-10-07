'use strict';
// The app: the simulation and render loop, input and the camera.

Features.part('water', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, clamp, v3, m4, PointerInput } = Common;
const { FirstPersonView } = kits.view;
const SLOW_ALT = { keys: ['AltLeft'], factor: 0.2 };       // Alt held: a fifth of the speed
const {
    NEAR, RENDER_MODES, WATER_DEFAULTS, Dam, World, FlowSim, WaveCascade, DebrisSystem, Renderer, TOOL_TYPES, Hud,
} = feature;

class App {
    constructor(fx) {
        this.fx = fx;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new PointerInput(fx.io);
        this.hud = new Hud(fx.ui);
        this.camera = new FirstPersonView({ pos: [0, 200, 0], speed: 80, wheel: { step: 1.2, min: 2, max: 2000 }, clearance: 2, slow: SLOW_ALT });
        this.time = 0;
        this.paused = false;
        this.fps = 60;
        this.mode = 0;
        this.brush = 20;
        this.extraSources = [];
        this.viewProj = new Float32Array(16);
        this.frameNo = 0;
    }

    async start() { await this.renderer.init(); }

    load(scenario) {
        const d = this.renderer.device;
        const world = new World(scenario);
        const flow = new FlowSim(d, world);
        const waves = new WaveCascade(d, flow, scenario.waves);
        const debris = new DebrisSystem(d, flow, world);
        Object.assign(this, { world, flow, waves, debris, scenario });
        this.renderer.setSim(world, flow, waves, debris);
        this.stepsPerFrame = flow.cfg.stepsPerFrame;
        this.water = { ...WATER_DEFAULTS, ...(scenario.water || {}) };
        this.tools = (scenario.tools || []).filter(t => TOOL_TYPES[t.type]).map(t => TOOL_TYPES[t.type](t));
        this.tool = this.tools[0] || null;
        const L = scenario.lighting || {};
        this.lightNames = Object.keys(L).filter(k => typeof L[k] === 'object');
        this.setLight(L.start && L[L.start] ? L.start : this.lightNames[0]);
        this.views = scenario.views || [];
        this.viewIndex = 0;
        if (this.views[0]) this.jump(this.views[0]);
    }

    setLight(name) {
        const p = (this.scenario.lighting || {})[name] || {};
        const sun = p.sun || {}, az = (sun.azimuth ?? 150) * DEG, el = (sun.elevation ?? 40) * DEG;
        this.lightName = name || 'default';
        this.light = {
            dir: [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)],
            color: sun.color || [1, 0.95, 0.85], intensity: sun.intensity ?? 3,
            top: p.sky?.top || [0.22, 0.42, 0.78], horizon: p.sky?.horizon || [0.62, 0.74, 0.86],
            ground: p.ground || [0.24, 0.22, 0.18], ambient: p.ambient ?? 0.9, fog: p.fog ?? 0.00025, exposure: p.exposure ?? 1,
        };
    }

    jump(v) {
        this.camera.pos = [...v.pos];
        if (v.look) this.camera.lookAt(v.look);
        this.hud.toast(v.name);
    }

    handleKeys(pressed) {
        const w = this.world;
        for (const code of pressed) {
            const t = this.tools.find(t => code === `Digit${t.key}` || code === `Numpad${t.key}`);
            if (t) { this.tool = t; this.fx.emit('tool', { name: t.name }); continue; }
            switch (code) {
                case 'BracketLeft': case 'BracketRight':
                    this.brush = clamp(this.brush * (code === 'BracketRight' ? 1.25 : 0.8), 4, 200);
                    break;
                case 'KeyB': w.boost = !w.boost; this.fx.emit('toggle', { on: w.boost }); this.hud.toast(w.boost ? 'Springs boosted' : 'Springs normal'); break;
                case 'KeyR': w.rainOn = !w.rainOn; this.fx.emit('toggle', { on: w.rainOn }); this.hud.toast(w.rainOn ? 'Rain' : 'Rain stopped'); break;
                case 'KeyX': {
                    const dams = w.entities.filter(e => e instanceof Dam);
                    if (!dams.length) { this.hud.toast('No dams in this scenario'); break; }
                    const on = dams.map(d => d.toggle())[0];
                    this.fx.emit('breach', { on });
                    this.hud.toast(on ? 'Dam breached!' : 'Dam rebuilt');
                    break;
                }
                case 'KeyN': this.flow.reset(); this.waves.reset(); this.fx.emit('reset'); this.hud.toast('Water reset'); break;
                case 'KeyM': this.mode = (this.mode + 1) % RENDER_MODES.length; this.hud.toast(`Render: ${RENDER_MODES[this.mode]}`); break;
                case 'KeyV': if (this.views.length) { this.viewIndex = (this.viewIndex + 1) % this.views.length; this.jump(this.views[this.viewIndex]); } break;
                case 'KeyG': {
                    const i = (this.lightNames.indexOf(this.lightName) + 1) % this.lightNames.length;
                    this.setLight(this.lightNames[i]);
                    this.hud.toast(`Lighting: ${this.lightName}`);
                    break;
                }
                case 'Comma': case 'Period':
                    this.stepsPerFrame = clamp(this.stepsPerFrame + (code === 'Period' ? 8 : -8), 0, 256);
                    this.hud.toast(`${this.stepsPerFrame} sim steps per frame`);
                    break;
                case 'KeyL': this.hud.showLabels = !this.hud.showLabels; break;
                case 'KeyP': this.paused = !this.paused; break;
            }
        }
    }

    writeFrame(hit) {
        const r = this.renderer, F = r.frameData, cam = this.camera, f = this.world.field, L = this.light, wt = this.water;
        const aspect = r.width / r.height, tanY = Math.tan(cam.fov / 2), tanX = tanY * aspect;
        const { fwd, right, up } = cam.basis();
        this.viewProj = m4.mul(m4.reversedInfinite(cam.fov, aspect, NEAR), m4.view(cam.pos, right, up, fwd));
        F.set(this.viewProj, 0);
        F.set([...cam.pos, this.time % 3600], 16);
        F.set([...fwd, NEAR], 20);
        F.set([...v3.mul(right, tanX), 0], 24);
        F.set([...v3.mul(up, tanY), 0], 28);
        F.set([...L.dir, L.intensity], 32);
        F.set([...L.color, L.exposure], 36);
        F.set([...L.top, L.fog], 40);
        F.set([...L.horizon, f.max + 5], 44);
        F.set([...L.ground, L.ambient], 48);
        F.set([f.origin, f.origin, f.cell, f.n], 52);
        F.set([r.width, r.height, this.flow.cfg.minDepth, this.mode], 56);
        F.set([...wt.deep, wt.foam], 60);
        F.set([...wt.absorb, wt.refraction], 64);
        F.set(hit ? [hit[0], hit[2], this.brush, 1] : [0, 0, 0, 0], 68);
        F.set([this.waves.layers.length, wt.detail, this.world.snowLine, this.world.seaLevel ?? -1e4], 72);
        this.waves.layers.forEach((l, i) => {
            const cur = l.slotOrigin[l.newest], old = l.slotOrigin[1 - l.newest];
            F.set([cur[0], cur[1], l.size, l.lerpK ?? 1], 76 + i * 4);
            F.set([old[0], old[1], l.newest, 0], 92 + i * 4);
        });
        F.set([wt.flowScale, 0, 0, 0], 108);
    }

    // update: input, camera, tools, world, sim; render: the frame. The host runs both, or (in a composition) the
    // camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        const r = this.renderer, w = this.world, flow = this.flow, d = r.device;
        if (update) {
            if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
            if (!this.paused) this.time += dt;
            const io = this.input.consume();
            this.handleKeys(io.pressed);
            if (!this.fx.cameraLocked) this.camera.control(dt, io, this.input.keys, this.fx.floor);

            // cursor ray -> terrain, tools
            const rect = this.canvas.getBoundingClientRect();
            const mx = this.input.mouse[0] - rect.left, my = this.input.mouse[1] - rect.top;
            const hit = this.hit = w.field.raycast(this.camera.pos, this.camera.ray(mx, my, rect.width, rect.height));
            this.extraSources = [];
            this.acting = !!(hit && this.input.acting && this.tool && !this.paused);
            if (this.acting) this.tool.apply(this, hit, dt);

            if (!this.paused) w.update(dt, this.time);
            if (w.field.dirty) flow.uploadTerrain();
            this.simDt = dt;
        }
        if (!render) return;
        r.resize();
        const enc = d.createCommandEncoder();
        if (!this.paused) {
            const dts = this.simDt ?? dt;
            let steps = this.stepsPerFrame;
            if (flow.warmupLeft > 0) { const extra = Math.min(flow.warmupLeft, 600); flow.warmupLeft -= extra; steps += extra; }
            flow.writeParams(w.gather(), this.extraSources, this.frameNo++);
            flow.encode(enc, steps);
            this.waves.encode(enc, dts, this.camera.pos, this.water.flowScale);
            this.debris.encode(enc, dts * this.water.flowScale, this.time);
        }
        this.simDt = null;
        this.writeFrame(this.hit);
        r.render(enc);
        d.queue.submit([enc.finish()]);
        flow.afterSubmit();
        this.hud.drawLabels(this);
        this.hud.update(this, now);
    }
}

return { App };
});
