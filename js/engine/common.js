'use strict';
// Common: the helpers several features (and the engine) share, so each feature script keeps only what is its own.
// A feature takes them from its factory's `engine` ({ Common } = engine); engine scripts use the global.
//
//   scalars      DEG, clamp, sat01, lerp, smoothstep
//   v3, m4       3-vectors as arrays; column-major 4x4 (Float64Array), WebGPU clip space (depth 0..1)
//   yawPitch     the yaw / pitch (radians) of a fly camera looking along a direction
//   random       mulberry32 (seeded generator), hash2 / vnoise / fbm (seeded 2D value noise)
//   polylines    polylineLengths, polylineNearest, polylineBox on [x, z] points
//   GPU          makeBuffer, gridIndices
//   controls     PointerInput (look / act / keys on a world's canvas), TerrainFlyCamera (a free camera over a terrain)
//   screen       Toast (a toast element of a world's HUD), LabelLayer (in-world labels on a 2D canvas)

const Common = (() => {
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sat01 = x => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------------ vectors
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

// --------------------------------------------------------------------------------------------- matrices
// Features add their own (perspective, TRS...) with { ...Common.m4, ... }.
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
    // reversed Z, infinite far plane: depth = near / view distance (1 at the near plane, 0 at infinity)
    reversedInfinite(fovy, aspect, near) {
        const f = 1 / Math.tan(fovy / 2);
        return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
    },
    // view matrix from the eye and its basis (rows: right, up, back)
    view(eye, r, u, f) {
        const b = [-f[0], -f[1], -f[2]];
        return new Float64Array([r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0,
            -v3.dot(r, eye), -v3.dot(u, eye), -v3.dot(b, eye), 1]);
    },
    lookAt(eye, target, up) {
        const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
        return new Float64Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1]);
    },
    // a point to clip space: [x, y, z, w]
    project(m, p) {
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]];
    },
    // the inverse; the identity when `a` is singular
    invert(a) {
        const o = new Float64Array(16);
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det) return m4.identity();
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

// a fly camera (forward = [-sin yaw cos pitch, sin pitch, -cos yaw cos pitch]) looking along d
const yawPitch = d => ({ yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(clamp(d[1], -1, 1)) });

// ------------------------------------------------------------------------------------------------- random
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// value noise in [-1, 1]
function vnoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

// fractal noise in about [-1, 1]; ridged gives sharp crests in [0, 1]
function fbm(x, y, { octaves = 5, seed = 1, ridged = false, gain = 0.5 } = {}) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
        const n = vnoise(x * f + o * 17.3, y * f - o * 9.1, seed + o * 31);
        sum += (ridged ? 1 - Math.abs(n) : n) * amp;
        norm += amp;
        amp *= gain;
        f *= 2.03;
    }
    return sum / norm;
}

// ----------------------------------------------------------------------------------------------- polylines
// arc length at each point
function polylineLengths(pts) {
    const lens = [0];
    for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return lens;
}

// nearest point on a polyline: { dist, s (arc length at that point) }
function polylineNearest(pts, lens, x, z) {
    let best = Infinity, bs = 0;
    for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
        const px = ax + dx * t - x, pz = az + dz * t - z, d = px * px + pz * pz;
        if (d < best) { best = d; bs = lens[k] + t * Math.sqrt(l2); }
    }
    return { dist: Math.sqrt(best), s: bs };
}

// [x0, z0, x1, z1] around the points, `pad` wider
function polylineBox(pts, pad) {
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    return [Math.min(...xs) - pad, Math.min(...zs) - pad, Math.max(...xs) + pad, Math.max(...zs) + pad];
}

// ------------------------------------------------------------------------------------------------------ GPU
function makeBuffer(device, size, usage, data) {
    const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, mappedAtCreation: !!data });
    if (data) { new data.constructor(b.getMappedRange()).set(data); b.unmap(); }
    return b;
}

// two triangles per cell of a w x w vertex grid
function gridIndices(w) {
    const idx = new Uint32Array((w - 1) * (w - 1) * 6);
    let o = 0;
    for (let j = 0; j < w - 1; j++) for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    return idx;
}

// ---------------------------------------------------------------------------------------------- controls
// Pointer and keys over a world's canvas (io: its InputRouter scope): left drag looks; the right button (or Ctrl + left)
// acts, `acting` while held and once per press in consume().clicks.
class PointerInput {
    constructor(io) {
        const el = io.canvas;
        this.el = el;
        this.keys = new Set();
        this.pressed = [];
        this.dx = this.dy = this.wheel = 0;
        this.mouse = [0, 0];
        this.looking = false;
        this.acting = false;
        this.clicks = [];
        io.listen(el, 'contextmenu', e => e.preventDefault());
        io.listen(el, 'pointerdown', e => {
            el.setPointerCapture(e.pointerId);
            if (e.button === 2 || (e.button === 0 && e.ctrlKey)) { this.acting = true; this.clicks.push([e.clientX, e.clientY]); }
            else if (e.button === 0) { this.looking = true; el.classList.add('drag'); }
        });
        io.listen(el, 'pointermove', e => {
            this.mouse = [e.clientX, e.clientY];
            if (this.looking) { this.dx += e.movementX; this.dy += e.movementY; }
        });
        const up = () => { this.looking = this.acting = false; el.classList.remove('drag'); };
        io.listen(el, 'pointerup', up);
        io.listen(el, 'pointercancel', up);
        io.listen(el, 'wheel', e => { e.preventDefault(); this.wheel += Math.sign(e.deltaY); }, { passive: false });
        io.listen(window, 'keydown', e => {
            if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
            if (!e.repeat) this.pressed.push(e.code);
            this.keys.add(e.code);
        });
        io.listen(window, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => { this.keys.clear(); up(); });
    }

    // what happened since the last call
    consume() {
        const r = { dx: this.dx, dy: this.dy, wheel: this.wheel, pressed: this.pressed, clicks: this.clicks };
        this.dx = this.dy = this.wheel = 0;
        this.pressed = [];
        this.clicks = [];
        return r;
    }
}

// A free camera over a terrain: WASD, Space / C, Shift faster, Alt slower, the wheel sets the speed; it stays
// `clearance` m above field.sample(x, z) and below `ceiling`.
class TerrainFlyCamera {
    constructor({ pos = [0, 200, 0], speed = 80, wheelStep = 1.2, minSpeed = 2, maxSpeed = 2000, clearance = 2, ceiling = Infinity } = {}) {
        this.pos = [...pos];
        this.yaw = 0;
        this.pitch = 0;
        this.fov = 60 * DEG;
        this.speed = speed;
        this.cfg = { wheelStep, minSpeed, maxSpeed, clearance, ceiling };
    }

    basis() {
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const fwd = [-sy * cp, sp, -cy * cp], right = [cy, 0, -sy];
        return { fwd, right, up: v3.cross(right, fwd) };
    }

    lookAt(target) {
        Object.assign(this, yawPitch(v3.norm(v3.sub(target, this.pos))));
    }

    // io: input.consume()
    update(dt, io, input, field) {
        const c = this.cfg;
        this.yaw -= io.dx * 0.0025;
        this.pitch = clamp(this.pitch - io.dy * 0.0025, -1.55, 1.55);
        if (io.wheel) this.speed = clamp(this.speed * Math.pow(c.wheelStep, -io.wheel), c.minSpeed, c.maxSpeed);
        const k = input.keys, { fwd, right } = this.basis();
        let m = [0, 0, 0];
        if (k.has('KeyW')) m = v3.add(m, fwd);
        if (k.has('KeyS')) m = v3.sub(m, fwd);
        if (k.has('KeyD')) m = v3.add(m, right);
        if (k.has('KeyA')) m = v3.sub(m, right);
        if (k.has('Space')) m[1] += 1;
        if (k.has('KeyC')) m[1] -= 1;
        const mul = (k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1) * (k.has('AltLeft') ? 0.2 : 1);
        this.pos = v3.add(this.pos, v3.mul(m, this.speed * mul * dt));
        this.pos[1] = clamp(this.pos[1], field.sample(this.pos[0], this.pos[2]) + c.clearance, c.ceiling);
    }

    // world-space direction through canvas pixel (mx, my) of a w x h canvas
    ray(mx, my, w, h) {
        const { fwd, right, up } = this.basis(), t = Math.tan(this.fov / 2), a = w / h;
        const x = (mx / w * 2 - 1) * t * a, y = (1 - my / h * 2) * t;
        return v3.norm(v3.add(fwd, v3.add(v3.mul(right, x), v3.mul(up, y))));
    }
}

// --------------------------------------------------------------------------------------------------- screen
// a world's toast: shown for `ms` (kept up when ms <= 0)
class Toast {
    constructor(el) { this.el = el; }

    show(msg, ms = 2200) {
        this.el.textContent = msg;
        this.el.style.display = 'block';
        clearTimeout(this.timer);
        if (ms > 0) this.timer = setTimeout(() => { this.el.style.display = 'none'; }, ms);
    }
}

// in-world labels on a 2D canvas over the world: begin() sizes and clears it, place() projects a point, mark() draws one
class LabelLayer {
    constructor(canvas) {
        this.canvas = canvas;
        this.g = canvas.getContext('2d');
        this.W = this.H = 0;
        this.dpr = 1;
    }

    begin() {
        const c = this.canvas, dpr = this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = this.W = Math.floor(c.clientWidth * dpr), H = this.H = Math.floor(c.clientHeight * dpr);
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        this.g.clearRect(0, 0, W, H);
        return this.g;
    }

    // ready to write labels: 11 px monospace, vertically centred
    font() {
        this.g.font = `${11 * this.dpr}px 'Share Tech Mono', monospace`;
        this.g.textBaseline = 'middle';
    }

    // canvas pixel [x, y] of world point p under viewProj, or null behind the eye or well off the screen
    place(viewProj, p) {
        const clip = m4.project(viewProj, p);
        if (clip[3] <= 0) return null;
        const x = (clip[0] / clip[3] * 0.5 + 0.5) * this.W, y = (0.5 - clip[1] / clip[3] * 0.5) * this.H;
        return x < -50 || x > this.W + 50 || y < -20 || y > this.H + 20 ? null : [x, y];
    }

    // a diamond at [x, y] and the text to its right
    mark([x, y], color, text) {
        const g = this.g, dpr = this.dpr;
        g.strokeStyle = g.fillStyle = color;
        g.lineWidth = dpr;
        g.beginPath();
        g.moveTo(x, y - 4 * dpr); g.lineTo(x + 4 * dpr, y); g.lineTo(x, y + 4 * dpr); g.lineTo(x - 4 * dpr, y); g.closePath();
        g.stroke();
        g.fillText(text, x + 8 * dpr, y);
    }
}

return {
    DEG, clamp, sat01, lerp, smoothstep, v3, m4, yawPitch, mulberry32, hash2, vnoise, fbm,
    polylineLengths, polylineNearest, polylineBox, makeBuffer, gridIndices, PointerInput, TerrainFlyCamera, Toast, LabelLayer,
};
})();
