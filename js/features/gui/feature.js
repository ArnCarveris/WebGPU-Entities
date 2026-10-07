'use strict';
// Entity GUI, as a feature of WebGPU Entities: Doom 3-style world-space GUIs (an airlock terminal with CCTV, a paint
// easel) in a facility built from data. The engine is the one from the WebGPU-EntityGUI demo; the host
// (js/engine/host.js) gives it its device, canvas target and input, and builds its scenario from entities ("gui.*", see
// js/engine/scenario-format.js). Its GUI toolkit is the gui kit (js/kits/gui/), and its phone is the engine's
// handheld (js/engine/handheld.js): the facility lends it pages, bindings and apps (radar, camera, gallery, IPTV) and
// its render targets.
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.gui (js/engine/features.js).

Features.part('gui', (engine, feature) => {
const { kits } = engine;
const { FeatureWorld } = kits.world;
const { Interior, InteriorIndex, Origin } = kits.interior;
const { Game } = feature;

// This demo as one world of the engine (js/engine/host.js calls these). All of its UI is in the 3D scene (and on the
// engine's handheld).
class GuiWorld extends FeatureWorld {
    createApp(fx) { return new Game(fx); }

    // classic 0..1 depth, near 0.02, far 100 or the scenario's player.far (depth-stencil, the depth aspect)
    depth() {
        const r = this.app.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.02, far: this.app.far };
    }

    // the player's view
    get view() { return this.app.player.view; }
    setView(v) { this.app.player.setView(v); }

    // its player walks the facility, always
    get moves() { return ['walk']; }
    get move() { return 'walk'; }
    setMove(mode) {}

    // the facility is a building (kits.interior): the room within the player's bounds and the corridor beyond the
    // doorway, joined by the hatch (a door portal), both weather shelters
    sheltered(p) {
        const P = this.app?.player;
        if (!P) return null;
        if (!this.interiors) {
            const { bounds: b, doorway: d } = P.cfg, ix = this.interiors = new InteriorIndex(8), at = Origin.IDENTITY, top = 4;
            const hatch = { c: [(d.x[0] + d.x[1]) / 2, 1.2, b.z[0]], n: [0, 0, -1], w: d.x[1] - d.x[0], h: 2.4, kind: 'door', open: () => this.app.world.get(d.door).passable };
            ix.add(new Interior({ owner: this, origin: at, lo: [b.x[0] - 0.3, -0.5, b.z[0] - 0.3], hi: [b.x[1] + 0.3, top, b.z[1] + 0.3], portals: [hatch] }));
            ix.add(new Interior({ owner: this, origin: at, lo: [d.x[0] - 0.3, -0.5, d.minZ - 0.3], hi: [d.x[1] + 0.3, top, b.z[0]], portals: [{ ...hatch, n: [0, 0, 1] }] }));
        }
        return this.interiors.sheltered(p);
    }

    stats() {
        const g = this.app, w = g.world, P = g.player;
        return {
            fps: Number(g.stats.fps) || 0, lightsOn: w.lightsOn, alarm: w.alarm, phone: g.handheld.visible, moving: P.moving, running: P.running,
            noise: P.noise, gui: g.interaction.focus ? g.interaction.focus.name || 'gui' : '', sound: g.audio.enabled,
        };
    }

    set(key, v) {
        const w = this.app.world;
        if (key === 'lights' && !!v !== w.lightsOn) w.setLights(!!v);
        else if (key === 'alarm' && !!v !== w.alarm) w.setAlarm(!!v);
        else if (key === 'phone') this.app.handheld.setShown(!!v);
    }
}

return { create: ctx => new GuiWorld(ctx) };
});
