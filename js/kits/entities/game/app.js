'use strict';
// The origin's AppExtension (the one App, kits.world): the frame loop over world, origin, camera and renderer.

Features.world('origin', (engine, kit) => {
const { Common } = engine;
const { DEG, clamp, v3, PointerInput } = Common;
const { hurricaneData } = engine.kits.weather;
const { BODY_FLOATS, MAX_COVERS, MAX_STORMS, NEAR, quat, m4, RendererExtension, WorldExtension, FloatingOrigin, Camera, CameraController, Hud } = kit;
// how much brighter a sunlit body reads to the night-adapted eye under the air (the full Moon a white, slightly
// overexposed disc with its maria still showing)
const NIGHT_EYE = 8;
const NO_CLOUDS = { coverage: 0, base: 0, top: 0, air: 0, reach: 0, storms: [] };     // a site's that makes none (Site.clouds: null)

class AppExtension {
    static key = 'origin';
    // what it answers on the App (Common.Composite)
    static exposes = ['bookmarks', 'camera', 'canvas', 'controller', 'density', 'floating', 'fps', 'frame', 'fx',
        'handleKeys', 'hud', 'input', 'jump', 'lighting', 'load', 'paused', 'prox', 'renderer', 'scenario', 'start',
        'siteOn', 'siteStorm', 'standing', 'time', 'viewProj', 'world', 'writeCovers', 'writeStorms'];
    constructor(app, fx) {
        this.app = app;
        this.fx = fx;
        this.canvas = fx.canvas;
        this.renderer = fx.renderer.extend(RendererExtension, fx);
        this.input = new PointerInput(fx.io, { act: false });
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
        // (a reload, the field density changed: the one World rebuilt in place)
        if (this.world) this.world.destroy();
        const world = this.fx.world.reset().extend(WorldExtension, scenario, this.renderer.device, this.density);
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

    // the commands, named by the key codes they once had: the handheld's pages run them (the keyboard has none)
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
        // (in a shared frame its depth is in metres, every kit's: the near plane in origin units is the frame's over the
        // origin's scale, so the scale never reaches the depth)
        const near = r.frameSpec?.shared ? r.frameSpec.near / o.scale : NEAR;
        this.viewProj = m4.mul(m4.reversedInfinite(cam.fov, aspect, near), m4.view(qO, camO));
        F.set(this.viewProj, 0);
        F.set([camO[0], camO[1], camO[2], this.time % 3600], 16);
        F.set([-Z[0], -Z[1], -Z[2], near], 20);
        F.set([X[0], X[1], X[2], tanH * aspect], 24);
        F.set([Y[0], Y[1], Y[2], tanH], 28);
        const sun = o.toLocal(this.world.sunPos);
        F.set([sun[0], sun[1], sun[2], 2 * tanH / r.height], 32);
        // sky: inside an atmosphere on the day side
        let sky = [0, 0, 0], starVis = 1, eye = 1;
        const b = prox.body;
        if (b && b.atmosphere) {
            const k = Math.pow(clamp(1 - prox.alt / b.atmosphere.height, 0, 1), 1.5);
            const upW = v3.norm(cam.pos.sub(b.pos)), sunW = v3.norm(this.world.sunPos.sub(cam.pos));
            const day = clamp((v3.dot(upW, sunW) + 0.15) / 0.4, 0, 1);
            sky = v3.mul(b.atmosphere.color, k * day * 0.9);
            starVis = 1 - clamp(k * day * 3, 0, 1);
            // by night under the air the eye is adapted to the dark: the Moon (any sunlit body) shines near white
            eye = 1 + (NIGHT_EYE - 1) * k * (1 - clamp((v3.dot(upW, sunW) + 0.2) / 0.25, 0, 1));
        }
        F.set([sky[0], sky[1], sky[2], starVis], 36);
        // (w: in a frame another kit maps from radiance, the reciprocal of that kit's exposure: its sky's, world.sunlight)
        const on = this.standing();
        F.set([this.lighting.exposure, this.lighting.sun, this.writeCovers(F, 52, on), 1 / Math.max(this.fx.world.sunlight?.exposure ?? 1, 1e-4)], 40);
        F.set([eye, 0, 0, 0], 44);
        // the clouds: how many storms, how much of their own clouds the sites on the bodies draw about the eye (their
        // air) and out to where (origin units), the origin's units per metre
        const own = on.map(i => i.clouds || NO_CLOUDS);
        F.set([this.writeStorms(F, 52 + MAX_COVERS * 12, on), Math.max(0, ...own.map(c => c.air)), Math.max(0, ...own.map(c => c.reach)) / o.scale, 1 / o.scale], 48);
    }

    // The sites standing on its bodies (their Site.footprint with an albedo: an atmosphere's map), MAX_COVERS at most,
    // each { k (the body's index), n (its centre's direction from the body's centre, world axes), r (its angular radius),
    // albedo, clouds (Site.clouds), dir([x, y, z]) (a point of its frame as such a direction) }
    standing() {
        const host = this.fx.host, self = host?.sites?.find(i => i.ctx === this.fx);
        if (!self) return [];
        const own = host.siteFrame(self), out = [];
        for (const i of host.sites.filter(i => i !== self && i.ready)) {
            const on = this.siteOn(i, own);
            if (on && out.push(on) >= MAX_COVERS) break;
        }
        return out;
    }

    // site i as standing() has it (own: this site's frame), or null: it has no ground with an albedo, or stands on no
    // body (its middle further from one's surface than that body's air, or a fiftieth of its radius)
    siteOn(i, own) {
        let fp = null, clouds = null;
        try { fp = i.world.footprint?.(); clouds = i.world.clouds?.(); } catch { return null; }
        if (!fp?.albedo) return null;
        const frame = this.fx.host.siteFrame(i), at = q => own.local(frame.point(q));
        const middle = [(fp.lo[0] + fp.hi[0]) / 2, fp.floor, (fp.lo[1] + fp.hi[1]) / 2], mid = at(middle);
        const k = this.world.bodies.findIndex(b => Math.abs(v3.len(v3.sub(mid, b.frame.pos.metres())) - b.radius) <= Math.max(b.atmosphere?.height || 0, 0.02 * b.radius));
        if (k < 0) return null;
        const b = this.world.bodies[k], c = b.frame.pos.metres(), dir = q => v3.norm(v3.sub(at(q), c));
        return { k, n: dir(middle), r: Math.hypot(fp.hi[0] - fp.lo[0], fp.hi[1] - fp.lo[1]) / 2 / b.radius, albedo: fp.albedo, clouds, floor: fp.floor, dir };
    }

    // The ground and the cloud layer of the sites standing on its bodies (standing: on) into F at o: [n, body index]
    // [albedo, angular radius] [coverage, base, top (m), 1: it has clouds] each. Its surface takes that colour there,
    // and its clouds that layer, easing back to its own over some eight times that (surfaceColor, cloudField), so the
    // ground beyond their maps is theirs. Returns how many
    writeCovers(F, o, on) {
        on.forEach(({ n, k, albedo, r, clouds }, i) => {
            const { coverage, base, top } = clouds || NO_CLOUDS;
            F.set([...n, k, ...albedo, r, coverage, base, top, clouds ? 1 : 0], o + i * 12);
        });
        return on.length;
    }

    // The storms in the bodies' clouds into F at o, MAX_STORMS at most: a body's own (its clouds' `storms`: { type
    // 'hurricane', cat, lat, lon, scale }) and those the sites standing on them make (Site.clouds: their hurricane and
    // their biggest cells), each [direction from the body's centre (world axes), body index] then a hurricane's [1, eye
    // radius, strength, seed] [eyewall top, turn, bands, outer radius] [precipitation, band top, eye floor, raggedness]
    // (the weather kit's hurricaneData, m) or a cell's [2, radius, coverage, seed] [top, the direction (world axes) of
    // the wind its anvil spreads with] [anvil spread, 1: a tornado under it, 0, 0]. Returns how many
    writeStorms(F, o, on) {
        const w = this.world, out = w.bodies.flatMap((b, k) => (b.def.clouds?.storms || []).map((s, i) => {
            const n = v3.norm(v3.sub(w.resolve({ surface: { parent: b.id, lat: s.lat, lon: s.lon } }).pos.metres(), b.frame.pos.metres()));
            const H = hurricaneData(s.cat, { scale: s.scale });
            return [...n, k, 1, H[2], H[3], i * 7.31, ...H.slice(4)];
        }));
        for (const i of on) out.push(...(i.clouds || NO_CLOUDS).storms.map(s => this.siteStorm(i, s)));
        out.slice(0, MAX_STORMS).forEach((s, i) => F.set(s, o + i * 16));
        return Math.min(out.length, MAX_STORMS);
    }

    // storm s of site i standing on a body (standing), as writeStorms writes it
    siteStorm({ k, clouds, floor, dir }, s) {
        const H = s.hurricane, c = s.cell;
        if (H) return [...dir([H[0], floor, H[1]]), k, 1, H[2], H[3], 3.17, ...H.slice(4)];
        const w = c.aloft || clouds.wind, n = dir([c.x, floor, c.z]), wd = v3.sub(dir([c.x + w[0], floor, c.z + w[1]]), n);
        return [...n, k, 2, c.radius, c.coverage, c.seed, c.top, ...wd, c.anvil || 1, s.tornado ? 1 : 0, 0, 0];
    }

    // update: input, camera, world, rebase; render: the frame.
    frame(now, dt) {
        const r = this.renderer, w = this.world, f = this.floating;
        if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
        if (!this.paused) this.time += dt;
        const io = this.input.consume();
        const near = w.proximity(this.camera.pos);
        if (!this.fx.cameraLocked) this.controller.update(dt, io, f.origin, near, this.minAlt, f.scale ? 6 : f.cfg.maxScaleExp);
        if (this.controller.atEdge) { this.controller.atEdge = false; this.hud.toast('Edge of the world: ±2^30 cells'); }
        w.update(dt, this.time);
        const count = f.stats.count;
        this.prox = f.update(this.camera.pos, w);         // O(1) rebase when needed
        if (f.stats.count !== count) this.fx.emit('rebase', { reason: f.stats.reason, scale: f.origin.scale });
        const prox = this.prox ||= f.update(this.camera.pos, w);
        r.resize();
        this.writeFrame(prox);
        w.bodies.forEach((b, i) => b.pack(r.bodyData, i * BODY_FLOATS, f.origin, this.camera.pos));
        r.render(w, w.bodies.length);
        this.hud.drawLabels(this.app);
        this.hud.update(this.app, prox, now);
    }
}

return { AppExtension };
});
