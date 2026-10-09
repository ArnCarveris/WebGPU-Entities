'use strict';
// Using lifts: their panels near the eye (placed and rebuilt each frame), the button under the view pressed, or at a
// landing door in view, a car called there.

Features.kit('transit', (engine, kit) => {
const { v3 } = engine.Common;
const { InteractionSystem } = engine.kits.gui;
const BUILD_RANGE = 25;          // m: panels nearer than this are rebuilt each frame (further ones keep their last picture)

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
        this.ia = new InteractionSystem(() => this.shown, () => this.ray);
    }

    // eye, dir (the view ray; null: nothing aimed at), feet (where a walker stands, or the eye), press (E this frame),
    // reach (m: a landing door this near can be called at). Returns { prompt, used (the press went to a button or a call) }
    update(dt, now, { eye, dir, feet = eye, press = false, reach = 2.4 }) {
        const L = this.lifts, out = { prompt: '', used: false };
        if (!L.cars.length) { this.shown = []; return out; }
        this.shown = L.panels(eye);
        for (const g of this.shown) {
            if (this.attached.has(g)) continue;
            g.attach(this.host);
            this.attached.add(g);
        }
        this.ray = dir ? { eye, dir } : null;
        this.ia.hover();
        if (this.ia.focus) {
            if (press) { this.ia.pointerDown(); this.ia.pointerUp(); out.used = true; }
            out.prompt = 'E press';
        } else if (dir && !L.carAt(feet)) {          // (not from inside a car)
            const at = this.landing(eye, dir, reach);
            if (at) {
                out.prompt = `E call the lift · ${at.group.name}`;
                if (press) { at.group.call(at.stop); this.host.audio.emit('liftButton', { id: 'call' }); out.used = true; }
            }
        }
        for (const g of this.shown) {
            g.update(dt, now);
            if (v3.len(v3.sub(g.center(), eye)) < BUILD_RANGE) g.build(this.host.renderer.dc, now);
        }
        return out;
    }

    // the landing door the eye looks at within reach: { group, stop } or null
    landing(eye, fwd, reach = 2.4) {
        const L = this.lifts;
        let best = null, score = 0;
        for (const c of L.near(eye, reach)) {
            const i = c.el.nearest(eye[1] - 1.5);
            if (Math.abs(c.el.stops[i] - (eye[1] - 1.5)) > 2) continue;
            const d = v3.sub(c.f.at(c.wall, c.el.stops[i] + 1.1, c.zc), eye), l = v3.len(d);
            if (l > reach + 0.6 || l < 1e-3) continue;
            const cos = v3.dot(d, fwd) / l, need = Math.cos(Math.atan2(L.L.door.width / 2 + 0.2, l));
            if (cos > need && cos - need > score) { score = cos - need; best = { group: c.group, stop: i }; }
        }
        return best;
    }
}

return { LiftInteraction };
});
