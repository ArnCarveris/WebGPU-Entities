'use strict';
// Octahedral mapping (must match the WGSL).

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { clamp, v3 } = Common;
const { sgn } = feature;

// p in [-1, 1]^2. Full: the whole sphere (lower half folded into the corners). Hemi: upper half only,
// the diamond rotated 45 degrees to fill the square. Frame (i, j) of an N x N grid sits at p = (i, j) / (N - 1) * 2 - 1.
const Oct = {
    encode(d, full) {
        if (full) {
            const s = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) || 1;
            let x = d[0] / s, z = d[2] / s;
            if (d[1] < 0) { const tx = x; x = (1 - Math.abs(z)) * sgn(tx); z = (1 - Math.abs(tx)) * sgn(z); }
            return [x, z];
        }
        const y = Math.max(d[1], 0), s = Math.abs(d[0]) + y + Math.abs(d[2]) || 1;
        const x = d[0] / s, z = d[2] / s;
        return [x + z, z - x];
    },
    decode(p, full) {
        let x, y, z;
        if (full) {
            x = p[0]; z = p[1]; y = 1 - Math.abs(x) - Math.abs(z);
            if (y < 0) { const tx = x; x = (1 - Math.abs(z)) * sgn(tx); z = (1 - Math.abs(tx)) * sgn(z); }
        } else {
            x = (p[0] - p[1]) * 0.5; z = (p[0] + p[1]) * 0.5; y = 1 - Math.abs(x) - Math.abs(z);
        }
        return v3.norm([x, y, z]);
    },
    frameDir(i, j, n, full) { return Oct.decode([i / (n - 1) * 2 - 1, j / (n - 1) * 2 - 1], full); },
    right(d) { return Math.abs(d[1]) > 0.9999 ? [1, 0, 0] : v3.norm([d[2], 0, -d[0]]); },
    // the three frames around a (local) view direction and their barycentric weights
    select(d, n, full, blend) {
        const p = Oct.encode(d, full), g = p.map(x => clamp((x * 0.5 + 0.5) * (n - 1), 0, n - 1));
        if (!blend) { const r = g.map(Math.round); return { cells: [r, r, r], w: [1, 0, 0] }; }
        const b = g.map(x => Math.min(Math.floor(x), n - 2)), f = [g[0] - b[0], g[1] - b[1]];
        if (f[0] > f[1]) return { cells: [b, [b[0] + 1, b[1]], [b[0] + 1, b[1] + 1]], w: [1 - f[0], f[0] - f[1], f[1]] };
        return { cells: [b, [b[0], b[1] + 1], [b[0] + 1, b[1] + 1]], w: [1 - f[1], f[1] - f[0], f[0]] };
    },
};

return { Oct };
});
