'use strict';
// Frustums: box tests, polygon clipping, hull frustums and screen rectangles (portal culling, PortalVis).

Features.kit('interior', (engine, kit) => {
const { v3 } = engine.Common;

// AABB tests and polygon clipping against frustum planes (Common.frustumPlanes).
// Planes are [nx, ny, nz, d]; a point is inside when dot(n, p) + d >= 0.

const planeDist = (p, v) => p[0] * v[0] + p[1] * v[1] + p[2] * v[2] + p[3];

function aabbVisible(min, max, planes) {
    for (const p of planes) {
        const x = p[0] > 0 ? max[0] : min[0], y = p[1] > 0 ? max[1] : min[1], z = p[2] > 0 ? max[2] : min[2];
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
}
// SECTR_Geometry.FrustumContainsBounds: every corner inside every plane
function aabbContained(min, max, planes) {
    for (const p of planes) {
        const x = p[0] > 0 ? min[0] : max[0], y = p[1] > 0 ? min[1] : max[1], z = p[2] > 0 ? min[2] : max[2];
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
}
// hierarchical test with a plane mask (SECTR baseMask): -1 outside, else mask of planes still straddled
function classify(min, max, planes, mask) {
    let out = mask;
    for (let i = 0; i < planes.length; i++) {
        const bit = 1 << i;
        if (!(mask & bit)) continue;
        const p = planes[i];
        const px = p[0] > 0 ? max[0] : min[0], py = p[1] > 0 ? max[1] : min[1], pz = p[2] > 0 ? max[2] : min[2];
        if (p[0] * px + p[1] * py + p[2] * pz + p[3] < 0) return -1;
        const nx = p[0] > 0 ? min[0] : max[0], ny = p[1] > 0 ? min[1] : max[1], nz = p[2] > 0 ? min[2] : max[2];
        if (p[0] * nx + p[1] * ny + p[2] * nz + p[3] >= 0) out &= ~bit;
    }
    return out;
}
function clipPoly3(poly, planes) {
    let out = poly;
    for (const p of planes) {
        const src = out; out = [];
        for (let i = 0; i < src.length; i++) {
            const a = src[i], b = src[(i + 1) % src.length], da = planeDist(p, a), db = planeDist(p, b);
            if (da >= 0) out.push(a);
            if ((da >= 0) !== (db >= 0)) out.push(v3.lerp(a, b, da / (da - db)));
        }
        if (out.length < 3) return [];
    }
    return out;
}
// SECTR _BuildFrustumFromHull: one plane through the eye per hull edge
function planesFromHull(eye, poly) {
    const c = poly.reduce((s, p) => v3.add(s, p), [0, 0, 0]).map(x => x / poly.length), planes = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        let n = v3.cross(v3.sub(a, eye), v3.sub(b, eye));
        const l = v3.len(n);
        if (l < 1e-9) continue;
        n = v3.mul(n, 1 / l);
        let d = -v3.dot(n, eye);
        if (v3.dot(n, c) + d < 0) { n = v3.mul(n, -1); d = -d; }
        planes.push([n[0], n[1], n[2], d]);
    }
    return planes;
}
function screenRect(poly, vp, W, H) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) {
        const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
        if (w < 1e-4) return [0, 0, W, H];
        const x = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w, y = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w;
        const sx = (x * 0.5 + 0.5) * W, sy = (0.5 - y * 0.5) * H;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return [x0 - 2, y0 - 2, x1 + 2, y1 + 2];
}
const rectIntersect = (a, b) => { const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; return r[2] > r[0] && r[3] > r[1] ? r : null; };
const rectUnion = (a, b) => !a ? b.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

// The heights [lo, hi] within [y0, y1] at which a vertical prism over footprint `shape` ([[x, z]...], convex or not: its
// corners bound it) meets every one of `planes` (inside: n . p + d >= 0), or null: a tall shaft's stretch in a frustum,
// as a slab test per plane, O(planes x corners)
function prismRange(shape, y0, y1, planes) {
    let lo = y0, hi = y1;
    for (const [a, b, c, d] of planes) {
        let m = -Infinity;
        for (const [x, z] of shape) m = Math.max(m, a * x + c * z);
        const k = d + m;
        if (Math.abs(b) < 1e-9) { if (k < 0) return null; continue; }
        if (b > 0) lo = Math.max(lo, -k / b); else hi = Math.min(hi, -k / b);
        if (hi < lo) return null;
    }
    return [lo, hi];
}

return {
    planeDist, aabbVisible, aabbContained, classify, clipPoly3, planesFromHull, screenRect,
    rectIntersect, rectUnion, prismRange,
};
});
