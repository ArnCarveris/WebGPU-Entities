'use strict';
// The lights of a frame: which point and spot lights the shaders take (and the boxes that can shade each), the grid
// that lists them per cell, the fake street lamps' poles near the camera, and the distant lights and glows by night.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, smoothstep, v3 } = Common;
const {
    MAX_LIGHTS, LIGHT_GRID, MAX_POLES, MAX_FAR_DYN, FAR_FLOATS, LIGHT_RANGE, LIGHT_CABIN, LIGHT_SPOT, POLE_DRAW,
    GLOW_GAIN, LAMPS, ShelterBoxes, Structures,
} = feature;

class LightWriter {
    constructor(app) {
        this.app = app;
        this.data = new Float32Array(MAX_LIGHTS * 16);
        this.mask = new Uint32Array(MAX_LIGHTS * 4);
        this.grid = new Uint32Array(LIGHT_GRID * LIGHT_GRID * 2);
        this.poleData = new Float32Array(MAX_POLES * 8);
        this.poleAt = null;             // where the camera was when the poles were last listed
        this.farDyn = new Float32Array(MAX_FAR_DYN * FAR_FLOATS);
    }

    // The lights (lightAt in WGSL): the flashlight (L) first, then by night the structures' lamps and the buses' lights,
    // nearest the camera first (by the distance to the edge of their reach), at most MAX_LIGHTS. They fade out toward
    // the furthest one taken, so none pops in or out. Their intensities are adapted to the exposure, as the eye adapts to
    // lamps. Each lists the frame's boxes (ShelterBoxes.write) that can stand between it and what it lights: all those
    // within its reach, but not one holding it that is not enclosed (the bus whose headlights or cabin it is, the bus the
    // flashlight is aboard), so it shines out of it
    write(F, cam, fwd, right, up) {
        const a = this.app, w = a.world, night = a.sun.moon > 0, adapt = 1 / Math.max(a.sun.exposure, 0.2), all = [];
        if (a.flashlight) {
            const L = LAMPS.flashlight, hand = a.walker.active ? [0.18, -0.28] : [0, -0.1];
            all.push({ pos: v3.add(cam, v3.add(v3.mul(right, hand[0]), v3.mul(up, hand[1]))), dir: v3.norm(v3.add(fwd, v3.mul(up, 0.02))), color: L.color,
                intensity: L.intensity, range: L.range, size: L.size, cone: [Math.cos(L.cone[0] * DEG), Math.cos(L.cone[1] * DEG)], first: true });
        }
        if (night) {
            all.push(...w.structures.fixtures.lights);
            w.nearFakeLamps(cam, LIGHT_RANGE + LAMPS.sodium.range, all);    // the fake street lamps near: real lights now
            for (const b of w.buses) if (Math.hypot(b.pose.x - cam[0], b.pose.z - cam[2]) < LIGHT_RANGE + 80) b.lights(all);
        }
        const reach = l => l.first ? -1 : Math.max(v3.len(v3.sub(l.pos, cam)) - l.range, 0);
        const list = all.map(l => [reach(l), l]).filter(e => e[0] < LIGHT_RANGE).sort((p, q) => p[0] - q[0]);
        const cut = list.length > MAX_LIGHTS ? Math.max(list[MAX_LIGHTS][0], 1) : LIGHT_RANGE;
        const { data, mask } = this;
        data.fill(0);
        mask.fill(0);
        const boxes = w.structures.boxes.listed || [];
        list.slice(0, MAX_LIGHTS).forEach(([dist, l], i) => {
            const k = l.intensity * adapt * (1 - smoothstep(cut * 0.7, cut, dist)), c = l.cone;
            data.set([...l.pos, l.range, ...l.color.map(x => x * k), c ? c[0] : -2, ...l.dir, c ? c[1] : 1, (l.cabin ? LIGHT_CABIN : 0) | (c ? LIGHT_SPOT : 0), (l.size ?? 0.5) ** 2], i * 16);
            boxes.forEach((b, j) => {
                const e = Math.hypot(b.hx, b.hz), sl = Math.abs(b.slope) * b.hx;
                if (Math.hypot(b.x - l.pos[0], b.z - l.pos[2]) > l.range + e) return;
                if (l.pos[1] - l.range > b.y1 + sl || l.pos[1] + l.range < b.y0 - sl) return;
                if (!b.enclosed && ShelterBoxes.contains(b, l.pos)) return;
                mask[i * 4 + (j >> 5)] |= 1 << (j & 31);
            });
        });
        // a grid over their reach, each cell listing the lights that reach into it (a light's circle against the cell)
        const taken = list.slice(0, MAX_LIGHTS).map(e => e[1]), G = LIGHT_GRID, grid = this.grid;
        grid.fill(0);
        let lb = [0, 0, 0, 0];
        if (taken.length) {
            lb = [Math.min(...taken.map(l => l.pos[0] - l.range)), Math.min(...taken.map(l => l.pos[2] - l.range)),
                Math.max(...taken.map(l => l.pos[0] + l.range)), Math.max(...taken.map(l => l.pos[2] + l.range))];
            const cw = (lb[2] - lb[0]) / G, ch = (lb[3] - lb[1]) / G;
            taken.forEach((l, k) => {
                const [x, , z] = l.pos, r = l.range;
                for (let j = clamp(Math.floor((z - r - lb[1]) / ch), 0, G - 1); j <= clamp(Math.floor((z + r - lb[1]) / ch), 0, G - 1); j++)
                    for (let i = clamp(Math.floor((x - r - lb[0]) / cw), 0, G - 1); i <= clamp(Math.floor((x + r - lb[0]) / cw), 0, G - 1); i++) {
                        const cx = clamp(x, lb[0] + i * cw, lb[0] + (i + 1) * cw), cz = clamp(z, lb[1] + j * ch, lb[1] + (j + 1) * ch);
                        if (Math.hypot(cx - x, cz - z) <= r) grid[(j * G + i) * 2 + (k >> 5)] |= 1 << (k & 31);
                    }
            });
        }
        F.set('lightBox', lb);
        F.setBits('lightGrid', grid);
        // the air scatters their light: a little in clear air, much more in rain and snow (not where the camera is
        // indoors or aboard: the rain stays outside)
        const out = !(a.indoors || a.inBus), c = w.weather.cur;
        const sigma = 0.0004 + 0.0005 * (c.haze ?? 1) + (out ? 0.012 * a.near.rain + 0.025 * a.near.snow : 0);
        F.set('lights', data);
        F.setBits('lightMask', mask);
        F.set('lightInfo', [Math.min(list.length, MAX_LIGHTS), night ? 1 : 0, cut, sigma]);
        this.writeFar(F, night, adapt);
    }

    // the fake street lamps' poles within POLE_DRAW (vsFarPole), day and night: re-listed when the camera has moved 20 m
    writePoles() {
        const a = this.app, r = a.renderer, cam = a.camera.pos, last = this.poleAt;
        if (last && Math.hypot(cam[0] - last[0], cam[2] - last[2]) < 20 && r.poleWorld === a.world) return;
        this.poleAt = [...cam];
        r.poleWorld = a.world;
        const near = a.world.nearFakeLamps(cam, POLE_DRAW + 20, []).slice(0, MAX_POLES);
        const data = this.poleData;
        near.forEach((l, i) => data.set(l.pole, i * 8));
        if (near.length) r.device.queue.writeBuffer(r.poleBuf, 0, data, 0, near.length * 8);
        r.poleCount = near.length;
    }

    // the distant lights by night (WGSL_FAR, cityGlow): the buses' lights into the slots after the static ones, the
    // light-pollution domes into the frame; none by day
    writeFar(F, night, adapt) {
        const a = this.app, r = a.renderer, w = a.world;
        this.writePoles();
        if (!night) { r.farCount = 0; F.set('glowInfo', [0, 0, 0, 0]); return; }
        const bl = [];
        for (const b of w.buses) b.lights(bl);
        const n = Math.min(bl.length, MAX_FAR_DYN), dyn = this.farDyn;
        bl.slice(0, n).forEach((l, i) => dyn.set([...l.pos, l.size ?? 0.5, ...l.color.map(c => c * l.intensity), 0, ...l.dir, l.cone ? l.cone[0] : -2,
            l.cone ? l.cone[1] : 1, l.range, l.pos[1], 0], i * FAR_FLOATS));
        if (n) r.device.queue.writeBuffer(r.farBuf, r.farStatic * FAR_FLOATS * 4, dyn, 0, n * FAR_FLOATS);
        r.farCount = r.farStatic + n;
        F.set('glows', w.glows.flat());
        F.set('glowInfo', [w.glows.length, GLOW_GAIN / Math.PI * adapt, 0, 0]);
    }
}

return { LightWriter };
});
