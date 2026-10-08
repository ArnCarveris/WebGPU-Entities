'use strict';
// The frame uniform and the per-frame GPU data: camera and projection, sky, weather map domain, quality, the buses
// and building interiors to draw, rain, storm cells, cloud features and the weather probe. It keeps what the frame's
// render and the HUD read back (viewProj, the particle counts, the probe texel, the shadow slices).

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { clamp, sat01, v3, m4, frustumPlanes } = Common;
const {
    NEAR, WEATHER_RES, GROUND_RES, DRIP_PARTICLES, CELL_FLOATS, QUALITY, SHADOW_SLICES, FROXEL_NEAR, rainFall,
    BUS_DRAW, BUS, INTERIOR_DRAW, BUS_UNIFORM, Sky,
} = feature;

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

    write(dt, wdt) {
        const a = this.app, r = a.renderer, F = r.frame, cam = a.camera, w = a.world, c = w.weather.cur, cfg = a.cfg, q = QUALITY[a.quality];
        const sun = a.sun, sky = Sky.compute(sun.azimuth, sun.elevation, sun.intensity, c, sun.moon);
        const aspect = r.width / r.height, tanY = Math.tan(cam.fov / 2), tanX = tanY * aspect;
        const { fwd, right, up } = cam.basis();
        // on foot the near plane comes in to 5 cm (seat backs and bus walls are within a metre); reversed-Z keeps the far depth precise
        const near = a.walker.active ? 0.05 : NEAR, proj = m4.reversedInfinite(cam.fov, aspect, near);
        this.viewProj = m4.mul(proj, m4.view(cam.pos, right, up, fwd));
        // each bus near enough to see (the InteriorIndex's coarse cells within BUS_DRAW, not every bus): its model-view
        // built in doubles about the camera (its interior a metre away would jitter in f32 world space), nearest first.
        // k: its slot in busData
        const draws = [];
        w.structures.interiors.near(cam.pos, BUS_DRAW, 'vehicle').forEach(({ owner: bus }) => {
            const k = bus.slot;
            const m = bus.model, dist = Math.hypot(m[12] - cam.pos[0], m[13] - cam.pos[1], m[14] - cam.pos[2]);
            if (dist > BUS_DRAW) return;
            const b = [-fwd[0], -fwd[1], -fwd[2]], rows = [right, up, b], mv = new Array(16).fill(0);
            for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 3; r2++) {
                const col = c < 3 ? [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]] : [m[12] - cam.pos[0], m[13] - cam.pos[1], m[14] - cam.pos[2]];
                mv[c * 4 + r2] = v3.dot(rows[r2], col);
            }
            mv[15] = 1;
            const o = k * BUS_UNIFORM / 4;
            r.busData.set(m4.mul(proj, mv), o);
            r.busData.set(m, o + 16);
            r.busData.set(bus.inverse, o + 32);
            r.busData.set([bus.v, bus.doors, 0, 0], o + 48);
            draws.push([dist, k]);
        });
        r.busDraws = draws.sort((p, q2) => p[0] - q2[0] || p[1] - q2[1]).map(e => e[1]);
        // building interiors within INTERIOR_DRAW of their centre (the same test fsWindow and fsPane make) that the camera
        // is in or sees into through a portal (a window, an open door) in the view frustum, nearest first: only the
        // InteriorIndex cells within INTERIOR_DRAW are visited, whatever the number of buildings
        const seen = w.structures.interiors.seen(cam.pos, frustumPlanes(this.viewProj, { reversed: true }), INTERIOR_DRAW, 'building');
        r.interiorDraws = seen.map(([, it]) => it.owner.range).map(([a, b]) => [a, b - a]).filter(e => e[1] > 0);
        // the cabin the rain and the march leave out: the bus ridden, or the nearest
        if (a.rideBus) {
            F.set('busInv', a.rideBus.inverse);
            F.set('cabinLo', [-BUS.hl, BUS.skirt, -BUS.hw, 1]);
            F.set('cabinHi', [BUS.hl, BUS.roof, BUS.hw, 0]);
        } else F.set('cabinLo', [0, 0, 0, 0]);
        // weather map follows the camera, snapped to its texels so it does not swim
        const ws = cfg.weatherSize, texel = ws / WEATHER_RES;
        const wo = [Math.floor((cam.pos[0] - ws / 2) / texel) * texel, Math.floor((cam.pos[2] - ws / 2) / texel) * texel];
        const f = w.field;
        F.set('viewProj', this.viewProj);
        F.set('prevViewProj', this.prevViewProj || this.viewProj);
        F.set('cam', [...cam.pos, a.time % 3600]);
        F.set('fwd', [...fwd, near]);
        F.set('right', [...v3.mul(right, tanX), a.frameNo % 1024]);
        F.set('up', [...v3.mul(up, tanY), a.weatherTime]);
        F.set('sunDir', [...sky.dir, sun.moon]);
        F.set('sunCol', [...sky.sun, sun.exposure]);
        F.set('zenith', [...sky.zenith, 0.00007 * c.haze]);
        F.set('horizon', [...sky.horizon, 1400]);
        F.set('ambient', [...sky.ambient, a.flashVeil]);
        F.set('screen', [r.width, r.height, r.cloudPass.w, r.cloudPass.h]);
        F.set('cloud', [c.base, Math.max(c.top, c.base + 400), c.density, c.coverage]);
        F.set('noise', [cfg.shapeScale, cfg.detailScale, cfg.detailStrength, cfg.maxTop]);
        F.set('wind', [...c.wind, ...w.weather.offset]);
        F.set('precip', [w.weather.freezingLevel, cfg.slant, cfg.rainExtinction, cfg.snowExtinction]);
        F.set('wdomain', [wo[0], wo[1], ws, WEATHER_RES]);
        F.set('tdomain', [f.origin, f.origin, f.size, f.n]);
        F.set('ground', [w.terrain.fieldSize, w.terrain.pivots, GROUND_RES, a.mode]);
        F.set('cirrus', [cfg.maxTop + 800, c.cirrus, 9000, c.drizzle]);
        F.set('march', [q.steps, q.light, cfg.maxDistance, a.radar ? 1 : 0]);
        // the shadow map refreshes a slice of rows per frame, unless the map moved or the sun / weather jumped
        const shadowKey = `${wo[0]},${wo[1]},${sky.dir.map(v => v.toFixed(2))},${w.weather.target},${w.weather.blend < 1 || w.rainZones.blend < 1}`;
        const full = a.reset || shadowKey !== this.shadowKey || w.weather.blend < 1 || w.rainZones.blend < 1;
        this.shadowKey = shadowKey;
        F.set('lod', [q.interleave, full ? 1 : SHADOW_SLICES, full ? 0 : a.frameNo % SHADOW_SLICES, q.detail]);
        this.shadowSlices = full ? 1 : SHADOW_SLICES;
        F.set('froxel', [FROXEL_NEAR, cfg.maxDistance, a.froxels ? 1 : 0, 0]);
        F.set('post', [q.blur || 0, a.tiles ? 1 : 0, a.radarTop || 0, cfg.bloomBolt]);
        // how far the wind carried the clouds since the last frame: the resolve reprojects the history along with them
        const off = this.offset = [...w.weather.offset], prev = this.prevOffset || off;
        F.set('look', [q.smooth || 0, off[0] - prev[0], off[1] - prev[1], 0]);
        F.set('bloom', [a.bloom ? cfg.bloom : 0, cfg.bloomThreshold, cfg.bloomKnee, r.bloomViews?.length || 1]);
        // heavy rain: up to three times the drops (big drops, past intensity 0.6)
        const drops = this.drops = w.rainZones.drops(cam.pos[0], cam.pos[2], c.drops);
        this.rainParticles = Math.round(cfg.particles * (1 + 2 * sat01((a.near.rain - 0.6) / 0.8) * drops));
        F.set('rain', [drops, rainFall(drops), c.rain, this.rainParticles]);
        w.rainZones.write(F);
        this.drips = w.structures.boxes.write(F, cam.pos, sky.dir, c.wind, w.weather.freezingLevel, rainFall(drops));
        a.lights.write(F, cam.pos, fwd, right, up);
        this.splashStart = this.rainParticles + (this.drips && a.near.rain > 0.02 ? DRIP_PARTICLES : 0);
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
