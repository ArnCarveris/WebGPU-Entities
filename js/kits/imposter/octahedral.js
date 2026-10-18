'use strict';
// Octahedral mapping: directions <-> points of the atlas square, in JS (Oct) and WGSL (WGSL_OCT, the same maths), and
// the orthographic frame a bake renders one direction with (orthoFrame).

Features.kit('imposter', (engine, kit) => {
const { Common } = engine;
const { clamp, v3 } = Common;

const sgn = x => (x >= 0 ? 1 : -1);

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

// orthographic view of the bounding sphere (centre c, radius R) looking along -dir, written as one 256-byte slot
// (FRAME_FLOATS floats at `o`): viewProj (depth 0..1 front to back), dir + 1 / R, centre. WGSL_BAKE_FRAME's `Bake`.
const FRAME_FLOATS = 64;
function orthoFrame(out, o, dir, c, R) {
    const rt = Oct.right(dir), up = v3.cross(dir, rt);
    out.set([rt[0] / R, up[0] / R, -dir[0] / (2 * R), 0, rt[1] / R, up[1] / R, -dir[1] / (2 * R), 0, rt[2] / R, up[2] / R, -dir[2] / (2 * R), 0,
        -v3.dot(rt, c) / R, -v3.dot(up, c) / R, 0.5 + v3.dot(dir, c) / (2 * R), 1], o);
    out.set([...dir, 1 / R, ...c, 0], o + 16);
}

const WGSL_OCT = /* wgsl */`
fn octSign(v: vec2f) -> vec2f { return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0)); }
fn octEncode(d: vec3f, full: bool) -> vec2f {
    if (full) {
        let n = d / (abs(d.x) + abs(d.y) + abs(d.z));
        var p = n.xz;
        if (n.y < 0.0) { p = (1.0 - abs(p.yx)) * octSign(p); }
        return p;
    }
    let h = vec3f(d.x, max(d.y, 0.0), d.z);
    let n = h / max(abs(h.x) + abs(h.y) + abs(h.z), 1e-6);
    return vec2f(n.x + n.z, n.z - n.x);
}
fn octDecode(p: vec2f, full: bool) -> vec3f {
    var n: vec3f;
    if (full) {
        n = vec3f(p.x, 1.0 - abs(p.x) - abs(p.y), p.y);
        if (n.y < 0.0) {
            let s = octSign(n.xz);
            n = vec3f((1.0 - abs(p.y)) * s.x, n.y, (1.0 - abs(p.x)) * s.y);
        }
    } else {
        let o = vec2f(p.x - p.y, p.x + p.y) * 0.5;
        n = vec3f(o.x, 1.0 - abs(o.x) - abs(o.y), o.y);
    }
    return normalize(n);
}
// a frame's right axis (Oct.right); its up is cross(d, right)
fn octRight(d: vec3f) -> vec3f {
    if (abs(d.y) > 0.9999) { return vec3f(1.0, 0.0, 0.0); }
    return normalize(vec3f(d.z, 0.0, -d.x));
}
`;

return { Oct, FRAME_FLOATS, orthoFrame, WGSL_OCT };
});
