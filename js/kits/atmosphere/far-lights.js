'use strict';
// Distant lights by night, fake and cheap (WGSL_FAR): a terrain's towns are only painted on it (townColor), so the
// street lamps of the lit town are points on its TOWN_BLOCK m street grid, one every FAR_LAMP_PITCH m, kept where the
// town is dense enough (with a hash, so its edges thin out), never on water nor near the structures' real lamps.

Features.kit('atmosphere', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, sat01 } = Common;
const { FAR_FLOATS, TOWN_BLOCK, FAR_LAMP_PITCH, FAR_LAMP_SIDE, FAR_LAMP_REACH, FAR_LAMP_H, MAX_GLOWS } = kit;
const { pcg } = kits.noise;
const { LAMPS } = kits.settlement;
const CELL = 250;           // m: the fake lamps' cells, for the ones near a point

// field: a LandField (its lamp channel gets the share kept, for the terrain's light pools: streetGlow); structures:
// their fixtures' lights; town: { pos, radius } (the lit town) or null. lights: those and the structures' lamps as
// sprites (FAR_FLOATS each); real: [first, count] of the structures' (vsFarPool); glows: the light-pollution domes
// (cityGlow), the town and each cluster of real lamps
class FarLights {
    constructor(field, structures, town) {
        const f = field, S = structures, n = f.n, real = new Set();
        for (const l of S.fixtures.lights) real.add(clamp(Math.round(f.ci(l.pos[2])), 0, n - 1) * n + clamp(Math.round(f.ci(l.pos[0])), 0, n - 1));
        const L0 = town;
        f.eachAll((idx, x, z) => {
            const lit = L0 && Math.hypot(x - L0.pos[0], z - L0.pos[1]) < L0.radius;
            f.lamp[idx] = !lit || real.has(idx) ? 0 : sat01(f.land[idx * 3] * 1.6 - 0.35) * (1 - sat01(f.land[idx * 3 + 2] * 3));
        });
        const out = [], glows = [], seen = new Set(), fake = [], B = TOWN_BLOCK, P = FAR_LAMP_PITCH;
        const put = (l, fake) => out.push(...l.pos, l.size ?? 0.5, ...l.color.map(c => c * l.intensity), fake ? 1 : 0, ...(l.dir || [0, -1, 0]), l.cone ? l.cone[0] : -2,
            l.cone ? l.cone[1] : 1, l.range, f.surface(l.pos[0], l.pos[2]), 0);
        for (const t of L0 ? [L0] : []) {
            const [cx, cz] = t.pos, r = t.radius;
            let sum = 0;
            // lamp at grid point (x, z) of a street along z (alongZ) or x: its pole at the kerb on alternate sides, the
            // arm over the road, the head FAR_LAMP_SIDE m off the centre line (farLampHead in WGSL)
            const lamp = (x, z, alongZ) => {
                if (seen.has(x * 65536 + z)) return;
                seen.add(x * 65536 + z);
                if (pcg(Math.imul(x / P + 65536, 196613) + z / P + 65536) / 4294967295 >= f.landAt(x, z, 3)) return;
                // a quarter of the districts have newer white LED lamps (farLampColor)
                const L = LAMPS[pcg((Math.floor(x / 600) + 1000) * 4099 + Math.floor(z / 600) + 1000) / 4294967295 < 0.25 ? 'led' : 'sodium'];
                const sd = ((alongZ ? z : x) / P) & 1 ? -1 : 1, ax = alongZ ? [sd, 0] : [0, sd];
                const pole = [x + ax[0] * (FAR_LAMP_SIDE + FAR_LAMP_REACH), z + ax[1] * (FAR_LAMP_SIDE + FAR_LAMP_REACH)], g = f.surface(...pole);
                const l = { pos: [x + ax[0] * FAR_LAMP_SIDE, g + FAR_LAMP_H, z + ax[1] * FAR_LAMP_SIDE], color: L.color, intensity: L.intensity,
                    range: L.range, size: L.size, dir: [0, -1, 0], cone: null,
                    pole: [pole[0], g, pole[1], Math.atan2(-ax[1], -ax[0]), ...L.color.map(c => 0.55 + 0.45 * c), 0] };
                put(l, true);
                fake.push(l);
                sum += L.intensity;
            };
            for (let i = Math.ceil((cx - r) / B); i <= Math.floor((cx + r) / B); i++)
                for (let z = Math.ceil((cz - r) / P) * P; z <= cz + r; z += P) lamp(i * B, z, true);
            for (let j = Math.ceil((cz - r) / B); j <= Math.floor((cz + r) / B); j++)
                for (let x = Math.ceil((cx - r) / P) * P; x <= cx + r; x += P) if (x % B) lamp(x, j * B, false);
            if (sum) glows.push([cx, cz, r * 0.7, sum]);
        }
        // the structures' lamps (a bus's are written each frame, LightWriter.writeFar), and a dome per 1.5 km cluster of them
        this.real = [out.length / FAR_FLOATS, S.fixtures.lights.length];      // their first instance and count (vsFarPool)
        const cl = new Map();
        for (const l of S.fixtures.lights) {
            put(l, false);
            if (l.tag === 'road') continue;                              // a country road's lamps light no sky
            const k = Math.floor(l.pos[0] / 1500) * 65536 + Math.floor(l.pos[2] / 1500), c = cl.get(k) || { x: 0, z: 0, i: 0, n: 0 };
            c.x += l.pos[0] * l.intensity; c.z += l.pos[2] * l.intensity; c.i += l.intensity; c.n++;
            cl.set(k, c);
        }
        for (const c of cl.values()) if (c.n > 4) glows.push([c.x / c.i, c.z / c.i, 400, c.i]);
        this.lights = new Float32Array(out);
        this.glows = glows.sort((a, b) => b[3] - a[3]).slice(0, MAX_GLOWS);
        // the fake lamps by CELL m cells, for the ones near the camera: real lights (LightWriter.write) and poles
        this.fake = new Map();
        for (const l of fake) {
            const k = Math.floor(l.pos[0] / CELL) * 65536 + Math.floor(l.pos[2] / CELL);
            if (!this.fake.has(k)) this.fake.set(k, []);
            this.fake.get(k).push(l);
        }
    }

    // the fake street lamps within r (m, horizontally) of p, into out
    near(p, r, out) {
        for (let i = Math.floor((p[0] - r) / CELL); i <= Math.floor((p[0] + r) / CELL); i++)
            for (let j = Math.floor((p[2] - r) / CELL); j <= Math.floor((p[2] + r) / CELL); j++)
                for (const l of this.fake.get(i * 65536 + j) || []) if (Math.hypot(l.pos[0] - p[0], l.pos[2] - p[2]) < r) out.push(l);
        return out;
    }
}

return { FarLights };
});
