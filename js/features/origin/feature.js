'use strict';
// Entity Origin, as a feature of WebGPU Entities: a Floating Origin with O(1) rebasing over a real-scale solar system.
// The engine is the one from the WebGPU-EntityOrigin demo; the host (js/engine/host.js) gives it its device, canvas
// target, input and HUD root, and builds its scenario from entities ("origin.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.origin (js/engine/features.js).
//
// Entity Origin: a Floating Origin in WebGPU with O(1) rebasing.
//
// Every position lives on an integer grid: WorldPos = integer cell (CELL metres) + local offset. The
// origin is a full matrix (translation, rotation, scale) and is the ONLY thing that changes on a rebase:
// 80 bytes to one uniform buffer. Instances stay in a static storage buffer as (cell, local, axes) and the
// vertex shader brings them into origin space itself:
//
//     p_origin = (R^T / s) * ( (cell - originCell) * CELL + (local - originLocal) + axes * vertex )
//
// The cell difference is an exact integer subtraction, so everything near the origin keeps full f32
// precision whatever its distance from the world centre, and rebasing never walks the entity list.

Features.part('origin', (engine, feature) => {
const { Common, kits } = engine;
const { v3 } = Common;
const { FeatureWorld } = kits.world, { HUD } = FeatureWorld;
const { SAMPLES, NEAR, quat, App, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these; view / setView: its camera's, in metres from
// world 0).
class OriginWorld extends FeatureWorld {
    constructor(fx) { super(fx, HUD.labels + HUD.toast); }

    createApp(fx) { return new App(fx); }

    // reversed-Z, infinite far plane, 4x MSAA; depth is in origin units: s metres each
    depth() {
        const r = this.app.renderer;
        return r.depthView && { view: r.depthView, kind: 'reversed', near: NEAR, samples: SAMPLES, scale: this.app.floating.origin.scale };
    }

    // where an entity is (other worlds can ride on it: layer.transform.anchor)
    anchor(id) {
        const e = this.app.world?.byId.get(id);
        return e && e.frame ? { pos: e.frame.pos.metres(), q: e.frame.q } : null;
    }

    stats() {
        const a = this.app, f = a.floating, cam = a.camera, prox = a.prox || {};
        return {
            name: a.world.scenario.name, fps: a.fps, paused: a.paused,
            speed: v3.len(cam.vel), fromZero: v3.len(cam.pos.metres()),
            body: prox.body ? prox.body.label || prox.body.id : '', altitude: prox.alt ?? 0, near: prox.near ? prox.near.label : '',
            rebases: f.stats.count, reason: f.stats.reason, scale: f.origin.scale,
            translate: f.translate, rotate: f.rotate, scaling: f.scale, everyFrame: f.everyFrame,
            instances: a.world.instanceCount, draws: a.renderer.draws, density: a.density,
            sunAt: this.sunProbes(),
        };
    }

    // the direction to the sun in the frame of every entity marked `sunProbe` (worlds riding on it light by it, through a
    // link: { to: "valley.sunDir", value: "sol.sunAt['site']" })
    sunProbes() {
        const w = this.app.world, out = {};
        for (const e of w.entities) {
            if (!e.def.sunProbe || !e.frame) continue;
            const d = v3.norm(w.sunPos.sub(e.frame.pos));
            out[e.id] = quat.rotate(quat.conj(e.frame.q), d);
        }
        return out;
    }

    // its bookmarks (origin.bookmark), the number keys' places
    views() {
        const a = this.app;
        return (a.bookmarks || []).map(b => ({ name: b.name, sub: b.key ? `key ${b.key}` : undefined, go: () => a.jump(b) }));
    }

    // the readout and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); }

    set(key, v) {
        const a = this.app, f = a.floating;
        if (key === 'paused') a.paused = !!v;
        else if (key === 'translate' || key === 'rotate' || key === 'scale') f[key] = !!v;
        else if (key === 'everyFrame') f.everyFrame = !!v;
        else if (key === 'labels') a.hud.showLabels = !!v;
    }
}

return { create: ctx => new OriginWorld(ctx) };
});
