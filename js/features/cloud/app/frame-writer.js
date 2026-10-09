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
            const o = k * BUS_UNIFORM / 4;
            r.busData.set(m4.mul(proj, m4.aboutEye(m, cam.pos, right, up, fwd)), o);
            r.busData.set(m, o + 16);
            r.busData.set(bus.inverse, o + 32);
            r.busData.set([bus.v, bus.doors, 0, 0], o + 48);
            draws.push([dist, k]);
        });
        r.busDraws = draws.sort((p, q2) => p[0] - q2[0] || p[1] - q2[1]).map(e => e[1]);
        // building interiors: the rooms of the planned ones the portal traversal reaches (the building kit's RoomVis: the interior kit's
        // PortalVis, from the camera's room, or from outside through the windows of the storeys within INTERIOR_DRAW,
        // the same test fsWindow and fsPane make); the unplanned ones (one room each) within INTERIOR_DRAW of their box
        // that the camera is in or sees into through a portal in the view frustum: only the InteriorIndex cells within
        // INTERIOR_DRAW are visited, whatever the number of buildings
        const planes = frustumPlanes(this.viewProj, { reversed: true }), S = w.structures, inside = [];
        for (const [, it] of S.interiors.seen(cam.pos, planes, INTERIOR_DRAW, 'building')) S.buildings.draws(it.owner, inside);
        if (this.roomVis?.world !== S) this.roomVis = new engine.kits.building.RoomVis(S, { range: INTERIOR_DRAW, inspect: a.inspect });
        this.rooms = this.roomVis.compute(cam.pos, this.viewProj, r.width, r.height, inside, near, { basis: { fwd, right, up }, aspect, fov: cam.fov });
        // its sector and portal frames, about the eye
        r.lineLayer.write(this.roomVis.inspector.lines(cam.pos), m4.mul(proj, m4.view([0, 0, 0], right, up, fwd)));
        // the lift cars the traversal reached (their areas), the landing doors and counterweights near
        r.boxGroups = S.lifts.instances(cam.pos, r.boxData, this.roomVis.cars, this.roomVis.ranges);
        r.boxCount = r.boxGroups.reduce((n, g) => n + g.count, 0);
        // each building drawn, in its Origin's frame: its model-view built in doubles about the camera, in a slot of
        // busData after the buses' (the interiors' and the lifts' draws name it)
        const slots = new Map();
        const slotOf = b => {
            let k = slots.get(b);
            if (k !== undefined) return k;
            if (slots.size >= r.busData.length / (BUS_UNIFORM / 4) - r.originSlot0) return -1;
            k = r.originSlot0 + slots.size;
            slots.set(b, k);
            const M = b.interior.origin.M, o = k * BUS_UNIFORM / 4;
            r.busData.set(m4.mul(proj, m4.aboutEye(M, cam.pos, right, up, fwd)), o);
            r.busData.set(M, o + 16);
            r.busData.set([0, 0, 0, 0], o + 48);
            return k;
        };
        r.interiorDraws = inside.map(d => [d[0], d[1], d[2], d[3], d[4], slotOf(d[4])]).filter(d => d[5] >= 0).sort((p, q) => p[5] - q[5]);
        for (const g of r.boxGroups) g.slot = slotOf(g.b);
        r.boxGroups = r.boxGroups.filter(g => g.slot >= 0);
        r.originCount = slots.size;
        r.setPanels(a.liftControl.shown);
        // the cabin the rain and the march leave out: the bus ridden, or the nearest; the lift car the camera is in (its
        // own air: nothing of the shaft's or the weather's in it); else the building the camera is in
        const car = a.rideCar;
        if (car) {
            const M = car.matrix(), [x0, x1, z0, z1] = car.out;
            F.set('busInv', [M[0], 0, M[8], 0, 0, 1, 0, 0, M[2], 0, M[10], 0, -(M[0] * M[12] + M[2] * M[14]), -M[13], -(M[8] * M[12] + M[10] * M[14]), 1]);
            F.set('cabinLo', [x0, -0.2, z0, 1]);
            F.set('cabinHi', [x1, car.h + 0.15, z1, 0]);
        } else if (a.rideBus) {
            F.set('busInv', a.rideBus.inverse);
            F.set('cabinLo', [-BUS.hl, BUS.skirt, -BUS.hw, 1]);
            F.set('cabinHi', [BUS.hl, BUS.roof, BUS.hw, 0]);
        } else if (a.indoors) {
            const b = a.indoors, { cs, sn, c } = b.f, tx = c[0], tz = c[1];
            F.set('busInv', [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, -(cs * tx + sn * tz), -b.floor, -(-sn * tx + cs * tz), 1]);
            F.set('cabinLo', [-b.hx + b.t, -0.2, -b.hz + b.t, 1]);
            F.set('cabinHi', [b.hx - b.t, b.top - b.floor, b.hz - b.t, 0]);
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
        // the weather and shadow maps refresh a slice of rows per frame, unless the map moved or the sun / weather jumped (a new target
        // weather starts its blend with one full refresh; the blend itself is gradual enough for the slices to follow)
        const shadowKey = `${wo[0]},${wo[1]},${sky.dir.map(v => v.toFixed(2))},${w.weather.target}`;
        const full = a.reset || shadowKey !== this.shadowKey;
        this.shadowKey = shadowKey;
        F.set('lod', [q.interleave, full ? 1 : SHADOW_SLICES, full ? 0 : a.frameNo % SHADOW_SLICES, q.detail]);
        this.shadowSlices = full ? 1 : SHADOW_SLICES;
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
