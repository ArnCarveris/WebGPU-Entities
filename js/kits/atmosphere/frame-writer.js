'use strict';
// The frame uniform and the per-frame GPU data: camera and projection, sky, weather map domain, quality, rain, storm
// cells, cloud features and the weather probe. It keeps what the frame's render and the HUD read back (viewProj, the
// particle counts, the probe texel, the shadow slices). Written for the app that runs a world under this kit's Renderer
// (host: world (field, weather, lightning...), camera, renderer, settings (quality, cfg, sun, time...), its surroundings
// (near...), extensions). What the features draw this frame, the cabin the camera is in and what shelters it from the
// weather are its app's extensions' (AppExtension.draws / cabin / shelter: app/app.js).

Features.kit('atmosphere', (engine, kit) => {
const { Common } = engine;
const { clamp, sat01, v3, m4, frustumPlanes } = Common;
const {
    NEAR, WEATHER_RES, SHADOW_NEAR, GROUND_RES, CELL_FLOATS, QUALITY, SHADOW_SLICES, FROXEL_NEAR, BUS_UNIFORM,
} = kit;
const { rainFall, Sky } = engine.kits.weather;
const { Outdoors } = engine.kits.world;

class FrameWriter {
    constructor(app) {
        this.app = app;
        this.viewProj = new Float32Array(16);
        this.prevViewProj = null;
        this.offset = null;             // the clouds' wind offset this frame, and the last frame's (prevOffset)
        this.prevOffset = null;
        this.shadowKey = '';            // what the shadow map was last fully drawn for
        this.shadowSlices = 1;
        this.drops = null;              // (none until the first frame is written)
        this.rainParticles = 0;
        this.drips = 0;
        this.splashStart = 0;           // the first splash particle (after the rain and the drips)
        this.probeTexel = [0, 0];
        this.groundSnowHint = 'none';
    }

    // after the frame is submitted: its projection is the next one's history
    advance() { this.prevViewProj = this.viewProj; this.prevOffset = this.offset; }

    // the camera as it renders this frame (the projection write() puts in the globals): { viewProj, height (px) }
    view() {
        const a = this.app, r = a.renderer, cam = a.camera, { fwd, right, up } = cam.basis();
        const proj = m4.reversedInfinite(cam.fov, r.width / r.height, a.walker.active ? 0.05 : NEAR);
        return { viewProj: m4.mul(proj, m4.view(cam.pos, right, up, fwd)), height: r.height };
    }

    write(dt, wdt) {
        const a = this.app, r = a.renderer, F = r.frame, cam = a.camera, w = a.world, c = w.weather.cur, cfg = a.cfg, q = QUALITY[a.quality];
        const sun = a.sun, sky = Sky.compute(sun.azimuth, sun.elevation, sun.intensity, c, sun.moon);
        const aspect = r.width / r.height, tanY = Math.tan(cam.fov / 2), tanX = tanY * aspect;
        const { fwd, right, up } = cam.basis();
        // on foot the near plane comes in to 5 cm (seat backs and bus walls are within a metre); reversed-Z keeps the far depth precise
        const near = a.walker.active ? 0.05 : NEAR, proj = m4.reversedInfinite(cam.fov, aspect, near);
        this.viewProj = m4.mul(proj, m4.view(cam.pos, right, up, fwd));
        // what the features draw this frame (their AppExtension.draws: the buses near, the rooms the portal traversal reaches
        // and their lifts, the world-space GUIs); one that sees the outdoors from inside sets this.outdoors ({ seen, rect });
        // the camera inside another world of a composition sees it only as that world does (fx.outdoors)
        this.outdoors = null;
        const view = { proj, near, basis: { fwd, right, up }, aspect, planes: frustumPlanes(this.viewProj, { reversed: true }) };
        a.each('draws', this, view);
        this.outdoors = r.outdoors = Outdoors.meet(this.outdoors, a.fx.outdoors, r.width, r.height);
        // the cabin the rain and the march leave out (the features': AppExtension.cabin() { rank, inv (world to its frame),
        // lo, hi }, the lowest rank's: the lift car the camera is in, the bus ridden or the nearest, the building it is in),
        // or none
        let cabin = null;
        for (const x of a.extensions) { const cb = x.cabin?.(); if (cb && (!cabin || cb.rank < cabin.rank)) cabin = cb; }
        if (cabin) {
            F.set('busInv', cabin.inv);
            F.set('cabinLo', cabin.lo);
            F.set('cabinHi', cabin.hi);
        } else F.set('cabinLo', [0, 0, 0, 0]);
        // weather map follows the camera, snapped to its texels so it does not swim
        const ws = cfg.weatherSize, texel = ws / WEATHER_RES;
        const wo = [Math.floor((cam.pos[0] - ws / 2) / texel) * texel, Math.floor((cam.pos[2] - ws / 2) / texel) * texel];
        const f = w.field;
        F.set('viewProj', this.viewProj);
        F.set('prevViewProj', this.prevViewProj || this.viewProj);
        F.set('cam', [...cam.pos, a.time % 3600]);
        // the outdoors curved about the eye: the terrain drawn out to past the horizon over the highest peak
        w.curvature.setEye(cam.pos);
        F.set('curve', w.curvature.gpu(w.field.max - w.curvature.reference));
        F.set('fwd', [...fwd, near]);
        F.set('right', [...v3.mul(right, tanX), a.frameNo % 1024]);
        F.set('up', [...v3.mul(up, tanY), a.weatherTime]);
        F.set('sunDir', [...sky.dir, sun.moon]);
        F.set('sunCol', [...sky.sun, sun.exposure]);
        F.set('zenith', [...sky.zenith, 0.00007 * c.haze]);
        F.set('horizon', [...sky.horizon, 1400]);
        // a flash floods the eye only as much as it sees of the outdoors (from a sealed room, none: RoomVis.outdoors)
        const od = this.outdoors, seenOut = !od || !od.seen ? (od ? 0 : 1) : od.rect ? Math.sqrt((od.rect[2] - od.rect[0]) * (od.rect[3] - od.rect[1]) / Math.max(1, r.width * r.height)) : 1;
        F.set('ambient', [...sky.ambient, a.flashVeil * seenOut]);
        F.set('screen', [r.width, r.height, r.cloudPass.w, r.cloudPass.h]);
        F.set('cloud', [c.base, Math.max(c.top, c.base + 400), c.density, c.coverage]);
        F.set('noise', [cfg.shapeScale, cfg.detailScale, cfg.detailStrength, cfg.maxTop]);
        F.set('wind', [...c.wind, ...w.weather.offset]);
        F.set('precip', [w.weather.freezingLevel, cfg.slant, cfg.rainExtinction, cfg.snowExtinction]);
        F.set('wdomain', [wo[0], wo[1], ws, WEATHER_RES]);
        F.set('tdomain', [f.origin, f.origin, f.size, f.n]);
        // (beyond the map, terrain.outside: the plain at its base (0), the sea (1), or none (-1): what lies behind it shows)
        F.set('geo', [w.terrain.style === 'natural' ? 1 : 0, { sea: 1, none: -1 }[w.terrain.outside] ?? 0, r.terrainLod.range0, w.terrain.moisture ?? 0.5]);
        F.set('tdetail', [f.rough, f.coastBand, r.terrainLod.step, r.vegetation ? (f.canopy ? 2 : 1) : 0]);
        // (beyond a map with no ground of its own, in a composition: the ground of the world it stands on, in the other
        // worlds' merged picture (fx.inject), its last terrain.edge m fading into it: fsTerrain)
        F.set('outside', [a.fx.inject ? 1 : 0, 0, 0, w.terrain.outside === 'none' ? w.terrain.edge || 0 : 0]);
        F.set('ground', [w.terrain.fieldSize, w.terrain.pivots, GROUND_RES, this.outdoors?.seen === false ? 1 : a.mode]);     // (mode 1: the scene alone, no volumetrics: also indoors with the outdoors out of sight)
        F.set('cirrus', [cfg.maxTop + 800, c.cirrus, 9000, c.drizzle]);
        F.set('march', [q.steps, q.light, cfg.maxDistance, a.radar ? 1 : 0]);
        // the weather and shadow maps refresh a slice of rows per frame, unless the map moved or the sun / weather jumped (a new target
        // weather starts its blend with one full refresh; the blend itself is gradual enough for the slices to follow)
        const shadowKey = `${wo[0]},${wo[1]},${sky.dir.map(v => v.toFixed(2))},${w.weather.target}`;
        const full = a.reset || shadowKey !== this.shadowKey;
        this.shadowKey = shadowKey;
        F.set('lod', [q.interleave, full ? 1 : SHADOW_SLICES, full ? 0 : a.frameNo % SHADOW_SLICES, q.detail]);
        this.shadowSlices = full ? 1 : SHADOW_SLICES;
        // the near shadow maps, each about where the sun rays from the ground under the eye cross the lowest cloud's
        // height (layerInfo.z, as the sky last wrote it: shadowAt's lookup), in steps of an eighth of its size; a step, a
        // new sun or weather refreshes that map whole
        const groundY = Math.min(cam.pos[1], f.sample(cam.pos[0], cam.pos[2]));
        const lift = Math.max(F.data[F.offsets.layerInfo + 2] - groundY, 0) / Math.max(sky.dir[1], 0.08);
        this.nearKeys ??= [];
        F.set('sdomain', SHADOW_NEAR.flatMap((size, k) => {
            const step = size / 8, no = [0, 2].map(i => Math.round((cam.pos[i] + sky.dir[i] * lift) / step) * step - size / 2);
            const key = `${no},${sky.dir.map(v => v.toFixed(2))},${w.weather.target}`, whole = a.reset || key !== this.nearKeys[k];
            this.nearKeys[k] = key;
            return [no[0], no[1], size, whole ? 1 : SHADOW_SLICES];
        }));
        F.set('froxel', [FROXEL_NEAR, cfg.maxDistance, a.froxels ? 1 : 0, 0]);
        F.set('post', [q.blur || 0, a.tiles ? 1 : 0, a.radarTop || 0, cfg.bloomBolt]);
        // how far the wind carried the clouds since the last frame: the resolve reprojects the history along with them
        const off = this.offset = [...w.weather.offset], prev = this.prevOffset || off;
        F.set('look', [q.smooth || 0, off[0] - prev[0], off[1] - prev[1], q.steady || 0]);
        F.set('bloom', [a.bloom ? cfg.bloom : 0, cfg.bloomThreshold, cfg.bloomKnee, r.bloomViews?.length || 1]);
        // heavy rain: up to three times the drops (big drops, past intensity 0.6)
        const drops = this.drops = w.rainZones.drops(cam.pos[0], cam.pos[2], c.drops);
        this.rainParticles = Math.round(cfg.particles * (1 + 2 * sat01((a.near.rain - 0.6) / 0.8) * drops));
        F.set('rain', [drops, rainFall(drops), c.rain, this.rainParticles]);
        w.rainZones.write(F);
        // what shelters from the weather (AppExtension.shelter: the structures' boxes, their sun and rain shadows, the roof
        // edges the rain drips off: this.drips of them, this.dripParticles the drops falling off them)
        this.drips = this.dripParticles = 0;
        a.each('shelter', this, F, { cam: cam.pos, sun: sky.dir, wind: c.wind, freezing: w.weather.freezingLevel, fall: rainFall(drops) });
        a.lights.write(F, cam.pos, fwd, right, up);
        this.splashStart = this.rainParticles + (this.drips && a.near.rain > 0.02 ? this.dripParticles : 0);
        F.set('drips', [this.splashStart], 1);
        F.set('misc', [c.temperature, a.time * cfg.fallSpeed % 52000, f.base, wdt]);
        w.lightning.write(F);

        const cells = w.gpuCells(cam.pos), cd = r.cellData;
        cd.fill(0);
        cells.forEach((s, i) => cd.set([s.x, s.z, s.radius, s.top, s.coverage, s.precip, s.seed, s.virga, s.core, s.offset[0], s.offset[1], 0,
            s.shelf || 0, s.laminar || 0, s.green || 0, s.wall || 0], i * CELL_FLOATS));
        const feat = w.features();
        feat.ms.forEach((m, i) => F.set('ms', m, i * 12));
        feat.shelves.forEach((sl, i) => F.set('shelves', sl, i * 16));
        F.set('tornado', feat.tornado || new Array(16).fill(0));
        const hurricane = w.hurricaneData(cfg.maxTop);
        F.set('hurricane', hurricane || new Array(12).fill(0));
        // highest cloud anywhere: nothing to sample above it
        const tops = [c.top + 200, ...cells.map(cl => cl.top + 200), ...feat.ms.map(m => m[5] + 2500), ...(hurricane ? [hurricane[4] + 200] : [])];
        for (const d of w.clouds.defs) if (w.clouds.coverage(c, d) > 0.005) tops.push(d.top);
        F.set('features', [feat.ms.length, feat.shelves.length, Math.min(Math.max(...tops), cfg.maxTop), 0]);
        // the march and shadow map start at the lowest cloud: wall clouds and shelf lips hang low
        const lows = [...feat.ms.map(m => m[4] - m[8] - 100), ...feat.shelves.map(sl => f.base + sl[8] - 300)];
        w.clouds.write(F, c, Math.min(c.base, ...lows.map(y => y + 1300)));
        F.set('near', [a.near.rain, a.near.snow, a.reset ? 1 : 0, cells.length]);
        r.device.queue.writeBuffer(r.boltBuf, 0, w.lightning.segs);

        // probe texel: where the precipitation above the camera left the cloud base
        const drop = Math.max(c.base - cam.pos[1], 0) * cfg.slant;
        const px = cam.pos[0] + c.wind[0] * drop, pz = cam.pos[2] + c.wind[1] * drop;
        this.probeTexel = [clamp(Math.floor((px - wo[0]) / texel), 0, WEATHER_RES - 1), clamp(Math.floor((pz - wo[1]) / texel), 0, WEATHER_RES - 1)];
        this.groundSnowHint = w.weather.freezingLevel < f.base + 150 ? 'settling' : w.weather.freezingLevel < f.max ? 'on the peaks' : 'melting';
    }
}

return { FrameWriter };
});
