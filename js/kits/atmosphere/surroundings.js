'use strict';
// Where the camera is, each frame: what falls on it, whether it is sheltered, and how much a lightning flash lights it;
// whether it is indoors, aboard or near a bus is the features' to say (AppExtension.surround(p): the app's indoors,
// nearBus, rideBus, inBus; shelters(p, dir): what keeps the rain coming along -dir off p). The app keeps the results
// (near, indoors, rideBus, inBus, sheltered, flashVeil), which the frame, the sounds, the HUD and the host read (host: the
// app, as FrameWriter's).

Features.kit('atmosphere', (engine, kit) => {
const { Common } = engine;
const { sat01, lerp, smoothstep, v3 } = Common;
const { rainFall } = engine.kits.weather;
const NEAR_EASE = 0.6;      // s: the time constant the near-field precipitation eases with

class Surroundings {
    constructor(app) { this.app = app; }

    update(dt = 0) {
        const a = this.app, w = a.world, cp = a.camera.pos;
        a.indoors = null;
        a.nearBus = { bus: null, dist: Infinity };
        a.rideBus = null;
        a.inBus = false;
        a.each('surround', cp);
        a.probe = a.renderer.weatherPass.probe;
        // another site's roof (a site link: set('indoors')) keeps the rain off as this site's own do
        const target = a.forceIndoors ? { rain: 0, snow: 0 } : this.nearPrecip();
        // eased towards the target (the probe reads back in steps, and crossing the cloud base or a link's roof would
        // cut it): the emitters thin out or fill in over about a second instead of popping; a jump snaps it
        const k = a.reset ? 1 : 1 - Math.exp(-Math.max(dt, 0) / NEAR_EASE);
        const prev = a.near || target;
        a.near = { rain: lerp(prev.rain, target.rain, k), snow: lerp(prev.snow, target.snow, k) };
        if (a.near.rain < 1e-4) a.near.rain = 0;
        if (a.near.snow < 1e-4) a.near.snow = 0;
        // under a roof or a deck: the way the drops come (as rainBack in WGSL) is blocked; or in the bus
        const c = w.weather.cur, fall = a.near.snow > a.near.rain ? 1.35 : rainFall(c.drops);
        const dir = v3.norm([-c.wind[0] * 0.8, fall, -c.wind[1] * 0.8]);
        a.sheltered = a.near.rain + a.near.snow > 0.01 && (a.inBus || !!a.indoors || a.first('shelters', cp, dir));
        a.flashVeil = w.lightning.veil(cp) * (a.indoors || a.inBus || a.forceIndoors ? 0.4 : 1);
    }

    // what is falling on the camera, from the weather probe (sampled where precipitation over us left the cloud base)
    nearPrecip() {
        const a = this.app, wx = a.world.weather, c = wx.cur, y = a.camera.pos[1], pr = a.probe;
        // virga, overwhelmed by a downpour as virgaOf() in WGSL
        const virga = pr.virga * (1 - sat01((pr.precip - 0.6) / 0.8));
        const g = a.world.field.base, bottom = lerp(g - 300, c.base, virga);
        if (y > c.base + 200 || pr.precip < 0.01) return { rain: 0, snow: 0 };
        // thinning out over the bottom 200 m of the cloud (none falls from above its base)
        const k = pr.precip * smoothstep(bottom, bottom + 300, y) * (1 - smoothstep(c.base, c.base + 200, y));
        const snow = smoothstep(wx.freezingLevel - 250, wx.freezingLevel + 250, y);
        return { rain: k * (1 - snow), snow: k * snow };
    }
}

return { Surroundings };
});
