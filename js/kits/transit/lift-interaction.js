'use strict';
// Using lifts: their panels near the eye (placed and rebuilt each frame), the button under the view pressed; at a
// landing door in view, its car called; held, the door's emergency release (from either side: the lobby, or the shaft).

Features.kit('transit', (engine, kit) => {
const { v3 } = engine.Common;
const { InteractionSystem } = engine.kits.gui;
const BUILD_RANGE = 25;          // m: panels nearer than this are rebuilt each frame (further ones keep their last picture)
const RELEASE_HOLD = 1.0;        // s: E held at a landing door forces it open

// Over a Lifts: each frame (update) its panels near the eye are placed (shown: what the renderer draws), aimed at along
// the view (the gui kit's InteractionSystem), and rebuilt into their models with the renderer's device context.
// host: { renderer (device; dc: a DeviceContext over the gui atlas), audio: { emit } } (what an EntityGUI attaches to)
class LiftInteraction {
    constructor(lifts, host) {
        this.lifts = lifts;
        this.host = host;
        this.shown = [];
        this.attached = new WeakSet();
        this.ray = null;
        this.held = 0;
        this.ia = new InteractionSystem(() => this.shown, () => this.ray);
    }

    // eye, dir (the view ray; null: nothing aimed at), feet (where a walker stands, or the eye), press (E this frame),
    // hold (E held), reach (m: a landing door this near can be used), cars (the cars the camera sees: their panels).
    // Returns { prompt, used (the press went to a button or a door) }
    update(dt, now, { eye, dir, feet = eye, press = false, hold = false, reach = 2.4, cars = null }) {
        const L = this.lifts, out = { prompt: '', used: false };
        if (!L.cars.length) { this.shown = []; return out; }
        this.shown = L.panels(eye, cars);
        for (const g of this.shown) {
            if (this.attached.has(g)) continue;
            g.attach(this.host);
            this.attached.add(g);
        }
        this.ray = dir ? { eye, dir } : null;
        this.ia.hover();
        const inCar = L.carAt(feet);
        if (this.ia.focus) {
            if (press) { this.ia.pointerDown(); this.ia.pointerUp(); out.used = true; }
            out.prompt = 'E press';
            this.held = 0;
        } else if (dir && !inCar) {
            const at = this.landing(eye, dir, feet, reach);
            if (at) {
                const { car, i, side } = at, el = car.el, open = L.landingDoor(car, i);
                if (side < 0 || open > 0.5 || el.at === i && el.door > 0) {
                    // from the shaft, or at a door already open: only the release (kept open while held)
                    out.prompt = open > 0.5 ? (side < 0 ? 'E step out' : '') : `hold E: emergency release · ${car.name}`;
                } else out.prompt = `E call · hold E: emergency release · ${car.name}`;
                if (press && side > 0 && open < 0.5) { el.call(i); this.host.audio.emit('liftButton', { id: 'call' }); out.used = true; }
                if (hold && open < 0.5) {
                    this.held += dt;
                    out.prompt = `releasing… ${Math.min(100, Math.round(this.held / RELEASE_HOLD * 100))}%`;
                    if (this.held >= RELEASE_HOLD) { L.force(car, i); this.host.audio.emit('liftRelease', { car: car.name }); this.held = 0; }
                    out.used = true;
                } else if (!hold) this.held = 0;
                out.landing = at;
            } else this.held = 0;
        }
        for (const g of this.shown) {
            g.update(dt, now);
            if (v3.len(v3.sub(g.center(), eye)) < BUILD_RANGE) g.build(this.host.renderer.dc, now);
        }
        return out;
    }

    // the landing door the eye looks at within reach: { car, i (its stop), side (+1 from the lobby, -1 from the shaft) }
    // or null
    landing(eye, fwd, feet, reach = 2.4) {
        const L = this.lifts;
        let best = null, score = 0;
        for (const c of L.near(eye, reach + 1)) {
            const i = c.el.stopAt(feet[1], 1.2);
            if (i < 0) continue;
            const d = v3.sub(c.f.at(c.wall, c.el.stops[i] + 1.1, c.zc), eye), l = v3.len(d);
            if (l > reach + 0.6 || l < 1e-3) continue;
            const cos = v3.dot(d, fwd) / l, need = Math.cos(Math.atan2(c.dw / 2 + 0.2, l));
            const [x] = kit.Lifts.local(c, eye), side = Math.sign(x - c.wall) === c.sx ? 1 : -1;
            if (cos > need && cos - need > score) { score = cos - need; best = { car: c, i, side }; }
        }
        return best;
    }
}

return { LiftInteraction };
});
