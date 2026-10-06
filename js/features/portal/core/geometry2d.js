'use strict';
// 2D geometry: polygons and segments on the ground plane.

Features.part('portal', (engine, feature) => {
// 2D polygon helpers on (x, z) or (u, v) points: area, point-in-polygon, ear clipping, convex clipping and
// subtraction (used to cut portal apertures out of walls, floors and the sea).

const g2 = {
    area(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; },
    inside(pt, poly) {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if (((a[1] > pt[1]) !== (b[1] > pt[1])) && (pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0])) c = !c;
        }
        return c;
    },
    // ear clipping, returns CCW triangles
    triangulate(poly) {
        let pts = poly.map(p => [p[0], p[1]]);
        if (g2.area(pts) < 0) pts.reverse();
        const idx = pts.map((_, i) => i), tris = [];
        const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const inTri = (p, a, b, c) => cross(a, b, p) > 1e-9 && cross(b, c, p) > 1e-9 && cross(c, a, p) > 1e-9;
        let guard = 0;
        while (idx.length > 3 && guard++ < 10000) {
            let clipped = false;
            for (let i = 0; i < idx.length; i++) {
                const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
                const a = pts[ia], b = pts[ib], c = pts[ic];
                if (cross(a, b, c) <= 1e-9) continue;
                let ok = true;
                for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inTri(pts[j], a, b, c)) { ok = false; break; } }
                if (!ok) continue;
                tris.push([a, b, c]); idx.splice(i, 1); clipped = true; break;
            }
            if (!clipped) break;
        }
        if (idx.length === 3) tris.push(idx.map(i => pts[i]));
        return tris;
    },
    // Sutherland-Hodgman against the half-plane left of a->b
    clip(poly, a, b) {
        const out = [], side = p => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
            if (sp >= 0) out.push(p);
            if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
        }
        return out;
    },
    bounds(poly) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        return [x0, y0, x1, y1];
    },
    // convex pieces minus a convex hole -> convex pieces (used to cut portal apertures)
    subtract(pieces, hole) {
        const h = g2.area(hole) < 0 ? hole.slice().reverse() : hole;
        const hb = g2.bounds(h), out = [];
        for (const piece of pieces) {
            const pb = g2.bounds(piece);
            if (pb[2] <= hb[0] || pb[0] >= hb[2] || pb[3] <= hb[1] || pb[1] >= hb[3]) { out.push(piece); continue; }
            let rem = piece;
            for (let i = 0; i < h.length && rem.length >= 3; i++) {
                const a = h[i], b = h[(i + 1) % h.length];
                const outside = g2.clip(rem, b, a);
                if (outside.length >= 3 && Math.abs(g2.area(outside)) > 1e-5) out.push(outside);
                rem = g2.clip(rem, a, b);
            }
        }
        return out;
    },
};

return { g2 };
});
