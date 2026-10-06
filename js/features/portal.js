'use strict';
// Entity Portal, as a feature of WebGPU Entities: a Portal-Room visibility system after Far Cry 1's VisArea/Portal and
// SECTR (sectors, portals, occluders, stencil-masked traversal), with an island outdoors, a ship and drones. The engine
// is the one from the WebGPU-EntityPortal demo (its js/ files, in load order); the host (js/engine/host.js) gives it
// its device, canvas target, input and HUD root, and builds its scenario from entities ("portal.*", see
// js/engine/scenario-format.js).

Features.define('portal', (engine) => {
const { GpuChoice } = engine;

// ----------------------------------------------------------------------------------------------- js/core/config.js
// Engine limits and buffer layouts shared by the world, the visibility code, the shaders and the renderer.

const MAX_LIGHTS = 12;                 // point lights per area
const AREA_FLOATS = 12 + MAX_LIGHTS * 8;
const MAT_FLOATS = 12;
const MAX_DRAWS = 4096;
const DRAW_STRIDE = 256;
const MAX_FOG_PORTALS = 4;             // portals per draw whose front areas' fog the scene shader applies
const DRAW_FLOATS = 24 + MAX_FOG_PORTALS * 8;   // model, info, tint, fog planes, fog colours
const MAX_LINE_VERTS = 120000;
const MAX_POLY_VERTS = 30000;
const POLY_FLOATS = 11;                // pos3 normal3 color4 area
const MAX_DEPTH = 12;                  // portal traversal depth
const MAX_ENTRIES = 127;               // stencil refs are 7 bits; bit 7 is the "being marked" flag
const NEAR_PASS = 0.35;                // SECTR: IsPointInHull(cameraPos, maxNearClipDistance)
const DEPTH_FORMAT = 'depth24plus-stencil8';
const PATTERNS = { flat: 0, tiles: 1, panels: 2, noise: 3, grass: 4, hazard: 5, planks: 6, bricks: 7, screen: 8, rust: 9 };
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const DEFAULT_GLASS = [0.55, 0.7, 0.75, 0.12];

// ------------------------------------------------------------------------------------------------- js/core/math.js
// Vector / matrix helpers (column-major Float64Array matrices, WebGPU clip-space depth 0..1) and noise.

const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    madd: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

const m4 = {
    identity() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    mul(a, b) {
        const o = new Float64Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
        return o;
    },
    // WebGPU clip space: depth 0..1
    perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
        return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]);
    },
    lookAt(eye, target, up) {
        const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
        return new Float64Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1]);
    },
    trs(p, deg = 0, s = 1) {
        const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        const [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        return new Float64Array([c * sx, 0, -sn * sx, 0, 0, sy, 0, 0, sn * sz, 0, c * sz, 0, p[0], p[1], p[2], 1]);
    },
    basis(x, y, z, o) {
        return new Float64Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1]);
    },
    point(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    },
    dir(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
    },
    translate(t) { const m = m4.identity(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
    rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float64Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    invert(a) {
        const o = new Float64Array(16);
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det) return o;
        det = 1 / det;
        o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
        o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
        o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
        o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
        o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
        return o;
    },
};
const IDENTITY = m4.identity();

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function hash2i(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2i(xi, yi), b = hash2i(xi + 1, yi), c = hash2i(xi, yi + 1), d = hash2i(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; } return s; }
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------- js/core/geometry2d.js
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

// ---------------------------------------------------------------------------------------------- js/core/frustum.js
// Frustum planes, AABB tests and polygon clipping.
// Planes are [nx, ny, nz, d]; a point is inside when dot(n, p) + d >= 0.

function frustumPlanes(m) {
    const row = i => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const add = (a, b) => a.map((x, i) => x + b[i]), sub = (a, b) => a.map((x, i) => x - b[i]);
    return [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2, sub(r3, r2)].map(p => {
        const l = Math.hypot(p[0], p[1], p[2]); return p.map(x => x / l);
    });
}
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

// ----------------------------------------------------------------------------------------------- js/render/mesh.js
// Geometry: MeshBuilder (one chunk), GeometryPool (every chunk in one vertex / index buffer) and splitMesh.
// vertex = pos(3f) normal(3f) material(u32) -> 28 bytes

function newell(pts) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [x, y, z];
}

class MeshBuilder {
    constructor() {
        this.data = []; this.idx = []; this.count = 0; this.M = null;
        this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity];
    }
    vert(p, n, m) {
        if (this.M) { p = m4.point(this.M, p); n = v3.norm(m4.dir(this.M, n)); }
        this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], m);
        for (let k = 0; k < 3; k++) { if (p[k] < this.min[k]) this.min[k] = p[k]; if (p[k] > this.max[k]) this.max[k] = p[k]; }
        return this.count++;
    }
    // convex polygon; winding is fixed to face n
    poly(pts, n, m) {
        if (pts.length < 3) return;
        const nw = newell(pts);
        if (v3.len(nw) < 1e-9) return;
        if (!n) n = v3.norm(nw);
        const flip = v3.dot(nw, n) < 0, base = this.count;
        for (const p of pts) this.vert(p, n, m);
        for (let k = 1; k < pts.length - 1; k++) {
            if (flip) this.idx.push(base, base + k + 1, base + k); else this.idx.push(base, base + k, base + k + 1);
        }
    }
    box(c, ax, h, m) {
        for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
            const j = (i + 1) % 3, k = (i + 2) % 3, n = v3.mul(ax[i], s), fc = v3.madd(c, n, h[i]);
            const J = v3.mul(ax[j], h[j]), K = v3.mul(ax[k], h[k]);
            this.poly([v3.sub(v3.sub(fc, J), K), v3.sub(v3.add(fc, J), K), v3.add(v3.add(fc, J), K), v3.add(v3.sub(fc, J), K)], n, m);
        }
    }
    cylinder(b, r, h, seg, m) {
        const top = [], bot = [];
        for (let i = 0; i < seg; i++) {
            const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
            const p0 = [b[0] + Math.cos(a0) * r, b[1], b[2] + Math.sin(a0) * r], p1 = [b[0] + Math.cos(a1) * r, b[1], b[2] + Math.sin(a1) * r];
            this.poly([p0, p1, [p1[0], b[1] + h, p1[2]], [p0[0], b[1] + h, p0[2]]], [Math.cos(am), 0, Math.sin(am)], m);
            top.push([p0[0], b[1] + h, p0[2]]); bot.push(p0);
        }
        this.poly(top, [0, 1, 0], m); this.poly(bot, [0, -1, 0], m);
    }
    cone(b, r, h, seg, m) {
        const apex = [b[0], b[1] + h, b[2]], bot = [];
        for (let i = 0; i < seg; i++) {
            const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, am = (a0 + a1) / 2;
            const p0 = [b[0] + Math.cos(a0) * r, b[1], b[2] + Math.sin(a0) * r], p1 = [b[0] + Math.cos(a1) * r, b[1], b[2] + Math.sin(a1) * r];
            this.poly([p0, p1, apex], v3.norm([Math.cos(am) * h, r, Math.sin(am) * h]), m);
            bot.push(p0);
        }
        this.poly(bot, [0, -1, 0], m);
    }
}

class GeometryPool {
    constructor() { this.vdata = []; this.idata = []; this.vcount = 0; this.chunks = []; }
    add(b, info) {
        if (!b.idx.length) return null;
        const c = Object.assign({ first: this.idata.length, count: b.idx.length, baseVertex: this.vcount, min: b.min.slice(), max: b.max.slice() }, info);
        for (let i = 0; i < b.data.length; i++) this.vdata.push(b.data[i]);
        for (let i = 0; i < b.idx.length; i++) this.idata.push(b.idx[i]);
        this.vcount += b.count; this.chunks.push(c);
        return c;
    }
    arrays() {
        const v = new Float32Array(this.vdata.length), u = new Uint32Array(v.buffer);
        for (let i = 0; i < this.vdata.length; i++) { if (i % 7 === 6) u[i] = this.vdata[i]; else v[i] = this.vdata[i]; }
        return { vertices: v, indices: new Uint32Array(this.idata) };
    }
}

// Split a MeshBuilder by a plane [nx, ny, nz, d] into [negative side, positive side].
// Straddling triangles are clipped; position and normal are interpolated, winding is kept.
function splitMesh(b, plane) {
    const neg = new MeshBuilder(), pos = new MeshBuilder(), eps = 1e-5;
    const V = i => ({ p: [b.data[i * 7], b.data[i * 7 + 1], b.data[i * 7 + 2]], n: [b.data[i * 7 + 3], b.data[i * 7 + 4], b.data[i * 7 + 5]], m: b.data[i * 7 + 6] });
    const emit = (dst, verts) => {
        if (verts.length < 3) return;
        const base = dst.count;
        for (const v of verts) dst.vert(v.p, v.n, v.m);
        for (let k = 1; k < verts.length - 1; k++) dst.idx.push(base, base + k, base + k + 1);
    };
    const clip = (tri, ds, sign) => {
        const out = [];
        for (let i = 0; i < 3; i++) {
            const a = tri[i], c = tri[(i + 1) % 3], da = ds[i] * sign, dc = ds[(i + 1) % 3] * sign;
            if (da >= 0) out.push(a);
            if ((da >= 0) !== (dc >= 0)) {
                const t = da / (da - dc);
                out.push({ p: v3.lerp(a.p, c.p, t), n: v3.norm(v3.lerp(a.n, c.n, t)), m: a.m });
            }
        }
        return out;
    };
    for (let t = 0; t < b.idx.length; t += 3) {
        const tri = [V(b.idx[t]), V(b.idx[t + 1]), V(b.idx[t + 2])], ds = tri.map(v => planeDist(plane, v.p));
        if (ds.every(d => d <= eps)) emit(neg, tri);
        else if (ds.every(d => d >= -eps)) emit(pos, tri);
        else { emit(pos, clip(tri, ds, 1)); emit(neg, clip(tri, ds, -1)); }
    }
    return [neg, pos];
}

// World-space AABB of a chunk placed with matrix `model`
function worldBounds(model, chunk) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
        const p = m4.point(model, [i & 1 ? chunk.max[0] : chunk.min[0], i & 2 ? chunk.max[1] : chunk.min[1], i & 4 ? chunk.max[2] : chunk.min[2]]);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    }
    return { min: mn, max: mx };
}

// ------------------------------------------------------------------------------------------ js/render/materials.js
// Material table: scenario `materials` -> one storage buffer the scene shader indexes with each vertex's
// material id. Per material: albedo rgb + pattern, scale, spec, emissive rgb + strength (MAT_FLOATS).

class MaterialTable {
    constructor(defs = {}, warnings = []) {
        this.warnings = warnings;
        this.names = Object.keys(defs);
        if (!this.names.length) this.names.push('default');
        this.byName = new Map(this.names.map((n, i) => [n, i]));
        this.data = new Float32Array(this.names.length * MAT_FLOATS);
        this.names.forEach((name, i) => {
            const m = defs[name] || {}, a = m.albedo || [0.6, 0.6, 0.6], e = m.emissive || [0, 0, 0, 0];
            this.data.set([a[0], a[1], a[2], PATTERNS[m.pattern] ?? 0, m.scale ?? 1, m.spec ?? 0.2, 0, 0, e[0], e[1], e[2], e[3] ?? 1], i * MAT_FLOATS);
        });
    }

    // index of a material; unknown names fall back to the first one (with a scenario warning)
    index(name) {
        if (this.byName.has(name)) return this.byName.get(name);
        this.warnings.push(`unknown material "${name}"`);
        this.byName.set(name, 0);
        return 0;
    }
}

// -------------------------------------------------------------------------------------------- js/render/shaders.js
// WGSL sources. The scene shader indexes the per-area lighting table and the material table (storage
// buffers) with the draw's area and each vertex's material id.

const WGSL_COMMON = /* wgsl */`
struct Globals {
    viewProj: mat4x4f, invViewProj: mat4x4f, eye: vec4f, sunDir: vec4f, sunColor: vec4f,
    skyTop: vec4f, skyHorizon: vec4f, params: vec4f,
};
struct Light { posRad: vec4f, color: vec4f };
struct Area { ambient: vec4f, fog: vec4f, info: vec4f, lights: array<Light, ${MAX_LIGHTS}> };
struct Material { albedo: vec4f, params: vec4f, emissive: vec4f };
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<storage, read> areas: array<Area>;
@group(0) @binding(2) var<storage, read> mats: array<Material>;

fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
    var s = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
    return s;
}
fn tonemap(c: vec3f) -> vec3f { return pow(vec3f(1.0) - exp(-c * 1.15), vec3f(1.0 / 2.2)); }
fn skyColor(dir: vec3f) -> vec3f {
    let t = dir.y;
    var col = mix(G.skyHorizon.rgb, G.skyTop.rgb, pow(max(t, 0.0), 0.6));
    if (t < 0.0) { col = mix(G.skyHorizon.rgb, G.skyHorizon.rgb * 0.5, min(-t * 4.0, 1.0)); }
    if (t > 0.01) {
        let uv = dir.xz / t * 0.6 + vec2f(G.params.x * 0.01, 0.0);
        let c = smoothstep(0.5, 0.8, fbm(uv));
        col = mix(col, vec3f(1.6), c * 0.6 * smoothstep(0.0, 0.25, t));
    }
    let sd = max(dot(dir, normalize(G.sunDir.xyz)), 0.0);
    return col + G.sunColor.rgb * (pow(sd, 900.0) * 8.0 + pow(sd, 10.0) * 0.25);
}
`;

const WGSL_WORLD = WGSL_COMMON + /* wgsl */`
// info: x = lighting area, y = number of fog portals.
// fogPlanes / fogColors: the portals this draw is seen through, nearest first, with the fog (rgb, density)
// of the area in front of each one
struct Draw {
    model: mat4x4f, info: vec4f, tint: vec4f,
    fogPlanes: array<vec4f, ${MAX_FOG_PORTALS}>, fogColors: array<vec4f, ${MAX_FOG_PORTALS}>,
};
@group(1) @binding(0) var<uniform> D: Draw;

// Fog along the view ray, split at the portals it passes through: each segment is fogged by the area it
// crosses, the last one (behind the deepest portal) by the surface's own area.
fn applyFog(c: vec3f, wpos: vec3f, own: vec4f) -> vec3f {
    let dist = length(wpos - G.eye.xyz);
    let n = u32(D.info.y);
    var t: array<f32, ${MAX_FOG_PORTALS + 1}>;      // fraction of the ray at each portal crossing
    t[0] = 0.0;
    for (var k = 0u; k < n; k++) {
        let pl = D.fogPlanes[k];
        let se = dot(pl.xyz, G.eye.xyz) + pl.w;
        let sp = dot(pl.xyz, wpos) + pl.w;
        var tk = 1.0;
        if (abs(se - sp) > 1e-6) { tk = clamp(se / (se - sp), 0.0, 1.0); }
        t[k + 1] = max(tk, t[k]);
    }
    var col = mix(c, own.rgb, 1.0 - exp(-dist * (1.0 - t[n]) * own.w));
    for (var k = i32(n) - 1; k >= 0; k--) {
        let f = D.fogColors[k];
        col = mix(col, f.rgb, 1.0 - exp(-dist * (t[k + 1] - t[k]) * f.w));
    }
    return col;
}

struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) wpos: vec3f,
    @location(1) nrm: vec3f,
    @location(2) lpos: vec3f,
    @location(3) @interpolate(flat) mat: u32,
    @location(4) lnrm: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: u32) -> VOut {
    var o: VOut;
    let w = D.model * vec4f(p, 1.0);
    o.pos = G.viewProj * w;
    o.wpos = w.xyz;
    o.nrm = (D.model * vec4f(n, 0.0)).xyz;
    o.lpos = p;
    o.lnrm = n;
    o.mat = m;
    return o;
}

// procedural surface: rgb = albedo, a = emissive mask
fn surface(m: Material, lp: vec3f, n: vec3f) -> vec4f {
    let an = abs(n);
    var uv = lp.xy;
    if (an.y > an.x && an.y > an.z) { uv = lp.xz; } else if (an.x > an.z) { uv = lp.zy; }
    uv = uv * m.params.x;
    let base = m.albedo.rgb;
    let kind = i32(m.albedo.w + 0.5);
    var col = base;
    var em = 1.0;
    switch kind {
        case 1: {
            let g = abs(fract(uv) - 0.5);
            let line = smoothstep(0.44, 0.48, max(g.x, g.y));
            col = base * (0.9 + 0.12 * hash2(floor(uv))) * (1.0 - 0.45 * line);
        }
        case 2: {
            let g = abs(fract(uv) - 0.5); let e = max(g.x, g.y);
            let seam = smoothstep(0.46, 0.49, e); let bevel = smoothstep(0.40, 0.46, e) * 0.12;
            col = base * (0.95 + 0.1 * hash2(floor(uv))) * (1.0 - 0.55 * seam + bevel) * (0.92 + 0.12 * vnoise(uv * 6.0));
        }
        case 3: { col = base * (0.78 + 0.38 * fbm(uv * 3.0)); }
        case 4: {
            let n1 = fbm(uv * 2.0); let n2 = vnoise(uv * 23.0);
            col = mix(base * 0.7, base * vec3f(1.25, 1.15, 0.9), n1) * (0.85 + 0.25 * n2);
        }
        case 5: { col = mix(base, vec3f(0.04), step(0.5, fract(uv.x + uv.y))); }
        case 6: {
            let row = floor(uv.y * 4.0);
            let x = uv.x + hash2(vec2f(row, 3.0)) * 3.0;
            let seam = min(step(fract(uv.y * 4.0), 0.06) + step(fract(x * 0.5), 0.02), 1.0);
            let grain = 0.85 + 0.25 * vnoise(vec2f(x * 2.0, uv.y * 40.0));
            col = base * grain * (0.9 + 0.2 * hash2(vec2f(row, floor(x * 0.5)))) * (1.0 - 0.5 * seam);
        }
        case 7: {
            let r = floor(uv.y * 4.0);
            let x = uv.x * 2.0 + select(0.0, 0.5, (i32(r) & 1) == 1);
            let mortar = max(step(fract(x), 0.05), step(fract(uv.y * 4.0), 0.08));
            col = mix(base * (0.8 + 0.3 * hash2(vec2f(floor(x), r))), vec3f(0.55, 0.53, 0.5), mortar);
        }
        case 8: {
            let t = G.params.x;
            let scan = 0.7 + 0.3 * sin(uv.y * 140.0 - t * 8.0);
            let cell = floor(uv * vec2f(16.0, 9.0));
            let blocks = step(0.5, hash2(cell + vec2f(floor(t * 1.5), 0.0)));
            em = scan * (0.25 + 0.75 * blocks);
        }
        case 9: {
            // painted steel with vertical rust streaks and panel seams
            let streak = smoothstep(0.55, 0.95, vnoise(vec2f(uv.x * 9.0, uv.y * 0.6)) * fbm(uv * vec2f(2.0, 0.4)) * 1.8);
            let seam = smoothstep(0.47, 0.5, abs(fract(uv.x * 0.25) - 0.5)) * 0.35;
            col = mix(base * (0.85 + 0.2 * fbm(uv * 2.0)), vec3f(0.30, 0.13, 0.05), streak) * (1.0 - seam);
        }
        default: {}
    }
    return vec4f(col, em);
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
    let m = mats[i.mat];
    let ai = u32(D.info.x);
    let N = normalize(i.nrm);
    let s = surface(m, i.lpos, normalize(i.lnrm));
    let albedo = s.rgb * D.tint.rgb;
    let V = normalize(G.eye.xyz - i.wpos);
    var col = albedo * areas[ai].ambient.rgb * (0.7 + 0.3 * N.y);
    let sunAmt = areas[ai].info.x;
    if (sunAmt > 0.0) {
        let L = normalize(G.sunDir.xyz);
        let ndl = max(dot(N, L), 0.0);
        let H = normalize(L + V);
        col += (albedo + vec3f(pow(max(dot(N, H), 0.0), 48.0) * m.params.y)) * ndl * G.sunColor.rgb * sunAmt;
    }
    let count = u32(areas[ai].info.y);
    for (var k = 0u; k < count; k++) {
        let lp = areas[ai].lights[k].posRad;
        let lc = areas[ai].lights[k].color;
        let dv = lp.xyz - i.wpos;
        let dist = length(dv);
        let L = dv / max(dist, 1e-4);
        let att = pow(clamp(1.0 - dist / lp.w, 0.0, 1.0), 2.0);
        let ndl = max(dot(N, L), 0.0);
        let H = normalize(L + V);
        col += (albedo + vec3f(pow(max(dot(N, H), 0.0), 32.0) * m.params.y)) * ndl * lc.rgb * lc.w * att;
    }
    col += m.emissive.rgb * m.emissive.w * s.a;
    return vec4f(tonemap(applyFog(col, i.wpos, areas[ai].fog)), 1.0);
}
`;

const WGSL_SKY = WGSL_COMMON + /* wgsl */`
struct SOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> SOut {
    var o: SOut;
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    o.pos = vec4f(p, 1.0, 1.0);
    o.ndc = p;
    return o;
}
@fragment fn fs(i: SOut) -> @location(0) vec4f {
    let h = G.invViewProj * vec4f(i.ndc, 1.0, 1.0);
    return vec4f(tonemap(skyColor(normalize(h.xyz / h.w - G.eye.xyz))), 1.0);
}
`;

// portal polygons (stencil marks) and glass panes share one vertex layout: pos3 normal3 color4
const WGSL_POLY = WGSL_COMMON + /* wgsl */`
struct POut { @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) nrm: vec3f, @location(2) col: vec4f, @location(3) @interpolate(flat) area: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f, @location(3) a: f32) -> POut {
    var o: POut;
    o.pos = G.viewProj * vec4f(p, 1.0);
    o.wpos = p; o.nrm = n; o.col = c; o.area = a;
    return o;
}
// fog of the area in front of a portal, over the distance from the eye to the portal surface
fn portalFog(i: POut) -> vec4f {
    let ai = u32(i.area + 0.5);
    return vec4f(areas[ai].fog.rgb, 1.0 - exp(-length(G.eye.xyz - i.wpos) * areas[ai].fog.w));
}
// veil over an open portal: what is seen through it is fogged by the air in front of it (scissor / none
// modes only; in stencil mode the scene shader fogs through the portals itself)
@fragment fn fsVeil(i: POut) -> @location(0) vec4f {
    let f = portalFog(i);
    return vec4f(tonemap(f.rgb), f.a);
}
@fragment fn fsMark(i: POut) -> @location(0) vec4f { return vec4f(0.0); }
fn waveH(q: vec2f, t: f32) -> f32 {
    return fbm(q * 0.18 + vec2f(t * 0.03, t * 0.02)) + vnoise(q * 0.9 + vec2f(-t * 0.25, t * 0.18)) * 0.35 + vnoise(q * 2.3 + vec2f(t * 0.5, t * 0.1)) * 0.12;
}
@fragment fn fsWater(i: POut) -> @location(0) vec4f {
    let t = G.params.x;
    let p = i.wpos.xz;
    let e = 0.2;
    let hx = waveH(p + vec2f(e, 0.0), t) - waveH(p - vec2f(e, 0.0), t);
    let hz = waveH(p + vec2f(0.0, e), t) - waveH(p - vec2f(0.0, e), t);
    let N = normalize(vec3f(-hx * 1.2, 2.0 * e, -hz * 1.2));
    let toEye = G.eye.xyz - i.wpos;
    let dist = length(toEye);
    let V = toEye / dist;
    let fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    let R = reflect(-V, N);
    let refl = skyColor(vec3f(R.x, abs(R.y), R.z));
    let L = normalize(G.sunDir.xyz);
    let spec = pow(max(dot(R, L), 0.0), 350.0) * 6.0;
    let body = i.col.rgb * (0.35 + 0.65 * max(dot(N, L), 0.0)) * (G.sunColor.rgb * 0.5 + areas[0].ambient.rgb);
    var col = mix(body, refl, fres) + G.sunColor.rgb * spec;
    let fog = 1.0 - exp(-dist * areas[0].fog.w);
    col = mix(col, areas[0].fog.rgb, fog);
    return vec4f(tonemap(col), clamp(mix(i.col.a, 1.0, fres) + fog, 0.0, 1.0));
}
@fragment fn fsGlass(i: POut) -> @location(0) vec4f {
    let V = normalize(G.eye.xyz - i.wpos);
    var N = normalize(i.nrm);
    if (dot(N, V) < 0.0) { N = -N; }
    let ndv = clamp(dot(N, V), 0.0, 1.0);
    let fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    let refl = skyColor(reflect(-V, N)) * 0.55;
    let q = vec2f(i.wpos.x + i.wpos.z, i.wpos.y);
    let smudge = smoothstep(0.45, 0.9, fbm(q * 2.5)) * 0.35 + smoothstep(0.7, 1.0, vnoise(vec2f(q.x * 30.0, q.y * 1.5))) * 0.15;
    let col = mix(i.col.rgb * 0.35, refl, 0.35 + 0.65 * fres) + vec3f(smudge * 0.25);
    let a = clamp(i.col.a + fres * 0.55 + smudge * 0.25, 0.0, 0.92);
    let f = portalFog(i);
    // stencil mode (params.w = 1): what is behind the pane is already fogged along its whole ray by the
    // scene shader, so only the pane itself is fogged
    if (G.params.w > 0.5) { return vec4f(tonemap(mix(col, f.rgb, f.a)), a); }
    // otherwise fog in front of the pane covers both the glass and what is behind it:
    // out = mix(mix(dst, glass, a), fog, f)  ->  src = (glass*a*(1-f) + fog*f) / A,  A = a*(1-f) + f
    let A = a * (1.0 - f.a) + f.a;
    return vec4f(tonemap((col * a * (1.0 - f.a) + f.rgb * f.a) / max(A, 1e-4)), A);
}
`;

const WGSL_LINES = WGSL_COMMON + /* wgsl */`
struct LOut { @builtin(position) pos: vec4f, @location(0) col: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec4f) -> LOut {
    var o: LOut;
    o.pos = G.viewProj * vec4f(p, 1.0);
    o.col = c;
    return o;
}
@fragment fn fs(i: LOut) -> @location(0) vec4f { return i.col; }
`;

// ------------------------------------------------------------------------------------------- js/render/renderer.js
// Renderer: pipelines for the scene, sky, stencil marks, water, glass / fog veils and debug lines, and one
// render pass that executes a command list built by FrameBuilder.

function depthState(o) {
    const face = { compare: o.sCompare || 'always', failOp: 'keep', depthFailOp: 'keep', passOp: o.sPass || 'keep' };
    return {
        format: DEPTH_FORMAT, depthWriteEnabled: !!o.write, depthCompare: o.compare || 'less',
        stencilFront: face, stencilBack: face, stencilReadMask: o.read ?? 0xFF, stencilWriteMask: o.writeMask ?? 0,
    };
}

class Renderer {
    // fx: the feature context (the host's device and canvas target; see js/engine/host.js)
    constructor(fx) { this.fx = fx; this.onError = (msg) => console.error(msg); }

    async init() {
        const device = this.device = this.fx.device;
        this.format = this.fx.format;

        const U = GPUBufferUsage;
        this.globalBuf = device.createBuffer({ size: 224, usage: U.UNIFORM | U.COPY_DST });
        this.drawBuf = device.createBuffer({ size: MAX_DRAWS * DRAW_STRIDE, usage: U.UNIFORM | U.COPY_DST });
        this.lineBuf = device.createBuffer({ size: MAX_LINE_VERTS * 28, usage: U.VERTEX | U.COPY_DST });
        this.polyBuf = device.createBuffer({ size: MAX_POLY_VERTS * POLY_FLOATS * 4, usage: U.VERTEX | U.COPY_DST });
        this.drawData = new Float32Array(MAX_DRAWS * DRAW_STRIDE / 4);

        const S = GPUShaderStage;
        this.bgl0 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: S.FRAGMENT, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ] });
        this.bgl1 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_FLOATS * 4 } },
        ] });
        this.drawBG = device.createBindGroup({ layout: this.bgl1, entries: [{ binding: 0, resource: { buffer: this.drawBuf, size: DRAW_FLOATS * 4 } }] });
        const worldLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl0, this.bgl1] });
        const baseLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl0] });
        const ms = { count: 4 };
        const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

        const worldMod = device.createShaderModule({ code: WGSL_WORLD });
        const world = stencil => device.createRenderPipeline({
            layout: worldLayout,
            vertex: { module: worldMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'uint32' },
            ] }] },
            fragment: { module: worldMod, entryPoint: 'fs', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: depthState({ write: true, compare: 'less', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.worldStencil = world(true);
        this.worldPlain = world(false);

        const skyMod = device.createShaderModule({ code: WGSL_SKY });
        const sky = stencil => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: skyMod, entryPoint: 'vs' },
            fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: depthState({ compare: 'less-equal', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.skyStencil = sky(true);
        this.skyPlain = sky(false);

        const polyMod = device.createShaderModule({ code: WGSL_POLY });
        const polyVB = [{ arrayStride: POLY_FLOATS * 4, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' },
            { shaderLocation: 3, offset: 40, format: 'float32' },
        ] }];
        const mark = ds => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsMark', targets: [{ format: this.format, writeMask: 0 }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState(ds),
            multisample: ms,
        });
        // three passes over the child's clipped portal polygon:
        //  A: where stencil == parent and the aperture is not hidden by nearer geometry, set bit 7
        //  B: where bit 7 is set, write the child's ref into bits 0..6
        //  C: clear bit 7
        this.markA = mark({ compare: 'less-equal', sCompare: 'equal', sPass: 'invert', read: 0x7F, writeMask: 0x80 });
        this.markB = mark({ compare: 'always', sCompare: 'equal', sPass: 'replace', read: 0x80, writeMask: 0x7F });
        this.markC = mark({ compare: 'always', sCompare: 'equal', sPass: 'zero', read: 0x80, writeMask: 0x80 });
        const water = stencil => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsWater', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal', sCompare: stencil ? 'equal' : 'always' }),
            multisample: ms,
        });
        this.waterStencil = water(true);
        this.waterPlain = water(false);
        this.veilPipe = device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsVeil', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal' }),
            multisample: ms,
        });
        this.glassPipe = device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: polyMod, entryPoint: 'vs', buffers: polyVB },
            fragment: { module: polyMod, entryPoint: 'fsGlass', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthState({ compare: 'less-equal' }),
            multisample: ms,
        });

        const lineMod = device.createShaderModule({ code: WGSL_LINES });
        const lines = compare => device.createRenderPipeline({
            layout: baseLayout,
            vertex: { module: lineMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ] }] },
            fragment: { module: lineMod, entryPoint: 'fs', targets: [{ format: this.format, blend }] },
            primitive: { topology: 'line-list' },
            depthStencil: depthState({ compare }),
            multisample: ms,
        });
        this.lineDepthPipe = lines('less-equal');
        this.lineOverlayPipe = lines('always');
    }

    upload(world) {
        const d = this.device, U = GPUBufferUsage;
        for (const b of [this.vbuf, this.ibuf, this.matBuf, this.areaBuf]) b?.destroy();
        const { vertices, indices } = world.pool.arrays();
        this.vbuf = d.createBuffer({ size: Math.max(16, vertices.byteLength), usage: U.VERTEX | U.COPY_DST });
        this.ibuf = d.createBuffer({ size: Math.max(16, indices.byteLength), usage: U.INDEX | U.COPY_DST });
        d.queue.writeBuffer(this.vbuf, 0, vertices);
        d.queue.writeBuffer(this.ibuf, 0, indices);
        this.matBuf = d.createBuffer({ size: world.materials.data.byteLength, usage: U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.matBuf, 0, world.materials.data);
        this.areaBuf = d.createBuffer({ size: world.areas.length * AREA_FLOATS * 4, usage: U.STORAGE | U.COPY_DST });
        this.bg0 = d.createBindGroup({ layout: this.bgl0, entries: [
            { binding: 0, resource: { buffer: this.globalBuf } },
            { binding: 1, resource: { buffer: this.areaBuf } },
            { binding: 2, resource: { buffer: this.matBuf } },
        ] });
    }

    resize(W, H) {
        if (this.W === W && this.H === H) return;
        this.W = W; this.H = H;
        this.msaa?.destroy(); this.depth?.destroy();
        this.msaa = this.device.createTexture({ size: [W, H], sampleCount: 4, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        // sampled too: a composition reads its depth (js/engine/compositor.js)
        this.depth = this.device.createTexture({ size: [W, H], sampleCount: 4, format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.depthSample = this.depth.createView({ aspect: 'depth-only' });
    }

    // f.cmds: draw | sky | mark | glass | veil | water, executed in order (portal-tree DFS in stencil mode)
    // f.draws: one { o, fog } per draw slot; fog = the portals it is seen through, nearest first
    render(f) {
        const d = this.device, q = d.queue, W = this.W, H = this.H;
        q.writeBuffer(this.globalBuf, 0, f.globals);
        q.writeBuffer(this.areaBuf, 0, f.areas);
        const F = DRAW_STRIDE / 4, nSlots = Math.min(f.draws.length, MAX_DRAWS), D = this.drawData;
        for (let i = 0; i < nSlots; i++) {
            const { o, fog } = f.draws[i], k = i * F, n = Math.min(fog.length, MAX_FOG_PORTALS);
            D.set(o.model, k);
            D[k + 16] = o.lightArea; D[k + 17] = n;
            D[k + 20] = 1; D[k + 21] = 1; D[k + 22] = 1; D[k + 23] = 1;
            for (let j = 0; j < n; j++) {
                D.set(fog[j].plane, k + 24 + j * 4);
                D.set(fog[j].fog, k + 24 + (MAX_FOG_PORTALS + j) * 4);
            }
        }
        if (nSlots) q.writeBuffer(this.drawBuf, 0, this.drawData, 0, nSlots * F);
        const polyVerts = Math.min(f.polys.length / POLY_FLOATS, MAX_POLY_VERTS);
        if (polyVerts) q.writeBuffer(this.polyBuf, 0, f.polys, 0, polyVerts * POLY_FLOATS);
        const lineVerts = Math.min(f.lines.length / 7, MAX_LINE_VERTS);
        if (lineVerts) q.writeBuffer(this.lineBuf, 0, f.lines, 0, lineVerts * 7);

        const enc = d.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.fx.target(),
                clearValue: { r: 0.004, g: 0.005, b: 0.007, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
                stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
        });
        const scissor = r => {
            const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1])), x1 = Math.min(W, Math.ceil(r[2])), y1 = Math.min(H, Math.ceil(r[3]));
            if (x1 <= x0 || y1 <= y0) return false;
            pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
            return true;
        };
        let pipe = null, vb = null;
        const use = (p, buffer) => {
            if (p !== pipe) { pass.setPipeline(p); pipe = p; }
            if (buffer && buffer !== vb) { pass.setVertexBuffer(0, buffer); vb = buffer; }
        };
        pass.setBindGroup(0, this.bg0);
        pass.setIndexBuffer(this.ibuf, 'uint32');
        const worldPipe = f.stencil ? this.worldStencil : this.worldPlain, skyPipe = f.stencil ? this.skyStencil : this.skyPlain;
        for (const c of f.cmds) {
            if (!scissor(c.rect)) continue;
            switch (c.op) {
                case 'draw':
                    if (c.slot >= MAX_DRAWS) break;
                    use(worldPipe, this.vbuf);
                    pass.setStencilReference(c.ref);
                    pass.setBindGroup(1, this.drawBG, [c.slot * DRAW_STRIDE]);
                    pass.drawIndexed(c.chunk.count, 1, c.chunk.first, c.chunk.baseVertex, 0);
                    break;
                case 'sky':
                    use(skyPipe);
                    pass.setStencilReference(c.ref);
                    pass.draw(3);
                    break;
                case 'mark':
                    use(this.markA, this.polyBuf); pass.setStencilReference(c.parent); pass.draw(c.count, 1, c.first);
                    use(this.markB); pass.setStencilReference(0x80 | c.child); pass.draw(c.count, 1, c.first);
                    use(this.markC); pass.setStencilReference(0x80); pass.draw(c.count, 1, c.first);
                    break;
                case 'water':
                    use(f.stencil ? this.waterStencil : this.waterPlain, this.polyBuf);
                    pass.setStencilReference(c.ref);
                    pass.draw(c.count, 1, c.first);
                    break;
                case 'glass':
                case 'veil':
                    use(c.op === 'glass' ? this.glassPipe : this.veilPipe, this.polyBuf);
                    pass.draw(c.count, 1, c.first);
                    break;
            }
        }
        if (lineVerts) {
            pass.setScissorRect(0, 0, W, H);
            const nd = Math.min(f.lineDepthCount, lineVerts);
            if (nd) { use(this.lineDepthPipe, this.lineBuf); pass.draw(nd, 1, 0); }
            if (lineVerts > nd) { use(this.lineOverlayPipe, this.lineBuf); pass.draw(lineVerts - nd, 1, nd); }
        }
        pass.end();
        q.submit([enc.finish()]);
    }
}

// -------------------------------------------------------------------------------------- js/render/frame-builder.js
// FrameBuilder: visibility entries -> object tree queries -> command list for Renderer.render.
//
// Stencil mode draws the portal tree depth-first. Each child's clipped portal polygon is marked into the
// stencil where the parent's ref is; the child's objects and sky then draw with stencil EQUAL. Every draw
// carries the chain of portals it is seen through (plane + fog of the area in front of each), so the scene
// shader fogs each stretch of the view ray with the air it crosses. After a child, its portal gets its
// glass pane; water draws last in every outdoor entry.
// Scissor / none modes draw every visible object once, clipped to the union of its entries' rects; fog
// through portals is then approximated by fog veils over the apertures.

const NO_FOG_CHAIN = [];

class FrameBuilder {
    constructor(world) {
        this.world = world;
        this.stamp = 0;
    }

    build(vis, mode, W, H) {
        this.stamp++;
        this.vis = vis;
        this.cmds = [];
        this.objs = [];
        this.draws = [];
        this.polys = [];
        this.st = { outNodes: 0, outObjs: 0, inNodes: 0, inObjs: 0, occluded: 0, marks: 0, refs: 1, glass: 0, water: 0, veils: 0 };
        if (mode === 'stencil') this.buildStencil();
        else this.buildFlat(mode, [0, 0, W, H]);
        return { cmds: this.cmds, objs: this.objs, draws: this.draws, polys: new Float32Array(this.polys), stats: this.st };
    }

    // draw slot of an object seen through a fog chain: one per (object, chain) this frame
    slot(o, fog = NO_FOG_CHAIN) {
        if (o.stamp !== this.stamp) { o.stamp = this.stamp; o.slots = new Map(); o.rect = null; this.objs.push(o); }
        let s = o.slots.get(fog);
        if (s === undefined) { s = this.draws.length; this.draws.push({ o, fog }); o.slots.set(fog, s); }
        return s;
    }

    occluded(o) {
        const occ = this.vis.occluders;
        return occ.length && occ.some(oc => aabbContained(o.wmin || o.min, o.wmax || o.max, oc.planes));
    }

    // query the tree of the entry's area only (outdoor quadtree or the area's BVH + its dynamic members)
    collect(e) {
        const w = this.world, st = this.st, out = [];
        if (e.skyOnly) return out;
        const counter = { nodes: 0, objs: 0 };
        const visit = o => { if (o.dockedOnly && !o.vehicle.docked) return; if (this.occluded(o)) st.occluded++; else out.push(o); };
        if (e.area === 0) {
            w.outdoorTree.query(e.planes, visit, counter);
            for (const veh of w.vehicles) veh.outdoorTree.query(veh.localPlanes(e.planes), visit, counter);   // vehicle space
        } else {
            const veh = w.areas[e.area].vehicle;
            w.areaTrees[e.area].query(veh ? veh.localPlanes(e.planes) : e.planes, visit, counter);
        }
        for (const d of w.dynamicByArea[e.area]) { counter.objs++; if (aabbVisible(d.min, d.max, e.planes)) visit(d); }
        if (e.area === 0) { st.outNodes += counter.nodes; st.outObjs += counter.objs; } else { st.inNodes += counter.nodes; st.inObjs += counter.objs; }
        return out;
    }

    addPoly(pts, n, c, area = 0) {
        const polys = this.polys, first = polys.length / POLY_FLOATS;
        for (let k = 1; k < pts.length - 1; k++) for (const p of [pts[0], pts[k], pts[k + 1]]) polys.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], c[3], area);
        return { first, count: polys.length / POLY_FLOATS - first };
    }

    addPolys(list, n, c) {
        const first = this.polys.length / POLY_FLOATS;
        for (const pts of list) this.addPoly(pts, n, c);
        return { first, count: this.polys.length / POLY_FLOATS - first };
    }

    // after what lies behind a portal is drawn: its glass pane, or (veil = true) a fog veil if the air in
    // front is foggy
    portalCover(P, pts, area, rect, veil) {
        if (P.glass) { this.cmds.push(Object.assign({ op: 'glass', rect }, this.addPoly(pts, P.normal, P.glass, area))); this.st.glass++; }
        else if (veil && this.world.areas[area].fog[3] > 0) { this.cmds.push(Object.assign({ op: 'veil', rect }, this.addPoly(pts, P.normal, [0, 0, 0, 0], area))); this.st.veils++; }
    }

    waterVisible(e) {
        const w = this.world;
        return e.area === 0 && w.water && !e.skyOnly && aabbVisible(w.water.min, w.water.max, e.planes);
    }

    buildStencil() {
        const w = this.world, cmds = this.cmds, st = this.st;
        let nextRef = 1;
        const walk = e => {
            for (const o of this.collect(e)) cmds.push({ op: 'draw', chunk: o.chunk, slot: this.slot(o, e.fog), ref: e.ref, rect: e.rect });
            if (e.area === 0) cmds.push({ op: 'sky', ref: e.ref, rect: e.rect });
            for (const c of e.children) {
                // the air in front of the portal fogs the ray up to its plane
                const P = c.via;
                c.fog = c.share ? e.fog : e.fog.concat([{ plane: [P.normal[0], P.normal[1], P.normal[2], P.d], fog: w.areas[e.area].fog }]);
                if (c.share || nextRef > 127) c.ref = e.ref;             // camera in the aperture: same region as the parent
                else {
                    c.ref = nextRef++;
                    cmds.push(Object.assign({ op: 'mark', parent: e.ref, child: c.ref, rect: c.rect }, this.addPoly(c.clipped, c.via.normal, [0, 0, 0, 0])));
                    st.marks++;
                }
                walk(c);
                if (!c.share) this.portalCover(c.via, c.clipped, e.area, c.rect, false);
            }
            // water last: it blends over this outdoor entry only (children already own their stencil refs)
            if (this.waterVisible(e)) {
                cmds.push(Object.assign({ op: 'water', ref: e.ref, rect: e.rect }, this.addPolys(w.water.pieces, [0, 1, 0], w.water.color)));
                st.water++;
            }
        };
        for (const r of this.vis.entries) if (!r.parent) { r.ref = 0; r.fog = NO_FOG_CHAIN; walk(r); }
        st.refs = nextRef;
    }

    buildFlat(mode, full) {
        const w = this.world, vis = this.vis, cmds = this.cmds;
        for (const e of vis.entries) for (const o of this.collect(e)) { this.slot(o); o.rect = rectUnion(o.rect, e.rect); }
        for (const o of this.objs) cmds.push({ op: 'draw', chunk: o.chunk, slot: o.slots.get(NO_FOG_CHAIN), ref: 0, rect: mode === 'scissor' ? o.rect : full });
        if (vis.sky) cmds.push({ op: 'sky', ref: 0, rect: mode === 'scissor' ? vis.skyRect : full });
        const outs = (vis.nodes[0] || []).filter(e => this.waterVisible(e));
        if (outs.length) {
            const r = outs.reduce((a, e) => rectUnion(a, e.rect), null);
            cmds.push(Object.assign({ op: 'water', ref: 0, rect: mode === 'scissor' ? r : full }, this.addPolys(w.water.pieces, [0, 1, 0], w.water.color)));
            this.st.water++;
        }
        // glass panes and fog veils, back to front
        const seen = vis.enabled ? [...new Set(vis.entries.filter(e => e.via && !e.share).map(e => e.via))] : this.portalsInView(vis);
        seen.sort((a, b) => v3.dist(b.center, vis.eye) - v3.dist(a.center, vis.eye));
        for (const P of seen) this.portalCover(P, P.verts, v3.dot(P.normal, vis.eye) + P.d < 0 ? P.front : P.back, full, true);
    }

    // with portal culling off, no traversal went through the portals: cover every open portal in the
    // view frustum, except one the camera stands in
    portalsInView(vis) {
        const planes = vis.entries[0].planes, eye = vis.eye;
        return this.world.portals.filter(P => !P.closed && aabbVisible(P.min, P.max, planes) &&
            !(Math.abs(v3.dot(P.normal, eye) + P.d) < NEAR_PASS && P.containsProjected(eye)));
    }
}

// ---------------------------------------------------------------------------------------- js/render/debug-lines.js
// Debug lines: portal outlines by state, clipped apertures, occluders, area volumes and (while the
// visibility is frozen) the frozen frustum and the portal cones.

const VIS_COLORS = {
    passed: [0.3, 1.0, 0.45, 0.95], sky: [0.35, 0.85, 1.0, 0.95], culled: [1.0, 0.75, 0.2, 0.6], closed: [1.0, 0.25, 0.2, 0.9],
    idle: [0.55, 0.6, 0.65, 0.35], clipped: [1, 1, 1, 0.9], occluder: [0.8, 0.4, 1.0, 0.9], frustum: [0.4, 0.9, 1.0, 0.8],
};
const DEPTH_COLORS = [[0.4, 0.9, 1.0], [0.3, 1.0, 0.45], [1.0, 0.85, 0.3], [1.0, 0.5, 0.25], [1.0, 0.3, 0.6], [0.7, 0.4, 1.0]];

// colour of a portal from its flags and this frame's traversal state (1 culled, 2 passed)
function portalColor(P, state) {
    return P.closed ? VIS_COLORS.closed : state === 2 ? (P.skyOnly ? VIS_COLORS.sky : VIS_COLORS.passed) : state === 1 ? VIS_COLORS.culled : VIS_COLORS.idle;
}

// line list: depth-tested lines first, overlay lines after
class Lines {
    constructor() { this.depth = []; this.overlay = []; }
    line(a, b, c, overlay = false) { const t = overlay ? this.overlay : this.depth; t.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]); }
    loop(pts, c, overlay) { for (let i = 0; i < pts.length; i++) this.line(pts[i], pts[(i + 1) % pts.length], c, overlay); }
    build() { const a = new Float32Array(this.depth.length + this.overlay.length); a.set(this.depth); a.set(this.overlay, this.depth.length); return { data: a, depthCount: this.depth.length / 7 }; }
}

class DebugLines {
    constructor(world) {
        this.world = world;
    }

    // opts: { portals, volumes }, frozen: { eye, basis, aspect } | null
    build(vis, opts, frozen, fov) {
        const L = new Lines();
        if (opts.portals) this.portals(L, vis);
        if (opts.volumes) this.volumes(L, vis);
        if (frozen) this.frustum(L, vis, frozen, fov);
        return L.build();
    }

    portals(L, vis) {
        for (const P of this.world.portals) {
            const c = portalColor(P, vis.portalState[P.index]);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, 0.004)), c);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, -0.004)), c);
        }
        for (const e of vis.entries) if (e.clipped && e.clipped !== e.via?.verts) L.loop(e.clipped, VIS_COLORS.clipped, false);
        for (const oc of vis.occluders) L.loop(oc.verts, VIS_COLORS.occluder, false);
    }

    volumes(L, vis) {
        const areas = this.world.areas;
        for (let i = 1; i < areas.length; i++) {
            const a = areas[i], c = vis.nodes[i] ? [0.3, 1, 0.5, 0.7] : [0.5, 0.55, 0.6, 0.25];
            const W3 = q => a.vehicle ? a.vehicle.toWorld(q) : q;
            const lo = a.shape.map(p => W3([p[0], a.y + 0.02, p[1]])), hi = a.shape.map(p => W3([p[0], a.top - 0.02, p[1]]));
            L.loop(lo, c, true); L.loop(hi, c, true);
            for (let k = 0; k < lo.length; k++) L.line(lo[k], hi[k], c, true);
        }
    }

    frustum(L, vis, f, fov) {
        const e = f.eye, { fwd, right, up } = f.basis, dist = 40;
        const th = Math.tan(fov / 2) * dist, tw = th * f.aspect, cen = v3.madd(e, fwd, dist);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => v3.madd(v3.madd(cen, right, sx * tw), up, sy * th));
        for (const c of corners) L.line(e, c, VIS_COLORS.frustum, true);
        L.loop(corners, VIS_COLORS.frustum, true);
        for (const en of vis.entries) {
            if (!en.clipped) continue;
            const dc = DEPTH_COLORS[(en.depth - 1) % DEPTH_COLORS.length], col = [dc[0], dc[1], dc[2], 0.85];
            L.loop(en.clipped, col, true);
            for (const p of en.clipped) {
                L.line(e, p, [dc[0], dc[1], dc[2], 0.35], true);
                const dir = v3.norm(v3.sub(p, e));
                L.line(p, v3.madd(p, dir, 6), [dc[0], dc[1], dc[2], 0.18], true);
            }
        }
    }
}

// ------------------------------------------------------------------------------------------ js/vis/object-trees.js
// Object trees. Outdoors and indoors are partitioned differently:
//   QuadTree   big open outdoor area (terrain chunks, scatter, building shells)
//   BVHTree    one small tree per indoor area (its static members)
// Both are queried with a frustum and a plane mask, so nodes fully inside stop testing planes.

function growBounds(n, o) {
    for (let k = 0; k < 3; k++) { n.min[k] = Math.min(n.min[k], o.min[k]); n.max[k] = Math.max(n.max[k], o.max[k]); }
}
function queryNode(n, planes, mask, visit, st) {
    st.nodes++;
    if (mask) { mask = classify(n.min, n.max, planes, mask); if (mask < 0) return; }
    if (n.objs) for (const o of n.objs) { st.objs++; if (!mask || classify(o.min, o.max, planes, mask) >= 0) visit(o); }
    if (n.kids) for (const k of n.kids) queryNode(k, planes, mask, visit, st);
}
const fullMask = planes => planes.length >= 31 ? 0x7fffffff : (1 << planes.length) - 1;

class BVHTree {
    constructor(objs) { this.kind = 'bvh'; this.count = objs.length; this.nodeCount = 0; this.root = objs.length ? this.build(objs.slice()) : null; }
    build(objs) {
        this.nodeCount++;
        const n = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], objs: null, kids: null };
        for (const o of objs) growBounds(n, o);
        if (objs.length <= 3) { n.objs = objs; return n; }
        const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
        for (const o of objs) for (let k = 0; k < 3; k++) { const c = (o.min[k] + o.max[k]) / 2; cmin[k] = Math.min(cmin[k], c); cmax[k] = Math.max(cmax[k], c); }
        let axis = 0;
        for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
        objs.sort((a, b) => (a.min[axis] + a.max[axis]) - (b.min[axis] + b.max[axis]));
        const mid = objs.length >> 1;
        n.kids = [this.build(objs.slice(0, mid)), this.build(objs.slice(mid))];
        return n;
    }
    query(planes, visit, st) { if (this.root) queryNode(this.root, planes, fullMask(planes), visit, st); }
}

class QuadTree {
    constructor(objs, maxDepth = 6, leafCap = 4) {
        this.kind = 'quadtree'; this.count = objs.length; this.maxDepth = maxDepth; this.leafCap = leafCap; this.nodeCount = 0;
        if (!objs.length) { this.root = null; return; }
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const o of objs) { x0 = Math.min(x0, o.min[0]); z0 = Math.min(z0, o.min[2]); x1 = Math.max(x1, o.max[0]); z1 = Math.max(z1, o.max[2]); }
        const s = Math.max(x1 - x0, z1 - z0) + 0.01;
        this.root = this.node(x0, z0, s, 0);
        for (const o of objs) this.insert(this.root, o);
        this.finalize(this.root);
    }
    node(x, z, s, depth) {
        this.nodeCount++;
        return { x, z, s, depth, objs: [], kids: null, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    }
    child(n, o) {
        const h = n.s / 2;
        for (const k of n.kids) if (o.min[0] >= k.x && o.max[0] <= k.x + h && o.min[2] >= k.z && o.max[2] <= k.z + h) return k;
        return null;
    }
    insert(n, o) {
        if (n.depth < this.maxDepth && (n.kids || n.objs.length >= this.leafCap)) {
            if (!n.kids) {
                const h = n.s / 2;
                n.kids = [this.node(n.x, n.z, h, n.depth + 1), this.node(n.x + h, n.z, h, n.depth + 1), this.node(n.x, n.z + h, h, n.depth + 1), this.node(n.x + h, n.z + h, h, n.depth + 1)];
                const old = n.objs; n.objs = [];
                for (const q of old) { const k = this.child(n, q); if (k) this.insert(k, q); else n.objs.push(q); }
            }
            const k = this.child(n, o);
            if (k) { this.insert(k, o); return; }
        }
        n.objs.push(o);                                                   // loose: straddlers stay in the parent
    }
    finalize(n) {
        for (const o of n.objs) growBounds(n, o);
        if (n.kids) {
            n.kids = n.kids.filter(k => this.finalize(k));
            for (const k of n.kids) growBounds(n, k);
            if (!n.kids.length) n.kids = null;
        }
        if (!n.objs.length) n.objs = null;
        return !!(n.objs || n.kids);
    }
    query(planes, visit, st) { if (this.root) queryNode(this.root, planes, fullMask(planes), visit, st); }
}

// -------------------------------------------------------------------------------------------- js/vis/portal-vis.js
// PortalVis: FarCry CVisArea::PreRender / SECTR_CullingCamera traversal.
// Starts in the camera's area only; other areas (and the outdoors) are reached exclusively
// through open portals. Each visited (area, frustum) pair is an "entry" in a tree.

class PortalVis {
    constructor(world) { this.world = world; }

    compute(eye, viewProj, W, H, enabled) {
        const w = this.world, full = [0, 0, W, H];
        const rootPlanes = frustumPlanes(viewProj), near = rootPlanes[4], far = rootPlanes[5];
        const res = {
            eye: eye.slice(), viewProj, W, H, root: w.areaAt(eye), nodes: w.areas.map(() => null), entries: [],
            sky: false, skyRect: null, occluders: [], portalState: new Uint8Array(w.portals.length),
            tested: 0, passed: 0, closed: 0, occludedPortals: 0, enabled,
        };
        const push = e => {
            e.children = [];
            res.entries.push(e);
            (res.nodes[e.area] ||= []).push(e);
            if (e.parent) e.parent.children.push(e);
            if (e.area === 0) { res.sky = true; res.skyRect = rectUnion(res.skyRect, e.rect); }
        };
        if (!enabled) {
            w.areas.forEach((a, i) => push({ area: i, planes: rootPlanes, rect: full, depth: 0, via: null, parent: null, skyOnly: false }));
            return res;
        }
        const activeOcc = new Set();
        const stack = [{ area: res.root, planes: rootPlanes, rect: full, path: [], depth: 0, via: null, parent: null, skyOnly: false, clipped: null }];
        while (stack.length && res.entries.length < MAX_ENTRIES) {
            const e = stack.pop();
            push(e);
            if (e.skyOnly) continue;                                      // FarCry SkyOnly: nothing but sky beyond
            // SECTR: accumulate the occluders of every sector we pass through
            for (const oi of w.areas[e.area].occluders) {
                if (activeOcc.has(oi)) continue;
                const O = w.occluders[oi];
                if (!aabbVisible(O.min, O.max, e.planes)) continue;
                const { n, verts } = O.verts(eye);
                const planes = planesFromHull(eye, verts);
                let pn = n, pd = -v3.dot(n, O.center);
                if (v3.dot(pn, eye) + pd > 0) { pn = v3.mul(pn, -1); pd = -pd; }  // positive side = behind the occluder
                planes.push([pn[0], pn[1], pn[2], pd]);
                activeOcc.add(oi);
                res.occluders.push({ occ: O, verts, planes });
            }
            if (e.depth >= MAX_DEPTH) continue;
            for (const pi of w.areas[e.area].portals) {
                if (e.path.includes(pi)) continue;
                const P = w.portals[pi];
                res.tested++;
                if (P.closed) { res.closed++; continue; }
                const fromFront = P.front === e.area, other = fromFront ? P.back : P.front;
                const s = v3.dot(P.normal, eye) + P.d;
                let planes, rect, clipped, share = false;
                if (Math.abs(s) < NEAR_PASS && P.containsProjected(eye)) {
                    planes = e.planes; rect = e.rect; clipped = P.verts; share = true;   // camera is inside the aperture
                } else {
                    // wrong side of the portal plane (SECTR IsPointInFrontOfPlane)
                    if (!P.doubleSide && (fromFront ? s > 0 : s < 0)) { res.portalState[pi] ||= 1; continue; }
                    // SECTR: the next portal must lie in front of the portal we came through
                    if (e.via) {
                        const entryN = e.fromFront ? e.via.normal : v3.mul(e.via.normal, -1);
                        if (v3.dot(v3.sub(P.center, e.via.center), entryN) < -0.01) { res.portalState[pi] ||= 1; continue; }
                    }
                    // SECTR: skip portals completely hidden by an accumulated occluder
                    if (res.occluders.some(o => aabbContained(P.min, P.max, o.planes))) { res.occludedPortals++; res.portalState[pi] ||= 1; continue; }
                    clipped = clipPoly3(P.verts, e.planes);
                    if (clipped.length < 3) { res.portalState[pi] ||= 1; continue; }
                    rect = rectIntersect(e.rect, screenRect(clipped, viewProj, W, H));
                    if (!rect) { res.portalState[pi] ||= 1; continue; }
                    if (P.passThrough) { planes = e.planes; share = true; }
                    else {
                        planes = planesFromHull(eye, clipped);
                        const pn = fromFront ? P.normal : v3.mul(P.normal, -1), pd = fromFront ? P.d : -P.d;
                        planes.push([pn[0], pn[1], pn[2], pd], near, far);      // portal plane becomes the near plane
                    }
                }
                res.portalState[pi] = 2;
                res.passed++;
                stack.push({ area: other, planes, rect, path: e.path.concat(pi), depth: e.depth + 1, via: P, fromFront, clipped, share, parent: e, skyOnly: P.skyOnly && other === 0 });
            }
        }
        return res;
    }
}

// ------------------------------------------------------------------------------------------- js/world/collision.js
// CollisionSet: walkable floors (triangles) and walls (XZ segments with a height range) taken
// from the scene triangles, hashed on a 2D grid. Vehicles keep their own set in vehicle space.

function pushSeg(p, r, lo, hi, s) {
    if (s.y1 <= lo || s.y0 >= hi) return;
    const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((p[0] - s.x0) * dx + (p[2] - s.z0) * dz) / L2));
    const qx = s.x0 + dx * t, qz = s.z0 + dz * t;
    let ex = p[0] - qx, ez = p[2] - qz;
    const d = Math.hypot(ex, ez);
    if (d >= r) return;
    if (d < 1e-6) { const L = Math.sqrt(L2); ex = -dz / L; ez = dx / L; } else { ex /= d; ez /= d; }
    p[0] = qx + ex * r; p[2] = qz + ez * r;
}
class CollisionSet {
    constructor(cell = 2) { this.cell = cell; this.floors = new Map(); this.walls = new Map(); this.nFloors = 0; this.nWalls = 0; }
    key(x, z) { return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell); }
    each(x0, z0, x1, z1, fn) {
        const c = this.cell;
        for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) fn(i * 100003 + j);
    }
    put(map, k, item) { let l = map.get(k); if (!l) map.set(k, l = []); l.push(item); }
    addTri(a, b, c) {
        const n = v3.cross(v3.sub(b, a), v3.sub(c, a)), l = v3.len(n);
        if (l < 1e-8) return;
        const ny = n[1] / l;
        if (ny > 0.55) {
            const f = { a, b, c };
            this.each(Math.min(a[0], b[0], c[0]), Math.min(a[2], b[2], c[2]), Math.max(a[0], b[0], c[0]), Math.max(a[2], b[2], c[2]), k => this.put(this.floors, k, f));
            this.nFloors++;
        } else if (Math.abs(ny) < 0.55) {
            const h = Math.hypot(n[0], n[2]), nx = n[0] / h, nz = n[2] / h, tx = -nz, tz = nx;
            let s0 = Infinity, s1 = -Infinity, o = 0, y0 = Infinity, y1 = -Infinity;
            for (const q of [a, b, c]) { const t = q[0] * tx + q[2] * tz; s0 = Math.min(s0, t); s1 = Math.max(s1, t); o += (q[0] * nx + q[2] * nz) / 3; y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
            if (s1 - s0 < 1e-3) return;
            const seg = { x0: tx * s0 + nx * o, z0: tz * s0 + nz * o, x1: tx * s1 + nx * o, z1: tz * s1 + nz * o, y0, y1 }, m = 0.5;
            this.each(Math.min(seg.x0, seg.x1) - m, Math.min(seg.z0, seg.z1) - m, Math.max(seg.x0, seg.x1) + m, Math.max(seg.z0, seg.z1) + m, k => this.put(this.walls, k, seg));
            this.nWalls++;
        }
    }
    ground(x, z, maxY) {
        const l = this.floors.get(this.key(x, z));
        let best = -Infinity;
        if (l) for (const { a, b, c } of l) {
            const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
            if (Math.abs(d) < 1e-9) continue;
            const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const y = w0 * a[1] + w1 * b[1] + w2 * c[1];
            if (y <= maxY && y > best) best = y;
        }
        return best;
    }
    pushOut(p, r, lo, hi) {
        const l = this.walls.get(this.key(p[0], p[2]));
        if (l) for (let it = 0; it < 2; it++) for (const s of l) pushSeg(p, r, lo, hi, s);
    }
}

// ------------------------------------------------------------------------------------------------ js/world/area.js
// Areas (FarCry1 VisArea / SECTR Sector) and the point lights that live in them.

// Point light; `signal` modulates the intensity: flicker | pulse
class PointLight {
    constructor(def) {
        this.pos = def.pos;
        this.color = def.color || [1, 1, 1];
        this.intensity = def.intensity ?? 1;
        this.radius = def.radius || 8;
        this.signal = def.signal;
        this.vehicle = null;        // set when the light rides a vehicle (pos is then moved from `local`)
        this.local = null;
    }

    intensityAt(t) {
        let I = this.intensity;
        if (this.signal === 'flicker') I *= (Math.sin(t * 23.0 + this.pos[0]) * Math.sin(t * 7.3 + 1.0 + this.pos[2]) > -0.25) ? 1 : 0.1;
        else if (this.signal === 'pulse') I *= 0.2 + 0.8 * Math.max(0, Math.sin(t * 4.0));
        return I;
    }
}

// Extruded 2D shape (x, z) from y to y + height, with its own ambient, sun amount and fog.
// Area 0 is the implicit outdoors (see Area.outdoors).
class Area {
    constructor(def, index) {
        const shape = def.shape.map(p => [p[0], p[1]]), y = def.y || 0;
        this.index = index;
        this.id = def.id;
        this.name = def.name || def.id;
        this.outdoor = false;
        this.shape = shape;
        this.y = y;
        this.height = def.height;
        this.top = y + def.height;
        this.bbox = g2.bounds(shape);
        this.edges = Area.edges(shape);
        const cen = shape.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map(v => v / shape.length);
        this.ambient = def.ambient || [0.02, 0.02, 0.02];
        this.sun = def.sun || 0;
        this.fog = def.fog || [0, 0, 0, 0];
        this.hub = def.hub || [cen[0], y + 1.6, cen[1]];
        this.shellFrom = def.shellFrom ?? -0.05;          // exterior faces only above this height (ground / ship deck)
        this.terrain = def.terrain !== false;              // flatten the terrain around it (off for ships)
        this.nav = def.nav !== false;                      // reachable by navigating actors
        this.mats = Object.assign({ floor: 'tiles', wall: 'plaster', ceiling: 'panel', exterior: 'concrete', roof: 'roof' }, def.materials);
        this.portals = [];
        this.lights = [];
        this.occluders = [];
        this.vehicle = null;
    }

    // the implicit outdoor area: holds every portal with only one area on it (FarCry exit portals)
    static outdoors(def = {}) {
        const a = Object.create(Area.prototype);
        return Object.assign(a, {
            index: 0, id: 'outdoor', name: def.name || 'Outdoors', outdoor: true, portals: [], lights: [], occluders: [], vehicle: null,
            ambient: def.ambient || [0.3, 0.3, 0.35], sun: def.sun ?? 1, fog: def.fog || [0.6, 0.7, 0.8, 0.006], hub: def.hub || [0, 1.8, -8],
        });
    }

    // wall edges with their inward normals
    static edges(shape) {
        return shape.map((p, i) => {
            const q = shape[(i + 1) % shape.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const dir = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
            const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
            let n = [-dir[1], dir[0]];
            if (!g2.inside([mid[0] + n[0] * 0.01, mid[1] + n[1] * 0.01], shape)) n = [-n[0], -n[1]];
            return { a: p, b: q, dir, L, n };
        });
    }

    // point (world space) inside the extruded shape; vehicle areas test in vehicle space
    contains(p0) {
        const p = this.vehicle ? this.vehicle.toLocal(p0) : p0;
        if (p[1] < this.y || p[1] >= this.top) return false;
        if (p[0] < this.bbox[0] || p[0] > this.bbox[2] || p[2] < this.bbox[1] || p[2] > this.bbox[3]) return false;
        return g2.inside([p[0], p[2]], this.shape);
    }

    // 2D footprint in world space (vehicle areas move)
    shape2D() {
        const v = this.vehicle;
        return v ? this.shape.map(q => { const r = v.toWorld([q[0], this.y, q[1]]); return [r[0], r[2]]; }) : this.shape;
    }
}

// ---------------------------------------------------------------------------------------------- js/world/portal.js
// Portals (SECTR_Portal hull + FarCry portal flags) and occluders (SECTR_Occluder).

// Rectangle (center, size, normal) as a planar convex hull. Front / back areas are found by probing
// both sides of the plane; a side with no area is the outdoors.
class Portal {
    constructor(def, index, world) {
        const n = v3.norm(def.normal), c = def.center, horizontal = Math.abs(n[1]) > 0.9;
        const right = horizontal ? [1, 0, 0] : v3.norm(v3.cross([0, 1, 0], n));
        const up = horizontal ? v3.norm(v3.cross(n, right)) : [0, 1, 0];
        const [w, h] = def.size, hw = w / 2, hh = h / 2;
        const corner = (sx, sy) => v3.madd(v3.madd(c, right, sx * hw), up, sy * hh);
        this.index = index;
        this.id = def.id;
        this.kind = def.kind || 'opening';                 // door | opening | window | hatch
        this.center = c;
        this.normal = n;
        this.d = -v3.dot(n, c);
        this.right = right;
        this.up = up;
        this.w = w;
        this.h = h;
        this.horizontal = horizontal;
        this.verts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        this.skyOnly = !!def.skyOnly;
        this.passThrough = !!def.passThrough;
        this.doubleSide = !!def.doubleSide;
        this.frame = def.frame !== false;
        this.closed = !!def.closed;
        this.locked = !!def.locked;
        this.autoDoor = false;
        this.glass = def.glass ? (Array.isArray(def.glass) ? def.glass : DEFAULT_GLASS) : null;
        this.vehicle = null;
        // FarCry derives connections from overlap; probe both sides of the plane
        this.front = def.front !== undefined ? world.areaIndex(def.front) : world.areaAt(v3.madd(c, n, -0.25));
        this.back = def.back !== undefined ? world.areaIndex(def.back) : world.areaAt(v3.madd(c, n, 0.25));
        this.updateBounds();
    }

    updateBounds() {
        this.min = [0, 1, 2].map(k => Math.min(...this.verts.map(v => v[k])));
        this.max = [0, 1, 2].map(k => Math.max(...this.verts.map(v => v[k])));
    }

    // is p (projected onto the plane) inside the aperture?
    containsProjected(p) {
        const r = v3.sub(p, this.center);
        return Math.abs(v3.dot(r, this.right)) <= this.w / 2 + 0.1 && Math.abs(v3.dot(r, this.up)) <= this.h / 2 + 0.1;
    }

    // nav point used by actors crossing the portal
    navPoint() {
        if (this.horizontal) return this.center.slice();
        const bottom = this.center[1] - this.h / 2;
        return [this.center[0], Math.min(bottom + 1.5, this.center[1] + this.h / 2 - 0.4), this.center[2]];
    }

    // stop flags for navigation: closed (unless automatic), locked, windows, sky-only
    get navigable() { return !this.locked && (!this.closed || this.autoDoor) && this.kind !== 'window' && !this.skyOnly; }

    // the portal rides a vehicle: remember its docked (local) pose
    attach(vehicle) {
        this.vehicle = vehicle;
        this.local = { verts: this.verts.map(v => v.slice()), center: this.center.slice(), normal: this.normal.slice(), right: this.right.slice(), up: this.up.slice() };
    }

    // move to the vehicle pose M
    place(M) {
        const l = this.local;
        this.verts = l.verts.map(v => m4.point(M, v));
        this.center = m4.point(M, l.center);
        this.normal = v3.norm(m4.dir(M, l.normal));
        this.right = v3.norm(m4.dir(M, l.right));
        this.up = v3.norm(m4.dir(M, l.up));
        this.d = -v3.dot(this.normal, this.center);
        this.updateBounds();
    }
}

// Planar convex hull that hides what is fully behind it; autoOrient "y" turns it toward the camera
class Occluder {
    constructor(def, index, world) {
        this.index = index;
        this.id = def.id;
        this.center = def.center;
        this.size = def.size;
        this.normal = v3.norm(def.normal || [0, 0, 1]);
        this.autoOrient = def.autoOrient || 'none';
        this.area = def.area !== undefined ? world.areaIndex(def.area) : world.areaAt(def.center);
        const r = Math.hypot(def.size[0], def.size[1]) / 2;
        this.min = v3.sub(def.center, [r, r, r]);
        this.max = v3.add(def.center, [r, r, r]);
    }

    verts(eye) {
        let n = this.normal;
        if (this.autoOrient === 'y') { const t = v3.sub(eye, this.center); t[1] = 0; if (v3.len(t) > 1e-3) n = v3.norm(t); }
        const horizontal = Math.abs(n[1]) > 0.9;
        const right = horizontal ? [1, 0, 0] : v3.norm(v3.cross([0, 1, 0], n)), up = horizontal ? v3.norm(v3.cross(n, right)) : [0, 1, 0];
        const hw = this.size[0] / 2, hh = this.size[1] / 2, c = this.center;
        return { n, verts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => v3.madd(v3.madd(c, right, sx * hw), up, sy * hh)) };
    }
}

// ---------------------------------------------------------------------------------------- js/world/architecture.js
// Architecture generated from the area shapes: inner walls, floors and ceilings per area, the exterior
// shell and roofs (no faces on edges shared with a neighbour, none underground), portal apertures cut out
// of all of them, and frames around the portals.

class Architecture {
    constructor(world) {
        this.world = world;
    }

    build() {
        const w = this.world;
        for (let ai = 1; ai < w.areas.length; ai++) this.buildArea(w.areas[ai]);
        for (const P of w.portals) if (P.frame) this.buildFrame(P);
    }

    // apertures of the vertical portals lying on wall edge e, in (u along the edge, y) coordinates
    wallHoles(e) {
        const holes = [];
        for (const P of this.world.portals) {
            if (P.horizontal) continue;
            const l = Math.hypot(P.normal[0], P.normal[2]);
            if (Math.abs((P.normal[0] * e.n[0] + P.normal[2] * e.n[1]) / l) < 0.99) continue;
            const dist = (P.center[0] - e.a[0]) * e.n[0] + (P.center[2] - e.a[1]) * e.n[1];
            if (Math.abs(dist) > 0.05) continue;
            const poly = P.verts.map(v => [(v[0] - e.a[0]) * e.dir[0] + (v[2] - e.a[1]) * e.dir[1], v[1]]);
            const us = poly.map(p => p[0]);
            if (Math.max(...us) <= 0 || Math.min(...us) >= e.L) continue;
            holes.push(poly);
        }
        return holes;
    }

    // parts of edge e (of area A) that are shared with a neighbouring area: no exterior face there
    wallCover(A, e) {
        const rects = [], areas = this.world.areas;
        for (let i = 1; i < areas.length; i++) {
            const B = areas[i];
            if (B === A) continue;
            for (const f of B.edges) {
                if (f.n[0] * e.n[0] + f.n[1] * e.n[1] > -0.99) continue;
                const da = (f.a[0] - e.a[0]) * e.n[0] + (f.a[1] - e.a[1]) * e.n[1], db = (f.b[0] - e.a[0]) * e.n[0] + (f.b[1] - e.a[1]) * e.n[1];
                if (Math.abs(da) > 0.02 || Math.abs(db) > 0.02) continue;
                const u0 = (f.a[0] - e.a[0]) * e.dir[0] + (f.a[1] - e.a[1]) * e.dir[1], u1 = (f.b[0] - e.a[0]) * e.dir[0] + (f.b[1] - e.a[1]) * e.dir[1];
                const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(e.L, Math.max(u0, u1));
                const ylo = Math.max(A.y, B.y), yhi = Math.min(A.top, B.top);
                if (hi - lo > 1e-3 && yhi - ylo > 1e-3) rects.push([[lo, ylo], [hi, ylo], [hi, yhi], [lo, yhi]]);
            }
        }
        return rects;
    }

    // apertures of the horizontal portals (hatches, skylights) in A's floor or ceiling at height y
    horizontalHoles(A, y) {
        const holes = [];
        for (const P of this.world.portals) {
            if (!P.horizontal || Math.abs(P.center[1] - y) > 0.05) continue;
            if (!g2.inside([P.center[0], P.center[2]], A.shape)) continue;
            holes.push(P.verts.map(v => [v[0], v[2]]));
        }
        return holes;
    }

    buildArea(A) {
        const w = this.world, inner = new MeshBuilder(), shell = new MeshBuilder();
        const mWall = w.mat(A.mats.wall), mExt = w.mat(A.mats.exterior), mFloor = w.mat(A.mats.floor);
        const mCeil = w.mat(A.mats.ceiling), mRoof = w.mat(A.mats.roof);
        const extBottom = Math.max(A.y, A.shellFrom), hasWalls = A.top > extBottom + 0.01, hasRoof = A.top > 0.01;
        for (const e of A.edges) {
            const to3 = p => [e.a[0] + e.dir[0] * p[0], p[1], e.a[1] + e.dir[1] * p[0]];
            const holes = this.wallHoles(e);
            let pieces = [[[0, A.y], [e.L, A.y], [e.L, A.top], [0, A.top]]];
            for (const h of holes) pieces = g2.subtract(pieces, h);
            for (const p of pieces) inner.poly(p.map(to3), [e.n[0], 0, e.n[1]], mWall);
            if (!hasWalls) continue;
            let ext = [[[0, extBottom], [e.L, extBottom], [e.L, A.top], [0, A.top]]];
            for (const r of this.wallCover(A, e)) ext = g2.subtract(ext, r);
            for (const h of holes) ext = g2.subtract(ext, h);
            for (const p of ext) shell.poly(p.map(to3), [-e.n[0], 0, -e.n[1]], mExt);
        }
        const tris = g2.triangulate(A.shape);
        const emitH = (b, pieces, y, n, m) => { for (const p of pieces) b.poly(p.map(q => [q[0], y, q[1]]), n, m); };
        let floor = tris;
        for (const h of this.horizontalHoles(A, A.y)) floor = g2.subtract(floor, h);
        emitH(inner, floor, A.y, [0, 1, 0], mFloor);
        let ceil = tris;
        for (const h of this.horizontalHoles(A, A.top)) ceil = g2.subtract(ceil, h);
        emitH(inner, ceil, A.top, [0, -1, 0], mCeil);
        if (hasRoof) {
            // roof: ceiling footprint minus areas stacked on top of it
            let roof = ceil;
            for (let bi = 1; bi < w.areas.length; bi++) {
                const B = w.areas[bi];
                if (B !== A && Math.abs(B.y - A.top) < 0.01) for (const t of g2.triangulate(B.shape)) roof = g2.subtract(roof, t);
            }
            emitH(shell, roof, A.top + 0.001, [0, 1, 0], mRoof);
        }
        w.addStatic(inner, { name: `area:${A.id}`, owners: [A.index], lightArea: A.index });
        w.addStatic(shell, { name: `shell:${A.id}`, owners: [0], lightArea: 0 });
    }

    buildFrame(P) {
        const w = this.world, m = w.mat('frame'), t = 0.12, depth = 0.3;
        const b = new MeshBuilder(), ax = [P.right, P.up, P.normal], hw = P.w / 2, hh = P.h / 2;
        b.box(v3.madd(P.center, P.right, -(hw + t / 2)), ax, [t / 2, hh, depth / 2], m);
        b.box(v3.madd(P.center, P.right, hw + t / 2), ax, [t / 2, hh, depth / 2], m);
        b.box(v3.madd(P.center, P.up, hh + t / 2), ax, [hw + t, t / 2, depth / 2], m);
        if (P.kind !== 'door' && P.kind !== 'opening') b.box(v3.madd(P.center, P.up, -(hh + t / 2)), ax, [hw + t, t / 2, depth / 2], m);
        w.addStatic(b, { name: `frame:${P.id}`, owners: [...new Set([P.front, P.back])], lightArea: P.front || P.back });
    }
}

// -------------------------------------------------------------------------------------------- js/world/outdoors.js
// The outdoors (scenario `outdoor`): terrain height field and chunks, scattered models and the sea.

// Animated sea plane minus the waterline of every hull (moving hulls cut a moving hole)
class Water {
    constructor(def) {
        const [x0, z0, x1, z1] = def.extent, y = def.level;
        this.level = y;
        this.color = def.color || [0.1, 0.3, 0.32, 0.8];
        this.verts = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
        this.min = [x0, y - 0.5, z0];
        this.max = [x1, y + 0.5, z1];
        this.pieces = [];
    }

    update(hulls) {
        const a = this.verts[0], c = this.verts[2], y = this.level;
        let pieces = [[[a[0], a[2]], [c[0], a[2]], [c[0], c[2]], [a[0], c[2]]]];
        for (const h of hulls) pieces = g2.subtract(pieces, h.worldWaterline());
        this.pieces = pieces.map(pc => pc.map(q => [q[0], y, q[1]]));
    }
}

class Outdoors {
    constructor(world, def = {}) {
        this.world = world;
        this.def = def;
        this.terrain = def.terrain || null;
        this.water = def.water ? new Water(def.water) : null;
    }

    // terrain height: fbm hills flattened around buildings and `flatten` rects, sinking into the sea
    // towards the island edge and beyond the coast line
    height(x, z) {
        const t = this.terrain;
        if (!t) return 0;
        const areas = this.world.areas;
        let dist = Infinity;
        const near = (bx0, bz0, bx1, bz1) => Math.hypot(Math.max(bx0 - x, 0, x - bx1), Math.max(bz0 - z, 0, z - bz1));
        for (let i = 1; i < areas.length; i++) {
            const a = areas[i];
            if (a.y > 0.01 || !a.terrain) continue;
            dist = Math.min(dist, near(a.bbox[0], a.bbox[1], a.bbox[2], a.bbox[3]));
        }
        for (const r of t.flatten || []) dist = Math.min(dist, near(r[0], r[1], r[2], r[3]));
        const f = t.freq || 0.035, mask = smoothstep(t.flat ?? 5, (t.flat ?? 5) + (t.blend ?? 20), dist);
        let h = (fbm(x * f + 11.3, z * f - 3.7) - 0.45) * 2 * (t.amp ?? 2.5) * mask - 0.03;
        // island: the land sinks into the sea towards the edges of the terrain
        if (t.island) {
            const [x0, z0, x1, z1] = t.extent, de = Math.min(x - x0, x1 - x, z - z0, z1 - z);
            const s = smoothstep(0, t.island.falloff ?? 30, de + (vnoise(x * 0.04, z * 0.04) - 0.5) * 10);
            h = h * s - (t.island.depth ?? 12) * (1 - s);
        }
        // coast: the land sinks to the seabed beyond a shore line (point + normal pointing out to sea)
        const c = t.coast;
        if (c) {
            const d = (x - c.point[0]) * c.normal[0] + (z - c.point[1]) * c.normal[1];
            const wob = (vnoise(x * 0.05, z * 0.05) - 0.5) * (c.wobble ?? 8);
            const s = smoothstep(-c.width * 0.35, c.width, d + wob);
            h = h * (1 - s) - c.depth * s;
        }
        return h;
    }

    build() {
        if (this.terrain) this.buildTerrain();
        for (const s of this.def.scatter || []) this.scatter(s);
        if (this.def.water && this.def.water.seabed) this.buildSeabed();
    }

    buildTerrain() {
        const w = this.world, o = this.def, t = this.terrain;
        const [x0, z0, x1, z1] = t.extent, cs = t.chunk || 20, st = t.step || 1, m = w.mat(t.mat || 'grass');
        const beach = t.beachMat ? w.mat(t.beachMat) : m, beachY = (o.water ? o.water.level : -Infinity) + (t.beachHeight ?? 0.6);
        for (let cz = z0; cz < z1; cz += cs) for (let cx = x0; cx < x1; cx += cs) {
            const b = new MeshBuilder(), n = Math.round(Math.min(cs, x1 - cx, z1 - cz) / st);
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
                const x = cx + i * st, z = cz + j * st, e = 0.5;
                const nx = this.height(x - e, z) - this.height(x + e, z), nz = this.height(x, z - e) - this.height(x, z + e);
                const y = this.height(x, z);
                b.vert([x, y, z], v3.norm([nx, 2 * e, nz]), y < beachY ? beach : m);
            }
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
                const a = j * (n + 1) + i;
                b.idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
            }
            w.addStatic(b, { name: `terrain:${cx},${cz}`, owners: [0], lightArea: 0, terrain: true });
        }
    }

    // seeded random placement outside buildings, `avoid` rects and the sea
    scatter(s) {
        const w = this.world, o = this.def;
        const rnd = mulberry32(s.seed || 1), [x0, z0, x1, z1] = s.extent, [s0, s1] = s.scale || [1, 1];
        let placed = 0;
        for (let tries = 0; placed < s.count && tries < s.count * 30; tries++) {
            const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0), rot = rnd() * 360, sc = s0 + rnd() * (s1 - s0);
            const cl = s.clearance || 4;
            if (w.areas.some((a, i) => i > 0 && x > a.bbox[0] - cl && x < a.bbox[2] + cl && z > a.bbox[1] - cl && z < a.bbox[3] + cl)) continue;
            if ((s.avoid || []).some(r => x > r[0] && x < r[2] && z > r[1] && z < r[3])) continue;
            if (o.water && this.height(x, z) < o.water.level + (s.shore ?? 1.0)) continue;
            const b = new MeshBuilder();
            w.addModel(b, s.model, m4.trs([x, this.height(x, z), z], rot, sc));
            w.addStatic(b, { name: `${s.model}#${placed}`, owners: [0], lightArea: 0 });
            placed++;
        }
    }

    buildSeabed() {
        const w = this.world, W = this.def.water, [x0, z0, x1, z1] = W.extent;
        const b = new MeshBuilder(), sy = W.seabed.y, m = w.mat(W.seabed.mat || 'sand');
        b.poly([[x0, sy, z0], [x1, sy, z0], [x1, sy, z1], [x0, sy, z1]], [0, 1, 0], m);
        w.addStatic(b, { name: 'seabed', owners: [0], lightArea: 0, terrain: true });
    }
}

// ------------------------------------------------------------------------------------------- js/world/nav-graph.js
// SECTR_Graph: shortest path over areas and portals (Dijkstra between area hubs through portal nav points).
// Portals stop navigation when closed (unless automatic), locked, windows or sky-only; vehicle areas and
// areas with `nav: false` are never entered.

class NavGraph {
    constructor(world) {
        this.world = world;
    }

    // [{ area, portal }, ...] from area `from` to area `to`, or null
    findPath(from, to) {
        const { areas, portals } = this.world;
        const N = areas.length, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(null), done = new Array(N).fill(false);
        dist[from] = 0;
        for (;;) {
            let u = -1;
            for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
            if (u < 0 || u === to) break;
            done[u] = true;
            for (const pi of areas[u].portals) {
                const P = portals[pi];
                if (!P.navigable) continue;
                const v = P.front === u ? P.back : P.front, pp = P.navPoint();
                if (areas[v].vehicle || areas[u].vehicle) continue;
                if (!areas[v].nav) continue;
                const cost = dist[u] + v3.dist(areas[u].hub, pp) + v3.dist(pp, areas[v].hub);
                if (cost < dist[v]) { dist[v] = cost; prev[v] = { area: u, portal: P }; }
            }
        }
        if (dist[to] === Infinity) return null;
        const path = [];
        for (let a = to; a !== from; a = prev[a].area) path.unshift({ area: a, portal: prev[a].portal });
        return path;
    }
}

// --------------------------------------------------------------------------------------------- js/world/vehicle.js
// Vehicle: a moving group of areas, portals, objects and lights (the freighter). Everything is
// authored at the docked pose, which is the vehicle's local space; each frame one transform M
// carries it along its route, with heel from steering and pitch / roll / heave from the waves.
// Visibility queries transform the frustum planes into vehicle space instead of moving trees.

// Closed Catmull-Rom spline through 2D waypoints, sampled by arc length
class Route {
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

class Vehicle {
    constructor(world, d) {
        this.world = world;
        this.id = d.id;
        this.data = d;
        this.hull = world.hulls.find(h => h.id === (d.hull || d.id));
        if (!this.hull) throw new Error(`vehicle "${d.id}": no hull "${d.hull || d.id}"`);
        this.hull.vehicle = this;
        this.pivot = d.pivot || [0, 0, 0];
        this.M = m4.identity();
        this.inv = m4.identity();
        this.col = new CollisionSet(2);
        this.dockCol = new CollisionSet(2);         // parts that are only there while docked (gangway)
        this.objects = [];
        this.lights = [];
        this.portals = [];
        this.areas = [];
        this.helmStation = null;                    // Helm entity, linked after the entities are spawned
        this.route = new Route(d.route.points);
        this.sDock = this.route.waypointS(d.route.dock || 0);
        this.s = this.sDock;
        this.v = 0;
        this.state = 'docked';
        this.docked = true;
        this.wait = d.route.wait ?? 25;
        this.heading = 0; this.dHeading = 0; this.heel = 0; this.pitch = 0; this.roll = 0; this.yawRate = 0;
        [this.px, this.pz] = this.route.at(this.s);
        this.control = null;
        this.helm = { throttle: 0, rudder: 0 };
        this.backoff = 0;
        // hull sample points for grounding / quay checks: deck line and (tapered) keel line
        const out = this.hull.outline, xs = out.map(q => q[0]), xc = (Math.min(...xs) + Math.max(...xs)) / 2, ins = this.hull.inset ?? 1.2;
        const edgeSamples = poly => poly.flatMap((a, i) => {
            const b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
            return Array.from({ length: n }, (_, k) => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
        });
        this.deckSamples = edgeSamples(out);
        this.keelSamples = edgeSamples(out.map(q => [q[0] + Math.sign(xc - q[0]) * Math.min(ins, Math.abs(xc - q[0])), q[1]]));
    }

    get maxSpeed() { return this.data.maxSpeed ?? 9; }
    get maxYawRate() { return this.data.maxYawRate ?? 0.12; }

    toLocal(p) { return m4.point(this.inv, p); }
    toWorld(p) { return m4.point(this.M, p); }
    // world planes -> vehicle planes (R orthonormal: n' = R^T n, d' = n.t + d)
    localPlanes(planes) {
        const M = this.M;
        return planes.map(q => [M[0] * q[0] + M[1] * q[1] + M[2] * q[2], M[4] * q[0] + M[5] * q[1] + M[6] * q[2], M[8] * q[0] + M[9] * q[1] + M[10] * q[2], M[12] * q[0] + M[13] * q[1] + M[14] * q[2] + q[3]]);
    }

    // everything authored inside the hull (at the docked pose) moves with the vehicle
    claim() {
        const w = this.world, out = this.hull.outline, keel = this.hull.keel;
        const segD2 = (x, z, a, b) => {
            const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
            return (x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2;
        };
        const near = (x, z, m) => g2.inside([x, z], out) || out.some((a, i) => segD2(x, z, a, out[(i + 1) % out.length]) < m * m);
        for (const a of w.areas) if (a.index > 0 && a.shape.every(q => near(q[0], q[1], 0.5))) { a.vehicle = this; this.areas.push(a); }
        for (const P of w.portals) if (P.center[1] > keel && near(P.center[0], P.center[2], 0.5)) { P.attach(this); this.portals.push(P); }
        for (const a of w.areas) for (const L of a.lights) if (L.pos[1] > keel && near(L.pos[0], L.pos[2], 0.5)) { L.vehicle = this; L.local = L.pos.slice(); this.lights.push(L); }
        for (const o of w.objects) {
            if (o.terrain) continue;
            const tagged = o.vehicleId && (o.vehicleId === this.id || o.vehicleId === this.hull.id);
            const inside = o.min[1] > keel - 1 && [[o.min[0], o.min[2]], [o.max[0], o.min[2]], [o.max[0], o.max[2]], [o.min[0], o.max[2]]].every(q => near(q[0], q[1], 1.0));
            if (!tagged && !inside) continue;
            o.vehicle = this; o.model = this.M; this.objects.push(o);
        }
        this.place();
    }

    update(dt, t) {
        const cruise = this.data.route.speed || 6, heading0 = this.heading;
        if (this.control || this.state === 'rejoin') this.steer(dt);
        else this.followRoute(dt);
        this.docked = this.state === 'docked';
        this.helmFromMotion();
        const p = [this.px, this.pz], heading = this.heading, dh = heading - heading0;
        this.dHeading = dh;
        const W = this.data.waves || {}, deg = Math.PI / 180, yawRate = dt > 0 ? dh / dt : 0;
        // heel away from the turn with a slow spring, plus wave pitch / roll / heave
        const heelTarget = Math.max(-1, Math.min(1, -yawRate * this.v * (this.data.steerHeel ?? 0.6))) * (this.data.maxHeel ?? 6) * deg;
        this.heel += (heelTarget - this.heel) * Math.min(1, dt * 0.7);
        const ampTarget = this.docked ? 0.08 : 0.35 + 0.65 * Math.min(1, Math.abs(this.v) / cruise);  // calm in harbour
        this.amp = this.amp === undefined ? ampTarget : this.amp + (ampTarget - this.amp) * Math.min(1, dt * 0.4);
        const amp = this.amp;
        this.pitch = amp * (W.pitch ?? 1.2) * deg * (Math.sin(t * 0.55) + 0.5 * Math.sin(t * 0.93 + 1.3));
        this.roll = this.heel + amp * (W.roll ?? 2) * deg * (Math.sin(t * 0.41 + 0.7) + 0.4 * Math.sin(t * 1.07));
        const heave = amp * (W.heave ?? 0.25) * (Math.sin(t * 0.63) + 0.5 * Math.sin(t * 1.21 + 2)), pv = this.pivot;
        const M = m4.mul(m4.mul(m4.mul(m4.mul(m4.translate([p[0], pv[1] + heave, p[1]]), m4.rotY(heading)), m4.rotX(-this.pitch)), m4.rotZ(this.roll)), m4.translate([-pv[0], -pv[1], -pv[2]]));
        this.M.set(M); this.inv.set(m4.invert(M));
        this.place();
    }

    // autopilot on the route: wait at the dock, cruise, brake to rest exactly on the dock mark
    followRoute(dt) {
        const R = this.data.route, route = this.route, cruise = R.speed || 6, acc = R.accel || 0.3;
        if (this.state === 'docked') {
            this.v = 0;
            if ((this.wait -= dt) <= 0) { this.state = 'departing'; this.travelled = 0; }
        } else {
            const ahead = ((this.sDock - this.s) % route.length + route.length) % route.length;
            if (this.state === 'departing' && this.travelled > 10) this.state = 'cruising';
            const brake = this.state === 'cruising' ? Math.sqrt(2 * acc * 1.2 * ahead) : Infinity;
            this.v += Math.max(-acc * 1.5 * dt, Math.min(acc * dt, Math.min(cruise, brake) - this.v));
            if (this.state === 'cruising') this.v = Math.min(this.v, ahead / Math.max(dt, 1e-4));      // never overshoot the dock
            this.s += this.v * dt;
            this.travelled += this.v * dt;
            if (this.state === 'cruising' && ahead < 0.002 && this.v < 0.2) { this.state = 'docked'; this.s = this.sDock; this.v = 0; this.wait = R.wait ?? 25; }
        }
        const p = route.at(this.s), tg = route.dir(this.s);
        // the hull yaws toward the path tangent through a critically damped spring: turn rate and
        // angular acceleration stay continuous even where the spline's curvature jumps at waypoints
        const target = Math.atan2(tg[0], tg[1]), k = this.data.yawResponse ?? 2.5;
        const err = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
        this.yawRate = (this.yawRate || 0) + (k * k * err - 2 * k * (this.yawRate || 0)) * dt;
        this.heading += this.yawRate * dt;
        this.px = p[0]; this.pz = p[1];
    }

    // free steering: the player at the helm, or the autopilot bringing the ship back to its route
    steer(dt) {
        const D = this.data, route = this.route, vmax = this.maxSpeed, acc = (D.route.accel || 0.3) * 1.5;
        let throttle, rudder;
        if (this.control) ({ throttle, rudder } = this.control);
        else {
            const near = route.nearest(this.px, this.pz), aim = route.at(near + 45);      // pure pursuit along the route
            const want = Math.atan2(aim[0] - this.px, aim[1] - this.pz);
            const err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
            rudder = Math.max(-1, Math.min(1, -err * 3)); throttle = 0.6;
            if (this.backoff > 0) { this.backoff -= dt; throttle = -0.4; rudder = -rudder; }
            const q = route.at(near), tg = route.dir(near), th = Math.atan2(tg[0], tg[1]);
            if (Math.hypot(q[0] - this.px, q[1] - this.pz) < 0.6 && Math.abs(Math.atan2(Math.sin(th - this.heading), Math.cos(th - this.heading))) < 0.05) {
                this.state = 'cruising'; this.s = near; this.travelled = 100;          // back on the route
                return this.followRoute(dt);
            }
        }
        this.v += Math.max(-acc * dt, Math.min(acc * dt, throttle * vmax - this.v));
        // the rudder only bites with water flowing past it: turn rate scales with speed (and flips astern)
        const flow = Math.max(-1, Math.min(1, this.v / (vmax * 0.5)));
        const target = -rudder * this.maxYawRate * flow;
        this.yawRate = (this.yawRate || 0) + (target - (this.yawRate || 0)) * Math.min(1, dt * 0.8);
        const h = this.heading + this.yawRate * dt;
        const nx = this.px + Math.sin(h) * this.v * dt, nz = this.pz + Math.cos(h) * this.v * dt;
        const free = !this.blocked(this.px, this.pz, this.heading);
        if (!free || !this.blocked(nx, nz, h)) { this.px = nx; this.pz = nz; this.heading = h; }
        else {
            // the turn would swing the hull into something: keep going straight if that is clear
            const sx = this.px + Math.sin(this.heading) * this.v * dt, sz = this.pz + Math.cos(this.heading) * this.v * dt;
            this.yawRate = 0;
            if (!this.blocked(sx, sz, this.heading)) { this.px = sx; this.pz = sz; }
            else { this.v = -this.v * 0.2; if (!this.control) this.backoff = 3; }       // bump against the quay or shore
        }
    }

    // would the hull at this pose touch the seabed (keel line) or a structure such as the quay (deck line)?
    blocked(x, z, h) {
        const c = Math.cos(h), sn = Math.sin(h), pv = this.pivot, w = this.world, wl = w.water ? w.water.level : 0;
        const at = q => { const ox = q[0] - pv[0], oz = q[1] - pv[2]; return [x + c * ox + sn * oz, z - sn * ox + c * oz]; };
        for (const q of this.keelSamples) { const r = at(q); if (w.terrainHeight(r[0], r[1]) > this.hull.keel + 0.3) return true; }
        // structures that reach above the water but not over the deck (quay, shore works; not crane booms)
        for (const q of this.deckSamples) { const r = at(q); if (w.col.ground(r[0], r[1], this.hull.deck) > wl + 0.3) return true; }
        return false;
    }

    // what the helm shows when nobody holds it: the wheel follows the turn, the lever the speed
    helmFromMotion() {
        if (this.control) return;
        const vmax = this.maxSpeed, flow = Math.max(0.3, Math.abs(this.v) / (vmax * 0.5));
        this.helm.throttle = this.v / vmax;
        this.helm.rudder = Math.max(-1, Math.min(1, -(this.yawRate || 0) / (this.maxYawRate * flow)));
    }

    takeHelm() { this.control = this.helm = { throttle: this.v / this.maxSpeed, rudder: 0 }; this.state = 'manual'; this.backoff = 0; }
    leaveHelm() { this.control = null; this.helm = { throttle: this.helm.throttle, rudder: this.helm.rudder }; this.state = 'rejoin'; }

    // move the vehicle's portals, lights and object bounds to its current pose
    place() {
        const M = this.M;
        for (const P of this.portals) P.place(M);
        for (const L of this.lights) L.pos = m4.point(M, L.local);
        for (const o of this.objects) {
            const b = worldBounds(M, o);
            o.wmin = b.min; o.wmax = b.max;
        }
    }

    waterline() { return this.hull.waterline2D.map(q => { const w = m4.point(this.M, [q[0], this.world.water.level, q[1]]); return [w[0], w[2]]; }); }
}

// -------------------------------------------------------------------------------------------- js/world/entities.js
// World entities. Each is constructed from a scenario definition ({ type, ... }) and spawned once, in
// scenario order: static ones add geometry to the world, dynamic ones also register for per-frame updates.

class Entity {
    constructor(def, world) {
        this.def = def;
        this.world = world;
        this.id = def && def.id;
        this.owners = [];           // areas it is drawn in (dynamic members only)
    }

    spawn() {}                      // build geometry, register with the world
    link() {}                       // resolve references once every entity and vehicle exists
    update(dt, t, actors) {}        // actors: positions that open automatic doors
}

// Dynamic SECTR Member: one geometry chunk drawn with its own model matrix, in every area it overlaps
class Member extends Entity {
    constructor(def, world, chunk = null, area = 0) {
        super(def, world);
        this.chunk = chunk;
        this.stamp = -1;
        this.owners = [area];
        this.lightArea = area;
        this.model = IDENTITY;
        this.min = [0, 0, 0];
        this.max = [0, 0, 0];
    }

    place(model) {
        this.model = model;
        const b = worldBounds(model, this.chunk);
        this.min = b.min;
        this.max = b.max;
    }
}

// A scenario model placed at pos / rot / scale; belongs to every area its bounds overlap
class Prop extends Entity {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model, m4.trs(e.pos, e.rot || 0, e.scale || 1));
        const owners = e.area !== undefined ? [w.areaIndex(e.area)] : w.areasOverlapping(b.min, b.max);
        const lightArea = w.areaAt(v3.add(e.pos, [0, 0.3, 0]));
        w.addStatic(b, {
            name: `prop:${e.model}`, owners, lightArea, vehicle: e.vehicle, dockedOnly: e.dockedOnly,
            solid: e.solid !== false, climbable: !!e.climbable,
        });
    }
}

// Point light of the area it is in, with an optional (non-solid) fixture model
class Lamp extends Entity {
    spawn() {
        const w = this.world, e = this.def, L = new PointLight(e);
        const a = e.area !== undefined ? w.areaIndex(e.area) : w.areaAt(e.pos), area = w.areas[a];
        area.lights.push(L);
        if (area.lights.length > MAX_LIGHTS) w.warnings.push(`area "${area.id}" has more than ${MAX_LIGHTS} lights`);
        if (e.model) new Prop({ model: e.model, pos: e.pos, rot: e.rot || 0, area: area.id, solid: false }, w).spawn();
    }
}

// Solid steps from `from` (top) to `to` (bottom), with an optional landing before the top step;
// `open` builds treads only (gangway), `rails` adds hand rails
class Stairs extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const b = new MeshBuilder(), m = w.mat(e.mat || 'concrete'), mEdge = w.mat(e.edgeMat || 'hazard');
        const f = e.from, t = e.to, L = Math.hypot(t[0] - f[0], t[2] - f[2]);
        const d = [(t[0] - f[0]) / L, 0, (t[2] - f[2]) / L], side = [-d[2], 0, d[0]], ax = [d, [0, 1, 0], side];
        const hw = (e.width || 2) / 2, n = e.steps || 12, rise = (f[1] - t[1]) / n, run = L / n;
        if (e.landing) {
            const c = v3.madd(f, d, -e.landing / 2);
            b.box([c[0], (f[1] + t[1]) / 2, c[2]], ax, [e.landing / 2, (f[1] - t[1]) / 2, hw], m);
        }
        for (let i = 0; i < n; i++) {
            const top = f[1] - (i + 1) * rise, h = top - t[1];
            if (h <= 1e-3) continue;
            const c = v3.madd(f, d, (i + 0.5) * run);
            if (e.open) b.box([c[0], top - 0.03, c[2]], ax, [run / 2 + 0.02, 0.03, hw], m);     // gangway: treads only
            else b.box([c[0], t[1] + h / 2, c[2]], ax, [run / 2, h / 2, hw], m);
            const nose = v3.madd(f, d, i * run + 0.06);
            b.box([nose[0], top + 0.006, nose[2]], ax, [0.06, 0.006, hw], mEdge);
        }
        if (e.rails) {
            const len = Math.hypot(L, f[1] - t[1]), mid = v3.lerp(f, t, 0.5), slope = v3.norm(v3.sub(t, f));
            const rup = v3.norm(v3.cross(side, slope)), rax = [slope, rup, side], mr = w.mat(e.railMat || 'metal');
            for (const sgn of [-1, 1]) {
                const base = v3.madd(mid, side, sgn * hw);
                b.box(v3.madd(base, rup, 0.95), rax, [len / 2, 0.03, 0.03], mr);
                for (let k = 0; k <= 4; k++) b.box(v3.madd(v3.madd(v3.lerp(f, t, k / 4), side, sgn * hw), [0, 1, 0], 0.5), AXES, [0.025, 0.5, 0.025], mr);
            }
        }
        w.addStatic(b, { name: 'stairs', owners: w.areasOverlapping(b.min, b.max), lightArea: w.areaAt(v3.madd(t, [0, 1, 0], 0.5)), vehicle: e.vehicle, dockedOnly: e.dockedOnly });
    }
}

// Ship hull extruded from its deck outline: sides taper toward the keel, antifouling band below the
// paint line, deck = outline minus the roofs of the interior areas under it, bulwark with gaps
class Hull extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const b = new MeshBuilder(), out = e.outline.map(p => [p[0], p[1]]), deck = e.deck, keel = e.keel;
        const xs = out.map(p => p[0]), xc = (Math.min(...xs) + Math.max(...xs)) / 2, inset = e.inset ?? 1.5;
        const bottom = out.map(p => [p[0] + Math.sign(xc - p[0]) * Math.min(inset, Math.abs(xc - p[0])), p[1]]);
        const mTop = w.mat(e.mat || 'hullpaint'), mBot = w.mat(e.bottomMat || e.mat || 'hullpaint');
        const mDeck = w.mat(e.deckMat || 'shipdeck'), mBul = w.mat(e.bulwarkMat || e.mat || 'hullpaint');
        const band = e.band ?? keel;
        const at = (i, y) => { const t = (y - keel) / (deck - keel); return [bottom[i][0] + (out[i][0] - bottom[i][0]) * t, y, bottom[i][1] + (out[i][1] - bottom[i][1]) * t]; };
        const face = (pts, outward, m) => { if (v3.dot(newell(pts), outward) < 0) pts = pts.slice().reverse(); b.poly(pts, null, m); };
        const gaps = e.bulwarkGaps || [], hb = e.bulwark || 0, th = 0.14;
        for (let i = 0; i < out.length; i++) {
            const j = (i + 1) % out.length, a = out[i], c = out[j];
            let n = v3.norm([c[1] - a[1], 0, -(c[0] - a[0])]);
            if (g2.inside([(a[0] + c[0]) / 2 + n[0] * 0.05, (a[1] + c[1]) / 2 + n[2] * 0.05], out)) n = v3.mul(n, -1);
            face([at(i, keel), at(j, keel), at(j, band), at(i, band)], n, mBot);
            face([at(i, band), at(j, band), at(j, deck), at(i, deck)], n, mTop);
            if (!hb) continue;
            const L = Math.hypot(c[0] - a[0], c[1] - a[1]), steps = Math.max(1, Math.ceil(L));
            for (let k = 0; k < steps; k++) {
                const p0 = [a[0] + (c[0] - a[0]) * k / steps, a[1] + (c[1] - a[1]) * k / steps], p1 = [a[0] + (c[0] - a[0]) * (k + 1) / steps, a[1] + (c[1] - a[1]) * (k + 1) / steps];
                const pm = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
                if (gaps.some(r => pm[0] > r[0] && pm[0] < r[2] && pm[1] > r[1] && pm[1] < r[3])) continue;
                const o0 = [p0[0], deck, p0[1]], o1 = [p1[0], deck, p1[1]], i0 = v3.madd(o0, n, -th), i1 = v3.madd(o1, n, -th), up = [0, hb, 0];
                face([o0, o1, v3.add(o1, up), v3.add(o0, up)], n, mTop);
                face([i0, i1, v3.add(i1, up), v3.add(i0, up)], v3.mul(n, -1), mBul);
                face([v3.add(o0, up), v3.add(o1, up), v3.add(i1, up), v3.add(i0, up)], [0, 1, 0], mBul);
            }
        }
        for (const t of g2.triangulate(bottom)) b.poly(t.map(p => [p[0], keel, p[1]]), [0, -1, 0], mBot);
        let top = g2.triangulate(out);
        for (let ai = 1; ai < w.areas.length; ai++) {
            const A = w.areas[ai];
            if (Math.abs(A.top - deck) < 0.01) for (const t of g2.triangulate(A.shape)) top = g2.subtract(top, t);
        }
        for (const p of top) b.poly(p.map(q => [q[0], deck, q[1]]), [0, 1, 0], mDeck);
        this.id = e.id || 'ship';
        this.outline = out;
        this.keel = keel;
        this.deck = deck;
        this.inset = inset;
        this.waterline2D = w.water ? out.map((_, i) => { const q = at(i, w.water.level); return [q[0], q[2]]; }) : [];
        this.vehicle = null;        // set by the Vehicle that moves this hull
        w.addStatic(b, { name: `hull:${this.id}`, owners: [0], lightArea: 0, vehicle: this.id });
        w.hulls.push(this);
    }

    // waterline cross-section in world space (cut out of the sea)
    worldWaterline() { return this.vehicle ? this.vehicle.waterline() : this.waterline2D; }
}

// One part of the helm (wheel or lever) riding its vehicle, posed from the helm state
class HelmPart extends Member {
    constructor(helm, chunk, area, pos, rotate) {
        super(null, helm.world, chunk, area);
        this.helm = helm;
        this.pos = pos;
        this.rotate = rotate;
    }

    update() {
        const v = this.helm.vehicle;
        if (v) this.place(m4.mul(m4.mul(v.M, m4.translate(this.pos)), this.rotate(v.helm)));
    }
}

// Ship's helm: a spoked wheel turning with the rudder and a throttle lever; `F` at the stand takes control
class Helm extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const mk = (name, build) => { const b = new MeshBuilder(); build(b); return w.pool.add(b, { name, dynamic: true }); };
        const mw = w.mat(e.wheelMat || 'wood'), mm = w.mat('metal'), r = e.wheel.radius || 0.35, Z = [0, 0, 1];
        const wheel = mk('helm:wheel', b => {
            for (let k = 0; k < 20; k++) {
                const a = k / 20 * Math.PI * 2, rad = [Math.cos(a), Math.sin(a), 0], tan = [-Math.sin(a), Math.cos(a), 0];
                b.box([rad[0] * r, rad[1] * r, 0], [tan, rad, Z], [Math.PI * r / 20 + 0.012, 0.025, 0.03], mw);          // rim
            }
            for (let k = 0; k < 8; k++) {
                const a = k / 8 * Math.PI * 2, rad = [Math.cos(a), Math.sin(a), 0], tan = [-Math.sin(a), Math.cos(a), 0];
                b.box([rad[0] * r / 2, rad[1] * r / 2, 0], [rad, tan, Z], [r / 2, 0.015, 0.015], mm);                     // spoke
                b.box([rad[0] * (r + 0.08), rad[1] * (r + 0.08), 0], [rad, tan, Z], [0.07, 0.022, 0.022], mw);            // handle
            }
            b.box([0, 0, 0], AXES, [0.07, 0.07, 0.05], mm);
            b.box([0, 0, 0.15], AXES, [0.03, 0.03, 0.12], mm);                                                           // shaft
        });
        const lever = mk('helm:lever', b => {
            b.box([0, 0, 0], AXES, [0.09, 0.04, 0.14], mm);
            b.box([0, 0.2, 0], AXES, [0.022, 0.2, 0.022], mm);
            b.box([0, 0.42, 0], AXES, [0.06, 0.04, 0.04], w.mat('hazard'));
        });
        const area = w.areaAt([e.stand[0], e.stand[1] + 0.5, e.stand[2]]);
        this.stand = e.stand;
        this.reach = e.reach || 1.4;
        this.lightArea = area;
        this.vehicle = null;
        w.addDynamic(this);
        w.helms.push(this);
        w.addDynamic(new HelmPart(this, wheel, area, e.wheel.pos, h => m4.rotZ(h.rudder * 2.6)));   // about 3/4 turn each way
        w.addDynamic(new HelmPart(this, lever, area, e.lever.pos, h => m4.rotX(h.throttle * 0.6))); // forward = ahead, back = astern
    }

    link() {
        this.vehicle = this.world.vehicles.find(v => v.id === this.def.vehicle) || null;
        if (this.vehicle) this.vehicle.helmStation = this;
    }
}

// One half of a door panel, cut along the portal plane. It always belongs to the area its face looks
// into, however far the panel slides or lifts: the underside of a hatch cover stays part of (and lit by)
// the room below.
class DoorPanel extends Member {
    constructor(door, chunk, area) {
        super(null, door.world, chunk, area);
        this.door = door;
    }

    update() { this.place(this.door.model); }
}

// SECTR_Door: drives the Closed flag of its portal; `auto` doors open for nearby actors.
// slide: right | left | up | down (in the portal frame), lift: pops the panel out first (hatches)
class Door extends Entity {
    spawn() {
        const w = this.world, e = this.def, P = w.portalById.get(e.portal);
        if (!P) { w.warnings.push(`door: unknown portal "${e.portal}"`); return; }
        const b = new MeshBuilder();
        b.box([0, 0, 0], AXES, [P.w / 2, P.h / 2, 0.04], w.mat(e.mat || (e.auto ? 'autodoor' : 'door')));
        if (e.style === 'ship') {
            // watertight ship door: raised frame ring, dogs and a hand wheel on both faces
            const mf = w.mat(e.frameMat || 'metal'), hw = P.w / 2, hh = P.h / 2;
            for (const z of [-0.06, 0.06]) {
                b.box([0, hh - 0.08, z], AXES, [hw - 0.04, 0.04, 0.02], mf); b.box([0, -hh + 0.08, z], AXES, [hw - 0.04, 0.04, 0.02], mf);
                b.box([-hw + 0.08, 0, z], AXES, [0.04, hh - 0.04, 0.02], mf); b.box([hw - 0.08, 0, z], AXES, [0.04, hh - 0.04, 0.02], mf);
                b.box([0, 0.05, z * 1.4], AXES, [0.22, 0.025, 0.02], mf); b.box([0, 0.05, z * 1.4], AXES, [0.025, 0.22, 0.02], mf);
                for (const yy of [-hh * 0.6, hh * 0.6]) b.box([hw - 0.12, yy, z * 1.3], AXES, [0.08, 0.03, 0.02], w.mat('hazard'));
            }
        } else {
            b.box([0, -P.h / 2 + 0.12, 0], AXES, [P.w / 2 - 0.02, 0.1, 0.05], w.mat('hazard'));
            if (e.auto) b.box([0, P.h / 2 - 0.2, 0], AXES, [0.25, 0.04, 0.06], w.mat('coldlamp'));
        }
        const halves = splitMesh(b, [0, 0, 1, 0]);
        P.locked = !!e.locked;
        P.autoDoor = !!e.auto && !P.locked;
        const startOpen = !!e.open && !e.auto;
        this.portal = P;
        this.auto = !!e.auto;
        this.lift = e.lift || 0;
        this.slide = e.slide || 'right';
        this.radius = e.radius || 3.2;
        this.delay = e.delay ?? 1.2;
        this.hold = 0;
        this.open = startOpen ? 1 : 0;
        this.target = this.open;
        this.speed = e.speed || (e.auto ? 2.6 : 1.4);
        this.lightArea = P.front || P.back;
        this.model = IDENTITY;
        this.update(0, 0, []);
        w.addDynamic(this);
        w.doors.push(this);
        halves.forEach((half, k) => {
            const chunk = w.pool.add(half, { name: `door:${P.id}:${k ? 'back' : 'front'}`, dynamic: true });
            if (!chunk) return;
            const panel = new DoorPanel(this, chunk, k ? P.back : P.front);
            panel.update();
            w.addDynamic(panel);
        });
    }

    get name() { return this.portal.id; }

    toggle() {
        if (this.portal.locked) return 'locked';
        if (this.auto) return 'auto';
        this.target = this.target > 0.5 ? 0 : 1;
        return 'ok';
    }

    update(dt, t, actors) {
        const P = this.portal;
        if (this.auto && !P.locked) {
            const near = actors.some(a => v3.dist(a, P.center) < this.radius);
            if (near) { this.target = 1; this.hold = this.delay; }
            else if ((this.hold -= dt) <= 0) this.target = 0;
        }
        const d = this.target - this.open;
        this.open += Math.sign(d) * Math.min(Math.abs(d), this.speed * dt);
        P.closed = this.open < 0.02;
        const ease = this.open * this.open * (3 - 2 * this.open);
        const lift = this.lift * Math.min(1, this.open * 4);
        const sd = { right: [P.right, P.w], left: [v3.mul(P.right, -1), P.w], up: [P.up, P.h], down: [v3.mul(P.up, -1), P.h] }[this.slide];
        this.model = m4.basis(P.right, P.up, P.normal, v3.madd(v3.madd(P.center, sd[0], sd[1] * 0.97 * ease), P.normal, lift));
    }
}

// Dynamic SECTR Member that walks the sector graph between random areas, waiting at automatic doors
class Drone extends Member {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model || 'drone', IDENTITY);
        this.chunk = w.pool.add(b, { name: 'drone', dynamic: true });
        this.rnd = mulberry32(e.seed || 99);
        this.pos = e.pos.slice();
        this.yaw = 0;
        this.speed = e.speed || 3;
        this.queue = [];
        this.wait = 0.5;
        this.target = -1;
        this.lightOn = !!e.light;
        this.light = e.light ? new PointLight({ pos: e.pos.slice(), color: e.light.color, intensity: e.light.intensity, radius: e.light.radius }) : null;
        w.addDynamic(this);
        w.drones.push(this);
    }

    plan() {
        const w = this.world, from = w.areaAt(this.pos);
        const path = w.nav.findPath(from, this.target);
        if (!path) return false;
        this.queue = [{ pos: w.areas[from].hub }];
        for (const step of path) this.queue.push({ pos: step.portal.navPoint(), portal: step.portal }, { pos: w.areas[step.area].hub });
        return true;
    }

    update(dt, t) {
        const w = this.world;
        if (!this.queue.length) {
            this.wait -= dt;
            if (this.wait <= 0) {
                const cur = w.areaAt(this.pos);
                for (let k = 0; k < 8; k++) {
                    this.target = Math.floor(this.rnd() * w.areas.length);
                    if (this.target !== cur && this.plan()) break;
                }
                this.wait = 1.0;
            }
        } else {
            const wp = this.queue[0];
            const d = v3.sub(wp.pos, this.pos), l = v3.len(d);
            if (wp.portal && !wp.portal.navigable) {                          // a door got locked/closed on us: replan
                if (!this.plan()) { this.queue = []; this.wait = 1.5; }
            } else if (!(wp.portal && wp.portal.closed && l < 1.6)) {         // wait for an automatic door
                const step = this.speed * dt;
                if (l <= step) { this.pos = wp.pos.slice(); this.queue.shift(); }
                else {
                    this.pos = v3.madd(this.pos, d, step / l);
                    if (Math.hypot(d[0], d[2]) > 0.05) {
                        const want = Math.atan2(-d[0], -d[2]) * 180 / Math.PI;
                        const dy = ((want - this.yaw + 540) % 360) - 180;
                        this.yaw += dy * Math.min(1, dt * 6);
                    }
                }
            }
        }
        const bob = Math.sin(t * 3) * 0.05;
        this.place(m4.trs([this.pos[0], this.pos[1] + bob, this.pos[2]], this.yaw, 1));
        this.owners = w.areasOverlapping(this.min, this.max);                // SECTR Member: may span several sectors
        this.lightArea = w.areaAt(this.pos);
        if (this.light) this.light.pos = [this.pos[0], this.pos[1] - 0.2, this.pos[2]];
    }
}

const ENTITY_TYPES = {
    prop: Prop,
    light: Lamp,
    stairs: Stairs,
    hull: Hull,
    helm: Helm,
    door: Door,
    drone: Drone,
};

// ----------------------------------------------------------------------------------------------- js/world/world.js
// World: built entirely from the scenario data.
//
// Build order: materials -> areas -> portals -> occluders -> generated architecture -> outdoors
// (terrain, scatter, seabed) -> entities -> vehicles (claim what is inside their hulls) -> link entities
// -> object trees -> collision -> sea surface.

class World {
    constructor(scn) {
        this.scn = scn;
        this.warnings = [];
        this.pool = new GeometryPool();
        this.objects = [];              // static members (chunks with owners), in the per-area trees
        this.dynamic = [];              // entities updated every frame, in spawn order
        this.entities = [];
        this.doors = [];
        this.helms = [];
        this.drones = [];
        this.hulls = [];
        this.materials = new MaterialTable(scn.materials, this.warnings);
        this.nav = new NavGraph(this);
        this.buildAreas();
        this.buildPortals();
        this.occluders = (scn.occluders || []).map((d, i) => new Occluder(d, i, this));
        for (const O of this.occluders) this.areas[O.area].occluders.push(O.index);
        new Architecture(this).build();
        this.outdoors = new Outdoors(this, scn.outdoor);
        this.water = this.outdoors.water;
        this.outdoors.build();
        this.spawnEntities();
        this.vehicles = (scn.vehicles || []).map(d => new Vehicle(this, d));
        for (const veh of this.vehicles) veh.claim();
        for (const e of this.entities) e.link();
        this.buildTrees();
        this.buildCollision();
        this.water?.update(this.hulls);
        this.totalTris = this.objects.reduce((s, o) => s + o.chunk.count / 3, 0);
        for (const w of this.warnings) console.warn('[scenario]', w);
    }

    mat(name) { return this.materials.index(name); }

    // ---- areas (FarCry VisArea / SECTR Sector) ----
    buildAreas() {
        this.areas = [Area.outdoors(this.scn.outdoor)];
        for (const def of this.scn.areas || []) this.areas.push(new Area(def, this.areas.length));
        this.areaById = new Map(this.areas.map(a => [a.id, a.index]));
    }

    areaIndex(id) {
        if (id === undefined || id === null) return undefined;
        if (!this.areaById.has(id)) { this.warnings.push(`unknown area "${id}"`); return 0; }
        return this.areaById.get(id);
    }

    // FarCry SetCurAreas / SECTR GetContaining: point query, outdoors when nothing contains it
    areaAt(p) {
        for (let i = 1; i < this.areas.length; i++) if (this.areas[i].contains(p)) return i;
        return 0;
    }

    // SECTR Member: an AABB may belong to several sectors (and to the outdoors)
    areasOverlapping(min, max) {
        const out = [];
        let covered = false;
        const pts = [[min[0], min[2]], [max[0], min[2]], [max[0], max[2]], [min[0], max[2]], [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2]];
        for (let i = 1; i < this.areas.length; i++) {
            const a = this.areas[i];
            if (max[1] <= a.y + 1e-3 || min[1] >= a.top - 1e-3) continue;
            if (max[0] < a.bbox[0] || min[0] > a.bbox[2] || max[2] < a.bbox[1] || min[2] > a.bbox[3]) continue;
            const hits = pts.filter(p => g2.inside(p, a.shape)).length;
            const vin = a.shape.some(p => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[2] && p[1] <= max[2]);
            if (hits || vin) out.push(i);
            if (hits === pts.length && min[1] >= a.y - 1e-3 && max[1] <= a.top + 1e-3) covered = true;
        }
        if (!covered && max[1] > -0.05) {
            const outside = pts.some(p => !this.areas.some((a, i) => i > 0 && g2.inside(p, a.shape) && min[1] < a.top && max[1] > a.y));
            if (outside || !out.length) out.push(0);
        }
        if (!out.length) out.push(0);
        return out;
    }

    // ---- portals ----
    buildPortals() {
        this.portals = [];
        this.portalById = new Map();
        for (const d of this.scn.portals || []) {
            const P = new Portal(d, this.portals.length, this);
            if (P.front === P.back) { this.warnings.push(`portal "${d.id}" connects "${this.areas[P.front].id}" to itself; skipped`); continue; }
            this.portals.push(P);
            this.portalById.set(P.id, P);
            this.areas[P.front].portals.push(P.index);
            this.areas[P.back].portals.push(P.index);
        }
    }

    // ---- static geometry ----
    // info: { name, owners, lightArea, vehicle?, dockedOnly?, terrain?, solid?, climbable? }
    addStatic(b, info) {
        const parts = this.splitByPortals(b, info.owners, info.lightArea);
        parts.forEach(part => {
            const name = parts.length > 1 ? `${info.name}|${this.areas[part.owners[0]].id}` : info.name;
            const chunk = this.pool.add(part.b, Object.assign({}, info, { name, owners: part.owners, lightArea: part.lightArea }));
            if (chunk) this.objects.push({
                name, chunk, min: chunk.min, max: chunk.max, owners: part.owners, lightArea: part.lightArea, model: IDENTITY, stamp: -1,
                vehicleId: info.vehicle, dockedOnly: !!info.dockedOnly, terrain: !!info.terrain, solid: info.solid !== false, climbable: !!info.climbable,
            });
        });
    }

    // does the mesh cross portal P's plane close to its aperture?
    straddles(b, P, margin = 0.6) {
        const c = v3.lerp(b.min, b.max, 0.5), h = v3.mul(v3.sub(b.max, b.min), 0.5);
        const ext = ax => Math.abs(ax[0]) * h[0] + Math.abs(ax[1]) * h[1] + Math.abs(ax[2]) * h[2];
        const dn = v3.dot(P.normal, c) + P.d, rn = ext(P.normal);
        if (dn - rn > -1e-3 || dn + rn < 1e-3) return false;
        const rel = v3.sub(c, P.center);
        return Math.abs(v3.dot(rel, P.right)) <= P.w / 2 + margin + ext(P.right) && Math.abs(v3.dot(rel, P.up)) <= P.h / 2 + margin + ext(P.up);
    }

    // cut geometry owned by both sides of a portal along the portal plane: each half belongs to
    // (and is lit by) the area on its side, so stencil masks and lighting stay per area
    splitByPortals(b, owners, lightArea) {
        let pieces = [{ b, owners }];
        if (owners.length > 1) for (const P of this.portals) {
            const next = [];
            for (const pc of pieces) {
                if (!pc.owners.includes(P.front) || !pc.owners.includes(P.back) || !this.straddles(pc.b, P)) { next.push(pc); continue; }
                const [neg, pos] = splitMesh(pc.b, [P.normal[0], P.normal[1], P.normal[2], P.d]);   // normal points to the back side
                // a piece keeps the owners on its side that its own bounds still overlap
                const refine = (half, owners) => { const ov = this.areasOverlapping(half.min, half.max), r = owners.filter(o => ov.includes(o)); return r.length ? r : ov; };
                if (neg.idx.length) next.push({ b: neg, owners: refine(neg, pc.owners.filter(o => o !== P.back)) });
                if (pos.idx.length) next.push({ b: pos, owners: refine(pos, pc.owners.filter(o => o !== P.front)) });
            }
            pieces = next;
        }
        return pieces.map(pc => ({ b: pc.b, owners: pc.owners, lightArea: pc.owners.includes(lightArea) ? lightArea : pc.owners[0] }));
    }

    // add a scenario model (box / cyl / cone parts) to b, placed with matrix M
    addModel(b, name, M) {
        const parts = (this.scn.models || {})[name];
        if (!parts) { this.warnings.push(`unknown model "${name}"`); return; }
        b.M = M;
        for (const part of parts) {
            const m = this.mat(part.mat);
            if (part.box) { const [x, y, z, sx, sy, sz] = part.box; b.box([x, y, z], AXES, [sx / 2, sy / 2, sz / 2], m); }
            else if (part.cyl) { const [x, y, z, r, h] = part.cyl; b.cylinder([x, y, z], r, h, part.seg || 12, m); }
            else if (part.cone) { const [x, y, z, r, h] = part.cone; b.cone([x, y, z], r, h, part.seg || 12, m); }
        }
        b.M = null;
    }

    terrainHeight(x, z) { return this.outdoors.height(x, z); }

    // ---- entities ----
    spawnEntities() {
        for (const def of this.scn.entities || []) {
            const Type = ENTITY_TYPES[def.type];
            if (!Type) { this.warnings.push(`unknown entity type "${def.type}"`); continue; }
            const e = new Type(def, this);
            e.spawn();
            this.entities.push(e);
        }
    }

    addDynamic(e) { this.dynamic.push(e); }

    // outdoor objects -> one quadtree; each indoor area -> its own BVH (SECTR Members may be in several)
    buildTrees() {
        this.outdoorTree = new QuadTree(this.objects.filter(o => !o.vehicle && o.owners.includes(0)));
        this.areaTrees = this.areas.map((a, i) => i === 0 ? null : new BVHTree(this.objects.filter(o => o.owners.includes(i))));
        // a vehicle keeps its outdoor parts (hull, deck gear) in its own tree, in vehicle space
        for (const veh of this.vehicles) veh.outdoorTree = new BVHTree(veh.objects.filter(o => o.owners.includes(0)));
        this.dynamicByArea = this.areas.map(() => []);
    }

    // ---- walking: collision, ground, ladders ----
    // walkable floors and wall segments from the scene triangles (terrain uses terrainHeight)
    buildCollision() {
        this.col = new CollisionSet(2);
        const pv = this.pool.vdata, pi = this.pool.idata, V = i => [pv[i * 7], pv[i * 7 + 1], pv[i * 7 + 2]];
        for (const o of this.objects) {
            if (o.terrain || !o.solid) continue;               // light fixtures are not solid
            const set = o.vehicle ? (o.dockedOnly ? o.vehicle.dockCol : o.vehicle.col) : this.col, c = o.chunk;
            for (let k = 0; k < c.count; k += 3) set.addTri(V(c.baseVertex + pi[c.first + k]), V(c.baseVertex + pi[c.first + k + 1]), V(c.baseVertex + pi[c.first + k + 2]));
        }
        this.ladders = this.objects.filter(o => o.climbable);
    }

    // highest walkable surface under p that is at most `step` above its feet
    groundAt(p, step) {
        const maxY = p[1] + step;
        let best = { y: -Infinity, support: null };
        const th = this.terrainHeight(p[0], p[2]);
        if (th <= maxY && this.areaAt([p[0], th + 0.1, p[2]]) === 0) best.y = th;     // no terrain inside buildings
        const gw = this.col.ground(p[0], p[2], maxY);
        if (gw > best.y) best = { y: gw, support: null };
        for (const veh of this.vehicles) {
            const l = veh.toLocal(p);
            let gl = veh.col.ground(l[0], l[2], l[1] + step);
            if (veh.docked) gl = Math.max(gl, veh.dockCol.ground(l[0], l[2], l[1] + step));
            if (gl > -Infinity) { const y = veh.toWorld([l[0], gl, l[2]])[1]; if (y > best.y) best = { y, support: veh }; }
        }
        for (const d of this.doors) {                                     // closed hatch covers can be stood on
            if (!d.portal.horizontal || d.open > 0.7) continue;
            const P = d.portal, r = v3.sub(p, P.center), y = P.center[1] + 0.05;
            if (Math.abs(v3.dot(r, P.right)) < P.w / 2 && Math.abs(v3.dot(r, P.up)) < P.h / 2 && y <= maxY && y > best.y) best = { y, support: P.vehicle || null };
        }
        return best;
    }

    // push a player cylinder (radius r, from feet+lo to feet+hi) out of walls, hulls and closed doors
    collide(p, r, lo, hi) {
        this.col.pushOut(p, r, p[1] + lo, p[1] + hi);
        for (const veh of this.vehicles) {
            const l = veh.toLocal(p);
            veh.col.pushOut(l, r, l[1] + lo, l[1] + hi);
            if (veh.docked) veh.dockCol.pushOut(l, r, l[1] + lo, l[1] + hi);
            const q = veh.toWorld(l); p[0] = q[0]; p[2] = q[2];
        }
        for (const d of this.doors) {
            if (d.portal.horizontal || d.open > 0.7) continue;
            const P = d.portal, a = P.verts[0], b = P.verts[1];
            if (Math.abs(p[0] - P.center[0]) > P.w + 2 || Math.abs(p[2] - P.center[2]) > P.w + 2) continue;
            pushSeg(p, r, p[1] + lo, p[1] + hi, { x0: a[0], z0: a[2], x1: b[0], z1: b[2], y0: P.center[1] - P.h / 2, y1: P.center[1] + P.h / 2 });
        }
    }

    ladderAt(p, r) {
        for (const o of this.ladders) {
            if (o.dockedOnly && !o.vehicle.docked) continue;
            const q = o.vehicle ? o.vehicle.toLocal(p) : p, m = r + 0.15;
            if (q[0] > o.min[0] - m && q[0] < o.max[0] + m && q[2] > o.min[2] - m && q[2] < o.max[2] + m && q[1] > o.min[1] - 0.3 && q[1] < o.max[1] + 0.2)
                return { o, top: o.vehicle ? o.vehicle.toWorld([q[0], o.max[1], q[2]])[1] : o.max[1] };
        }
        return null;
    }

    // ---- per frame ----
    update(dt, t, actors) {
        this.time = t;
        for (const veh of this.vehicles) veh.update(dt, t);
        const all = actors.concat(this.drones.map(d => d.pos));
        for (const e of this.dynamic) e.update(dt, t, all);
        for (const list of this.dynamicByArea) list.length = 0;
        for (const e of this.dynamic) for (const o of e.owners) this.dynamicByArea[o].push(e);
        this.water?.update(this.hulls);
    }

    // per-area lighting table (static lights + dynamic lights of the frame)
    lightingTable(t) {
        const data = new Float32Array(this.areas.length * AREA_FLOATS);
        const dyn = this.areas.map(() => []);
        for (const e of this.dynamic) if (e.light && e.lightOn) dyn[e.lightArea].push(e.light);
        this.areas.forEach((a, i) => {
            const o = i * AREA_FLOATS, lights = dyn[i].concat(a.lights).slice(0, MAX_LIGHTS);
            data.set([a.ambient[0], a.ambient[1], a.ambient[2], 0, a.fog[0], a.fog[1], a.fog[2], a.fog[3], a.sun, lights.length, 0, 0], o);
            lights.forEach((L, k) => data.set([L.pos[0], L.pos[1], L.pos[2], L.radius, L.color[0], L.color[1], L.color[2], L.intensityAt(t)], o + 12 + k * 8));
        });
        return data;
    }
}

// ----------------------------------------------------------------------------------------------- js/game/player.js
// Camera and PlayerController: walking (gravity, walls, stairs, ladders, swimming, riding vehicles),
// fly mode (noclip) and standing at a ship's helm. Tuning comes from the scenario's `player` block.

const PLAYER_DEFAULTS = {
    eyeHeight: 1.65, radius: 0.3, walkSpeed: 4.2, runSpeed: 7.5, stepHeight: 0.55,
    jumpSpeed: 5.2, gravity: 18, climbSpeed: 2.4,
    swim: { speedFactor: 0.45, jumpSpeed: 3.5, depth: 1.3 },
    fly: { speed: 5, runSpeed: 14 },
    turnSpeed: 1.8, mouseSensitivity: 0.0022,
    helm: { throttleRate: 0.35, rudderRate: 0.9, rudderReturn: 0.5 },
};

// defaults overridden by (possibly partial) scenario values, one level of nesting deep
function withDefaults(defaults, over = {}) {
    const out = {};
    for (const k of Object.keys(defaults)) {
        const d = defaults[k], o = over[k];
        out[k] = d && typeof d === 'object' && !Array.isArray(d) ? Object.assign({}, d, o) : (o ?? d);
    }
    return out;
}

class Camera {
    constructor(def) {
        this.pos = (def ? def.pos : [0, 1.7, -16]).slice();
        this.yaw = def ? (def.yaw || 0) * Math.PI / 180 : Math.PI;
        def = def || {};
        this.pitch = (def.pitch || 0) * Math.PI / 180;
        this.fov = (def.fov || 70) * Math.PI / 180;
        this.start = { pos: this.pos.slice(), yaw: this.yaw, pitch: this.pitch };
    }

    reset() { Object.assign(this, { pos: this.start.pos.slice(), yaw: this.start.yaw, pitch: this.start.pitch }); }

    look(dx, dy) {
        this.yaw += dx;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy));
    }

    // arrow keys turn the view
    turn(keys, rate) {
        if (keys.has('ArrowLeft')) this.yaw -= rate;
        if (keys.has('ArrowRight')) this.yaw += rate;
        if (keys.has('ArrowUp')) this.pitch = Math.min(1.5, this.pitch + rate);
        if (keys.has('ArrowDown')) this.pitch = Math.max(-1.5, this.pitch - rate);
    }

    // view axes; on a vehicle the look direction is kept relative to the ship and turned by its full
    // rotation (heading, pitch, roll)
    basis(vehicle = null) {
        const { yaw, pitch } = this;
        if (vehicle) {
            const ly = yaw + vehicle.heading;
            const fwd = v3.norm(m4.dir(vehicle.M, [Math.sin(ly) * Math.cos(pitch), Math.sin(pitch), -Math.cos(ly) * Math.cos(pitch)]));
            const right = v3.norm(m4.dir(vehicle.M, [Math.cos(ly), 0, Math.sin(ly)]));
            return { fwd, right, up: v3.cross(right, fwd) };
        }
        const fwd = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
        const right = [Math.cos(yaw), 0, Math.sin(yaw)];
        return { fwd, right, up: v3.cross(right, fwd) };
    }
}

class PlayerController {
    constructor(game, cameraDef, def) {
        this.game = game;
        this.cfg = withDefaults(PLAYER_DEFAULTS, def);
        this.cam = new Camera(cameraDef);
        this.reset(this.cam.pos);
    }

    get world() { return this.game.world; }
    get walking() { return this.game.opts.walk; }

    // put the walker's feet under an eye position
    reset(eye) {
        Object.assign(this, {
            feet: [eye[0], eye[1] - this.cfg.eyeHeight, eye[2]], vy: 0, support: null, local: null,
            onGround: false, wasGround: false, swimming: false, climbing: false, driving: null,
        });
    }

    basis() { return this.cam.basis(this.walking && this.driving); }

    get stateLabel() {
        if (!this.walking) return 'flying';
        return this.driving ? 'at the helm' : this.climbing ? 'climbing' : this.swimming ? 'swimming' : this.onGround ? 'walking' : 'airborne';
    }

    update(dt, keys) {
        if (this.walking) this.walk(dt, keys);
        else this.fly(dt, keys);
        this.cam.turn(keys, this.cfg.turnSpeed * dt);
    }

    fly(dt, k) {
        const { fwd, right } = this.basis(), f = this.cfg.fly;
        let mv = [0, 0, 0];
        if (k.has('KeyW')) mv = v3.add(mv, fwd);
        if (k.has('KeyS')) mv = v3.sub(mv, fwd);
        if (k.has('KeyD')) mv = v3.add(mv, right);
        if (k.has('KeyA')) mv = v3.sub(mv, right);
        if (k.has('KeyE') || k.has('Space')) mv[1] += 1;
        if (k.has('KeyQ') || k.has('ControlLeft')) mv[1] -= 1;
        const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? f.runSpeed : f.speed;
        if (v3.len(mv) > 0) this.cam.pos = v3.madd(this.cam.pos, v3.norm(mv), speed * dt);
    }

    walk(dt, k) {
        const w = this.world, c = this.cfg, R = c.radius;
        // ride along with whatever vehicle we stand on (or are inside)
        if (this.support) { this.feet = this.support.toWorld(this.local); this.cam.yaw -= this.support.dHeading; }
        if (this.driving) { this.drive(dt, k); return; }
        const { fwd, right } = this.basis(), f = v3.norm([fwd[0], 0, fwd[2]]);
        let mv = [0, 0, 0];
        if (k.has('KeyW')) mv = v3.add(mv, f);
        if (k.has('KeyS')) mv = v3.sub(mv, f);
        if (k.has('KeyD')) mv = v3.add(mv, right);
        if (k.has('KeyA')) mv = v3.sub(mv, right);
        if (v3.len(mv) > 0) mv = v3.norm(mv);
        const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? c.runSpeed : c.walkSpeed) * (this.swimming ? c.swim.speedFactor : 1);
        const step = this.swimming ? 3.2 : c.stepHeight;
        // ladders: W / S climb; forward motion only at the top, to step off
        const lad = w.ladderAt(this.feet, R);
        let climb = 0;
        this.climbing = !!lad && (k.has('KeyW') || k.has('KeyS'));
        if (this.climbing) {
            climb = (k.has('KeyW') ? 1 : -1) * c.climbSpeed * dt;
            if (!(k.has('KeyW') && this.feet[1] >= lad.top - 0.2)) mv = v3.sub(mv, v3.mul(f, v3.dot(mv, f)));
        }
        const h = v3.mul(mv, speed * dt), n = Math.max(1, Math.ceil(Math.hypot(h[0], h[2]) / 0.1));
        for (let i = 0; i < n; i++) { this.feet[0] += h[0] / n; this.feet[2] += h[2] / n; w.collide(this.feet, R, step, 1.75); }
        if (this.climbing) { this.feet[1] += climb; this.vy = 0; }
        else {
            if (k.has('Space') && (this.onGround || this.swimming)) this.vy = this.swimming ? c.swim.jumpSpeed : c.jumpSpeed;
            this.vy -= c.gravity * dt;
            this.feet[1] += this.vy * dt;
        }
        // ground under the whole footprint (centre + 4 rim samples) so short treads can be stepped onto
        let g = w.groundAt(this.feet, this.climbing ? 0.05 : step);
        if (!this.climbing) for (const [ox, oz] of [[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]]) {
            const gi = w.groundAt([this.feet[0] + ox * R, this.feet[1], this.feet[2] + oz * R], step);
            if (gi.y > g.y) g = gi;
        }
        this.onGround = false;
        if (!this.climbing && this.vy <= 0 && (this.feet[1] <= g.y + 1e-3 || (this.wasGround && this.feet[1] - g.y < 0.35))) {
            this.feet[1] = g.y; this.vy = 0; this.onGround = true;
        }
        this.support = this.climbing ? (lad.o.vehicle || null) : g.support;
        const depth = c.swim.depth;
        const wl = w.water && w.areaAt(v3.add(this.feet, [0, 0.5, 0])) === 0 ? w.water.level : -Infinity;   // the sea is outdoors only
        this.swimming = this.feet[1] < wl - depth + 1e-3 && !this.onGround;
        if (this.feet[1] < wl - depth) { this.feet[1] = wl - depth; this.vy = Math.max(this.vy, 0); this.swimming = true; this.support = null; }
        if (this.feet[1] < -40) this.reset(this.cam.start.pos);
        this.wasGround = this.onGround;
        if (this.support) this.local = this.support.toLocal(this.feet);
        this.cam.pos = v3.add(this.feet, [0, c.eyeHeight, 0]);
    }

    // at the helm: the player stands at the wheel and the camera rolls and pitches with the hull
    drive(dt, k) {
        const veh = this.driving, ctl = veh.control, st = veh.helmStation.stand, hc = this.cfg.helm;
        if (k.has('KeyW')) ctl.throttle = Math.min(1, ctl.throttle + hc.throttleRate * dt);
        if (k.has('KeyS')) ctl.throttle = Math.max(-0.5, ctl.throttle - hc.throttleRate * dt);
        if (k.has('KeyX')) ctl.throttle = 0;
        const steer = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
        if (steer) ctl.rudder = Math.max(-1, Math.min(1, ctl.rudder + steer * hc.rudderRate * dt));
        else ctl.rudder -= Math.sign(ctl.rudder) * Math.min(Math.abs(ctl.rudder), hc.rudderReturn * dt);   // self-centring
        if (k.has('Space')) ctl.rudder = 0;
        this.local = st.slice(); this.support = veh; this.feet = veh.toWorld(this.local);
        this.vy = 0; this.onGround = true; this.climbing = false; this.swimming = false;
        this.cam.pos = veh.toWorld([st[0], st[1] + this.cfg.eyeHeight, st[2]]);
    }

    // take the helm in reach, or let go of the one we hold; returns a message, or null if no helm is near
    toggleHelm() {
        if (!this.walking) return null;
        if (this.driving) { this.driving.leaveHelm(); this.driving = null; return 'Left the helm: autopilot returns to the route'; }
        for (const h of this.world.helms) {
            if (!h.vehicle || v3.dist(this.feet, h.vehicle.toWorld(h.stand)) > h.reach) continue;
            h.vehicle.takeHelm();
            this.driving = h.vehicle;
            return 'At the helm: W/S throttle, A/D steer, X stop, Space centre rudder, F leave';
        }
        return null;
    }

    teleport(pos) {
        this.cam.pos = pos;
        if (this.walking) this.reset(pos);
    }
}

// ------------------------------------------------------------------------------------------------ js/game/input.js
// InputSystem: held keys, pointer-lock mouse look and key presses routed to the game.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.keys = new Set();
    }

    attach() {
        const canvas = this.canvas, io = this.io;
        io.listen(canvas, 'click', () => canvas.requestPointerLock?.());
        io.listen(document, 'mousemove', e => {
            const p = this.game.player;
            if (document.pointerLockElement !== canvas || !p) return;
            const s = p.cfg.mouseSensitivity;
            if (this.game.fx.cameraLocked) return;
            p.cam.look(e.movementX * s, e.movementY * s);
        });
        io.listen(document, 'keydown', e => {
            this.keys.add(e.code);
            if (this.game.world) this.game.onKey(e.code);
        });
        io.listen(document, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }
}

// -------------------------------------------------------------------------------------------------- js/game/hud.js
// Hud: the stats / traversal panel, toasts and the help panel (DOM overlays).

class Hud {
    constructor(game) {
        this.game = game;
        this.el = game.ui.$('hud');
        this.help = game.ui.$('help');
        this.toastEl = game.ui.$('toast');
        this.toastUntil = 0;
        this.last = 0;
    }

    toast(msg) {
        this.toastEl.textContent = msg;
        this.toastEl.style.display = 'block';
        this.toastUntil = performance.now() + 1800;
    }

    tick(now, vis) {
        if (now - this.last > 120) { this.last = now; this.update(vis); }
        if (this.toastUntil && now > this.toastUntil) { this.toastEl.style.display = 'none'; this.toastUntil = 0; }
    }

    update(vis) {
        const g = this.game, w = g.world, o = g.opts, s = g.stats, fs = g.frameStats, P = g.player;
        const flag = (b, on = 'ON', off = 'OFF') => b ? `<span class="on">${on}</span>` : `<span class="off">${off}</span>`;
        const camArea = w.areas[w.areaAt(P.cam.pos)];
        const vAreas = w.areas.filter((a, i) => vis.nodes[i] && vis.nodes[i].some(e => !e.skyOnly));
        const lines = [];
        lines.push(`<span class="t">ENTITY PORTAL // WEBGPU</span>   ${s.fps.toFixed(0)} fps   cpu ${s.visMs.toFixed(2)} ms`);
        lines.push(`camera area   ${camArea.name}${o.freeze ? '  <span class="w">[vis frozen]</span>' : ''}`);
        lines.push(`culling ${flag(o.culling)}  masking <span class="${g.frameMode === 'stencil' ? 'on' : 'w'}">${g.frameMode}</span>  occluders ${flag(o.occluders)}`);
        lines.push(`areas visible ${vAreas.length}/${w.areas.length}  entries ${vis.entries.length}  sky ${flag(vis.sky, 'yes', 'no')}`);
        lines.push(`portals       tested ${vis.tested}  passed ${vis.passed}  <span class="d">closed ${vis.closed}</span>  occluded ${vis.occludedPortals}`);
        lines.push(`stencil       refs ${fs.refs - 1}  marks ${fs.marks}  glass panes ${fs.glass}  fog veils ${fs.veils}  water ${fs.water}`);
        lines.push(`outdoor tree  <span class="${fs.outNodes ? '' : 'off'}">quadtree ${w.outdoorTree.nodeCount} nodes: visited ${fs.outNodes}, tested ${fs.outObjs}</span>`);
        lines.push(`indoor trees  bvh per area: visited ${fs.inNodes}, tested ${fs.inObjs}`);
        lines.push(`draws         ${s.draws} (${s.objs} objs of ${w.objects.length + w.dynamic.length})  tris ${(s.tris / 1000).toFixed(1)}k/${(w.totalTris / 1000).toFixed(1)}k  occluded ${fs.occluded}`);
        lines.push('');
        lines.push('<span class="t">TRAVERSAL</span>');
        const shown = vis.entries.slice(0, 16);
        for (const e of shown) {
            const a = w.areas[e.area];
            const via = e.via ? `${e.via.id} → ` : '';
            lines.push(`${'  '.repeat(e.depth)}${e.depth ? '└ ' : ''}${via}${a.name}${e.skyOnly ? ' <span class="w">[sky only]</span>' : ''}${e.ref !== undefined && g.frameMode === 'stencil' ? ` <span class="off">#${e.ref}</span>` : ''}`);
        }
        if (vis.entries.length > shown.length) lines.push(`  … ${vis.entries.length - shown.length} more`);
        lines.push('');
        lines.push(`<span class="t">PLAYER</span> ${P.stateLabel}${o.walk && P.support ? ` on ${P.support.id}` : ''}`);
        if (o.walk && P.driving) {
            const c = P.driving.control, rud = Math.round(c.rudder * 35);
            lines.push(`<span class="t">HELM</span> throttle <span class="${c.throttle < 0 ? 'w' : 'on'}">${Math.round(c.throttle * 100)}%</span>  rudder ${Math.abs(rud)}° ${rud > 0 ? 'starboard' : rud < 0 ? 'port' : ''}   <span class="off">W/S A/D X Space · F leave</span>`);
        }
        for (const veh of w.vehicles) lines.push(`<span class="t">SHIP</span> ${veh.id}  ${veh.state}${veh.docked ? ` (${Math.max(0, veh.wait).toFixed(0)} s)` : ''}  ${(veh.v * 1.944).toFixed(1)} kn  hdg ${((veh.heading * 180 / Math.PI + 360) % 360).toFixed(0)}°  heel ${(veh.roll * 180 / Math.PI).toFixed(1)}°`);
        const drone = w.drones[0];
        if (drone) {
            lines.push('');
            lines.push(`<span class="t">DRONE</span> in ${drone.owners.map(i => w.areas[i].name).join(' + ')} → ${drone.target >= 0 ? w.areas[drone.target].name : '-'}`);
        }
        this.el.innerHTML = lines.join('\n');
        this.help.style.display = o.help ? 'block' : 'none';
    }
}

// ---------------------------------------------------------------------------------------------- js/game/minimap.js
// Minimap: top-down view centred on the player (areas, portals by state, view cones through the portals,
// occluders, the ship and its route, drones). Click to teleport. Spans come from the scenario's `minimap`.

class Minimap {
    constructor(game, canvas) {
        this.game = game;
        this.canvas = canvas;
        this.xf = null;
        canvas.addEventListener('click', e => this.click(e));
    }

    get spans() { return Object.assign({ near: 110, far: 420 }, this.game.world.scn.minimap); }

    // teleport to the clicked spot: an indoor floor, or the ground / deck under it
    click(e) {
        const r = this.canvas.getBoundingClientRect(), m = this.xf, g = this.game;
        if (!m || !g.world) return;
        const x = m.ix(e.clientX - r.left), z = m.iz(e.clientY - r.top);
        const w = g.world, a = w.areas[w.areaAt([x, 1.0, z])];
        const y = !a.outdoor && !a.vehicle ? a.y : w.groundAt([x, 60, z], 0).y;
        g.player.teleport([x, y + g.player.cfg.eyeHeight, z]);
    }

    draw(vis) {
        const game = this.game, w = game.world, cvs = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = cvs.clientWidth, ch = cvs.clientHeight;
        if (cvs.width !== cw * dpr) { cvs.width = cw * dpr; cvs.height = ch * dpr; }
        const g = cvs.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, cw, ch);
        // the map is centred on the player; N switches between a close and an island-wide span
        const span = game.opts.island ? this.spans.far : this.spans.near, cam = game.player.cam, cp0 = cam.pos;
        const b = [cp0[0] - span / 2, cp0[2] - span / 2, cp0[0] + span / 2, cp0[2] + span / 2], s = Math.min((cw - 12) / (b[2] - b[0]), (ch - 12) / (b[3] - b[1]));
        const ox = (cw - (b[2] - b[0]) * s) / 2, oy = (ch - (b[3] - b[1]) * s) / 2;
        // top-down view of a right-handed, y-up world: +z points up the map, +x points left
        const X = x => ox + (b[2] - x) * s, Y = z => ch - (oy + (z - b[1]) * s);
        const path = pts => { g.beginPath(); pts.forEach((v, i) => i ? g.lineTo(X(v[0]), Y(v[1])) : g.moveTo(X(v[0]), Y(v[1]))); g.closePath(); };
        this.xf = { ix: px => b[2] - (px - ox) / s, iz: py => (ch - py - oy) / s + b[1] };
        g.fillStyle = vis.nodes[0] && vis.nodes[0].some(e => !e.skyOnly) ? 'rgba(60,110,70,0.25)' : 'rgba(40,50,55,0.2)';
        g.fillRect(0, 0, cw, ch);
        const coast = ((w.scn.outdoor || {}).terrain || {}).coast;
        if (w.water && coast) {
            const n = coast.normal, p = coast.point, d = [-n[1], n[0]], F = 2000;
            path([[p[0] + d[0] * F, p[1] + d[1] * F], [p[0] + d[0] * F + n[0] * F, p[1] + d[1] * F + n[1] * F], [p[0] - d[0] * F + n[0] * F, p[1] - d[1] * F + n[1] * F], [p[0] - d[0] * F, p[1] - d[1] * F]]);
            g.fillStyle = 'rgba(40,110,150,0.35)'; g.fill();
        }
        for (const veh of w.vehicles) {
            g.setLineDash([3, 4]); g.strokeStyle = 'rgba(160,200,230,0.35)'; g.lineWidth = 1;
            path(veh.route.samples.map(sm => sm.p)); g.stroke();
            g.setLineDash([]);
        }
        for (const h of w.hulls) {
            const veh = h.vehicle;
            path(veh ? h.outline.map(q => { const r = veh.toWorld([q[0], h.deck, q[1]]); return [r[0], r[2]]; }) : h.outline);
            g.fillStyle = 'rgba(150,50,35,0.45)'; g.fill();
        }
        const root = vis.root, camY = cam.pos[1];
        for (const a of w.areas.slice(1).sort((a, c) => a.y - c.y)) {
            path(a.shape2D());
            const seen = vis.nodes[a.index] && vis.nodes[a.index].some(e => !e.skyOnly);
            const level = camY >= a.y - 0.5 && camY <= a.top + 0.5;
            g.fillStyle = a.index === root ? 'rgba(110,220,255,0.35)' : seen ? 'rgba(98,240,138,0.22)' : level ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)';
            g.fill();
            g.setLineDash(a.top <= 0.01 ? [2, 3] : a.y > 0.01 ? [5, 3] : []);
            g.strokeStyle = seen || a.index === root ? 'rgba(200,240,255,0.8)' : a.top <= 0.01 ? 'rgba(200,160,110,0.45)' : 'rgba(160,180,190,0.4)';
            g.lineWidth = 1; g.stroke();
            g.setLineDash([]);
        }
        // view cones through the portals
        const e0 = vis.eye;
        for (const en of vis.entries) {
            if (!en.clipped || en.skyOnly) continue;
            g.beginPath();
            g.moveTo(X(e0[0]), Y(e0[2]));
            for (const p of en.clipped) {
                const d = v3.sub(p, e0), l = Math.hypot(d[0], d[2]) || 1, far = 70;
                g.lineTo(X(e0[0] + d[0] / l * far), Y(e0[2] + d[2] / l * far));
            }
            g.closePath();
            g.fillStyle = 'rgba(255,220,90,0.05)';
            g.fill();
        }
        const rgba = c => `rgba(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0},${Math.min(1, c[3] + 0.2)})`;
        for (const P of w.portals) {
            g.strokeStyle = rgba(portalColor(P, vis.portalState[P.index]));
            g.lineWidth = 3;
            g.beginPath();
            if (P.horizontal) { const v = P.verts; g.moveTo(X(v[0][0]), Y(v[0][2])); for (const p of v.slice(1)) g.lineTo(X(p[0]), Y(p[2])); g.closePath(); g.lineWidth = 1.5; }
            else { g.moveTo(X(P.verts[0][0]), Y(P.verts[0][2])); g.lineTo(X(P.verts[1][0]), Y(P.verts[1][2])); }
            g.stroke();
        }
        g.strokeStyle = rgba(VIS_COLORS.occluder); g.lineWidth = 2;
        for (const O of w.occluders) {
            const { verts } = O.verts(vis.eye);
            g.beginPath(); g.moveTo(X(verts[0][0]), Y(verts[0][2])); g.lineTo(X(verts[1][0]), Y(verts[1][2])); g.stroke();
        }
        g.fillStyle = '#ff5a40';
        for (const d of w.drones) { g.beginPath(); g.arc(X(d.pos[0]), Y(d.pos[2]), 3.5, 0, Math.PI * 2); g.fill(); }
        // camera
        const cp = cam.pos, { fwd } = game.player.basis();
        const ang = Math.atan2(Y(cp[2] + fwd[2]) - Y(cp[2]), X(cp[0] + fwd[0]) - X(cp[0]));
        const cx = Math.max(4, Math.min(cw - 4, X(cp[0]))), cy = Math.max(4, Math.min(ch - 4, Y(cp[2])));
        g.strokeStyle = 'rgba(110,220,255,0.9)'; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang - 0.6) * 18, cy + Math.sin(ang - 0.6) * 18);
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang + 0.6) * 18, cy + Math.sin(ang + 0.6) * 18);
        g.stroke();
        g.fillStyle = '#6edcff';
        g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill();
        if (game.opts.freeze && game.frozen) {
            const fe = game.frozen.eye;
            g.strokeStyle = '#ffc94a';
            g.beginPath(); g.arc(X(fe[0]), Y(fe[2]), 5, 0, Math.PI * 2); g.stroke();
        }
    }
}

// ------------------------------------------------------------------------------------------------- js/game/game.js
// Game: builds the world from a scenario and runs the frame.
//
// Frame order:
//   world update (vehicles first, so riders use this frame's pose) -> player -> portal traversal
//   (or the frozen one) -> FrameBuilder command list -> debug lines -> render -> minimap, HUD

const MASK_MODES = ['stencil', 'scissor', 'none'];

class Game {
    constructor(fx) {
        const mapCanvas = fx.ui.$('map');
        this.fx = fx;
        this.ui = fx.ui;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.input = new InputSystem(this, fx.io);
        this.hud = new Hud(this);
        this.minimap = new Minimap(this, mapCanvas);
        this.mapCanvas = mapCanvas;
        this.onError = (e) => console.error(e);
        this.world = null;
        this.player = null;
        this.vis = null;
        this.frozen = null;
        this.opts = { culling: true, freeze: false, mode: 'stencil', portals: true, volumes: false, map: true, help: true, occluders: true, walk: true, island: false };
        this.stats = { fps: 0, visMs: 0, draws: 0, tris: 0, objs: 0 };
        this.frameStats = null;
        this.frameMode = 'stencil';
        this.running = false;
        this.lastT = performance.now();
    }

    get cam() { return this.player && this.player.cam; }

    async start() {
        await this.renderer.init();
        this.input.attach();
    }

    // build a world from scenario data and make it current (throws on errors in the data)
    load(scn) {
        const world = new World(scn);
        this.world = world;
        this.vis = new PortalVis(world);
        this.frameBuilder = new FrameBuilder(world);
        this.debugLines = new DebugLines(world);
        this.renderer.upload(world);
        this.frozen = null;
        this.opts.freeze = false;
        this.player = new PlayerController(this, scn.camera, scn.player);
        if (world.warnings.length) this.hud.toast(`${world.warnings.length} scenario warning(s), see console`);
        else this.hud.toast(`Loaded "${scn.name || 'scenario'}": ${world.areas.length - 1} areas, ${world.portals.length} portals`);
    }

    onKey(code) {
        const o = this.opts, P = this.player, hud = this.hud;
        switch (code) {
            case 'Digit1': o.culling = !o.culling; hud.toast(`Portal culling ${o.culling ? 'ON' : 'OFF'}`); break;
            case 'Digit2': o.freeze = !o.freeze; this.frozen = null; hud.toast(o.freeze ? 'Visibility frozen: fly around to inspect' : 'Visibility live'); break;
            case 'Digit3': o.mode = MASK_MODES[(MASK_MODES.indexOf(o.mode) + 1) % MASK_MODES.length]; hud.toast(`Portal masking: ${o.mode}`); break;
            case 'Digit4': o.portals = !o.portals; break;
            case 'Digit5': o.volumes = !o.volumes; break;
            case 'Digit6': o.occluders = !o.occluders; hud.toast(`Occluders ${o.occluders ? 'ON' : 'OFF'}`); break;
            case 'KeyM': o.map = !o.map; break;
            case 'KeyH': o.help = !o.help; break;
            case 'KeyR': if (P.driving) hud.toast(P.toggleHelm()); P.cam.reset(); P.reset(P.cam.pos); break;
            case 'KeyV': if (P.driving) hud.toast(P.toggleHelm()); o.walk = !o.walk; if (o.walk) P.reset(P.cam.pos); hud.toast(o.walk ? 'Walk mode' : 'Fly mode (noclip)'); break;
            case 'KeyN': o.island = !o.island; break;
            case 'KeyF': { const msg = P.toggleHelm(); if (msg) hud.toast(msg); else this.useDoor(); break; }
        }
    }

    // report the nearest door (all doors in the scenario are automatic, manual ones toggle)
    useDoor() {
        let best = null, bd = 4.5;
        for (const d of this.world.doors) {
            const dist = v3.dist(this.cam.pos, d.portal.center);
            if (dist < bd) { bd = dist; best = d; }
        }
        if (!best) { this.hud.toast('No door in reach'); return; }
        const r = best.toggle();
        this.fx.emit('door', { result: r, open: best.target > 0.5 });
        if (r === 'locked') this.hud.toast(`${best.name}: LOCKED (portal flag Locked)`);
        else if (r === 'auto') this.hud.toast(`${best.name}: automatic door`);
        else this.hud.toast(`${best.name}: ${best.target > 0.5 ? 'opening' : 'closing'}`);
    }

    // update: world (vehicles first, so riding players use this frame's pose), player; render: visibility, the
    // frame. The host runs both, or (in a composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        dt = Math.min(0.05, dt);
        const t = now / 1000;
        const { renderer: R, world: w, opts: o, player, stats } = this;
        if (update) {
            stats.fps = stats.fps * 0.93 + (1 / Math.max(dt, 1e-4)) * 0.07;
            w.update(dt, t, [player.cam.pos]);
            if (!this.fx.cameraLocked) player.update(dt, this.input.keys);
            this.soundEvents(dt);
        }
        if (render) this.tick(now, t);
    }

    // events for the scenario's sound cues: footsteps while walking on the ground, every stride
    soundEvents(dt) {
        const P = this.player, pos = P.cam.pos;
        if (this.fx.cameraLocked || !this.opts.walk || !P.onGround || P.driving) { this.stepPos = pos.slice(); return; }
        const run = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
        const d = this.stepPos ? Math.hypot(pos[0] - this.stepPos[0], pos[2] - this.stepPos[2]) : 0;
        this.stepDist = (this.stepDist || 0) + (d < 3 ? d : 0);
        this.stepPos = pos.slice();
        if (this.stepDist > (run ? 1.6 : 1.1)) { this.stepDist = 0; this.fx.emit('step', { run, swim: P.swimming }); }
    }

    tick(now, t) {
        const { renderer: R, world: w, opts: o, player, stats } = this;
        const [W, H] = this.fx.size();
        R.resize(W, H);

        const { fwd, up } = player.basis(), eye = player.cam.pos;
        const proj = m4.perspective(player.cam.fov, W / H, 0.05, 400);
        const viewProj = m4.mul(proj, m4.lookAt(eye, v3.add(eye, fwd), up));

        const t0 = performance.now();
        let vis;
        if (o.freeze && this.frozen) vis = this.frozen.vis;
        else {
            vis = this.vis.compute(eye, viewProj, W, H, o.culling);
            if (!o.occluders) vis.occluders = [];
            if (o.freeze) this.frozen = { vis, eye: eye.slice(), basis: player.basis(), aspect: W / H };
        }
        // stencil masks and scissor rects only make sense for the view the traversal was computed for
        const mode = (!o.culling || o.freeze) ? 'none' : o.mode;
        const fr = this.frameBuilder.build(vis, mode, W, H);
        stats.visMs = stats.visMs * 0.9 + (performance.now() - t0) * 0.1;
        stats.draws = fr.cmds.filter(c => c.op === 'draw').length;
        stats.tris = fr.cmds.reduce((s, c) => s + (c.op === 'draw' ? c.chunk.count / 3 : 0), 0);
        stats.objs = fr.objs.length;
        this.frameStats = fr.stats;
        this.frameMode = mode;

        const lines = this.debugLines.build(vis, o, o.freeze ? this.frozen : null, player.cam.fov);
        R.render({ globals: this.globals(viewProj, eye, t, W, H, mode === 'stencil'), areas: w.lightingTable(t), draws: fr.draws, cmds: fr.cmds, polys: fr.polys, stencil: mode === 'stencil', lines: lines.data, lineDepthCount: lines.depthCount });

        if (o.map) this.minimap.draw(vis);
        this.mapCanvas.style.display = o.map ? 'block' : 'none';
        this.hud.tick(now, vis);
    }

    // Globals uniform: view-projection (+ inverse), eye, sun, sky colours, time, viewport and whether the
    // scene shader fogs through portals (stencil mode)
    globals(viewProj, eye, t, W, H, portalFog) {
        const sc = this.world.scn.outdoor || {}, g = new Float32Array(56);
        g.set(viewProj, 0);
        g.set(m4.invert(viewProj), 16);
        g.set([eye[0], eye[1], eye[2], 1], 32);
        g.set([...v3.norm(sc.sunDir || [0.4, 0.8, 0.3]), 0], 36);
        g.set([...(sc.sunColor || [1.2, 1.1, 1.0]), 1], 40);
        g.set([...(sc.skyTop || [0.3, 0.55, 1.3]), 1], 44);
        g.set([...(sc.skyHorizon || [1.0, 1.15, 1.35]), 1], 48);
        g.set([t, W, H, portalFog ? 1 : 0], 52);
        return g;
    }
}

// ------------------------------------------------------------------------------------- feature world
// This demo as one world of the engine (js/engine/host.js calls these).
const HUD_HTML = `<div data-hud="crosshair"></div><div data-hud="hud" class="panel"></div>
    <canvas data-hud="map" title="Minimap: click to teleport"></canvas>
    <div data-hud="help" class="panel"></div><div data-hud="toast" class="panel"></div>`;

class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = HUD_HTML;
    }

    async init() {
        const g = this.game = new Game(this.fx);
        g.onError = this.fx.fail;
        await g.start();
        g.load(this.fx.native);
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // classic 0..1 depth, near 0.05, far 400; 4x MSAA depth-stencil (the depth aspect)
    depth() {
        const r = this.game.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.05, far: 400, samples: 4 };
    }

    get view() {
        const P = this.game.player, { fwd, up } = P.basis();
        return { pos: [...P.cam.pos], fwd, up, fov: P.cam.fov };
    }

    setView(v) {
        const P = this.game.player, c = P.cam;
        c.pos = [...v.pos];
        c.yaw = Math.atan2(v.fwd[0], -v.fwd[2]);
        c.pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd[1])));
        if (v.fov) c.fov = v.fov;
        P.driving = null;
        P.reset(c.pos);
    }

    stats() {
        const g = this.game, w = g.world, P = g.player, s = g.stats, cam = P.cam.pos;
        const area = w.areas[w.areaAt(cam)], ship = w.vehicles[0];
        return {
            name: w.scn.name, fps: s.fps, area: area.name, outdoor: !!area.outdoor, onShip: !!area.vehicle, state: P.stateLabel,
            swimming: !!P.swimming, driving: !!P.driving, culling: g.opts.culling, mode: g.frameMode, draws: s.draws, tris: s.tris,
            shipSpeed: ship ? ship.v : 0, shipDist: ship ? Math.hypot(ship.M[12] - cam[0], ship.M[14] - cam[2]) : 1e9,
            drones: w.drones.length,
        };
    }

    set(key, v) {
        const o = this.game.opts;
        if (key in o && typeof o[key] === typeof v) o[key] = v;
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
