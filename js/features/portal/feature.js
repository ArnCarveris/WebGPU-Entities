'use strict';
// Entity Portal, as a feature of WebGPU Entities: a Portal-Room visibility system after Far Cry 1's VisArea/Portal and
// SECTR (sectors, portals, occluders, stencil-masked traversal), with an island outdoors, a ship and drones. The engine
// is the one from the WebGPU-EntityPortal demo; the host (js/engine/host.js) gives it its device, canvas target, input
// and HUD root, and builds its scenario from entities ("portal.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.portal (js/engine/features.js).
//
// ----------------------------------------------------------------------------------------------- js/core/config.js
// Engine limits and buffer layouts shared by the world, the visibility code, the shaders and the renderer.

Features.part('portal', (engine, feature) => {
const { MASK_MODES, Game, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these).
const HUD_HTML = `<div data-hud="crosshair"></div><div data-hud="toast" class="panel"></div>`;

class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = HUD_HTML;
    }

    async init() {
        const g = this.game = new Game(this.fx);
        g.onError = this.fx.fail;
        await g.start();
        g.load(this.fx.native);
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // classic 0..1 depth, near 0.05, far 400; 4x MSAA depth-stencil (the depth aspect)
    depth() {
        const r = this.game.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.05, far: 400, samples: 4 };
    }

    get view() {
        const P = this.game.player, { fwd, up } = P.basis();
        return { pos: [...P.cam.pos], fwd, up, fov: P.cam.fov };
    }

    setView(v) {
        const P = this.game.player, c = P.cam;
        c.pos = [...v.pos];
        c.yaw = Math.atan2(v.fwd[0], -v.fwd[2]);
        c.pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd[1])));
        if (v.fov) c.fov = v.fov;
        P.driving = null;
        P.reset(c.pos);
    }

    stats() {
        const g = this.game, w = g.world, P = g.player, s = g.stats, cam = P.cam.pos;
        const area = w.areas[w.areaAt(cam)], ship = w.vehicles[0];
        return {
            name: w.scn.name, fps: s.fps, area: area.name, outdoor: !!area.outdoor, onShip: !!area.vehicle, state: P.stateLabel,
            swimming: !!P.swimming, driving: !!P.driving, culling: g.opts.culling, mode: g.frameMode, draws: s.draws, tris: s.tris,
            shipSpeed: ship ? ship.v : 0, shipDist: ship ? Math.hypot(ship.M[12] - cam[0], ship.M[14] - cam[2]) : 1e9,
            drones: w.drones.length,
        };
    }

    // the readout, the minimap and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.game); }

    set(key, v) {
        const o = this.game.opts;
        if (key in o && typeof o[key] === typeof v) o[key] = v;
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
