'use strict';
// A heightfield with land use: terrain heights plus the land-use map, authored by entities and uploaded once.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, lerp } = Common;
const { toHalf, fromHalf } = kits.gpu;

// The procedural detail laid over the data where it is rough (LandField.detail; the terrain shader's terrainSurface):
// octaves of value noise, each [wavelength m, amplitude per m of roughness], and the hash both sides share
const DETAIL_OCTAVES = [[29, 0.6], [11, 0.25], [4.3, 0.1], [1.7, 0.04]];
const EASE = 4000;          // m: beyond the map the heights ease back to the base level over this

// a value in -1..1 for lattice point (ix, iz) of octave s (the shader's detailHash, bit for bit)
const detailHash = (ix, iz, s) => {
    let h = Math.imul(ix, 0x8da6b343) ^ Math.imul(iz, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) * (2 / 4294967296) - 1;
};

// value noise at (x, z) in lattice units, quintic fade
const valueNoise = (x, z, s) => {
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const a = detailHash(ix, iz, s), b = detailHash(ix + 1, iz, s), c = detailHash(ix, iz + 1, s), d = detailHash(ix + 1, iz + 1, s);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
};

// Catmull-Rom weights at t (0..1) for taps -1..2
const cubicW = t => { const t2 = t * t, t3 = t2 * t; return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]; };

// The terrain (the Heightfield) plus a land-use map (r town, g forest, b water), authored by entities and uploaded once.
// Beyond the map the terrain eases back to its base level. As drawn (surface) the heights are interpolated bicubically,
// and where rough > 0 (m: about how far the detail lifts and sinks the ground on gentle slopes; more on steep ones) the
// procedural detail adds what the data is too coarse to hold, kept off what keepSmooth() marked (roads, buildings),
// the shore and open water: the `smooth` mask, mres^2 texels over the map.
class LandField extends kit.Heightfield {
    constructor(size, n, base, { rough = 0 } = {}) {
        super(size, n, base);
        this.land = new Float32Array(n * n * 3);
        this.lamp = new Float32Array(n * n);   // share of the fake street lamps kept (FarLights), landTex's alpha
        this.rough = rough;
        this.mres = rough > 0 ? Math.min(4096, n * 2) : 1;
        this.mcell = size / this.mres;
        this.smooth = new Uint8Array(this.mres * this.mres);
    }

    sample(x, z) {
        const v = super.sample(x, z);
        // matches the terrain shader: beyond the map the edge height eases back to the base level
        const out = Math.max(Math.abs(x), Math.abs(z)) - this.size / 2;
        return out > 0 ? lerp(this.base, v, Math.exp(-out / EASE)) : v;
    }

    paint(idx, channel, value) { const k = idx * 3 + channel; this.land[k] = Math.max(this.land[k], value); }
    wet(idx, k) { this.paint(idx, 2, k); }

    // land use channel (0 town, 1 forest, 2 water, 3 the lamp share) at x, z, filtered like the GPU's landTex
    landAt(x, z, ch) {
        const n = this.n, fx = clamp(this.ci(x), 0, n - 1), fz = clamp(this.ci(z), 0, n - 1);
        const i = Math.min(Math.floor(fx), n - 2), j = Math.min(Math.floor(fz), n - 2), tx = fx - i, tz = fz - j, L = this.land;
        const at = ch === 3 ? (a, b) => this.lamp[b * n + a] : (a, b) => L[(b * n + a) * 3 + ch];
        return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), tz);
    }

    // keeps the ground within r m of x, z free of the procedural detail (a road, a building's plot)
    keepSmooth(x, z, r) {
        if (!this.rough) return;
        const M = this.mres, c = this.mcell, o = this.origin, m = this.smooth;
        const i0 = Math.max(0, Math.floor((x - r - o) / c - 1)), i1 = Math.min(M - 1, Math.ceil((x + r - o) / c));
        const j0 = Math.max(0, Math.floor((z - r - o) / c - 1)), j1 = Math.min(M - 1, Math.ceil((z + r - o) / c));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(o + (i + 0.5) * c - x, o + (j + 0.5) * c - z), v = Math.round(clamp((r + c - d) / c, 0, 1) * 255), k = j * M + i;
            if (v > m[k]) m[k] = v;
        }
    }

    // the smooth mask at x, z (0..1), filtered like the GPU's smoothTex
    smoothAt(x, z) {
        const M = this.mres;
        if (M < 2) return 0;
        const fx = clamp((x - this.origin) / this.mcell - 0.5, 0, M - 1), fz = clamp((z - this.origin) / this.mcell - 0.5, 0, M - 1);
        const i = Math.min(Math.floor(fx), M - 2), j = Math.min(Math.floor(fz), M - 2), tx = fx - i, tz = fz - j, m = this.smooth;
        return lerp(lerp(m[j * M + i], m[j * M + i + 1], tx), lerp(m[(j + 1) * M + i], m[(j + 1) * M + i + 1], tx), tz) / 255;
    }

    // the heights interpolated bicubically (Catmull-Rom, through the data) at x, z: [height, dh/dx, dh/dz], easing back to
    // the base beyond the map (the shader's terrainCubic)
    cubic(x, z) {
        const n = this.n, h = this.h, fx = clamp(this.ci(x), 0, n - 1), fz = clamp(this.ci(z), 0, n - 1);
        const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, wx = cubicW(tx), wz = cubicW(tz);
        const t2x = tx * tx, t2z = tz * tz;
        const dx = [(-3 * t2x + 4 * tx - 1) / 2, (9 * t2x - 10 * tx) / 2, (-9 * t2x + 8 * tx + 1) / 2, (3 * t2x - 2 * tx) / 2];
        const dz = [(-3 * t2z + 4 * tz - 1) / 2, (9 * t2z - 10 * tz) / 2, (-9 * t2z + 8 * tz + 1) / 2, (3 * t2z - 2 * tz) / 2];
        let v = 0, gx = 0, gz = 0;
        for (let b = 0; b < 4; b++) {
            const row = clamp(j + b - 1, 0, n - 1) * n;
            let r = 0, rd = 0;
            for (let a = 0; a < 4; a++) { const hv = h[row + clamp(i + a - 1, 0, n - 1)]; r += wx[a] * hv; rd += dx[a] * hv; }
            v += wz[b] * r; gx += wz[b] * rd; gz += dz[b] * r;
        }
        const out = Math.max(Math.abs(x - this.origin - this.size / 2), Math.abs(z - this.origin - this.size / 2)) - this.size / 2;
        const k = out > 0 ? Math.exp(-out / EASE) : 1;
        return [lerp(this.base, v, k), gx / this.cell * k, gz / this.cell * k];
    }

    // the procedural detail at x, z over ground of height hgt and slope (|gradient|), octaves shorter than 4 sp m left
    // out (0: all; the shader band-limits by vertex spacing and pixel size)
    detail(x, z, hgt, slope, sp = 0) {
        if (!this.rough) return 0;
        const m = (1 - this.smoothAt(x, z)) * clamp((hgt - 1) / 3, 0, 1) * (1 - clamp(this.landAt(x, z, 2), 0, 1));
        if (m <= 0) return 0;
        let v = 0;
        DETAIL_OCTAVES.forEach(([l, a], k) => {
            const w = sp > 0 ? clamp(l / (2 * sp) - 1, 0, 1) : 1;
            if (w > 0) v += w * a * valueNoise(x / l, z / l, k + 1);
        });
        return v * this.rough * m * (0.25 + Math.min(slope, 2));
    }

    // the terrain as drawn: bicubic heights plus the detail. Structures stand on this, so they neither float nor sink
    // (the finest lod's triangles, 1 m apart by default, stay within centimetres of it)
    surface(x, z) {
        const [h, gx, gz] = this.cubic(x, z);
        return h + this.detail(x, z, h, Math.hypot(gx, gz));
    }

    // r8 texels: the smooth mask
    packSmooth() { return this.smooth; }

    // rgba16float texels: the height as two halves (r + g: half floats alone step 1 m above 1024 m; the remainder keeps
    // it to a tenth of a millimetre, and both filter linearly), the normal's x and z (its y from them)
    packHeight() {
        const n = this.n, h = this.h, out = new Uint16Array(n * n * 4);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const nv = this.normal(i, j), k = (j * n + i) * 4, v = h[j * n + i], hi = toHalf(v);
            out[k] = hi; out[k + 1] = toHalf(v - fromHalf(hi)); out[k + 2] = toHalf(nv[0]); out[k + 3] = toHalf(nv[2]);
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

return { LandField, DETAIL_OCTAVES, TERRAIN_EASE: EASE };
});
