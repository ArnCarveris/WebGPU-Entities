'use strict';
// The facility's game, its AppExtension (the one App, kits.world): the frame loop over world, screens and renderer.

Features.world('gui', (engine, kit) => {
const {
    M4, MaterialTable, RendererExtension, GuiAtlas, DeviceContext, DEPTH_FORMAT, InteractionSystem, GuiSchedule,
} = engine.kits.gui;
const { AudioSystem, SecurityCamera, WorldExtension, PlayerController, InputSystem, Bindings } = kit;

// The game: builds every system from the scenario and runs the frame.
//
// Frame order:
//   simulate (player, world) -> route the cursor -> update GUIs, rebuild the models that are due (GuiSchedule)
//   -> decide which views are needed (the features' prepare) -> write instances -> encode passes: the features'
//      (paint canvases, CCTV, phone camera), the GUIs' targets, the player view -> submit
// The CCTV, the phone's camera and IPTV are the media kit's (js/kits/media/, the media feature's): this game is their
// scene (renderView), its security cameras their cameras.
// (the phone itself is the engine's handheld, drawn over the finished frame)
//
// What the features on in its world add to it are its extensions (AppExtension, new E(game), kept as game.ext[E.key]);
// each hook optional: start(renderer) (before the world's instances are final), apps(phone) (phone apps it lends the
// handheld), prepare() (what renders this frame), passes(renderer, now) (its passes, first of the frame's), and the
// media's fullscreen / hidden() (the handheld's)

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

class AppExtension {
    static key = 'gui';
    // what it answers on the App (Common.Composite)
    static exposes = ['atlas', 'audio', 'bindings', 'camera', 'cameras', 'canvas', 'cctv', 'dc', 'far', 'frame', 'fx',
        'guis', 'handheld', 'input', 'interaction', 'iptv', 'phoneModel', 'placeLabel', 'player', 'render',
        'renderView', 'renderer', 'scenario', 'scene', 'start', 'stats', 'update', 'views', 'world'];
    constructor(app, fx) {
        this.app = app;
        this.fx = fx;
        this.scenario = fx.native;
        this.canvas = fx.canvas;
        this.renderer = fx.renderer.extend(RendererExtension, fx);
        this.audio = new AudioSystem(fx);
        this.far = fx.native.player.far || 100;
        this.input = new InputSystem(this.app, fx.io);
        this.stats = new FrameStats();
        this.lastTime = performance.now();
        app.compose(engine.kits.gpu.extensionsOf(fx.features, 'app'));
    }

    // the media feature's systems, if on
    get cctv() { return this.app.ext.media?.cctv || null; }
    get camera() { return this.app.ext.media?.camera || null; }
    get iptv() { return this.app.ext.media?.iptv || null; }

    async start() {
        const r = this.renderer, s = this.scenario;
        this.world = this.fx.world.extend(WorldExtension, this.app, s);
        await r.init();
        await GuiAtlas.loadFonts();
        r.reserveSurfaces(this.world.guis.length);
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(s.materials));

        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);
        this.schedule = new GuiSchedule();

        this.player = new PlayerController(this.app, s.player);
        this.scene = this.app;
        this.views = new Map();         // view target -> its depth and view uniforms
        this.handheld = this.app.ext.handheld.handheld;
        // the view ray through the mouse, unless it looks around or the handheld has the cursor
        this.interaction = new InteractionSystem(() => this.world.guis, () => {
            const { input, player, handheld } = this;
            if (!input.mouse.inside || input.looking || handheld.hasCursor) return null;
            return { eye: player.eye, dir: player.viewRay(input.mouse, player.fovy) };
        });
        this.bindings = new Bindings(this.app);

        this.app.each('start', r);
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
            apps: (phone) => Object.assign({}, ...this.app.all('apps', phone)),
            renderer: r,
            fullscreen: () => !!this.app.ext.media?.fullscreen,
            hidden: () => this.app.ext.media?.hidden(),
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

    // the scene contract (js/kits/media/views.js): a view of the facility into `target`, in this frame's encoder
    renderView(enc, target, s) {
        const r = this.renderer;
        let v = this.views.get(target);
        if (!v) {
            // (at the frame's samples, resolved into the target: a shared frame's may be more than one)
            const size = [target.width, target.height], n = r.frameSpec.samples, U = GPUTextureUsage;
            const depth = r.device.createTexture({ size, format: r.sceneDepthFormat(), sampleCount: n, usage: U.RENDER_ATTACHMENT });
            const msaa = n > 1 ? r.device.createTexture({ size, format: r.format, sampleCount: n, usage: U.RENDER_ATTACHMENT }).createView() : null;
            v = { depthView: depth.createView(), view: r.createView(), msaa };
            if (target.material) v.view.exclude.add(target.material);     // can't sample the texture it renders into
            this.views.set(target, v);
        }
        v.view.update(r.frameDepth(M4.viewProjection(s.eye, s.dir, s.up, s.fovY, target.aspect, s.near, s.far)), s.eye, this.frameState);
        r.updateGuiTargets(enc, this.world.guis);
        const pass = v.msaa ? r.beginScenePass(v.msaa, v.depthView, v.view, { resolve: target.colorView }) : r.beginScenePass(target.colorView, v.depthView, v.view);
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
        const r = this.renderer, viewProj = M4.multiply(M4.perspective(player.fovy, r.aspect, 0.02, this.far), player.viewMatrix());
        for (const g of this.schedule.due(world.guis, { viewProj, eye: player.eye, height: r.height })) g.build(dc, now);
    }

    render(now, dt, t) {
        const { renderer: r, world, player } = this;
        r.resize();
        // Views and render targets for this frame
        const frame = this.frameState = world.frameState(t);
        const view = player.viewMatrix();
        // (a shared frame's depth: every kit's the same, reversed with an infinite far plane)
        const shared = r.frameSpec.shared && engine.Common.m4.reversedInfinite(player.fovy, r.aspect, r.frameSpec.near);
        this.mainView.update(shared ? M4.multiply(shared, view) : r.frameDepth(M4.multiply(M4.perspective(player.fovy, r.aspect, r.frameSpec.near, this.far), view)), player.eye, frame);
        this.app.each('prepare');

        world.writeInstances(r);

        // Passes: the features' (paint, the media views), the GUI targets, then the scene
        r.frame({
            compute: enc => { this.app.each('passes', r, now); r.updateGuiTargets(enc, world.guis); },
            scene: { view: this.mainView },
            draw: pass => world.render(pass, { showAvatar: false }),
        });

        this.stats.tick(dt);
    }
}

return { AppExtension };
});
