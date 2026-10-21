'use strict';
// The GUI screens (props with a `screen`): their kinds in the world, their pass in the renderer, the cursor on them and
// their rebuilds in the game. Without them none of it is made: no GUI pass, no atlas, no interaction.

Features.feature('interior/portal/screens', (engine, kit) => {
const { v3 } = engine.Common;
const { InteractionSystem, DeviceContext, GuiSchedule } = engine.kits.gui;
const { m4, SCREEN_GUIS, GuiPass } = kit;

const VIEW_EVERY = 4;           // frames between rebuilds of a screen only a view target (not the main view) sees

// the world's GUI kinds (a Screen entity's `gui`, js/kits/entities/sectors.js)
class ScreensWorld {
    static key = 'screens';
    constructor(world) { world.guiKinds = SCREEN_GUIS; }
}

// The game's: the screens' cursor (the gui kit's InteractionSystem, app.interaction: the view ray, the crosshair while the
// mouse looks, else the mouse; game/input.js routes clicks to it), their device context and rebuild schedule
class ScreensApp {
    static key = 'screens';

    constructor(app) {
        this.app = app;
        this.screenRay = null;
        app.interaction = new InteractionSystem(() => app.world?.screenGuis || [], () => this.screenRay);
    }

    start() {
        this.dc = new DeviceContext(this.app.renderer.ext.gui.atlas);
        this.schedule = new GuiSchedule();
    }

    load(scn, world) {
        this.app.interaction.reset();
        world.screenGuis = world.screens.map(s => s.gui);
        for (const g of world.screenGuis) g.attachTo(this.app);
    }

    // GUI screens (kits.entities sectorTypes Screen, js/kits/entities/sectors.js): the interaction system (the gui kit) gives the nearest screen the view ray
    // meets the cursor, if within the GUI's range; the screens in this frame's draws rebuild their GUI models when the
    // gui kit's GuiSchedule says so (the others aren't seen)
    frame(now, { eye, fwd, viewProj, height }) {
        const g = this.app, dt = Math.min(0.1, (now - (this.screenT ?? now)) / 1000), screens = g.world.screens, ia = g.interaction;
        this.screenT = now;
        const dir = this.viewRay(eye, fwd, viewProj);
        this.screenRay = dir && { eye, dir };
        ia.hover();
        ia.drag();
        const free = document.pointerLockElement !== g.canvas;
        if (free && ia.focus) { g.canvas.style.cursor = 'none'; this.cursorHidden = true; }
        else if (this.cursorHidden) { g.canvas.style.cursor = ''; this.cursorHidden = false; }
        for (const s of screens) s.gui.update(dt, now);
        this.buildScreens(g.frameBuilder.stamp, now, { viewProj, eye, height });
    }

    // the screens the main view draws (this frame's stamp) rebuild their GUI models as the schedule has them due: the one
    // with the cursor every frame, the others by their size on screen; the others aren't seen and keep theirs
    buildScreens(stamp, now, cam) {
        const seen = [];
        for (const s of this.app.world.screens) if (s.stamp === stamp) seen.push(s.gui);
        for (const g of this.schedule.due(seen, cam)) {
            g.build(this.dc, now);
            g.builtAt = this.app.frameNo;
        }
    }

    // a view of the world (Game.renderView) was built: the screens only a view target (CCTV, the phone's camera) draws,
    // rebuilt every VIEW_EVERY frames, once per frame however many views see them
    view(stamp, now) {
        const frameNo = this.app.frameNo;
        for (const s of this.app.world.screens) {
            const g = s.gui;
            if (s.stamp !== stamp || frameNo - (g.builtAt ?? -Infinity) < VIEW_EVERY) continue;
            g.build(this.dc, now);
            g.builtAt = frameNo;
        }
    }

    // the view ray: forward while the mouse looks (pointer lock), through the mouse while it is over the canvas
    viewRay(eye, fwd, viewProj) {
        const g = this.app;
        if (g.fx.cameraLocked) return null;
        if (document.pointerLockElement === g.canvas) return fwd;
        const m = g.input.mouse;
        if (!m.inside) return null;
        const r = g.canvas.getBoundingClientRect();
        const q = m4.project(m4.invert(viewProj), [((m.x - r.left) / r.width) * 2 - 1, 1 - ((m.y - r.top) / r.height) * 2, 1, 1]);
        return v3.norm(v3.sub([q[0] / q[3], q[1] / q[3], q[2] / q[3]], eye));
    }
}

return { extensions: { world: ScreensWorld, app: ScreensApp, portal: r => new GuiPass(r) } };
});
