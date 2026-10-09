'use strict';
// Entity Portal, as a feature of WebGPU Entities: a Portal-Room visibility system after Far Cry 1's VisArea/Portal and
// SECTR (sectors, portals, occluders, stencil-masked traversal), with an island outdoors, a ship and drones. The engine
// is the one from the WebGPU-EntityPortal demo; the host (js/engine/host.js) gives it its device, canvas target, input
// and HUD root, and builds its scenario from entities ("portal.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.portal (js/engine/features.js).

Features.part('portal', (engine, feature) => {
const { kits } = engine;
const { FeatureWorld } = kits.world, { HUD } = FeatureWorld;
const { MASK_MODES, Game, phonePages } = feature;

// This demo as one world of the engine (js/engine/host.js calls these).
class PortalWorld extends FeatureWorld {
    constructor(fx) { super(fx, HUD.crosshair + HUD.toast); }

    createApp(fx) {
        const g = new Game(fx);
        g.onError = fx.fail;
        return g;
    }

    // classic 0..1 depth, near 0.05, far 400; 4x MSAA depth-stencil (the depth aspect)
    depth() {
        const r = this.app.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.05, far: 400, samples: 4 };
    }

    get view() {
        const P = this.app.player, { fwd, up } = P.basis();
        return { pos: [...P.cam.pos], fwd, up, fov: P.cam.fov };
    }

    setView(v) {
        const P = this.app.player, c = P.cam;
        c.setView(v);
        P.driving = null;
        P.reset(c.pos);
    }

    // its player walks (collision, stairs, ladders, swimming) or flies through walls; the engine switches it
    get moves() { return ['fly', 'walk']; }
    get move() { return this.app.opts.walk ? 'walk' : 'fly'; }
    setMove(mode) {
        const g = this.app, P = g.player;
        if (P?.driving) g.hud.toast(P.toggleHelm());
        g.opts.walk = mode === 'walk';
        if (g.opts.walk && P) P.reset(P.cam.pos);
    }

    // floors, terrain (not indoors), the ship's decks, closed hatches
    ground(p) {
        const w = this.app.world;
        if (!w) return null;
        const g = w.groundAt(p, 0).y;
        return g === -Infinity ? null : g;
    }

    // its areas but the outdoors are weather shelters (Area.shelter)
    sheltered(p) { return this.app.world?.shelterAt(p) || null; }

    stats() {
        const g = this.app, w = g.world, P = g.player, s = g.stats, cam = P.cam.pos;
        const area = w.areas[w.areaAt(cam)], ship = w.vehicles[0];
        return {
            name: w.scn.name, fps: s.fps, area: area.name, outdoor: !!area.outdoor, onShip: !!area.vehicle, state: P.stateLabel,
            swimming: !!P.swimming, driving: !!P.driving, culling: g.opts.culling, mode: g.frameMode, draws: s.draws, tris: s.tris,
            shipSpeed: ship ? ship.v : 0, shipDist: ship ? Math.hypot(ship.M[12] - cam[0], ship.M[14] - cam[2]) : 1e9,
            drones: w.drones.length,
        };
    }

    // the readout, the minimap and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); }

    // its portal visibility (the interior kit's VisInspector): floor map, traversal, frames on the handheld
    get inspector() { return this.app?.inspector || null; }

    set(key, v) {
        const o = this.app.opts;
        if (key in o && typeof o[key] === typeof v) o[key] = v;
    }
}

return { create: ctx => new PortalWorld(ctx) };
});
