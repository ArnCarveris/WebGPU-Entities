'use strict';
// Entity Portal, as a feature of WebGPU Entities: a Portal-Room visibility system after Far Cry 1's VisArea/Portal and
// SECTR (sectors, portals, occluders, stencil-masked traversal), with an island outdoors, a ship and drones. The engine
// is the one from the WebGPU-EntityPortal demo; the host (js/engine/host.js) gives it its device, canvas target, input
// and HUD root, and builds its scenario from entities ("portal.*", see js/engine/scenario-format.js).
//
// This file: the feature's adapter to the host (Site). The engine's parts load before it, in the order of
// Features.PARTS.portal (js/engine/features.js).

Features.world('portal', (engine, kit) => {
const { kits } = engine;
const { Site } = kits.world, { HUD } = Site;
const { MASK_MODES, AppExtension, phonePages } = kit;

// This demo as one world of the engine (js/engine/host.js calls these).
const portalWorld = {
    hud: HUD.crosshair + HUD.toast,

    app(app, fx) {
        app.extend(AppExtension, fx);
        app.onError = fx.fail;
        return app;
    },

    // classic 0..1 depth, near 0.05, far 400; 4x MSAA depth-stencil (the depth aspect)
    depth() {
        const r = this.app.renderer;
        const s = r.frameSpec;
        return r.depthSample && { view: r.depthSample, kind: s.depth, near: s.near, far: 400, samples: s.samples };
    },

    get view() {
        const P = this.app.player, { fwd, up } = P.basis();
        return { pos: [...P.cam.pos], fwd, up, fov: P.cam.fov };
    },

    setView(v) {
        const P = this.app.player, c = P.cam;
        c.setView(v);
        P.driving = null;
        P.reset(c.pos);
    },

    // its player walks (collision, stairs, ladders, swimming) or flies through walls; the engine switches it
    get moves() { return ['fly', 'walk']; },
    get move() { return this.app.opts.walk ? 'walk' : 'fly'; },

    // the keys there are (Site.keys; every option is on the handheld): walking, flying through walls, at the helm
    get keys() {
        const P = this.app.player, look = Site.LOOK_KEYS[this.move];
        if (P?.driving) return [look, ['W / S', 'throttle'], ['A / D', 'rudder'], ['X', 'stop'], ['Space', 'rudder centre'], ['F', 'leave the helm']];
        if (this.move === 'fly') return [look, ['WASD', 'move'], ['Space / E', 'up'], ['Q / Ctrl', 'down'], ['Shift', 'fast'], ['F', 'door / helm']];
        return [look, ['WASD', 'walk'], ['Shift', 'run'], ['Space', 'jump'], ['F', 'door / helm']];
    },
    setMove(mode) {
        const g = this.app, P = g.player;
        if (P?.driving) g.hud.toast(P.toggleHelm());
        g.opts.walk = mode === 'walk';
        if (g.opts.walk && P) P.reset(P.cam.pos);
    },

    // floors, terrain (not indoors), the ship's decks, closed hatches
    ground(p) {
        const w = this.app.world;
        if (!w) return null;
        const g = w.groundAt(p, 0).y;
        return g === -Infinity ? null : g;
    },

    // its areas but the outdoors are weather shelters (Area.shelter)
    sheltered(p) { return this.app.world?.shelterAt(p) || null; },

    stats() {
        const g = this.app, w = g.world, P = g.player, s = g.stats, cam = P.cam.pos;
        const area = w.areas[w.areaAt(cam)], ship = w.vehicles[0];
        return {
            name: w.scn.name, fps: s.fps, area: area.name, outdoor: !!area.outdoor, onShip: !!area.vehicle, state: P.stateLabel,
            swimming: !!P.swimming, driving: !!P.driving, culling: g.opts.culling, mode: g.frameMode, draws: s.draws, tris: s.tris,
            shipSpeed: ship ? ship.v : 0, shipDist: ship ? Math.hypot(ship.M[12] - cam[0], ship.M[14] - cam[2]) : 1e9,
            drones: w.drones.length,
        };
    },

    // the readout, the minimap and every option, on the engine's handheld (js/engine/handheld.js)
    handheld() { return phonePages(this.app); },

    // its portal visibility (the interior kit's VisInspector): floor map, traversal, frames on the handheld
    get inspector() { return this.app?.inspector || null; },

    // its outdoors' terrain (the island), down to its lowest ground (Site.footprint)
    footprint() {
        const o = this.app.world?.outdoors, t = o?.terrain;
        if (!t?.extent) return null;
        const [x0, z0, x1, z1] = t.extent;
        let floor = Infinity;
        for (let z = z0; z <= z1; z += 4) for (let x = x0; x <= x1; x += 4) floor = Math.min(floor, o.height(x, z));
        return { lo: [x0, z0], hi: [x1, z1], floor, ground: true };
    },

    // toward the sun of its outdoors, the same everywhere
    sunDir() { const w = this.app?.world; return w ? engine.Common.v3.norm(w.sunDir) : null; },

    set(key, v) {
        const o = this.app.opts;
        if (key === 'sunDir' && Array.isArray(v)) this.app.world.sunAlong = engine.Common.v3.norm(v);
        else if (key in o && typeof o[key] === typeof v) o[key] = v;
    },
};

return { spec: portalWorld };
});
