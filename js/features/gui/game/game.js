'use strict';
// The game: the frame loop over world, screens and renderer.

Features.part('gui', (engine, feature) => {
const { M4, MaterialTable, Renderer, GuiAtlas, DeviceContext } = GuiKit;
const {
    AudioSystem, Easel, RadarApp, CameraApp, GalleryApp, ViewerApp, TvApp, CctvSystem, PhoneCamera, IptvPlayer,
    World, PlayerController, InputSystem, InteractionSystem, Bindings,
} = feature;

// Game: builds every system from the scenario and runs the frame.
//
// Frame order:
//   simulate (player, world) -> route the cursor -> update + rebuild GUI models
//   -> decide which render targets are needed -> write instances -> encode passes:
//      paint canvases, CCTV, phone camera, player view -> submit
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
        const r = this.renderer;
        await r.init();
        await GuiAtlas.loadFonts();
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(this.scenario.materials));

        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);

        const s = this.scenario;
        this.world = new World(this, s);
        this.player = new PlayerController(this, s.player);
        this.cctv = new CctvSystem(this, s.cctv);
        this.camera = new PhoneCamera(this, s.media);
        this.iptv = new IptvPlayer(this, s.iptv);
        this.handheld = this.fx.host.handheld;
        this.interaction = new InteractionSystem(this);
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
            apps: (phone) => ({
                radar: new RadarApp(phone, this), camera: new CameraApp(phone, this), photos: new GalleryApp(phone, this),
                viewer: new ViewerApp(phone, this), tv: new TvApp(phone, this)
            }),
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
        const frame = world.frameState(t);
        const view = player.viewMatrix();
        this.mainView.update(M4.multiply(M4.perspective(player.fovy, r.aspect, 0.02, this.far), view), player.eye, frame);
        if (!phone.visible) this.iptv.fullscreen = false;
        this.iptv.update(phone.visible && (this.iptv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        this.cctv.prepare(frame);
        this.camera.prepare(frame);

        world.writeInstances(r);

        // Passes
        r.beginFrame();
        for (const easel of world.ofType(Easel)) easel.canvas.flush(r);
        this.cctv.render();
        this.camera.render(now);
        const pass = r.beginScenePass(r.swapView, r.depthView, this.mainView);
        world.render(pass, { showAvatar: false });
        pass.end();
        r.endFrame();

        this.stats.tick(dt);
    }
}

return { Game };
});
