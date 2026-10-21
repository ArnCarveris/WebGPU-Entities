'use strict';
// The lights of a frame: which point and spot lights the shaders take, the grid that lists them per cell (host: the
// app, as FrameWriter's). The lights of what the features bring, the boxes that shade them, the distant lights and glows
// by night are its app's extensions' (AppExtension.lights / lightMasks / writeFar).

Features.kit('atmosphere', (engine, kit) => {
const { Common, kits } = engine;
const { DEG, clamp, smoothstep, v3 } = Common;
const { MAX_LIGHTS, LIGHT_GRID, LIGHT_RANGE, LIGHT_CABIN, LIGHT_SPOT, LIGHT_ROOM, FLASHLIGHT } = kit;

class LightWriter {
    constructor(app) {
        this.app = app;
        this.data = new Float32Array(MAX_LIGHTS * 16);
        this.mask = new Uint32Array(MAX_LIGHTS * 4);
        this.grid = new Uint32Array(LIGHT_GRID * LIGHT_GRID * 2);
    }

    // The lights (lightAt in WGSL): the flashlight (L) first, then by night the features' (AppExtension.lights(all, cam):
    // the structures' lamps, the lit rooms of the buildings near, the buses' lights), nearest the camera first (by the
    // distance to the edge of their reach), at most MAX_LIGHTS. They fade out toward the furthest one taken, so none pops in
    // or out. Their intensities are adapted to the exposure, as the eye adapts to lamps. Each lists the boxes that can
    // stand between it and what it lights (AppExtension.lightMasks: the structures')
    write(F, cam, fwd, right, up) {
        const a = this.app, w = a.world, night = a.sun.moon > 0, adapt = 1 / Math.max(a.sun.exposure, 0.2), all = [];
        if (a.flashlight) {
            const L = FLASHLIGHT, hand = a.walker.active ? [0.18, -0.28] : [0, -0.1];
            all.push({ pos: v3.add(cam, v3.add(v3.mul(right, hand[0]), v3.mul(up, hand[1]))), dir: v3.norm(v3.add(fwd, v3.mul(up, 0.02))), color: L.color,
                intensity: L.intensity, range: L.range, size: L.size, cone: [Math.cos(L.cone[0] * DEG), Math.cos(L.cone[1] * DEG)], first: true });
        }
        if (night) a.each('lights', all, cam);
        const reach = l => l.first ? -1 : Math.max(v3.len(v3.sub(l.pos, cam)) - l.range, 0);
        const list = all.map(l => [reach(l), l]).filter(e => e[0] < LIGHT_RANGE).sort((p, q) => p[0] - q[0]);
        const cut = list.length > MAX_LIGHTS ? Math.max(list[MAX_LIGHTS][0], 1) : LIGHT_RANGE;
        const { data, mask } = this;
        data.fill(0);
        mask.fill(0);
        list.slice(0, MAX_LIGHTS).forEach(([dist, l], i) => {
            const k = l.intensity * adapt * (1 - smoothstep(cut * 0.7, cut, dist)), c = l.cone;
            data.set([...l.pos, l.range, ...l.color.map(x => x * k), c ? c[0] : -2, ...l.dir, c ? c[1] : 1, (l.cabin ? LIGHT_CABIN : 0) | (c ? LIGHT_SPOT : 0) | (l.room ? LIGHT_ROOM : 0), (l.size ?? 0.5) ** 2], i * 16);
        });
        const taken = list.slice(0, MAX_LIGHTS).map(e => e[1]), G = LIGHT_GRID, grid = this.grid;
        a.each('lightMasks', taken, mask);
        // a grid over their reach, each cell listing the lights that reach into it (a light's circle against the cell)
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

    // the distant lights by night (WGSL_FAR, cityGlow): the features' (AppExtension.writeFar: the structures' sprites and
    // light-pollution domes, the buses' lights among them); none without them
    writeFar(F, night, adapt) {
        F.set('glowInfo', [0, 0, 0, 0]);
        this.app.each('writeFar', F, night, adapt);
    }
}

return { LightWriter };
});
