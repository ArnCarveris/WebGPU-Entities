'use strict';
// Curvature: a round planet's surface out of a flat world, O(1) per point. The world stays flat: its heightfield, its
// clouds, weather and shadow maps, its lighting and every simulation keep their x, y, z. Only what the eye sees is bent:
// a world point at horizontal distance rho from the eye and height y is drawn where it would be on a sphere through
// the eye, rho along its surface (an azimuthal equidistant map about the eye, so nothing near the eye moves and no
// length along the ground changes), y over it. The far ground and the cloud deck fall away below the eye's level and
// meet at a true horizon, at sqrt(2 R h) for an eye h over the ground.
//
//   toRender(p)   world -> drawn (vertices: the terrain grid, structures, bolts...)
//   toWorld(r)    drawn -> world, its exact inverse (a view ray's samples: the cloud march, the froxels, picking)
//   bounds(lo, hi) a world box's bounds as drawn (culling: the outdoor quadtree, ray-box tests)
//   span(dir, yLo, yHi)  where a view ray is between two world heights (two concentric spheres as drawn)
//   horizonDip()  how far (rad) the horizon lies below the eye's level; skyward(dir) a direction's height over it
//
// Every formula is relative to the eye and written so nothing subtracts two numbers the size of the planet's radius:
// it holds to the millimetre near the eye in f32 on the GPU. The sphere's centre is K = R + (eye height over the
// reference) below the eye, so each world height is one shell about it.
//
// The `curvature` entity (optional, one per world; the outdoors only: indoor areas stay as they are, a few metres from
// the eye): { radius (m, default the Earth's), on (default true), reference (m: the height the radius is measured from,
// default the terrain's base) }. A world without one has a Curvature that is off (the handheld can turn it on).
//
// CurvatureWGSL(U, viewProj): the same functions for a shader whose uniform U has a vec4f `curve` (gpu(): K, on, the
// terrain's reach, R): curveOn, curveOffset, curveToRender, curveToWorld, curveClip (a vertex's clip position, from
// its world position and the flat projection's), curveShell, curveSpan, curveBox.

Features.kit('curvature', (engine, kit) => {

const EARTH = 6371000;
const FLAT_REACH = 260000;          // how far a flat world's terrain grid reaches (the atmosphere's)

// sin(x) / x - 1, without the cancellation near 0
const sincm1 = x => {
    const x2 = x * x;
    return x2 < 0.01 ? x2 * (-1 / 6 + x2 * (1 / 120 - x2 / 5040)) : Math.sin(x) / x - 1;
};

class Curvature {
    // def: the scenario's `curvature` entity, or nothing (off); reference: its default (the terrain's base)
    constructor(def, reference = 0) {
        this.def = def || null;
        this.radius = Math.max(def?.radius ?? EARTH, 1000);
        this.on = !!def && def.on !== false;
        this.reference = def?.reference ?? reference;
        this.setEye([0, reference, 0]);
    }

    // how curved, as a slider takes it: 0 flat, else 0 .. 1 on a log scale of the curvature from 0.1 x to 50 x the
    // Earth's (the Earth at 1 / 2.7); setAmount turns it off at 0 and sets the radius
    get amount() { return this.on ? Math.min(Math.max((Math.log10(EARTH / this.radius) + 1) / 2.7, 0.001), 1) : 0; }
    setAmount(s) {
        this.on = s > 0.0005;
        if (this.on) this.radius = EARTH / Math.pow(10, -1 + 2.7 * Math.min(s, 1));
        this.setEye(this.eye);
    }
    // the slider's readout
    describe(s = this.amount) {
        if (s <= 0.0005) return 'flat';
        const m = Math.pow(10, -1 + 2.7 * Math.min(s, 1)), R = EARTH / m;
        return `${m < 0.995 || m > 1.005 ? `${m.toFixed(m < 10 ? 2 : 0)}× Earth` : 'Earth'} · R ${R >= 1e6 ? `${(R / 1e6).toFixed(2)}k` : (R / 1000).toFixed(0)} km`;
    }

    // the eye this frame: the sphere passes through it
    setEye(eye) {
        this.eye = [eye[0], eye[1], eye[2]];
        this.K = this.radius + Math.max(eye[1] - this.reference, -0.5 * this.radius);
    }

    // how far the eye sees the ground (m): to the horizon over the reference, and over that to whatever stands up to
    // `top` m over it (a mountain, a cloud top); a flat world's terrain reach when off
    horizon(top = 0) {
        if (!this.on) return FLAT_REACH;
        const R = this.radius, h = Math.max(this.eye[1] - this.reference, 1);
        return Math.sqrt(h * (2 * R + h)) + Math.sqrt(Math.max(top, 0) * (2 * R + top));
    }

    // how high p is over the reference (m): over the sphere when on, measured from its centre (below the world's origin),
    // so it holds however far p is
    altitude(p) {
        const h = p[1] - this.reference;
        return this.on ? Math.hypot(p[0], this.radius + h, p[2]) - this.radius : h;
    }

    // how far below the eye's level the horizon of the reference lies (rad): acos(R / K); 0 off, or under the reference
    horizonDip() {
        if (!this.on || this.K <= this.radius) return 0;
        return Math.atan2(Math.sqrt((this.K - this.radius) * (this.K + this.radius)), this.radius);
    }

    // world p -> drawn: p plus offset(p)
    offset(p) {
        if (!this.on) return [0, 0, 0];
        const e = this.eye, K = this.K, qx = p[0] - e[0], qy = p[1] - e[1], qz = p[2] - e[2];
        const rho = Math.hypot(qx, qz), th = rho / K, s = 1 + qy / K, half = 1 + sincm1(th / 2), h = sincm1(th) * s + qy / K;
        return [qx * h, -s * rho * rho / (2 * K) * half * half, qz * h];
    }
    toRender(p) { const o = this.offset(p); return [p[0] + o[0], p[1] + o[1], p[2] + o[2]]; }

    // drawn r -> world (toRender's inverse)
    toWorld(r) {
        if (!this.on) return [r[0], r[1], r[2]];
        const e = this.eye, K = this.K, qx = r[0] - e[0], qy = r[1] - e[1], qz = r[2] - e[2];
        const H = Math.hypot(qx, qz), a = K + qy, len = Math.hypot(H, a);
        const dy = (H * H + qy * qy + 2 * K * qy) / (len + K);              // len - K, stably
        const k = H > 1e-3 ? Math.atan2(H, a) * K / H : K / a;              // arc over chord
        return [e[0] + qx * k, e[1] + dy, e[2] + qz * k];
    }

    // the drawn bounds of the world box [lo, hi] (into outLo / outHi): it drops most at its far corner, least at its
    // near one; it moves sideways by at most its far corner's horizontal offset. O(1)
    bounds(lo, hi, outLo = [0, 0, 0], outHi = [0, 0, 0]) {
        if (!this.on) {
            for (let k = 0; k < 3; k++) { outLo[k] = lo[k]; outHi[k] = hi[k]; }
            return [outLo, outHi];
        }
        const e = this.eye, K = this.K;
        const far = Math.hypot(Math.max(Math.abs(lo[0] - e[0]), Math.abs(hi[0] - e[0])), Math.max(Math.abs(lo[2] - e[2]), Math.abs(hi[2] - e[2])));
        const near = Math.hypot(Math.max(lo[0] - e[0], e[0] - hi[0], 0), Math.max(lo[2] - e[2], e[2] - hi[2], 0));
        const sLo = 1 + (lo[1] - e[1]) / K, sHi = 1 + (hi[1] - e[1]) / K;
        const drop = (rho, s) => { const half = 1 + sincm1(rho / (2 * K)); return s * rho * rho / (2 * K) * half * half; };
        const side = far * (Math.abs(sincm1(far / K)) * Math.max(sLo, sHi) + Math.max(Math.abs(lo[1] - e[1]), Math.abs(hi[1] - e[1])) / K) + 0.01;
        outLo[0] = lo[0] - side; outLo[1] = lo[1] - drop(far, Math.max(sLo, sHi)) - 0.01; outLo[2] = lo[2] - side;
        outHi[0] = hi[0] + side; outHi[1] = hi[1] - drop(near, Math.min(sLo, sHi)) + 0.01; outHi[2] = hi[2] + side;
        return [outLo, outHi];
    }

    // the frame uniform's vec4 (CurvatureWGSL): the eye's sphere, on, how far the terrain is drawn, the planet's radius
    gpu(top = 0) { return [this.K, this.on ? 1 : 0, Math.min(Math.max(this.horizon(top) * 1.1, FLAT_REACH), 4e6), this.radius]; }
}

// The shader side: U (the uniform holding `curve`, gpu()'s vec4 and the eye: `cam`) and viewProj (an expression for the
// flat view-projection, column-major as m4)
const CurvatureWGSL = (U = 'F', viewProj = `${U}.viewProj`) => /* wgsl */`
fn curveOn() -> bool { return ${U}.curve.y > 0.5; }
fn curveSincM1(x: f32) -> f32 {
    let x2 = x * x;
    if (x2 < 0.01) { return x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 - x2 / 5040.0)); }
    return sin(x) / x - 1.0;
}

// where world point p is drawn, less p
fn curveOffset(p: vec3f) -> vec3f {
    if (${U}.curve.y < 0.5) { return vec3f(0.0); }
    let K = ${U}.curve.x;
    let q = p - ${U}.cam.xyz;
    let rho = length(q.xz);
    let s = 1.0 + q.y / K;
    let half = 1.0 + curveSincM1(rho / (2.0 * K));
    let h = curveSincM1(rho / K) * s + q.y / K;
    return vec3f(q.x * h, -s * rho * rho / (2.0 * K) * half * half, q.z * h);
}
fn curveToRender(p: vec3f) -> vec3f { return p + curveOffset(p); }

// the world point drawn at r (a point of a view ray)
fn curveToWorld(r: vec3f) -> vec3f {
    if (${U}.curve.y < 0.5) { return r; }
    let K = ${U}.curve.x;
    let q = r - ${U}.cam.xyz;
    let H = length(q.xz);
    let a = K + q.y;
    let len = sqrt(H * H + a * a);
    let dy = (H * H + q.y * q.y + 2.0 * K * q.y) / (len + K);
    let k = select(K / a, atan2(H, a) * K / H, H > 1e-3);
    return ${U}.cam.xyz + vec3f(q.x * k, dy, q.z * k);
}

// a vertex's clip position: clip is the flat projection of world point p (the matrix it was drawn with, whatever frame
// it was built in), moved by p's offset
fn curveClip(clip: vec4f, p: vec3f) -> vec4f {
    if (${U}.curve.y < 0.5) { return clip; }
    return clip + ${viewProj} * vec4f(curveOffset(p), 0.0);
}

// the distances along the view ray dir (from the eye) to the shell of world height y, nearest first; x > y if it misses
fn curveShell(dir: vec3f, y: f32) -> vec2f {
    let K = ${U}.curve.x;
    let h = y - ${U}.cam.y;
    let b = K * dir.y;
    let c = -h * (2.0 * K + h);
    let disc = b * b - c;
    if (disc < 0.0) { return vec2f(1.0, -1.0); }
    let q = -b - select(-1.0, 1.0, b >= 0.0) * sqrt(disc);
    if (abs(q) < 1e-6) { return vec2f(0.0); }
    let r0 = q;
    let r1 = c / q;
    return vec2f(min(r0, r1), max(r0, r1));
}

// [t0, t1] of the view ray between world heights yLo and yHi, up to tMax (the first stretch: past the lower shell is
// under the ground); t1 < t0 where it misses
fn curveSpan(dir: vec3f, yLo: f32, yHi: f32, tMax: f32) -> vec2f {
    let o = curveShell(dir, yHi);
    if (o.x > o.y || o.y < 0.0) { return vec2f(0.0, -1.0); }
    var t0 = max(o.x, 0.0);
    var t1 = min(o.y, tMax);
    let i = curveShell(dir, yLo);
    if (i.x <= i.y && i.y > 0.0) {
        if (${U}.cam.y > yLo) { t1 = min(t1, i.x); } else { t0 = max(t0, i.y); }
    }
    return vec2f(t0, t1);
}

// how far below the eye's level the horizon lies (rad, as Curvature.horizonDip); a direction's sine of elevation over
// that horizon (what the sky's gradient, the stars' fade, take for dir.y: the sky meets the ground where it is drawn)
fn curveHorizonDip() -> f32 {
    let K = ${U}.curve.x;
    let R = ${U}.curve.w;
    if (${U}.curve.y < 0.5 || K <= R) { return 0.0; }
    return atan2(sqrt((K - R) * (K + R)), R);
}
fn curveSkyward(dir: vec3f) -> f32 {
    let dip = curveHorizonDip();
    if (dip <= 0.0) { return dir.y; }
    return sin(min(asin(clamp(dir.y, -1.0, 1.0)) + dip, 1.5707963));
}

// the drawn bounds of the world box [lo, hi] (as Curvature.bounds)
struct CurveBox { lo: vec3f, hi: vec3f };
fn curveBox(lo: vec3f, hi: vec3f) -> CurveBox {
    if (${U}.curve.y < 0.5) { return CurveBox(lo, hi); }
    let K = ${U}.curve.x;
    let e = ${U}.cam.xyz;
    let far = length(max(abs(lo.xz - e.xz), abs(hi.xz - e.xz)));
    let near = length(max(max(lo.xz - e.xz, e.xz - hi.xz), vec2f(0.0)));
    let sLo = 1.0 + (lo.y - e.y) / K;
    let sHi = 1.0 + (hi.y - e.y) / K;
    let hf = 1.0 + curveSincM1(far / (2.0 * K));
    let hn = 1.0 + curveSincM1(near / (2.0 * K));
    let side = far * (abs(curveSincM1(far / K)) * max(sLo, sHi) + max(abs(lo.y - e.y), abs(hi.y - e.y)) / K) + 0.01;
    return CurveBox(vec3f(lo.x - side, lo.y - max(sLo, sHi) * far * far / (2.0 * K) * hf * hf - 0.01, lo.z - side),
                    vec3f(hi.x + side, hi.y - min(sLo, sHi) * near * near / (2.0 * K) * hn * hn + 0.01, hi.z + side));
}
`;

return { Curvature, CurvatureWGSL, EARTH };
});
