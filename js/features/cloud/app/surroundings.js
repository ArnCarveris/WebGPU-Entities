'use strict';
// Where the camera is, each frame: what falls on it, whether it is indoors, aboard or near a bus, or sheltered, and how
// much a lightning flash lights it. The app keeps the results (near, indoors, rideBus, inBus, sheltered, flashVeil),
// which the frame, the sounds, the HUD and the host read.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { sat01, lerp, smoothstep, v3 } = Common;
const { rainFall, BUS_DRAW } = feature;

class Surroundings {
    constructor(app) { this.app = app; }

    update() {
        const a = this.app, w = a.world, cp = a.camera.pos;
        a.indoors = w.structures.buildings.inside(cp);
        a.probe = a.renderer.weatherPass.probe;
        // another world's roof (a composition's link: set('indoors')) keeps the rain off as this world's own do
        a.near = a.forceIndoors ? { rain: 0, snow: 0 } : this.nearPrecip();
        // under a roof or a deck: the way the drops come (as rainBack in WGSL) is blocked; or in the bus
        const c = w.weather.cur, fall = a.near.snow > a.near.rain ? 1.35 : rainFall(c.drops);
        // the bus nearest the camera within BUS_DRAW (the InteriorIndex's rings, O(1); the sounds and the readout read
        // it); the bus ridden, the one whose cabin the camera is in, or that nearest (its cabin keeps the rain out, the
        // HUD tells of it)
        const near = w.structures.interiors.nearest(cp, 'vehicle', BUS_DRAW);
        a.nearBus = near ? { bus: near.it.owner, dist: near.d } : { bus: null, dist: Infinity };
        const cabin = w.structures.interiors.at(cp, 'vehicle');
        a.rideBus = (a.walker.active && a.walker.bus) || cabin?.owner || a.nearBus.bus;
        a.inBus = !!a.rideBus?.interior?.contains(cp);
        a.sheltered = a.near.rain + a.near.snow > 0.01 && (a.inBus || !!a.indoors || !!w.structures.interiors.sheltered(cp)
            || w.structures.boxes.shelters(cp, v3.norm([-c.wind[0] * 0.8, fall, -c.wind[1] * 0.8])));
        a.flashVeil = w.lightning.veil(cp) * (a.indoors || a.inBus || a.forceIndoors ? 0.4 : 1);
    }

    // what is falling on the camera, from the weather probe (sampled where precipitation over us left the cloud base)
    nearPrecip() {
        const a = this.app, wx = a.world.weather, c = wx.cur, y = a.camera.pos[1], pr = a.probe;
        // virga, overwhelmed by a downpour as virgaOf() in WGSL
        const virga = pr.virga * (1 - sat01((pr.precip - 0.6) / 0.8));
        const g = a.world.field.base, bottom = lerp(g - 300, c.base, virga);
        if (y > c.base + 200 || pr.precip < 0.01) return { rain: 0, snow: 0 };
        const k = pr.precip * smoothstep(bottom, bottom + 300, y);
        const snow = smoothstep(wx.freezingLevel - 250, wx.freezingLevel + 250, y);
        return { rain: k * (1 - snow), snow: k * snow };
    }
}

return { Surroundings };
});
