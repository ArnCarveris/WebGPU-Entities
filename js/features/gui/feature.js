'use strict';
// Entity GUI, as a feature of WebGPU Entities: Doom 3-style world-space GUIs (an airlock terminal with CCTV, a paint
// easel) in a facility built from data. The engine is the one from the WebGPU-EntityGUI demo; the host
// (js/engine/host.js) gives it its device, canvas target and input, and builds its scenario from entities ("gui.*", see
// js/engine/scenario-format.js). Its GUI toolkit is the engine's (js/engine/gui-kit.js), and its phone is the engine's
// handheld (js/engine/handheld.js): the facility lends it pages, bindings and apps (radar, camera, gallery, IPTV) and
// its render targets.
//
// This file: the feature's adapter to the host (FeatureWorld). The engine's parts load before it, in the order of
// Features.PARTS.gui (js/engine/features.js).
//
// ------------------------------------------------------------------------------------------------ js/core/audio.js
// Sound effects as events of this world (door, step, shutter, chime, key, tap...): what each one sounds like is
// scenario data (sound.cue entities, synthesised by the engine's AudioEngine).

Features.part('gui', (engine, feature) => {
const { Game } = feature;

// This demo as one world of the engine (js/engine/host.js calls these). All of its UI is in the 3D scene (and on the
// engine's handheld).
class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = '';
    }

    async init() {
        this.game = new Game(this.fx);
        await this.game.start();
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // classic 0..1 depth, near 0.02, far 100 or the scenario's player.far (depth-stencil, the depth aspect)
    depth() {
        const r = this.game.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.02, far: this.game.far };
    }

    get view() {
        const P = this.game.player, { fwd, up } = P.basis();
        return { pos: [...P.pos], fwd, up, fov: P.fovy };
    }

    setView(v) {
        const P = this.game.player;
        P.pos[0] = v.pos[0]; P.pos[1] = v.pos[1]; P.pos[2] = v.pos[2];
        P.yaw = Math.atan2(v.fwd[0], -v.fwd[2]);
        P.pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd[1])));
        if (v.fov) P.fovDeg = v.fov * 180 / Math.PI;
    }

    stats() {
        const g = this.game, w = g.world, P = g.player;
        return {
            fps: Number(g.stats.fps) || 0, lightsOn: w.lightsOn, alarm: w.alarm, phone: g.handheld.visible, moving: P.moving, running: P.running,
            noise: P.noise, gui: g.interaction.focus ? g.interaction.focus.name || 'gui' : '', sound: g.audio.enabled,
        };
    }

    set(key, v) {
        const w = this.game.world;
        if (key === 'lights' && !!v !== w.lightsOn) w.setLights(!!v);
        else if (key === 'alarm' && !!v !== w.alarm) w.setAlarm(!!v);
        else if (key === 'phone') this.game.handheld.setShown(!!v);
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
