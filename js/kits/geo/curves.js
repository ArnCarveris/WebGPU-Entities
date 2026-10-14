'use strict';
// Curves for a mapped line (a road): its corners rounded into arcs, resampled finely enough to follow the ground.

Features.kit('geo', (engine, kit) => {
const DEG = Math.PI / 180;

// [[x, z], ...] from flat [x0, z0, x1, z1, ...], without repeated points
function toPoints(flat) {
    const out = [];
    for (let k = 0; k < flat.length; k += 2) {
        const p = [flat[k], flat[k + 1]], q = out[out.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p);
    }
    return out;
}

// The polyline with each corner turning more than `minTurn` rounded: an arc of `radius` m (a quadratic Bezier through
// the corner's legs, sampled every `step` of turn), as tight as the legs need (a corner takes at most half of each leg).
// A closed line (first point = last, a roundabout) is rounded all round.
function roundCorners(pts, radius, { minTurn = 4 * DEG, step = 6 * DEG } = {}) {
    const n = pts.length, closed = n > 3 && Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 0.1;
    if (n < 3 || radius <= 0) return pts;
    const ring = closed ? pts.slice(0, -1) : pts, m = ring.length, out = [];
    const corner = k => {
        const a = ring[(k - 1 + m) % m], b = ring[k], c = ring[(k + 1) % m];
        const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
        const u1 = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], u2 = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
        const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
        if (turn < minTurn || turn > 170 * DEG) { out.push(b); return; }
        const t = Math.min(radius * Math.tan(turn / 2), 0.5 * l1, 0.5 * l2);
        const p1 = [b[0] - u1[0] * t, b[1] - u1[1] * t], p2 = [b[0] + u2[0] * t, b[1] + u2[1] * t];
        const steps = Math.max(2, Math.ceil(turn / step));
        for (let s = 0; s <= steps; s++) {
            const u = s / steps, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
            out.push([w0 * p1[0] + w1 * b[0] + w2 * p2[0], w0 * p1[1] + w1 * b[1] + w2 * p2[1]]);
        }
    };
    if (closed) { for (let k = 0; k < m; k++) corner(k); out.push(out[0]); }
    else { out.push(ring[0]); for (let k = 1; k < m - 1; k++) corner(k); out.push(ring[m - 1]); }
    return out;
}

// points at most `step` m apart (the line's own points kept)
function densify(pts, step) {
    const out = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(l / step);
        for (let s = 1; s <= n; s++) out.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
    }
    return out;
}

// per point: the unit vector across the line (to its right, facing along it: [-dz, dx] with x east, z south), from its
// neighbours, and the distance along it
function frames(pts) {
    const n = pts.length, side = new Array(n), along = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const a = pts[Math.max(k - 1, 0)], b = pts[Math.min(k + 1, n - 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
        side[k] = [-dz / l, dx / l];
        if (k) along[k] = along[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    return { side, along };
}

return { toPoints, roundCorners, densify, frames };
});
