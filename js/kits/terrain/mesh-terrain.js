'use strict';
// A terrain built as meshes: noise hills, a ring of mountains and single peaks, coloured by height and slope.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, smoothstep, v3, quat } = Common;
const { valueNoise3, valueNoise3xz, ridgedMultifractal, fbm } = kits.noise;

// the terrain's fbm: octaves of the xz plane of valueNoise3, each with its own seed
const fbmXZ = (x, z, octaves, seed) => fbm(x, z, { octaves, seed, offset: [0, 0], seedStep: 1, noise: valueNoise3xz });

// The mesh terrain over a world's own entity base (Base). It draws through the world's meshes (the common mesh
// interface, kits.mesh: builder (an indexed surface: point, face), add(build, { key, material, castShadows }) -> what is
// instanced, instance(..., { lod: 'mesh' }), color(spec)), and sets the world's `terrain` (this: height / slope /
// contains, for what stands on it).
function meshTerrain(Base) {
    // Heightfield ground: fbm hills, flattened inside `flat` [cx, cz, r0, r1]; a ring of ridgedMultifractal `mountains`
    // { inner, outer, height, frequency } around `center`; single `peaks` [x, z, radius, height]. Built in
    // `chunks` x `chunks` pieces, each its own model, so the camera and every shadow cascade cull them. Vertex
    // colours come from `layers`: grass / dry grass, rock where steep (`rockSlope`: 1 - normal.y range) and
    // snow above `snowLine` (a height range). The terrain casts shadows unless `castShadows` is false.
    class Terrain extends Base {
        spawn() {
            const e = this.def, w = this.world;
            this.size = e.size || 1000;
            this.res = e.res || 128;
            this.amp = e.height ?? 10;
            this.freq = e.frequency ?? 0.004;
            this.seed = e.seed ?? 1;
            this.flat = e.flat;
            this.mountains = e.mountains;
            this.peaks = e.peaks || [];
            const n = this.res, S = this.size, step = S / n, H = this.heights = new Float32Array((n + 1) * (n + 1));
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) H[j * (n + 1) + i] = this.noise(-S / 2 + i * step, -S / 2 + j * step);
            w.terrain = this;

            const h = (i, j) => H[clamp(j, 0, n) * (n + 1) + clamp(i, 0, n)], L = e.layers || {}, mix3 = (a, b, t) => a.map((x, k) => x + (b[k] - x) * t);
            const lin = w.meshes.color, col = { grass: lin(L.grass || '#5d7a34'), dry: lin(L.dry || '#8c8a4c'), rock: lin(L.rock || '#6f675f'), snow: lin(L.snow || '#f4f6fa') };
            const [s0, s1] = L.rockSlope || [0.3, 0.5], [l0, l1] = L.snowLine || [1e9, 2e9];
            const chunks = clamp(e.chunks || 1, 1, 32), cn = Math.ceil(n / chunks), key = JSON.stringify(e);
            for (let cj = 0; cj < chunks; cj++) for (let ci = 0; ci < chunks; ci++) {
                const i0 = ci * cn, j0 = cj * cn, i1 = Math.min(n, i0 + cn), j1 = Math.min(n, j0 + cn), wd = i1 - i0 + 1;
                if (i0 >= n || j0 >= n) continue;
                const asset = w.meshes.add(() => {
                    const g = w.meshes.builder();
                    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                        const x = -S / 2 + i * step, z = -S / 2 + j * step, y = h(i, j);
                        const nrm = v3.norm([h(i - 1, j) - h(i + 1, j), 2 * step, h(i, j - 1) - h(i, j + 1)]), steep = 1 - nrm[1];
                        let c = mix3(col.grass, col.dry, (valueNoise3(x * 0.02, 0, z * 0.02, this.seed + 50) * 0.5 + 0.5) * 0.6);
                        c = mix3(c, col.rock, smoothstep(s0, s1, steep + valueNoise3(x * 0.05, 0, z * 0.05, this.seed + 55) * 0.06));
                        const snow = smoothstep(l0, l1, y + valueNoise3(x * 0.01, 0, z * 0.01, this.seed + 60) * 40) * (1 - smoothstep(0.3, 0.5, steep));
                        g.point([x, y, z], nrm, [x, z], mix3(c, col.snow, snow));
                    }
                    for (let j = 0; j < j1 - j0; j++) for (let i = 0; i < i1 - i0; i++) {
                        const a = j * wd + i;
                        g.face(a, a + wd, a + wd + 1, a + 1);
                    }
                    return g;
                }, { key: `terrain:${e.id || ''}:${ci},${cj}:${key}`, material: e.mat, castShadows: e.castShadows !== false });
                w.meshes.instance(asset, { pos: [0, 0, 0], q: quat.identity(), scale: 1 }, { lod: 'mesh' });
            }
        }

        noise(x, z) {
            const f = this.freq;
            let h = fbmXZ(x * f, z * f, 5, this.seed) * this.amp + fbmXZ(x * f * 0.3, z * f * 0.3, 3, this.seed + 9) * this.amp * 1.4;
            if (this.flat) { const [cx, cz, r0, r1] = this.flat; h *= smoothstep(r0, r1, Math.hypot(x - cx, z - cz)); }
            const m = this.mountains;
            if (m) {
                const [cx, cz] = m.center || [0, 0], ring = smoothstep(m.inner ?? 500, m.outer ?? 1000, Math.hypot(x - cx, z - cz));
                const mf = m.frequency ?? 0.002;
                if (ring > 0) h += ring * (m.height ?? 200) * ridgedMultifractal(x * mf, z * mf, 6, this.seed + 20);
            }
            for (const [px, pz, rad, ph] of this.peaks) {
                const t = 1 - Math.hypot(x - px, z - pz) / rad;
                if (t > 0) h += ph * Math.pow(smoothstep(0, 1, t), 1.6) * (0.7 + 0.5 * ridgedMultifractal(x * 0.004, z * 0.004, 5, this.seed + 30));
            }
            return h;
        }

        height(x, z) {
            const n = this.res, step = this.size / n;
            const gx = clamp((x + this.size / 2) / step, 0, n - 1e-6), gz = clamp((z + this.size / 2) / step, 0, n - 1e-6);
            const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, H = this.heights, k = j * (n + 1) + i;
            const ha = H[k], hb = H[k + n + 1], hc = H[k + n + 2], hd = H[k + 1];
            return fz >= fx ? ha + (hc - hb) * fx + (hb - ha) * fz : ha + (hd - ha) * fx + (hc - hd) * fz;
        }

        // 1 - normal.y: 0 flat, 1 vertical
        slope(x, z) {
            const e = this.size / this.res;
            return 1 - v3.norm([this.height(x - e, z) - this.height(x + e, z), 2 * e, this.height(x, z - e) - this.height(x, z + e)])[1];
        }

        contains(x, z, margin) { return Math.abs(x) < this.size / 2 - margin && Math.abs(z) < this.size / 2 - margin; }
    }

    return Terrain;
}

return { meshTerrain };
});
