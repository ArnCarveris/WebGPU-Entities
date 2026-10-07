'use strict';
// Math and small helpers: V3 / M4, easing, colours, layout and text formats, hit regions.

Features.kit('gui', (engine, kit) => {
// Math helpers. Matrices are column-major Float32Arrays; projection uses WebGPU clip-space depth [0, 1].

const V3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    length: (a) => Math.hypot(a[0], a[1], a[2]),
    normalize: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
};

const M4 = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    translation: (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
    rotationX: (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
    },
    rotationY: (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
    rotationZ: (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },
    // Object-to-world for something at `pos` whose local -Z looks along `fwd`
    facing: (pos, fwd) => {
        const r = V3.normalize(V3.cross(fwd, [0, 1, 0]));
        const u = V3.cross(r, fwd);
        return new Float32Array([...r, 0, ...u, 0, -fwd[0], -fwd[1], -fwd[2], 0, pos[0], pos[1], pos[2], 1]);
    },
    // Translation + yaw about Y: the placement used by scenario entities
    placement: (pos, yaw = 0) => M4.multiply(M4.translation(pos[0], pos[1], pos[2]), M4.rotationY(yaw)),
    multiply: (a, b) => {
        const out = new Float32Array(16);
        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
                out[col * 4 + row] = sum;
            }
        }
        return out;
    },
    chain: (...ms) => ms.reduce((acc, m) => M4.multiply(acc, m)),
    perspective: (fovy, aspect, near, far) => {
        const f = 1.0 / Math.tan(fovy / 2);
        const rangeInv = 1.0 / (near - far);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, far * rangeInv, -1,
            0, 0, far * near * rangeInv, 0
        ]);
    },
    lookAt: (eye, center, up) => {
        let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
        let len = 1 / Math.hypot(z0, z1, z2);
        z0 *= len; z1 *= len; z2 *= len;
        let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
        len = Math.hypot(x0, x1, x2) || 1;
        x0 /= len; x1 /= len; x2 /= len;
        const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
        return new Float32Array([
            x0, y0, z0, 0,
            x1, y1, z1, 0,
            x2, y2, z2, 0,
            -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
            -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
            -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
            1
        ]);
    },
    // View-projection for an eye looking along `dir`
    viewProjection: (eye, dir, up, fovy, aspect, near, far) =>
        M4.multiply(M4.perspective(fovy, aspect, near, far), M4.lookAt(eye, V3.add(eye, dir), up)),
    transformPoint: (m, p) => [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
    ],
    transformVector: (m, v) => [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2]
    ]
};

const { clamp, lerp } = Common;
const smooth01 = (x) => x * x * (3 - 2 * x);
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const wrapIndex = (i, n) => ((i % n) + n) % n;
const deg = (rad) => (rad * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;

// Colours: palette entries are 0..255 RGB; GUI vertices take 0..1 RGBA
const col = (c, a = 1) => [c[0] / 255, c[1] / 255, c[2] / 255, a];
const mixRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Layout / formatting
function fitRect(R, aspect) {
    let w = R.w, h = R.w / aspect;
    if (h > R.h) { h = R.h; w = R.h * aspect; }
    return { x: R.x + (R.w - w) / 2, y: R.y + (R.h - h) / 2, w, h };
}
const timeText = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
const clipTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const pad3 = (n) => String(Math.round(n) % 360).padStart(3, '0');
const cardinal = (degrees) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(wrapIndex(degrees, 360) / 45) % 8];
// Compass bearing of a horizontal direction: 0 = north (-Z), clockwise
const bearingOf = (dx, dz) => wrapIndex(deg(Math.atan2(dx, -dz)), 360);

function hitIn(list, cursor) {
    const { x, y } = cursor;
    return list.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
}

return { V3, M4, clamp, lerp, smooth01, easeOutBack, easeOutCubic, wrapIndex, deg, rad, col, mixRGB, fitRect, timeText, clipTime, pad3, cardinal, bearingOf, hitIn };
});
