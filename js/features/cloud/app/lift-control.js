'use strict';
// Using the lifts and their shafts (the transit kit's LiftInteraction over the world's Lifts, the building kit's
// Ladders): E presses the panel button in view, calls the car at the landing door in view (held: its emergency
// release), takes hold of the emergency ladder in a shaft, steps out from it through a landing door. Someone in a shaft
// (on its ladder, a car's roof, the pit) keeps its cars halted.

Features.part('cloud', (engine, feature) => {
const { LiftInteraction, Lifts } = engine.kits.transit;
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
        const a = this.app, S = a.world.structures, L = S.lifts, cam = a.camera, wk = a.walker;
        if (this.lifts !== L) {
            this.lifts = L;
            this.use = new LiftInteraction(L, { renderer: a.renderer, audio: { emit: (name, payload) => a.fx.emit(name, payload) } });
        }
        const k = io.pressed.indexOf('KeyE'), press = k >= 0 && !wk.bus, feet = wk.active ? wk.feet : cam.pos;
        const dir = a.fx.cameraLocked ? null : cam.basis().fwd;
        a.rideCar = L.carAt([cam.pos[0], cam.pos[1] - 1.5, cam.pos[2]], 0.4);
        // on a ladder: out through the landing beside it (forcing its door), nothing else
        if (wk.active && wk.ladder) {
            const l = wk.ladder.l, at = S.ladders.landingAt(l, wk.feet[1]);
            this.occupy(l);
            wk.liftPrompt = 'emergency ladder · W up · S down';
            if (at) {
                wk.liftPrompt = `E step out · floor ${l.building?.R?.storeys[at.g]?.label ?? at.g} · W up · S down`;
                if (press) {
                    for (const c of L.shafts.get(Lifts.shaftKey(l.f, l.building.core.shafts.find(s => s.key === at.shaft).rect)) || []) {
                        const i = c.el.stopAt(at.y, 0.2);
                        if (i >= 0) { L.force(c, i); break; }
                    }
                    const p = S.ladders.exit(l, at);
                    wk.ladder = null;
                    wk.place(a, p[0], p[2], p[1] + 0.05);
                    io.pressed.splice(k, 1);
                }
            }
            return;
        }
        const r = this.use.update(dt, now, { eye: cam.pos, dir, feet, press, hold: this.app.input.keys.has('KeyE') && !wk.bus, reach: DOOR_REACH, cars: a.frameWriter.roomVis?.cars });
        if (r.used && k >= 0) io.pressed.splice(k, 1);
        let prompt = wk.bus ? '' : r.prompt;
        if (wk.active && !wk.bus) {
            // the emergency ladder: in reach in the shaft, or through an open landing door from the lobby
            let l = S.ladders.grab(wk.feet, dir), y = wk.feet[1];
            const lg = r.landing;
            if (!l && lg && lg.side > 0 && L.landingDoor(lg.car, lg.i) > 0.8 && !(lg.car.el.at === lg.i && lg.car.el.door > 0)) {
                const sy = lg.car.el.stops[lg.i];
                l = S.ladders.near(wk.feet, 3).find(q => q.landings?.some(x => Math.abs(x.y - sy) < 0.2 && x.shaft === lg.car.shaft.key)) || null;
                y = sy + 0.3;
                if (l) L.holdForced(lg.car.key, sy, 3);
            }
            if (l && (!r.prompt || r.prompt.startsWith('hold') || r.prompt === 'E step out')) {
                prompt = 'E climb onto the emergency ladder';
                if (press && !r.used) { wk.ladder = { l, y }; wk.feet = S.ladders.hang(l, y); io.pressed.splice(io.pressed.indexOf('KeyE'), 1); }
            }
            // in a shaft (not in its car): its cars stay halted
            const sh = this.shaftAt(wk.feet);
            if (sh) L.occupy(sh, 0.5);
        }
        wk.liftPrompt = prompt;
    }

    // the shaft key of the car run world p stands in (outside any car), or null
    shaftAt(p) {
        const L = this.lifts;
        if (L.carAt(p, 0.3)) return null;
        for (const c of L.near(p, 0.5)) {
            const [x0, x1, z0, z1] = c.shaft.rect, [x, z] = Lifts.local(c, p);
            if (x > x0 && x < x1 && z > z0 && z < z1) return c.key;
        }
        return null;
    }

    // a climber on ladder l: its shaft's cars halted
    occupy(l) {
        const sh = l.building?.core.shafts.find(s => Math.abs(s.ladder.x - l.x) < 1e-6 && Math.abs(s.ladder.z - l.z) < 1e-6);
        if (sh) this.lifts.occupy(Lifts.shaftKey(l.f, sh.rect), 0.5);
    }
}

return { LiftControl };
});
