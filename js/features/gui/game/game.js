'use strict';
// The game: the frame loop over world, screens and renderer.

Features.part('gui', (engine, feature) => {
const {
    M4, MaterialTable, Renderer, GuiAtlas, DeviceContext, DEPTH_FORMAT, InteractionSystem, CctvSystem, PhoneCamera, IptvPlayer,
    mediaApps,
} = engine.kits.gui;
const { AudioSystem, Easel, SecurityCamera, RadarApp, World, PlayerController, InputSystem, Bindings } = feature;

// Game: builds every system from the scenario and runs the frame.
//
// Frame order:
//   simulate (player, world) -> route the cursor -> update + rebuild GUI models
//   -> decide which views are needed -> write instances -> encode passes:
//      paint canvases, CCTV, phone camera, player view -> submit
// The CCTV, the phone's camera and IPTV are the gui kit's (js/kits/gui/): this game is their scene (renderView),
// its security cameras their cameras.
// (the phone itself is the engine's handheld, drawn over the finished frame)

class FrameStats {
    constructor() {
        this.fps = '--';
        this.acc = 0;
        this.frames = 0;
    }

    tick(dt) {
        this.acc += dt;
        this.frames++;
        if (this.acc > 0.5) {
            this.fps = String(Math.round(this.frames / this.acc));
            this.acc = 0;
            this.frames = 0;
        }
    }

    gui(g) {
        return `${g.model.quads} quads, ${g.model.surfaces.length} surf.`;
    }
}

class Game {
    constructor(fx) {
        this.fx = fx;
        this.scenario = fx.native;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.audio = new AudioSystem(fx);
        this.far = fx.native.player.far || 100;
        this.input = new InputSystem(this, fx.io);
        this.stats = new FrameStats();
        this.lastTime = performance.now();
    }

    async start() {
        const r = this.renderer, s = this.scenario;
        // the facility's entities first: their screens are what the renderer reserves stencil values for
        this.world = new World(this, s);
        await r.init();
        await GuiAtlas.loadFonts();
        r.reserveSurfaces(this.world.guis.length);
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(s.materials));

        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);

        this.player = new PlayerController(this, s.player);
        this.scene = this;
        this.views = new Map();         // view target -> its depth and view uniforms
        this.cctv = new CctvSystem(this, s.cctv);
        this.camera = new PhoneCamera(this, s.media);
        this.iptv = new IptvPlayer(this, s.iptv);
        this.handheld = this.fx.host.handheld;
        // the view ray through the mouse, unless it looks around or the handheld has the cursor
        this.interaction = new InteractionSystem(() => this.world.guis, () => {
            const { input, player, handheld } = this;
            if (!input.mouse.inside || input.looking || handheld.hasCursor) return null;
            return { eye: player.eye, dir: player.viewRay(input.mouse, player.fovy) };
        });
        this.bindings = new Bindings(this);

        this.cctv.init(r);
        this.camera.init(r);
        this.iptv.init(r);
        this.world.init(r);
        r.finalizeInstances();
        this.mainView = r.createView();

        this.input.attach();
        this.lendHandheld(r);
    }

    // The engine's handheld carries this facility's phone pages: its bindings, apps and render targets
    lendHandheld(r) {
        const fx = this.fx, player = this.player;
        this.handheld.provide({
            id: fx.id,
            pages: this.scenario.phone.pages,
            bindings: this.bindings,
            apps: (phone) => ({ radar: new RadarApp(phone, this), ...mediaApps(this)(phone) }),
            renderer: r,
            fullscreen: () => this.iptv.fullscreen,
            hidden: () => { this.iptv.fullscreen = false; },
            // while this world's player is the camera: its stride sways the phone, its lights light it (in eye space)
            motion: () => (fx.cameraLocked ? null : { moving: player.moving, stepPhase: player.stepPhase }),
            lighting: (t) => {
                if (fx.cameraLocked) return null;
                const f = this.world.frameState(t), v = player.viewMatrix();
                return { ...f, lights: f.lights.map((l) => [...M4.transformPoint(v, l), ...l.slice(3)]) };
            },
        });
    }

    // the phone in this world: the handheld's eye-space pose, held by the player
    phoneModel() {
        return M4.multiply(M4.facing(this.player.eye, this.player.basis().fwd), this.handheld.pose);
    }

    // ---- what the kit's media systems ask of their world ----
    cameras() {
        return this.world.ofType(SecurityCamera);
    }

    placeLabel(x, z) {
        return this.world.placeLabel(x, z);
    }

    // the scene contract (js/kits/gui/views.js): a view of the facility into `target`, in this frame's encoder
    renderView(enc, target, s) {
        const r = this.renderer;
        let v = this.views.get(target);
        if (!v) {
            const depth = r.device.createTexture({ size: [target.width, target.height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
            v = { depthView: depth.createView(), view: r.createView() };
            if (target.material) v.view.exclude.add(target.material);     // can't sample the texture it renders into
            this.views.set(target, v);
        }
        v.view.update(M4.viewProjection(s.eye, s.dir, s.up, s.fovY, target.aspect, s.near, s.far), s.eye, this.frameState);
        const pass = r.beginScenePass(target.colorView, v.depthView, v.view);
        this.world.render(pass, { showAvatar: s.showAvatar, skip: s.skip });
        pass.end();
    }

    get guis() {
        return this.world.guis;
    }

    // update: player, world, GUIs; render: views, render targets, passes. The host runs both, or (in a
    // composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        dt = Math.min(0.05, dt);
        const t = now / 1000;
        if (update) this.update(now, dt, t);
        if (render) this.render(now, dt, t);
    }

    update(now, dt, t) {
        const { world, player, interaction, dc } = this;
        // Simulation
        if (!this.fx.cameraLocked) player.update(dt, this.input.keys);
        world.update(dt, t);

        // GUIs: cursor routing, logic, then rebuild their models
        interaction.hover();
        interaction.drag();
        this.canvas.style.cursor = this.input.cursorStyle;
        for (const g of this.guis) g.update(dt, now);
        for (const g of world.guis) g.build(dc, now);
    }

    render(now, dt, t) {
        const { renderer: r, world, player, handheld: phone } = this;
        r.resize();
        // Views and render targets for this frame
        const frame = this.frameState = world.frameState(t);
        const view = player.viewMatrix();
        this.mainView.update(M4.multiply(M4.perspective(player.fovy, r.aspect, 0.02, this.far), view), player.eye, frame);
        if (!phone.visible) this.iptv.fullscreen = false;
        this.iptv.update(phone.visible && (this.iptv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        this.cctv.prepare();
        this.camera.prepare();

        world.writeInstances(r);

        // Passes
        r.beginFrame();
        for (const easel of world.ofType(Easel)) easel.canvas.flush(r);
        this.cctv.render(r.encoder);
        this.camera.render(r.encoder, now);
        const pass = r.beginScenePass(r.swapView, r.depthView, this.mainView);
        world.render(pass, { showAvatar: false });
        pass.end();
        r.endFrame();

        this.stats.tick(dt);
    }
}

return { Game };
});
