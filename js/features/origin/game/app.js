'use strict';
// The app: the frame loop over world, origin, camera and renderer.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3 } = Common;
const {
    BODY_FLOATS, NEAR, quat, m4, Renderer, World, FloatingOrigin, Camera, Input, CameraController, Hud,
} = feature;

class App {
    constructor(fx) {
        this.fx = fx;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new Input(fx.io);
        this.hud = new Hud(fx.ui);
        this.camera = new Camera();
        this.controller = new CameraController(this.camera, this.input);
        this.density = 1;
        this.time = 0;
        this.paused = false;
        this.fps = 60;
        this.viewProj = new Float64Array(16);
    }

    async start() {
        await this.renderer.init();
        this.floating = new FloatingOrigin({}, this.renderer);
    }

    load(scenario, keepCamera = false) {
        const world = new World(scenario, this.renderer.device, this.density);
        if (this.world) this.world.destroy();
        this.world = world;
        this.scenario = scenario;
        this.renderer.setWorld(world);
        this.floating.cfg = { ...this.floating.cfg, ...(scenario.origin || {}) };
        this.floating.force = true;
        const camCfg = scenario.camera || {};
        this.camera.fov = (camCfg.fov || 60) * DEG;
        this.minAlt = camCfg.minAltitude ?? 1.7;
        this.lighting = { exposure: 1, sun: 1.6, ...(scenario.lighting || {}) };
        this.bookmarks = scenario.bookmarks || [];
        if (!keepCamera) {
            const b = this.bookmarks.find(b => b.key === scenario.start) || this.bookmarks[0];
            if (b) this.jump(b);
        }
    }

    jump(b) {
        const f = this.world.resolve(b.at), cam = this.camera;
        cam.pos = f.pos.clone();
        const up = quat.rotate(f.q, [0, 1, 0]);
        cam.q = b.look ? quat.look(v3.norm(this.world.get(b.look).pos.sub(cam.pos)), up) : f.q;
        cam.vel = [0, 0, 0];
        this.controller.speedExp = 0;
        this.hud.toast(b.name);
        this.fx.emit('jump', { name: b.name });
    }

    handleKeys(pressed) {
        const f = this.floating;
        for (const code of pressed) {
            const b = this.bookmarks.find(b => code === `Digit${b.key}` || code === `Numpad${b.key}`);
            if (b) { this.jump(b); continue; }
            switch (code) {
                case 'KeyT': f.translate = !f.translate; this.fx.emit('toggle', { on: f.translate }); this.hud.toast(f.translate ? 'Translation rebasing ON' : 'Translation rebasing OFF: origin pinned to world 0, float32 breaks down far away'); break;
                case 'KeyR': f.rotate = !f.rotate; this.fx.emit('toggle', { on: f.rotate }); this.hud.toast(f.rotate ? 'Rotation rebasing ON: origin +Y follows the local vertical' : 'Rotation rebasing OFF: origin axes = world axes'); break;
                case 'KeyG': f.scale = !f.scale; this.fx.emit('toggle', { on: f.scale }); this.hud.toast(f.scale ? 'Scale rebasing ON: units follow proximity' : 'Scale rebasing OFF: 1 unit = 1 m (use the wheel for speed)'); break;
                case 'KeyO': f.everyFrame = !f.everyFrame; this.fx.emit('toggle', { on: f.everyFrame }); this.hud.toast(f.everyFrame ? 'Rebasing every frame: cost stays one 80 B upload' : 'Rebasing on demand'); break;
                case 'KeyL': this.hud.showLabels = !this.hud.showLabels; break;
                case 'KeyP': this.paused = !this.paused; break;
                case 'BracketLeft': case 'BracketRight': {
                    const d = clamp(this.density * (code === 'BracketRight' ? 2 : 0.5), 1 / 16, 8);
                    if (d !== this.density) { this.density = d; this.load(this.scenario, true); this.hud.toast(`Field density ×${d}: ${this.world.instanceCount.toLocaleString()} instances`); }
                    break;
                }
            }
        }
    }

    // frame uniform: camera in origin space (doubles until the final f32 store)
    writeFrame(prox) {
        const r = this.renderer, o = this.floating.origin, cam = this.camera, F = r.frameData;
        const camO = o.toLocal(cam.pos), qO = quat.mul(quat.conj(o.q), cam.q), [X, Y, Z] = quat.axes(qO);
        const aspect = r.width / r.height, tanH = Math.tan(cam.fov / 2);
        this.viewProj = m4.mul(m4.reversedInfinite(cam.fov, aspect, NEAR), m4.view(qO, camO));
        F.set(this.viewProj, 0);
        F.set([camO[0], camO[1], camO[2], this.time % 3600], 16);
        F.set([-Z[0], -Z[1], -Z[2], NEAR], 20);
        F.set([X[0], X[1], X[2], tanH * aspect], 24);
        F.set([Y[0], Y[1], Y[2], tanH], 28);
        const sun = o.toLocal(this.world.sunPos);
        F.set([sun[0], sun[1], sun[2], 2 * tanH / r.height], 32);
        // sky: inside an atmosphere on the day side
        let sky = [0, 0, 0], starVis = 1;
        const b = prox.body;
        if (b && b.atmosphere) {
            const k = Math.pow(clamp(1 - prox.alt / b.atmosphere.height, 0, 1), 1.5);
            const upW = v3.norm(cam.pos.sub(b.pos)), sunW = v3.norm(this.world.sunPos.sub(cam.pos));
            const day = clamp((v3.dot(upW, sunW) + 0.15) / 0.4, 0, 1);
            sky = v3.mul(b.atmosphere.color, k * day * 0.9);
            starVis = 1 - clamp(k * day * 3, 0, 1);
        }
        F.set([sky[0], sky[1], sky[2], starVis], 36);
        F.set([this.lighting.exposure, this.lighting.sun, 0, 0], 40);
    }

    // update: input, camera, world, rebase; render: the frame. The host runs both, or (in a composition) the
    // camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        const r = this.renderer, w = this.world, f = this.floating;
        if (update) {
            if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
            if (!this.paused) this.time += dt;
            const io = this.input.consume();
            this.handleKeys(io.pressed);
            const near = w.proximity(this.camera.pos);
            if (!this.fx.cameraLocked) this.controller.update(dt, io, f.origin, near, this.minAlt, f.scale ? 6 : f.cfg.maxScaleExp);
            if (this.controller.atEdge) { this.controller.atEdge = false; this.hud.toast('Edge of the world: ±2^30 cells'); }
            w.update(dt, this.time);
            const count = f.stats.count;
            this.prox = f.update(this.camera.pos, w);         // O(1) rebase when needed
            if (f.stats.count !== count) this.fx.emit('rebase', { reason: f.stats.reason, scale: f.origin.scale });
        }
        if (!render) return;
        const prox = this.prox ||= f.update(this.camera.pos, w);
        r.resize();
        this.writeFrame(prox);
        w.bodies.forEach((b, i) => b.pack(r.bodyData, i * BODY_FLOATS, f.origin, this.camera.pos));
        r.render(w, w.bodies.length);
        this.hud.drawLabels(this);
        this.hud.update(this, prox, now);
    }
}

return { App };
});
