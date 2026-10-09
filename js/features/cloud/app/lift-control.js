'use strict';
// Using the lifts (the transit kit's LiftInteraction over the world's Lifts): E presses the panel button in view, or
// calls a car at the landing door in view, before the doors take it.

Features.part('cloud', (engine, feature) => {
const { LiftInteraction } = engine.kits.transit;
const { DOOR_REACH } = feature;

class LiftControl {
    constructor(app) {
        this.app = app;
        this.lifts = null;
        this.use = null;
    }

    // the panels drawn this frame (FrameWriter)
    get shown() { return this.use ? this.use.shown : []; }

    update(dt, io, now) {
        const a = this.app, L = a.world.structures.lifts, cam = a.camera, wk = a.walker;
        if (this.lifts !== L) {
            this.lifts = L;
            this.use = new LiftInteraction(L, { renderer: a.renderer, audio: { emit: (name, payload) => a.fx.emit(name, payload) } });
        }
        const k = io.pressed.indexOf('KeyE');
        const r = this.use.update(dt, now, { eye: cam.pos, dir: a.fx.cameraLocked ? null : cam.basis().fwd,
            feet: wk.active ? wk.feet : cam.pos, press: k >= 0 && !wk.bus, reach: DOOR_REACH });
        if (r.used && k >= 0) io.pressed.splice(k, 1);
        wk.liftPrompt = wk.bus ? '' : r.prompt;
    }
}

return { LiftControl };
});
