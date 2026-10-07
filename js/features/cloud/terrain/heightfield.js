'use strict';
// The CPU heightfield: terrain heights plus the land-use map, authored by entities and uploaded once.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { clamp, lerp } = Common;
const { GRID_N, toHalf, fromHalf } = feature;

// The terrain (kits.terrain's Heightfield) plus a land-use map (r town, g forest, b water), authored by entities and
// uploaded once. Beyond the map the terrain eases back to its base level.
class Heightfield extends kits.terrain.Heightfield {
    constructor(size, n, base) {
        super(size, n, base);
        this.land = new Float32Array(n * n * 3);
        this.lamp = new Float32Array(n * n);   // share of the fake street lamps kept (World.buildFarLights), landTex's alpha
    }

    sample(x, z) {
        const v = super.sample(x, z);
        // matches the terrain shader: beyond the map the edge height eases back to the base level
        const out = Math.max(Math.abs(x), Math.abs(z)) - this.size / 2;
        return out > 0 ? lerp(this.base, v, Math.exp(-out / 4000)) : v;
    }

    paint(idx, channel, value) { const k = idx * 3 + channel; this.land[k] = Math.max(this.land[k], value); }

    // land use channel (0 town, 1 forest, 2 water, 3 the lamp share) at x, z, filtered like the GPU's landTex
    landAt(x, z, ch) {
        const n = this.n, fx = clamp(this.ci(x), 0, n - 1), fz = clamp(this.ci(z), 0, n - 1);
        const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j, L = this.land;
        const at = ch === 3 ? (a, b) => this.lamp[b * n + a] : (a, b) => L[(b * n + a) * 3 + ch];
        return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), tz);
    }

    // after authoring: the heights as uploaded (half floats), for surface()
    freeze() { this.hq = this.h.map(v => fromHalf(toHalf(v))); }

    // the terrain exactly as drawn: half-float heights filtered bilinearly at the mesh vertices, flat triangles between
    // them (the inner, linear part of vsTerrain's grid). Structures stand on this, so they neither float nor sink.
    surface(x, z) {
        const N = GRID_N, half = this.size / 2, c = this.origin + half, n = this.n, h = this.hq;
        const texH = (px, pz) => {
            const fx = clamp(this.ci(px), 0, n - 1), fz = clamp(this.ci(pz), 0, n - 1);
            const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j;
            return lerp(lerp(h[j * n + i], h[j * n + i + 1], tx), lerp(h[(j + 1) * n + i], h[(j + 1) * n + i + 1], tx), tz);
        };
        const vx = k => c + (k / (N - 1) * 2 - 1) / 0.72 * half;
        const g = u => ((u - c) / half * 0.72 + 1) / 2 * (N - 1);
        const gx = g(x), gz = g(z), i = clamp(Math.floor(gx), 0, N - 2), j = clamp(Math.floor(gz), 0, N - 2), fx = gx - i, fz = gz - j;
        const at = (a, b) => texH(vx(a), vx(b));
        // gridIndices: triangles (a, c, b) and (b, c, d), split along b-c
        if (fx + fz <= 1) { const ha = at(i, j); return ha + (at(i + 1, j) - ha) * fx + (at(i, j + 1) - ha) * fz; }
        const hd = at(i + 1, j + 1);
        return hd + (at(i, j + 1) - hd) * (1 - fx) + (at(i + 1, j) - hd) * (1 - fz);
    }

    // rgba16float texels: height, normal xyz
    packHeight() {
        const n = this.n, h = this.h, out = new Uint16Array(n * n * 4);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const nv = this.normal(i, j), k = (j * n + i) * 4;
            out[k] = toHalf(h[j * n + i]); out[k + 1] = toHalf(nv[0]); out[k + 2] = toHalf(nv[1]); out[k + 3] = toHalf(nv[2]);
        }
        return out;
    }

    packLand() {
        const n = this.n, out = new Uint8Array(n * n * 4);
        for (let k = 0; k < n * n; k++) {
            out[k * 4] = clamp(this.land[k * 3], 0, 1) * 255;
            out[k * 4 + 1] = clamp(this.land[k * 3 + 1], 0, 1) * 255;
            out[k * 4 + 2] = clamp(this.land[k * 3 + 2], 0, 1) * 255;
            out[k * 4 + 3] = clamp(this.lamp[k], 0, 1) * 255;
        }
        return out;
    }
}

return { Heightfield };
});
