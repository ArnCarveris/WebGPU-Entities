'use strict';
// The app's commands: every setting the keys, the menus and the host change, each with its toast.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp } = Common;
const { QUALITY, RENDER_MODES, RAIN_VARIANTS, BUS, WALK, BusLine, HURRICANE, Supercell, TORNADO } = feature;

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
        a.menus.sync();
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

    toggleBloom() {
        const a = this.app;
        a.bloom = !a.bloom;
        a.hud.toast(`Bloom: ${a.bloom ? 'on' : 'off'}`);
        a.menus.sync();
    }

    // to bus i: outside its front door while it stands at a stop, else aboard in the aisle
    toBus(i) {
        const a = this.app, bus = a.world.buses[i];
        if (!bus) return;
        a.busPick = i;
        const doorX = BUS.bay0 + (BUS.doorBays[0] + 0.5) * BUS.bay;
        if (bus.mode === 'dwell') {
            const p = bus.toWorld([doorX, 0, BUS.hw + 1.2]);
            a.walker.place(a, p[0], p[2], p[1]);
            a.walker.eye(a);
            a.camera.lookAt(bus.toWorld([doorX, 1.5, 0]));
        } else {
            a.walker.place(a, bus.pose.x, bus.pose.z);
            Object.assign(a.walker, { bus, seat: null, feet: [-1.0, BUS.floor, 0], busYaw: bus.yaw });
            a.camera.yaw = bus.yaw;
        }
        a.camera.pitch = 0;
        a.reset = true;
        a.hud.toast(`${bus.label}: ${bus.describe()}`);
        a.menus.sync();
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

    setHurricane(cat) {
        const a = this.app;
        a.world.hurricaneCat = cat;
        a.reset = true;
        a.menus.sync();
        a.hud.toast(cat ? `${HURRICANE[cat].name} hurricane, eye at ${a.world.hurricanePos.map(v => (v / 1000).toFixed(0)).join(', ')} km` : 'Hurricane: off');
    }

    setTornado(cat) {
        const a = this.app, w = a.world, P = a.clouds.persistent;
        w.tornadoCat = cat;
        a.menus.sync();
        if (!cat) { a.hud.toast('Tornado: off'); return; }
        // no supercell showing: show the first one the scenario places
        if (!w.tornadoHost) {
            const e = P.find(e => e instanceof Supercell);
            if (e) a.clouds.set(P.indexOf(e), true, false);
        }
        const host = w.tornadoHost;
        a.hud.toast(host ? `${TORNADO[cat].name} tornado under ${host.def.label || host.id}` : `${TORNADO[cat].name} tornado: waiting for a supercell`);
    }

    jump(v) {
        const a = this.app, cam = a.camera, e = v.follow && a.world.get(v.follow);
        a.walker.active = false;
        // a view on a hidden persistent cloud shows it, and J then toggles it
        const pick = a.clouds.persistent.indexOf(e);
        if (pick >= 0) a.clouds.set(pick, true, false);
        if (v.spot === 'seat' && e instanceof BusLine) {
            // aboard the bus, in a seat
            a.walker.sit(a, e.buses[0]);
            a.walker.eye(a);
        } else if (v.spot && e?.spots?.[v.spot]) {
            // a viewpoint the entity laid out (a village's bus stop)
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
        if (v.hurricane !== undefined && v.hurricane !== a.world.hurricaneCat) this.setHurricane(v.hurricane);
        a.reset = true;
        a.hud.toast(v.name);
    }
}

return { Controls };
});
