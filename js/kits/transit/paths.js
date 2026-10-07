'use strict';
// Paths vehicles follow: rounded polylines, offset lanes, and smooth splines sampled by arc length.

Features.kit('transit', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp } = Common;

// a path through control points { p: [x, z], r (corner radius, m) }: straight between them, the corners rounded by arcs,
// resampled evenly about every `step` m. Closed: a loop starting at ctrl[0] (which should be on a straight), the last
// point one step short of it; open: from the first point to the last. Returns { pts, length, step (the actual one) }
function roundPath(ctrl, step = 1, closed = true) {
    const n = ctrl.length, pts = [];
    for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) { pts.push(ctrl[i].p); continue; }
        const A = ctrl[(i + n - 1) % n].p, B = ctrl[i].p, C = ctrl[(i + 1) % n].p;
        const l1 = Math.hypot(B[0] - A[0], B[1] - A[1]), l2 = Math.hypot(C[0] - B[0], C[1] - B[1]);
        const u1 = [(B[0] - A[0]) / l1, (B[1] - A[1]) / l1], u2 = [(C[0] - B[0]) / l2, (C[1] - B[1]) / l2];
        const th = Math.acos(clamp(u1[0] * u2[0] + u1[1] * u2[1], -1, 1)), sg = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);
        if (th < 1e-3) { pts.push(B); continue; }
        // the arc is tangent to both legs, its centre on the side the path turns to (right of travel: (-z, x))
        const dd = Math.min(ctrl[i].r * Math.tan(th / 2), 0.48 * Math.min(l1, l2)), r = dd / Math.tan(th / 2);
        const P1 = [B[0] - u1[0] * dd, B[1] - u1[1] * dd], O = [P1[0] - u1[1] * sg * r, P1[1] + u1[0] * sg * r];
        const a0 = Math.atan2(P1[1] - O[1], P1[0] - O[0]), k1 = Math.max(2, Math.ceil(th * r / 0.5));
        for (let k = 0; k <= k1; k++) { const a = a0 + sg * th * k / k1; pts.push([O[0] + Math.cos(a) * r, O[1] + Math.sin(a) * r]); }
    }
    if (closed) pts.push(pts[0]);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const total = cum[cum.length - 1], N = Math.max(1, Math.round(total / step)), out = [];
    for (let i = 0, k = 0; i < N + (closed ? 0 : 1); i++) {
        const s = i * total / N;
        while (k + 2 < cum.length && cum[k + 1] < s) k++;
        const t = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
        out.push([lerp(pts[k][0], pts[k + 1][0], t), lerp(pts[k][1], pts[k + 1][1], t)]);
    }
    return { pts: out, length: total, step: total / N };
}

// the polyline `o` m to the right of travel (right of a heading [x, z] is [-z, x]), mitred at the corners
function offsetLine(pts, o) {
    const nrm = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [-dz / l, dx / l]; };
    return pts.map((p, k) => {
        const n1 = k > 0 ? nrm(pts[k - 1], p) : nrm(p, pts[1]), n2 = k + 1 < pts.length ? nrm(p, pts[k + 1]) : n1;
        const m = [n1[0] + n2[0], n1[1] + n2[1]], d = m[0] * n1[0] + m[1] * n1[1];
        return [p[0] + m[0] / d * o, p[1] + m[1] / d * o];
    });
}

// A closed Catmull-Rom spline through 2D waypoints, sampled by arc length (`steps` samples per segment)
class SplineRoute {
    constructor(points, steps = 64) {
        this.points = points;
        this.steps = steps;
        this.samples = [];
        const n = points.length;
        for (let i = 0; i < n; i++) for (let k = 0; k < steps; k++) this.samples.push({ p: this.cr(i, k / steps), i, t: k / steps, s: 0 });
        let L = 0;
        this.samples.forEach((sm, i) => { if (i) L += Math.hypot(sm.p[0] - this.samples[i - 1].p[0], sm.p[1] - this.samples[i - 1].p[1]); sm.s = L; });
        const first = this.samples[0].p, last = this.samples[this.samples.length - 1].p;
        this.length = L + Math.hypot(first[0] - last[0], first[1] - last[1]);
    }

    // arc length at waypoint i
    waypointS(i) { return this.samples[i * this.steps].s; }

    // segment i at parameter t (or its derivative): smooth position and direction
    cr(i, t, deriv = false) {
        const P = this.points, n = P.length, p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
        const t2 = t * t, t3 = t2 * t;
        const f = deriv
            ? (a, b, c, e) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - e) * t + 3 * (-a + 3 * b - 3 * c + e) * t2)
            : (a, b, c, e) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t2 + (-a + 3 * b - 3 * c + e) * t3);
        return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
    }

    // arc length -> spline parameter through the sample table, then evaluate the spline itself
    param(s) {
        s = ((s % this.length) + this.length) % this.length;
        const S = this.samples;
        let lo = 0, hi = S.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (S[mid].s <= s) lo = mid; else hi = mid - 1; }
        const a = S[lo], sb = lo + 1 < S.length ? S[lo + 1].s : this.length;
        return { i: a.i, t: a.t + (s - a.s) / Math.max(1e-6, sb - a.s) / this.steps };
    }

    at(s) { const q = this.param(s); return this.cr(q.i, q.t); }
    dir(s) { const q = this.param(s); return this.cr(q.i, q.t, true); }

    // arc length of the sample nearest to (x, z)
    nearest(x, z) {
        let best = 0, bd = Infinity;
        for (const sm of this.samples) { const d = (sm.p[0] - x) ** 2 + (sm.p[1] - z) ** 2; if (d < bd) { bd = d; best = sm.s; } }
        return best;
    }
}

return { roundPath, offsetLine, SplineRoute };
});
