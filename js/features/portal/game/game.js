'use strict';
// The game: the frame loop over world, visibility and renderer.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const {
    m4, Renderer, FrameBuilder, PortalVis, World, PlayerController, InputSystem, Hud, PortalMedia,
} = feature;
const { VisInspector } = engine.kits.interior;

// Game: builds the world from a scenario and runs the frame.
//
// Frame order:
//   world update (vehicles first, so riders use this frame's pose) -> player -> portal traversal
//   (or the frozen one) -> FrameBuilder command list -> GUI screens (cursor, the drawn ones rebuilt) -> the media
//   systems' views (CCTV, the phone's camera: renderView, each its own traversal and frame) -> debug lines -> render
//   -> HUD. The floor map, the traversal readout and the frames are the interior kit's VisInspector (this.inspector)

const NO_LINES = new Float32Array(0);

const MASK_MODES = ['stencil', 'scissor', 'none'];

class Game {
    constructor(fx) {
        this.fx = fx;
        this.ui = fx.ui;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new InputSystem(this, fx.io);
        this.hud = new Hud(this);
        this.onError = (e) => console.error(e);
        this.world = null;
        this.player = null;
        this.vis = null;
        this.inspector = null;
        this.opts = { culling: true, freeze: false, mode: 'stencil', portals: true, volumes: false, map: true, help: true, occluders: true, walk: true, wide: false };
        this.stats = { fps: 0, visMs: 0, draws: 0, tris: 0, objs: 0 };
        this.frameStats = null;
        this.frameMode = 'stencil';
        this.running = false;
        this.lastT = performance.now();
        // the GUI screens' cursor (the gui kit): the view ray, the crosshair while the mouse looks, else the mouse
        this.interaction = new engine.kits.gui.InteractionSystem(() => this.world?.screenGuis || [], () => this.screenRay);
        this.screenRay = null;
        this.media = new PortalMedia(this);
    }

    get cam() { return this.player && this.player.cam; }

    async start() {
        await this.renderer.init();
        this.dc = new engine.kits.gui.DeviceContext(this.renderer.ext.gui.atlas);
        this.input.attach();
    }

    // build a world from scenario data and make it current (throws on errors in the data)
    load(scn) {
        const world = new World(scn);
        this.world = world;
        this.vis = new PortalVis(world);
        this.frameBuilder = new FrameBuilder(world, this.renderer);
        this.viewVis = new PortalVis(world);        // views of the world (renderView): their own traversal and frame
        this.viewBuilder = new FrameBuilder(world, this.renderer);
        this.renderer.upload(world);
        this.opts.freeze = false;
        this.inspector = this.createInspector(world);
        this.player = new PlayerController(this, scn.camera, scn.player);
        this.interaction.reset();
        world.screenGuis = world.screens.map(s => s.gui);
        for (const g of world.screenGuis) g.attachTo(this);
        this.media.load(scn, world);
        if (world.warnings.length) this.hud.toast(`${world.warnings.length} scenario warning(s), see console`);
        else this.hud.toast(`Loaded "${scn.name || 'scenario'}": ${world.areas.length - 1} areas, ${world.portals.length} portals`);
    }

    onKey(code) {
        const o = this.opts, P = this.player, hud = this.hud;
        switch (code) {
            case 'Digit1': o.culling = !o.culling; hud.toast(`Portal culling ${o.culling ? 'ON' : 'OFF'}`); break;
            case 'Digit2': o.freeze = !o.freeze; hud.toast(o.freeze ? 'Visibility frozen: fly around to inspect' : 'Visibility live'); break;
            case 'Digit3': o.mode = MASK_MODES[(MASK_MODES.indexOf(o.mode) + 1) % MASK_MODES.length]; hud.toast(`Portal masking: ${o.mode}`); break;
            case 'Digit4': o.portals = !o.portals; break;
            case 'Digit5': o.volumes = !o.volumes; break;
            case 'Digit6': o.occluders = !o.occluders; hud.toast(`Occluders ${o.occluders ? 'ON' : 'OFF'}`); break;
            case 'KeyM': o.map = !o.map; break;
            case 'KeyR': if (P.driving) hud.toast(P.toggleHelm()); P.cam.reset(); P.reset(P.cam.pos); break;
            case 'KeyN': o.wide = !o.wide; break;
            case 'KeyF': { const msg = P.toggleHelm(); if (msg) hud.toast(msg); else this.useDoor(); break; }
        }
    }

    // the visibility inspector (the interior kit's: floor map, traversal, frames on the handheld) over the world, with the
    // island's own layers on its map (the sea, the ship's route and hull, the drones) and the masking options
    createInspector(w) {
        const g = this;
        return new VisInspector({
            set: w, opts: this.opts, keys: { culling: '1', freeze: '2', portals: '4', volumes: '5', map: 'M', wide: 'N' },
            map: {
                spans: w.scn.minimap,
                teleport: (x, z) => {
                    const a = w.areas[w.areaAt([x, 1.0, z])];
                    const y = !a.outdoor && !a.vehicle ? a.y : w.groundAt([x, 60, z], 0).y;
                    g.player.teleport([x, y + g.player.cfg.eyeHeight, z]);
                },
                under: (c, { X, Y, path }) => {
                    const coast = ((w.scn.outdoor || {}).terrain || {}).coast;
                    if (w.water && coast) {
                        const n = coast.normal, p = coast.point, d = [-n[1], n[0]], F = 2000;
                        path([[p[0] + d[0] * F, p[1] + d[1] * F], [p[0] + d[0] * F + n[0] * F, p[1] + d[1] * F + n[1] * F], [p[0] - d[0] * F + n[0] * F, p[1] - d[1] * F + n[1] * F], [p[0] - d[0] * F, p[1] - d[1] * F]]);
                        c.fillStyle = 'rgba(40,110,150,0.35)'; c.fill();
                    }
                    for (const veh of w.vehicles) {
                        c.setLineDash([3, 4]); c.strokeStyle = 'rgba(160,200,230,0.35)'; c.lineWidth = 1;
                        path(veh.route.samples.map(sm => sm.p)); c.stroke();
                        c.setLineDash([]);
                    }
                    for (const h of w.hulls) {
                        const veh = h.vehicle;
                        path(veh ? h.outline.map(q => { const r = veh.toWorld([q[0], h.deck, q[1]]); return [r[0], r[2]]; }) : h.outline);
                        c.fillStyle = 'rgba(150,50,35,0.45)'; c.fill();
                    }
                },
                over: (c, { X, Y }) => {
                    c.fillStyle = '#ff5a40';
                    for (const d of w.drones) { c.beginPath(); c.arc(X(d.pos[0]), Y(d.pos[2]), 3.5, 0, Math.PI * 2); c.fill(); }
                },
            },
            options: () => [
                { choice: 'Masking (3)', options: MASK_MODES, index: MASK_MODES.indexOf(g.opts.mode), pick: i => { g.opts.mode = MASK_MODES[i]; } },
                { toggle: 'Occluders (6)', on: g.opts.occluders, set: () => g.onKey('Digit6') }],
        });
    }

    // report the nearest door (all doors in the scenario are automatic, manual ones toggle)
    useDoor() {
        let best = null, bd = 4.5;
        for (const d of this.world.doors) {
            const dist = v3.dist(this.cam.pos, d.portal.center);
            if (dist < bd) { bd = dist; best = d; }
        }
        if (!best) { this.hud.toast('No door in reach'); return; }
        const r = best.toggle();
        this.fx.emit('door', { result: r, open: best.target > 0.5 });
        if (r === 'locked') this.hud.toast(`${best.name}: LOCKED (portal flag Locked)`);
        else if (r === 'auto') this.hud.toast(`${best.name}: automatic door`);
        else this.hud.toast(`${best.name}: ${best.target > 0.5 ? 'opening' : 'closing'}`);
    }

    // update: world (vehicles first, so riding players use this frame's pose), player; render: visibility, the
    // frame. The host runs both, or (in a composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        dt = Math.min(0.05, dt);
        const t = now / 1000;
        const { world: w, player, stats } = this;
        if (update) {
            stats.fps = stats.fps * 0.93 + (1 / Math.max(dt, 1e-4)) * 0.07;
            w.update(dt, t, [player.cam.pos]);
            if (!this.fx.cameraLocked) player.update(dt, this.input.keys);
            this.soundEvents(dt);
        }
        if (render) this.tick(now, t);
    }

    // events for the scenario's sound cues: footsteps while walking on the ground, every stride
    soundEvents(dt) {
        // strides are measured in the frame of what the player stands on: a ship carrying them is no walking
        const P = this.player, frame = P.support || null, pos = frame ? frame.toLocal(P.cam.pos) : P.cam.pos.slice();
        const from = this.stepFrame === frame ? this.stepPos : null;
        this.stepPos = pos;
        this.stepFrame = frame;
        if (this.fx.cameraLocked || !this.opts.walk || !P.onGround || P.driving) return;
        const run = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
        const d = from ? Math.hypot(pos[0] - from[0], pos[2] - from[2]) : 0;
        this.stepDist = (this.stepDist || 0) + (d < 3 ? d : 0);
        if (this.stepDist > (run ? 1.6 : 1.1)) { this.stepDist = 0; this.fx.emit('step', { run, swim: P.swimming }); }
    }

    tick(now, t) {
        this.frameNo = (this.frameNo || 0) + 1;
        this.frameNow = now;
        const { renderer: R, world: w, opts: o, player, stats } = this;
        const [W, H] = this.fx.size();
        R.resize(W, H);

        const { fwd, up } = player.basis(), eye = player.cam.pos;
        const proj = m4.perspective(player.cam.fov, W / H, 0.05, 400);
        const viewProj = m4.mul(proj, m4.lookAt(eye, v3.add(eye, fwd), up));

        const t0 = performance.now();
        const I = this.inspector;
        let vis = I.frozen;
        if (!vis) {
            vis = this.vis.compute(eye, viewProj, W, H, o.culling);
            if (!o.occluders) vis.occluders = [];
        }
        I.update(vis, { eye, basis: player.basis(), aspect: W / H, fov: player.cam.fov }, performance.now() - t0);
        // stencil masks and scissor rects only make sense for the view the traversal was computed for
        const mode = (!o.culling || o.freeze) ? 'none' : o.mode;
        const fr = this.frameBuilder.build(vis, mode, W, H);
        stats.visMs = stats.visMs * 0.9 + (performance.now() - t0) * 0.1;
        stats.draws = fr.cmds.filter(c => c.op === 'draw').length;
        stats.tris = fr.cmds.reduce((s, c) => s + (c.op === 'draw' ? c.chunk.count / 3 : 0), 0);
        stats.objs = fr.objs.length;
        this.frameStats = fr.stats;
        this.frameMode = mode;
        this.updateScreens(now, eye, fwd, viewProj);
        this.media.frame(now);

        const lines = I.lines();
        R.render({ globals: this.globals(viewProj, eye, t, W, H, mode === 'stencil'), areas: w.lightingTable(t, eye), draws: fr.draws, cmds: fr.cmds, polys: fr.polys, stencil: mode === 'stencil', lines: lines.data, lineDepthCount: lines.depthCount });

        this.hud.tick(now, vis);
    }

    // the scene contract of the gui kit's views (js/kits/gui/views.js): a view of the island into `target`, with the
    // main view's culling and masking options; it submits its own frame, before the main one
    renderView(enc, target, s) {
        const w = this.world, o = this.opts, t = performance.now() / 1000, W = target.width, H = target.height;
        const viewProj = m4.mul(m4.perspective(s.fovY, target.aspect, s.near, s.far), m4.lookAt(s.eye, v3.add(s.eye, s.dir), s.up));
        const vis = this.viewVis.compute(s.eye, viewProj, W, H, o.culling);
        if (!o.occluders) vis.occluders = [];
        const mode = o.culling ? o.mode : 'none';
        const fr = this.viewBuilder.build(vis, mode, W, H);
        this.buildScreens(this.viewBuilder.stamp, this.frameNow);
        this.renderer.render({
            globals: this.globals(viewProj, s.eye, t, W, H, mode === 'stencil'), areas: w.lightingTable(t, s.eye), draws: fr.draws, cmds: fr.cmds,
            polys: fr.polys, stencil: mode === 'stencil', lines: NO_LINES, lineDepthCount: 0,
        }, target);
    }

    // GUI screens (kits.entities sectorTypes Screen, js/kits/entities/sectors.js): the interaction system (the gui kit) gives the nearest screen the view ray
    // meets the cursor, if within the GUI's range; the screens in this frame's draws rebuild their GUI models (the
    // others aren't seen)
    updateScreens(now, eye, fwd, viewProj) {
        const dt = Math.min(0.1, (now - (this.screenT ?? now)) / 1000), screens = this.world.screens, ia = this.interaction;
        this.screenT = now;
        const dir = this.viewRay(eye, fwd, viewProj);
        this.screenRay = dir && { eye, dir };
        ia.hover();
        ia.drag();
        const free = document.pointerLockElement !== this.canvas;
        if (free && ia.focus) { this.canvas.style.cursor = 'none'; this.cursorHidden = true; }
        else if (this.cursorHidden) { this.canvas.style.cursor = ''; this.cursorHidden = false; }
        for (const s of screens) s.gui.update(dt, now);
        this.buildScreens(this.frameBuilder.stamp, now);
    }

    // the screens a frame (the main view's, a view target's) draws rebuild their GUI models, once per frame however
    // many views see them; the others aren't seen and keep theirs
    buildScreens(stamp, now) {
        for (const s of this.world.screens) {
            if (s.stamp !== stamp || s.gui.builtAt === this.frameNo) continue;
            s.gui.build(this.dc, now);
            s.gui.builtAt = this.frameNo;
        }
    }

    // the view ray: forward while the mouse looks (pointer lock), through the mouse while it is over the canvas
    viewRay(eye, fwd, viewProj) {
        if (this.fx.cameraLocked) return null;
        if (document.pointerLockElement === this.canvas) return fwd;
        const m = this.input.mouse;
        if (!m.inside) return null;
        const r = this.canvas.getBoundingClientRect();
        const q = m4.project(m4.invert(viewProj), [((m.x - r.left) / r.width) * 2 - 1, 1 - ((m.y - r.top) / r.height) * 2, 1, 1]);
        return v3.norm(v3.sub([q[0] / q[3], q[1] / q[3], q[2] / q[3]], eye));
    }

    // Globals uniform: view-projection (+ inverse), eye, sun, sky colours, time, viewport and whether the
    // scene shader fogs through portals (stencil mode)
    globals(viewProj, eye, t, W, H, portalFog) {
        const w = this.world, sc = w.scn.outdoor || {}, g = new Float32Array(56);
        g.set(viewProj, 0);
        g.set(m4.invert(viewProj), 16);
        g.set([eye[0], eye[1], eye[2], 1], 32);
        g.set([...v3.norm(w.sunDir), 0], 36);
        g.set([...(sc.sunColor || [1.2, 1.1, 1.0]), 1], 40);
        g.set([...(sc.skyTop || [0.3, 0.55, 1.3]), 1], 44);
        g.set([...(sc.skyHorizon || [1.0, 1.15, 1.35]), 1], 48);
        g.set([t, W, H, portalFog ? 1 : 0], 52);
        return g;
    }
}

return { MASK_MODES, Game };
});
