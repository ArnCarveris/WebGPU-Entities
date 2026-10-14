'use strict';
// The app's commands: every setting the keys, the menus and the host change, each with its toast. An app extension
// adds its own commands itself, and takes part in a jump to a view (beforeJump / afterJump).

Features.kit('atmosphere', (engine, kit) => {
const { Common } = engine;
const { DEG, clamp } = Common;
const { QUALITY, RENDER_MODES } = kit;
const { RAIN_VARIANTS } = engine.kits.weather;
const { WALK } = engine.kits.settlement;

class Controls {
    constructor(app) { this.app = app; }

    setTimeScale(t) {
        const a = this.app;
        a.timeScale = t;
        a.hud.toast(`Weather time ×${t}`);
        a.menus.sync();
    }

    pickLight(name) {
        const a = this.app;
        this.setLight(name);
        a.hud.toast(`Lighting: ${a.lightName}`);
        a.menus.sync();
    }

    setLight(name) {
        const a = this.app, p = a.lightPresets[name] || {};
        a.lightName = name || 'default';
        a.sun = { azimuth: (p.azimuth ?? 150) * DEG, elevation: (p.elevation ?? 35) * DEG, intensity: p.intensity ?? 12, exposure: p.exposure ?? 0.45,
            moon: p.moon ? clamp(p.moon, 0.02, 1) : 0 };
    }

    // walk from here (down on the ground below the camera), or fly again
    setWalk(on) {
        const a = this.app;
        if (on === a.walker.active) return;
        if (!on) { a.walker.active = false; a.walker.bus = null; a.hud.toast('Flying'); }
        else {
            const c = a.camera.pos, y = c[1] - WALK.eye, f = a.world.field;
            a.walker.place(a, c[0], c[2], y - f.surface(c[0], c[2]) < 3 ? y : undefined);
            a.camera.pitch = 0;
            a.hud.toast('Walking');
        }
        a.reset = true;
        a.menus.sync();
    }

    setView(i) {
        const a = this.app;
        if (!a.views[i]) return;
        a.viewIndex = i;
        this.jump(a.views[i]);
    }

    setQuality(i) {
        const a = this.app;
        a.quality = i;
        a.reset = true;
        a.hud.toast(`Quality: ${QUALITY[i].name}`);
        a.menus.sync();
    }

    setMode(i) {
        const a = this.app;
        a.mode = i;
        a.reset = true;
        a.hud.toast(`Render: ${RENDER_MODES[i]}`);
        a.menus.sync();
    }

    toggleFroxels() {
        const a = this.app;
        a.froxels = !a.froxels;
        a.hud.toast(`Froxel lighting: ${a.froxels ? 'on' : 'off'}`);
        a.menus.sync();
    }

    toggleTiles() {
        const a = this.app;
        a.tiles = !a.tiles;
        a.hud.toast(`Cloud tile pre-pass: ${a.tiles ? 'on' : 'off'}`);
        a.menus.sync();
    }

    // how round the planet the outdoors is drawn on (the world's Curvature: 0 flat .. 1, Curvature.amount)
    setCurvature(s) {
        const a = this.app, cv = a.world.curvature;
        cv.setAmount(s);
        a.reset = true;                 // no ghost of the last shape in the temporal history
        a.menus.sync();
    }

    toggleBloom() {
        const a = this.app;
        a.bloom = !a.bloom;
        a.hud.toast(`Bloom: ${a.bloom ? 'on' : 'off'}`);
        a.menus.sync();
    }

    // to bus i (B): at its door (Bus.board)
    toBus(i) {
        const a = this.app, bus = a.world.buses[i];
        if (!bus) return;
        a.busPick = i;
        a.walker.active = false;
        bus.board(a, 'door');
        a.reset = true;
        a.hud.toast(`${bus.label}: ${bus.describe()}`);
    }

    setWeather(name) {
        const a = this.app;
        a.world.weather.set(name);
        a.fx.emit('weather', { name });
        a.hud.toast(`${RAIN_VARIANTS.includes(name) ? 'Rain' : 'Weather'}: ${a.world.weather.target}`);
        a.menus.sync();
    }

    toggleCycle() {
        const a = this.app, wx = a.world.weather;
        wx.cycle.enabled = !wx.cycle.enabled;
        wx.cycleClock = wx.cycle.hold;
        a.hud.toast(`Auto weather ${wx.cycle.enabled ? 'on' : 'off'}`);
        a.menus.sync();
    }

    // to view v (a `view` entity): its pos / look, or on what it follows (the entity `follow`, or `member` of it): boarding it
    // (board(app, spot): a bus's seat or door), at a spot it laid out (a village's bus stop), or offset from its focus
    jump(v, member = null) {
        const a = this.app, cam = a.camera, e = member || (v.follow && a.world.get(v.follow));
        a.walker.active = false;
        for (const x of a.extensions) x.beforeJump?.(v, e);
        if (e?.board) e.board(a, v.spot);
        else if (v.spot && e?.spots?.[v.spot]) {
            cam.pos = [...e.spots[v.spot].pos];
            cam.lookAt(e.spots[v.spot].look);
        } else if (e?.focus) {
            // relative to a moving entity: offset from its focus point, height above the ground there
            const f = e.focus, o = v.offset || [0, 0, 0], l = v.lookOffset || [0, 2000, 0];
            const x = f[0] + o[0], z = f[2] + o[2];
            cam.pos = [x, a.world.field.sample(x, z) + o[1], z];
            cam.lookAt([f[0] + l[0], f[1] + l[1], f[2] + l[2]]);
        } else {
            cam.pos = [...v.pos];
            if (v.look) cam.lookAt(v.look);
        }
        // on foot from there (`walk`)
        if (v.walk && !a.walker.active) { a.walker.place(a, cam.pos[0], cam.pos[2], cam.pos[1] - WALK.eye); a.walker.eye(a); }
        if (v.lighting && a.lightPresets[v.lighting]) this.setLight(v.lighting);
        if (v.weather) a.world.weather.set(v.weather);
        for (const x of a.extensions) x.afterJump?.(v, e);
        a.reset = true;
        a.hud.toast(member ? `${member.label}: ${member.describe?.() ?? ''}` : v.name);
    }
}

return { Controls };
});
