'use strict';
// Entity GUI, as a feature of WebGPU Entities: Doom 3-style world-space GUIs (an airlock terminal with CCTV, a paint
// easel, a handheld debug phone with radar, camera, gallery and IPTV) in a facility built from data. The engine is the
// one from the WebGPU-EntityGUI demo (its js/ files, in load order); the host (js/engine/host.js) gives it its device,
// canvas target and input, and builds its scenario from entities ("gui.*", see js/engine/scenario-format.js).

Features.define('gui', (engine) => {
const { GpuChoice } = engine;

// ------------------------------------------------------------------------------------------------- js/core/math.js
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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
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

// ------------------------------------------------------------------------------------------------ js/core/audio.js
// Sound effects as events of this world (door, step, shutter, chime, key, tap...): what each one sounds like is
// scenario data (sound.cue entities, synthesised by the engine's AudioEngine).

class AudioSystem {
    constructor(fx) {
        this.fx = fx;
        this.enabled = true;            // the phone's sound switch
        this.stepVolume = 0.7;
    }

    emit(name, payload = {}) { if (this.enabled) this.fx.emit(name, payload); }
    later(ms, fn) { setTimeout(fn, ms); }

    door() { this.emit('door'); }
    step(run) { if (this.stepVolume > 0) this.emit('step', { run, vol: this.stepVolume }); }
    shutter() { this.emit('shutter'); }
    chime(up) { this.emit('chime', { up }); }
}

// ------------------------------------------------------------------------------------------ js/render/materials.js
// World materials as data. The scenario's `materials` block is packed into a storage buffer that the
// scene shader indexes with the per-vertex material id; a material picks a procedural pattern (surface
// detail around its albedo) and an emission signal (what drives its glow over time).

// Patterns implemented by pattern() in the scene shader. `args` are the defaults for the material's `args`.
const MATERIAL_PATTERNS = Object.freeze({
    flat:    { id: 0, args: [] },
    panels:  { id: 1, args: [] },                       // wall panels with rivets and a wainscot stripe
    grating: { id: 2, args: [5, 0.02] },                // holes per metre, hole specular
    mottled: { id: 3, args: [4, 2, 0.75, 0.35] },       // cells per metre x/y, brightness min, variation
    plates:  { id: 4, args: [2, 0.8, 0.4, 0.6] },       // plates per metre, brightness min, variation, seam depth
    door:    { id: 5, args: [] },                       // sliding door panels with hazard ends
    tiles:   { id: 6, args: [1, 0.6] },                 // tiles per metre, seam depth
    hazard:  { id: 7, args: [2.5] },                    // stripes per metre (albedo = stripe colour)
    bands:   { id: 8, args: [4, 0.5] },                 // bands per metre, seam depth
    wood:    { id: 9, args: [] }                        // wood grain
});

// Emission signals implemented by signal() in the scene shader; emission = color * (base + gain * s)
const MATERIAL_SIGNALS = Object.freeze({
    constant: 0,    // s = 0
    wave: 1,        // s = sin(time * rate)
    blink: 2,       // s = step(duty, fract(time * rate + uv.x * spread))
    alarm: 3,       // s = alarm pulse (facility alarm)
    light0: 4       // s = first light's intensity; the colour is also tinted by that light
});

const MATERIAL_FLOATS = 20;        // 5 x vec4, see struct MaterialDef in shaders.js

// def: { pattern?, args?, albedo: [r, g, b], spec?, shin?,
//        emissive?: { color: [r, g, b], signal?, base?, gain?, rate?, spread?, duty?, idle? } }
// `idle` makes the emission react to the instance's "selected" flag: idle level when not selected.
class MaterialTable {
    constructor(defs) {
        this.names = Object.keys(defs);
        this.ids = new Map(this.names.map((name, i) => [name, i]));
        this.data = new Float32Array(Math.max(1, this.names.length) * MATERIAL_FLOATS);
        this.names.forEach((name, i) => this.data.set(MaterialTable.pack(name, defs[name]), i * MATERIAL_FLOATS));
    }

    id(name) {
        const id = this.ids.get(name);
        if (id === undefined) throw new Error(`Unknown material "${name}"`);
        return id;
    }

    static pack(name, def) {
        const pattern = MATERIAL_PATTERNS[def.pattern || 'flat'];
        if (!pattern) throw new Error(`Material "${name}": unknown pattern "${def.pattern}"`);
        const e = def.emissive || { color: [0, 0, 0] };
        const signal = MATERIAL_SIGNALS[e.signal || 'constant'];
        if (signal === undefined) throw new Error(`Material "${name}": unknown signal "${e.signal}"`);
        const args = [0, 1, 2, 3].map((i) => (def.args && def.args[i] !== undefined ? def.args[i] : pattern.args[i]) || 0);
        const albedo = def.albedo || [0.3, 0.3, 0.3];
        return [
            ...albedo, pattern.id,
            ...e.color, signal,
            def.spec ?? 0.3, def.shin ?? 32, e.idle ?? -1, e.duty ?? 0.5,
            e.base ?? 1, e.gain ?? 0, e.rate ?? 1, e.spread ?? 0,
            ...args
        ];
    }
}

// ------------------------------------------------------------------------------------------- js/render/geometry.js
// Mesh building and the Doom 3 GUI-surface mapping.

// Vertex layout: pos3 normal3 uv2 material1. UVs are planar and world-scaled (1 unit = 1 m).
// Material names resolve to ids through the world MaterialTable.
class MeshBuilder {
    constructor(materials) {
        this.materials = materials;
        this.data = [];
    }

    vertex(p, n, uv, m) {
        this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], m);
    }

    box(x0, y0, z0, x1, y1, z1, mat) {
        const m = this.materials.id(mat);
        const faces = [
            [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
            [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
            [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
            [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
            [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
            [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]]
        ];
        for (const [n, c] of faces) {
            const uvOf = (p) => n[0] ? [p[2], p[1]] : n[1] ? [p[0], p[2]] : [p[0], p[1]];
            for (const i of [0, 1, 2, 0, 2, 3]) this.vertex(c[i], n, uvOf(c[i]), m);
        }
        return this;
    }

    cylinder(center, radius, length, axis, mat, segments = 16) {
        const m = this.materials.id(mat);
        const place = (u, v, along) => axis === 'x' ? [along, u, v] : axis === 'y' ? [u, along, v] : [u, v, along];
        const h = length / 2;
        for (let i = 0; i < segments; i++) {
            const ring = [i, i + 1].map((k) => {
                const a = (k / segments) * Math.PI * 2;
                return { n: place(Math.cos(a), Math.sin(a), 0), off: place(Math.cos(a) * radius, Math.sin(a) * radius, 0), u: a * radius };
            });
            const corner = (r, along) => V3.add(V3.add(center, r.off), place(0, 0, along));
            const quad = [[ring[0], -h], [ring[1], -h], [ring[1], h], [ring[0], h]];
            for (const i of [0, 1, 2, 0, 2, 3]) {
                const [r, along] = quad[i];
                this.vertex(corner(r, along), r.n, [r.u, along], m);
            }
        }
        return this;
    }

    // The two triangles of a GUI surface; their texture coordinates define the GUI frame
    surface(tri, mat) {
        const m = this.materials.id(mat);
        const { xyz, st, normal, corner } = tri;
        for (const [p, uv] of [[xyz[0], st[0]], [xyz[1], st[1]], [xyz[2], st[2]], [xyz[0], st[0]], [xyz[2], st[2]], [corner, [0, 1]]]) {
            this.vertex(p, normal, uv, m);
        }
        return this;
    }

    // Data-driven parts: { box: [x0, y0, z0, x1, y1, z1], mat } or
    //                    { cylinder: [cx, cy, cz], r, len, axis, mat, seg? }
    parts(list) {
        for (const part of list) {
            if (part.box) this.box(...part.box, part.mat);
            else if (part.cylinder) this.cylinder(part.cylinder, part.r, part.len, part.axis, part.mat, part.seg);
            else throw new Error(`Unknown model part ${JSON.stringify(part)}`);
        }
        return this;
    }

    toFloat32() {
        return new Float32Array(this.data);
    }
}

// Doom 3 gui surfaces (ports of R_SurfaceToTextureAxis / R_RenderGuiSurf / idRenderWorld::GuiTrace)
const GuiSurface = {
    // A GUI surface triangle in local space. s runs right, t runs down, (0,0) = top-left.
    tri(w, h, z = 0) {
        return {
            xyz: [[-w / 2, h / 2, z], [w / 2, h / 2, z], [w / 2, -h / 2, z]],
            st: [[0, 0], [1, 0], [1, 1]],
            normal: [0, 0, 1],
            corner: [-w / 2, -h / 2, z]
        };
    },

    // The surface's texture-space origin and axes, so that xyz = origin + s * axis[0] + t * axis[1]
    textureAxis(tri) {
        const [a, b, c] = tri.xyz;
        const [sa, sb, sc] = tri.st;
        const d0 = [...V3.sub(b, a), sb[0] - sa[0], sb[1] - sa[1]];
        const d1 = [...V3.sub(c, a), sc[0] - sa[0], sc[1] - sa[1]];
        const inva = 1 / (d0[3] * d1[4] - d0[4] * d1[3]);
        const axis0 = [0, 1, 2].map((i) => (d0[i] * d1[4] - d0[4] * d1[i]) * inva);
        const axis1 = [0, 1, 2].map((i) => (d0[3] * d1[i] - d0[i] * d1[3]) * inva);
        const origin = [0, 1, 2].map((i) => a[i] - sa[0] * axis0[i] - sa[1] * axis1[i]);
        return { origin, axis: [axis0, axis1, tri.normal] };
    },

    // GUI (x, y) in its virtual screen -> surface local space, then through the surface's model matrix
    modelMatrix(tri, surfaceModel, vw, vh) {
        const { origin, axis } = GuiSurface.textureAxis(tri);
        return M4.multiply(surfaceModel, new Float32Array([
            axis[0][0] / vw, axis[0][1] / vw, axis[0][2] / vw, 0,
            axis[1][0] / vh, axis[1][1] / vh, axis[1][2] / vh, 0,
            axis[2][0], axis[2][1], axis[2][2], 0,
            origin[0], origin[1], origin[2], 1
        ]));
    },

    // Ray vs surface -> GUI cursor position and hit distance, or null
    trace(tri, surfaceModel, vw, vh, rayOrigin, rayDir) {
        const { origin, axis } = GuiSurface.textureAxis(tri);
        const o = M4.transformPoint(surfaceModel, origin);
        const a0 = M4.transformVector(surfaceModel, axis[0]);
        const a1 = M4.transformVector(surfaceModel, axis[1]);
        const n = M4.transformVector(surfaceModel, axis[2]);
        const denom = V3.dot(rayDir, n);
        if (denom >= -1e-6) return null; // back-facing
        const t = V3.dot(V3.sub(o, rayOrigin), n) / denom;
        if (t <= 0) return null;
        const hit = V3.sub(V3.add(rayOrigin, V3.scale(rayDir, t)), o);
        const x = V3.dot(hit, a0) / V3.dot(a0, a0);
        const y = V3.dot(hit, a1) / V3.dot(a1, a1);
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: x * vw, y: y * vh, t };
    }
};

// -------------------------------------------------------------------------------------------- js/render/shaders.js
// WGSL sources.

// Scene + GUI shader. Bind group 0: view uniforms, per-instance data, sampler, GUI material texture,
// world material table.
const SCENE_SHADER = /* wgsl */`
    struct Light { pos : vec4f, color : vec4f };   // pos.w = intensity
    struct Globals {
        viewProj : mat4x4f,
        camPos   : vec4f,
        params   : vec4f,                           // x time, y lightsOn, z alarm pulse
        lights   : array<Light, 6>,
        env      : vec4f,                           // x fog density (1/m), y ambient
    };
    struct Instance { model : mat4x4f, tint : vec4f }; // tint.x: tally LED on (world) / CRT amount (GUI)

    @group(0) @binding(0) var<uniform> U : Globals;
    @group(0) @binding(1) var<storage, read> inst : array<Instance>;
    @group(0) @binding(2) var guiSampler : sampler;
    @group(0) @binding(3) var guiTex : texture_2d<f32>;
    @group(0) @binding(4) var<storage, read> mats : array<MaterialDef>;

    fn hash(p : vec2f) -> f32 {
        return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
    }

    // ---------------- World ----------------
    struct VSIn {
        @location(0) pos : vec3f,
        @location(1) nrm : vec3f,
        @location(2) uv  : vec2f,
        @location(3) mat : f32,
        @builtin(instance_index) instanceIdx : u32,
    };
    struct VSOut {
        @builtin(position) pos : vec4f,
        @location(0) wpos : vec3f,
        @location(1) nrm  : vec3f,
        @location(2) uv   : vec2f,
        @location(3) @interpolate(flat) mat : f32,
        @location(4) @interpolate(flat) sel : f32,
    };

    @vertex
    fn vs_main(i : VSIn) -> VSOut {
        let model = inst[i.instanceIdx].model;
        let wp = model * vec4f(i.pos, 1.0);
        var o : VSOut;
        o.pos = U.viewProj * wp;
        o.wpos = wp.xyz;
        o.nrm = (model * vec4f(i.nrm, 0.0)).xyz;
        o.uv = i.uv;
        o.mat = i.mat;
        o.sel = inst[i.instanceIdx].tint.x;
        return o;
    }

    fn seam(x : f32, w : f32) -> f32 {
        let f = fract(x);
        return 1.0 - step(w, f) * step(f, 1.0 - w);
    }
    fn hazard(uv : vec2f, stripe : vec3f, freq : f32) -> vec3f {
        let st = step(0.5, fract((uv.x + uv.y) * freq));
        return mix(vec3f(0.02), stripe, st);
    }

    // Material table (see MaterialTable in materials.js)
    struct MaterialDef {
        albedo : vec4f,     // rgb, w = pattern id
        emis   : vec4f,     // rgb, w = signal id
        shade  : vec4f,     // x spec, y shininess, z idle emission (< 0: ignores selection), w blink duty
        sig    : vec4f,     // x base, y gain, z rate, w uv.x spread
        args   : vec4f,     // pattern arguments
    };
    struct Mat { albedo : vec3f, spec : f32, shin : f32, emis : vec3f };

    // Surface detail around the base albedo
    fn pattern(id : u32, base : vec3f, a : vec4f, uv : vec2f, wp : vec3f, m : ptr<function, Mat>) {
        switch id {
            case 1u: { // wall panels
                let cell = floor(vec2f(uv.x, uv.y * 0.5));
                var c = base * (0.75 + 0.5 * hash(cell));
                c = c * (1.0 - 0.75 * max(seam(uv.x, 0.01), seam(uv.y * 0.5, 0.005)));
                let rv = fract(vec2f(uv.x, uv.y * 0.5));
                let rd = min(min(length(rv - vec2f(0.05, 0.05)), length(rv - vec2f(0.95, 0.05))),
                             min(length(rv - vec2f(0.05, 0.95)), length(rv - vec2f(0.95, 0.95))));
                if (rd < 0.02) { c = c * 1.8; }
                if (wp.y < 1.0) { c = c * vec3f(0.7, 0.68, 0.64); }
                if (abs(wp.y - 1.0) < 0.035) { c = vec3f(0.55, 0.32, 0.08); }
                (*m).albedo = c;
            }
            case 2u: { // grating
                let g = fract(uv * a.x);
                let hole = step(0.18, g.x) * step(0.18, g.y);
                (*m).albedo = mix(base, vec3f(0.015), hole) * (1.0 - 0.6 * max(seam(uv.x * 0.5, 0.006), seam(uv.y * 0.5, 0.006)));
                (*m).spec = mix((*m).spec, a.y, hole);
            }
            case 3u: { // mottled
                (*m).albedo = base * (a.z + a.w * hash(floor(uv * a.xy)));
            }
            case 4u: { // plates
                var c = base * (a.y + a.z * hash(floor(uv * a.x)));
                (*m).albedo = c * (1.0 - a.w * max(seam(uv.x * a.x, 0.01), seam(uv.y * a.x, 0.01)));
            }
            case 5u: { // sliding door
                var c = base * (1.0 - 0.6 * seam(uv.y * 1.25 + 0.5, 0.012));
                if (uv.y < -0.95 || uv.y > 1.05) { c = hazard(uv, vec3f(0.75, 0.55, 0.04), 2.5); }
                (*m).albedo = c;
            }
            case 6u: { // tiles
                (*m).albedo = base * (1.0 - a.y * max(seam(uv.x * a.x, 0.012), seam(uv.y * a.x, 0.012)));
            }
            case 7u: { // hazard stripes
                (*m).albedo = hazard(uv, base, a.x);
            }
            case 8u: { // bands
                (*m).albedo = base * (1.0 - a.y * seam(uv.y * a.x, 0.03));
            }
            case 9u: { // wood grain
                let g = sin((uv.x + uv.y * 0.15) * 55.0 + sin(uv.y * 5.0) * 2.0) * 0.5 + 0.5;
                (*m).albedo = base * (0.75 + 0.3 * g) * (0.9 + 0.2 * hash(floor(uv * vec2f(3.0, 1.0))));
            }
            default: {}
        }
    }

    // Time-varying emission driver
    fn signal(id : u32, d : MaterialDef, uv : vec2f) -> f32 {
        let t = U.params.x;
        switch id {
            case 1u: { return sin(t * d.sig.z); }
            case 2u: { return step(d.shade.w, fract(t * d.sig.z + uv.x * d.sig.w)); }
            case 3u: { return U.params.z; }
            case 4u: { return U.lights[0].pos.w; }
            default: { return 0.0; }
        }
    }

    fn material(id : u32, uv : vec2f, wp : vec3f, sel : f32) -> Mat {
        let d = mats[id];
        var m : Mat;
        m.albedo = d.albedo.rgb;
        m.spec = d.shade.x;
        m.shin = d.shade.y;
        pattern(u32(d.albedo.w + 0.5), d.albedo.rgb, d.args, uv, wp, &m);

        let sid = u32(d.emis.w + 0.5);
        var level = d.sig.x + d.sig.y * signal(sid, d, uv);
        if (d.shade.z >= 0.0) { level = mix(d.shade.z, level, sel); }
        var ec = d.emis.rgb;
        if (sid == 4u) { ec = ec * U.lights[0].color.rgb; }
        m.emis = ec * level;
        return m;
    }

    @fragment
    fn fs_scene(i : VSOut) -> @location(0) vec4f {
        let mt = material(u32(i.mat + 0.5), i.uv, i.wpos, i.sel);
        let V = normalize(U.camPos.xyz - i.wpos);
        var N = normalize(i.nrm);
        if (dot(N, V) < 0.0) { N = -N; }

        var col = mt.albedo * (0.012 + U.env.y) + mt.emis;
        for (var k = 0u; k < 6u; k = k + 1u) {
            let light = U.lights[k];
            let lv = light.pos.xyz - i.wpos;
            let d2 = max(dot(lv, lv), 1e-4);
            let l = lv * inverseSqrt(d2);
            let att = light.pos.w / (1.0 + d2);
            let ndl = max(dot(N, l), 0.0);
            let h = normalize(l + V);
            let sp = pow(max(dot(N, h), 0.0), mt.shin) * mt.spec;
            col += (mt.albedo + sp) * ndl * att * light.color.rgb;
        }

        let dist = length(U.camPos.xyz - i.wpos);
        col = mix(vec3f(0.004, 0.005, 0.007), col, exp(-dist * U.env.x));
        col = col / (1.0 + col);
        col = pow(col, vec3f(1.0 / 2.2));
        col += (hash(i.pos.xy + fract(U.params.x) * 91.0) - 0.5) * 0.025;
        return vec4f(col, 1.0);
    }

    // ---------------- GUI models ----------------
    // Vertices are in the GUI's virtual screen space; inst[instanceIdx].model is its gui model matrix
    // (surface texture axes scaled by 1/width, 1/height, times the surface's model matrix).
    struct GuiIn {
        @location(0) pos   : vec2f,
        @location(1) uv    : vec2f,
        @location(2) color : vec4f,
        @builtin(instance_index) instanceIdx : u32,
    };
    struct GuiOut {
        @builtin(position) pos : vec4f,
        @location(0) uv    : vec2f,
        @location(1) color : vec4f,
        @location(2) gpos  : vec2f,
        @location(3) @interpolate(flat) fx : f32,
    };

    @vertex
    fn vs_gui(i : GuiIn) -> GuiOut {
        let t = U.params.x;
        let fx = inst[i.instanceIdx].tint.x;
        // Occasional horizontal tearing (CRT GUIs only)
        let glitch = step(0.97, hash(vec2f(floor(t * 8.0), 3.1))) * fx;
        let jit = (hash(vec2f(floor(i.pos.y / 12.0), floor(t * 30.0))) - 0.5) * 5.0 * glitch;
        var o : GuiOut;
        o.pos = U.viewProj * (inst[i.instanceIdx].model * vec4f(i.pos.x + jit, i.pos.y, 0.0, 1.0));
        o.uv = i.uv;
        o.color = i.color;
        o.gpos = i.pos;
        o.fx = fx;
        return o;
    }

    fn crt(rgb : vec3f, gpos : vec2f, a : f32) -> vec3f {
        let t = U.params.x;
        let g = gpos / vec2f(640.0, 480.0);
        let scan = 0.82 + 0.18 * sin(gpos.y * 2.0944);
        let roll = exp(-pow((fract(t * 0.12) * 1.3 - 0.15 - g.y) * 10.0, 2.0));
        let flick = 0.96 + 0.04 * sin(t * 71.0);
        let d = g - vec2f(0.5);
        let vig = clamp(1.0 - dot(d, d) * 1.1, 0.0, 1.0);
        return rgb * scan * flick * vig + vec3f(0.35, 0.8, 1.0) * roll * 0.05 * a;
    }

    @fragment
    fn fs_gui(i : GuiOut) -> @location(0) vec4f {
        let c = textureSample(guiTex, guiSampler, i.uv) * i.color;
        return vec4f(mix(c.rgb, crt(c.rgb, i.gpos, c.a), i.fx), c.a);
    }

    // Security-camera look. color.r = signal strength (0 = static).
    @fragment
    fn fs_cctv(i : GuiOut) -> @location(0) vec4f {
        let t = U.params.x;
        let uv = i.uv;
        let tear = (hash(vec2f(floor(uv.y * 120.0), floor(t * 24.0))) - 0.5) * 0.004;
        let s = textureSample(guiTex, guiSampler, vec2f(uv.x + tear, uv.y));
        let noise = hash(uv * vec2f(391.0, 283.0) + fract(t * 7.3) * vec2f(17.0, 29.0));
        var v = dot(s.rgb, vec3f(0.3, 0.59, 0.11)) * 1.35 + (noise - 0.5) * 0.1;
        v = v * (0.9 + 0.1 * sin(uv.y * 5.0 - t * 1.7)) * (0.85 + 0.15 * sin(uv.y * 384.0 * 3.14159));
        let d = uv - vec2f(0.5);
        v = v * (1.0 - dot(d, d) * 1.3);
        let feed = vec3f(v * 0.72, v, v * 0.8);
        let rgb = mix(vec3f(noise * 0.75), feed, clamp(i.color.r, 0.0, 1.0));
        return vec4f(crt(rgb, i.gpos, 1.0), 1.0);
    }
`;

// Texture-array GUI material (video frames). Same vertex stage (vs_gui); color.r carries the layer.
const VIDEO_SHADER = /* wgsl */`
    struct GuiOut {
        @builtin(position) pos : vec4f,
        @location(0) uv    : vec2f,
        @location(1) color : vec4f,
        @location(2) gpos  : vec2f,
        @location(3) @interpolate(flat) fx : f32,
    };
    @group(0) @binding(2) var guiSampler : sampler;
    @group(0) @binding(3) var frames : texture_2d_array<f32>;

    @fragment
    fn fs_video(i : GuiOut) -> @location(0) vec4f {
        let c = textureSample(frames, guiSampler, i.uv, i32(i.color.r + 0.5));
        return vec4f(c.rgb, i.color.a);
    }
`;

// Full-screen triangle copying a texture into a (smaller) target
const BLIT_SHADER = /* wgsl */`
    @group(0) @binding(0) var blitSampler : sampler;
    @group(0) @binding(1) var src : texture_2d<f32>;
    struct O { @builtin(position) pos : vec4f, @location(0) uv : vec2f };

    @vertex
    fn vs(@builtin(vertex_index) vi : u32) -> O {
        var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        var o : O;
        o.pos = vec4f(p[vi], 0.0, 1.0);
        o.uv = vec2f((p[vi].x + 1.0) * 0.5, (1.0 - p[vi].y) * 0.5);
        return o;
    }

    @fragment
    fn fs(i : O) -> @location(0) vec4f {
        return textureSample(src, blitSampler, i.uv);   // bilinear at 2x2 block centres = box filter
    }
`;

// Brush stamping: every dab is an instanced quad drawn into the paint render target. The brush type
// picks the dab's shape; flow is how much paint one dab lays down.
const stampShader = (width, height) => /* wgsl */`
    struct Dab {
        @location(0) a : vec4f,     // x, y (paint px), radius (px), brush type
        @location(1) col : vec4f,
        @location(2) b : vec4f,     // seed, angle, flow, -
    };
    struct O {
        @builtin(position) pos : vec4f,
        @location(0) local : vec2f,
        @location(1) px : vec2f,
        @location(2) col : vec4f,
        @location(3) @interpolate(flat) info : vec4f,   // type, seed, angle, flow
    };
    const SIZE = vec2f(${width}.0, ${height}.0);

    fn hash(p : vec2f) -> f32 {
        return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
    }

    @vertex
    fn vs_stamp(@builtin(vertex_index) vi : u32, d : Dab) -> O {
        var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                                      vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
        let c = corners[vi];
        let px = d.a.xy + c * d.a.z;
        var o : O;
        o.pos = vec4f(px.x / SIZE.x * 2.0 - 1.0, 1.0 - px.y / SIZE.y * 2.0, 0.0, 1.0);
        o.local = c;
        o.px = px;
        o.col = d.col;
        o.info = vec4f(d.a.w, d.b.x, d.b.y, d.b.z);
        return o;
    }

    @fragment
    fn fs_stamp(i : O) -> @location(0) vec4f {
        let dist = length(i.local);
        let flow = i.info.w;
        var a = 0.0;
        switch u32(i.info.x + 0.5) {
            case 0u: { a = (1.0 - smoothstep(0.3, 1.0, dist)) * flow; }             // round brush: soft edge
            case 1u: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // ink pen: hard, opaque
            case 2u: {                                                               // airbrush: speckled spray
                let n = hash(floor(i.px) + i.info.y);
                a = pow(max(1.0 - dist, 0.0), 2.0) * flow * step(0.55, n);
            }
            case 3u: {                                                               // marker: fixed chisel tip
                let cs = cos(i.info.z);
                let sn = sin(i.info.z);
                let q = vec2f(cs * i.local.x + sn * i.local.y, -sn * i.local.x + cs * i.local.y);
                a = step(abs(q.x), 1.0) * step(abs(q.y), 0.32) * flow;
            }
            case 4u: {                                                               // charcoal: grain fixed to the paper
                let n = hash(floor(i.px * 0.8));
                a = (1.0 - smoothstep(0.55, 1.0, dist)) * step(0.3 + 0.45 * dist, n) * flow;
            }
            default: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // eraser (paper colour)
        }
        if (a <= 0.002) { discard; }
        return vec4f(i.col.rgb, a * i.col.a);
    }
`;

// ------------------------------------------------------------------------------------------- js/render/renderer.js
// WebGPU renderer: device, pipelines, instance data, GUI materials, views and render targets.

const UNIFORM_FLOATS = 76;       // viewProj 16 + camPos 4 + params 4 + 6 lights * 8 + env 4
const MAX_LIGHTS = 6;
const INSTANCE_FLOATS = 20;      // model 16 + tint 4
const GUI_STRIDE = 8;            // x y u v r g b a
const DEPTH_FORMAT = 'depth24plus-stencil8';
const CLEAR_COLOR = { r: 0.004, g: 0.005, b: 0.007, a: 1 };

const WORLD_VERTEX_LAYOUT = {
    arrayStride: 9 * 4,
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'float32' }
    ]
};
const GUI_VERTEX_LAYOUT = {
    arrayStride: GUI_STRIDE * 4,
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32x4' }
    ]
};
const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
};

async function checkShaderModule(module) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
        throw new Error('WGSL compile error:\n' + errors.map((m) => `L${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    }
}

class Renderer {
    // fx: the feature context (the host's device, canvas size and target; see js/engine/host.js)
    constructor(fx) {
        this.fx = fx;
        this.pipelines = {};
        this.materials = new Map();     // name -> { shading, view, version }
        this.instanceCount = 0;
        this.stencilRefs = 0;
        this.useStencil = true;         // false = GUI surfaces rely on the depth test alone (z-fights)
        this.onError = null;
    }

    async init() {
        this.device = this.fx.device;
        this.format = this.fx.format;
        this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.resize();
    }

    get aspect() {
        return this.width / this.height;
    }

    // the world's depth (sampled by a composition, js/engine/compositor.js) and the phone's own, so the view model
    // never clips into a wall nor clears the world's depth
    resize() {
        const [w, h] = this.fx.size();
        if (!this.device || (w === this.width && h === this.height)) return;
        this.width = w;
        this.height = h;
        for (const t of [this.depthTexture, this.phoneDepth]) t?.destroy();
        const U = GPUTextureUsage;
        this.depthTexture = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.depthView = this.depthTexture.createView();
        this.depthSample = this.depthTexture.createView({ aspect: 'depth-only' });
        this.phoneDepth = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: U.RENDER_ATTACHMENT });
        this.phoneDepthView = this.phoneDepth.createView();
    }

    // ---- resources ----
    createBuffer(size, usage) {
        return this.device.createBuffer({ size, usage });
    }

    createMesh(builder) {
        const data = builder.toFloat32();
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return { buffer, count: data.length / 9 };
    }

    // Instances are allocated by entities / GUIs during setup; the buffer is created afterwards
    allocInstances(n = 1) {
        if (this.instanceData) throw new Error('allocInstances after finalizeInstances');
        const first = this.instanceCount;
        this.instanceCount += n;
        return first;
    }

    finalizeInstances() {
        this.instanceData = new Float32Array(this.instanceCount * INSTANCE_FLOATS);
        this.instanceBuffer = this.createBuffer(this.instanceData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    }

    setInstance(index, matrix, tint = null) {
        const o = index * INSTANCE_FLOATS;
        this.instanceData.set(matrix, o);
        this.instanceData.fill(0, o + 16, o + 20);
        if (tint) this.instanceData.set(tint, o + 16);
    }

    // Each GUI surface gets its own stencil value, so one GUI can never draw through another
    nextStencilRef() {
        if (this.stencilRefs >= 255) throw new Error('Out of stencil references');
        return ++this.stencilRefs;
    }

    // ---- pipelines ----
    async createPipelines() {
        const device = this.device;
        const module = device.createShaderModule({ code: SCENE_SHADER });
        const videoModule = device.createShaderModule({ code: VIDEO_SHADER });
        await checkShaderModule(module);
        await checkShaderModule(videoModule);

        const layoutEntries = (viewDimension) => [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
        ];
        this.groupLayouts = {
            '2d': device.createBindGroupLayout({ entries: layoutEntries('2d') }),
            '2d-array': device.createBindGroupLayout({ entries: layoutEntries('2d-array') })
        };
        const layout2d = device.createPipelineLayout({ bindGroupLayouts: [this.groupLayouts['2d']] });
        const layoutArray = device.createPipelineLayout({ bindGroupLayouts: [this.groupLayouts['2d-array']] });

        const make = ({ layout = layout2d, vs, fs, fsModule = module, buffers, depthStencil, blend }) => device.createRenderPipeline({
            layout,
            vertex: { module, entryPoint: vs, buffers: [buffers] },
            fragment: { module: fsModule, entryPoint: fs, targets: [blend ? { format: this.format, blend } : { format: this.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: DEPTH_FORMAT, ...depthStencil }
        });

        const writeStencil = { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' };
        const testStencil = { compare: 'equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' };
        const guiStencil = { depthWriteEnabled: false, depthCompare: 'always', stencilFront: testStencil, stencilBack: testStencil };
        const guiDepth = { depthWriteEnabled: false, depthCompare: 'less-equal' };

        this.pipelines.scene = make({ vs: 'vs_main', fs: 'fs_scene', buffers: WORLD_VERTEX_LAYOUT, depthStencil: { depthWriteEnabled: true, depthCompare: 'less' } });
        // GUI surface geometry ("anchor"): writes its stencil value wherever it survives the depth test
        this.pipelines.anchor = make({
            vs: 'vs_main', fs: 'fs_scene', buffers: WORLD_VERTEX_LAYOUT,
            depthStencil: { depthWriteEnabled: true, depthCompare: 'less', stencilFront: writeStencil, stencilBack: writeStencil }
        });

        // GUI model shading variants: stencil-masked (depth ALWAYS + stencil EQUAL) or plain depth-tested
        const variants = (opts) => ({
            stencil: make({ ...opts, vs: 'vs_gui', buffers: GUI_VERTEX_LAYOUT, depthStencil: guiStencil, blend: ALPHA_BLEND }),
            depth: make({ ...opts, vs: 'vs_gui', buffers: GUI_VERTEX_LAYOUT, depthStencil: guiDepth, blend: ALPHA_BLEND })
        });
        this.shadings = {
            gui: { layout: '2d', ...variants({ fs: 'fs_gui' }) },
            cctv: { layout: '2d', ...variants({ fs: 'fs_cctv' }) },
            video: { layout: '2d-array', ...variants({ layout: layoutArray, fs: 'fs_video', fsModule: videoModule }) }
        };
    }

    // ---- World materials: the scenario's material table, indexed by the mesh vertices' material id ----
    setWorldMaterials(table) {
        this.worldMaterials = table;
        this.worldMaterialBuffer = this.createBuffer(table.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        this.device.queue.writeBuffer(this.worldMaterialBuffer, 0, table.data);
    }

    // ---- GUI materials: a named texture + a shading ----
    registerMaterial(name, shading, textureView) {
        if (!this.shadings[shading]) throw new Error(`Unknown shading "${shading}"`);
        this.materials.set(name, { shading, view: textureView, version: 0 });
    }

    setMaterialTexture(name, textureView) {
        const m = this.materials.get(name);
        m.view = textureView;
        m.version++;
    }

    createView() {
        return new RenderView(this);
    }

    // Bind group for (view, material), cached per view until the material's texture changes
    groupFor(view, name) {
        if (view.exclude.has(name)) return null;
        const mat = this.materials.get(name);
        if (!mat) return null;
        const cached = view.groups.get(name);
        if (cached && cached.version === mat.version) return cached.group;
        const layout = this.groupLayouts[this.shadings[mat.shading].layout];
        const group = this.device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: { buffer: view.buffer } },
                { binding: 1, resource: { buffer: this.instanceBuffer } },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: mat.view },
                { binding: 4, resource: { buffer: this.worldMaterialBuffer } }
            ]
        });
        view.groups.set(name, { version: mat.version, group });
        return group;
    }

    // ---- frames & passes ----
    beginFrame() {
        this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData);
        this.encoder = this.device.createCommandEncoder();
        this.swapView = this.fx.target();
        return this.encoder;
    }

    endFrame() {
        this.device.queue.submit([this.encoder.finish()]);
        this.encoder = null;
    }

    depthAttachment(view) {
        return {
            view,
            depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
            stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store'
        };
    }

    // A scene pass into `colorView`. `load` keeps what's already there (the phone draws over the world).
    beginScenePass(colorView, depthView, view, { load = false, forceStencil = false } = {}) {
        const pass = this.encoder.beginRenderPass({
            colorAttachments: [{ view: colorView, clearValue: CLEAR_COLOR, loadOp: load ? 'load' : 'clear', storeOp: 'store' }],
            depthStencilAttachment: this.depthAttachment(depthView)
        });
        return new ScenePass(this, pass, view, forceStencil);
    }
}

// Per-camera uniforms and the bind groups that use them
class RenderView {
    constructor(renderer) {
        this.renderer = renderer;
        this.buffer = renderer.createBuffer(UNIFORM_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        this.groups = new Map();
        this.exclude = new Set();       // materials this view can't sample (its own render target)
        this.data = new Float32Array(UNIFORM_FLOATS);
    }

    // frame: { time, lightsOn, alarmPulse, lights: up to 6 x [x, y, z, intensity, r, g, b, 0] }
    update(viewProj, eye, frame) {
        const u = this.data;
        u.fill(0);
        u.set(viewProj, 0);
        u.set([eye[0], eye[1], eye[2], 1], 16);
        u.set([frame.time, frame.lightsOn ? 1 : 0, frame.alarmPulse, 0], 20);
        frame.lights.slice(0, MAX_LIGHTS).forEach((l, i) => u.set(l, 24 + i * 8));
        u.set([frame.fog ?? 0.05, frame.ambient ?? 0, 0, 0], 72);
        this.renderer.device.queue.writeBuffer(this.buffer, 0, u);
    }

    group(material) {
        return this.renderer.groupFor(this, material);
    }
}

// Offscreen colour + depth/stencil target with its own view (camera)
class RenderTarget {
    constructor(renderer, width, height, { copySrc = false } = {}) {
        this.renderer = renderer;
        this.width = width;
        this.height = height;
        this.aspect = width / height;
        this.texture = renderer.device.createTexture({
            size: [width, height],
            format: renderer.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | (copySrc ? GPUTextureUsage.COPY_SRC : 0)
        });
        this.colorView = this.texture.createView();
        this.depthView = renderer.device.createTexture({
            size: [width, height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT
        }).createView();
        this.view = renderer.createView();
    }

    beginScene() {
        return this.renderer.beginScenePass(this.colorView, this.depthView, this.view);
    }
}

// Thin wrapper over a render pass that avoids redundant pipeline / bind-group switches
class ScenePass {
    constructor(renderer, pass, view, forceStencil) {
        this.renderer = renderer;
        this.pass = pass;
        this.view = view;
        this.forceStencil = forceStencil;
        this.pipeline = null;
        this.bindGroup = null;
    }

    use(pipeline, group) {
        if (pipeline !== this.pipeline) { this.pass.setPipeline(pipeline); this.pipeline = pipeline; }
        if (group !== this.bindGroup) { this.pass.setBindGroup(0, group); this.bindGroup = group; }
    }

    mesh(mesh, firstInstance, count = 1) {
        this.use(this.renderer.pipelines.scene, this.view.group('atlas'));
        this.pass.setVertexBuffer(0, mesh.buffer);
        this.pass.draw(mesh.count, count, 0, firstInstance);
    }

    // GUI surface geometry that marks its visible pixels with `stencilRef`
    anchor(mesh, instance, stencilRef) {
        this.use(this.renderer.pipelines.anchor, this.view.group('atlas'));
        this.pass.setStencilReference(stencilRef);
        this.pass.setVertexBuffer(0, mesh.buffer);
        this.pass.draw(mesh.count, 1, 0, instance);
    }

    // A GUI model's surfaces; each material picks its shading pipeline and texture
    gui(model, instance, stencilRef) {
        if (!model.count) return;
        const r = this.renderer;
        this.pass.setStencilReference(stencilRef);
        this.pass.setVertexBuffer(0, model.buffer);
        const stencil = r.useStencil || this.forceStencil;
        for (const surf of model.surfaces) {
            const group = this.view.group(surf.material);
            if (!group) continue;
            const shading = r.shadings[r.materials.get(surf.material).shading];
            this.use(stencil ? shading.stencil : shading.depth, group);
            this.pass.draw(surf.count, 1, surf.first, instance);
        }
    }

    end() {
        this.pass.end();
    }
}

// ------------------------------------------------------------------------------------------------- js/gui/atlas.js
// GUI atlas: bitmap fonts, cursor, soft blob and a white texel, baked once at startup
// (like Doom 3's pre-rendered font pages and gui images).
//   mono (Share Tech Mono) sharp + blurred glow copy, sans (Inter 500), sansBold (Inter 700)

const FONT_PX = 44;
const GLYPH = { cellW: 56, cellH: 80, pad: 8, base: 58, perRow: 18 };
const GLYPH_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '°', '•', '×', '‹', '›', '·'];

class GuiAtlas {
    static WIDTH = 1024;
    static HEIGHT = 2048;
    static MIPS = 5;
    static MISC_Y = 970;

    constructor() {
        this.fonts = {};
    }

    static async loadFonts(timeoutMs = 3000) {
        // Don't wait forever if the webfonts are blocked; the atlas falls back to system fonts
        await Promise.race([
            Promise.all([
                document.fonts.load(`${FONT_PX}px "Share Tech Mono"`),
                document.fonts.load(`500 ${FONT_PX}px "Inter"`),
                document.fonts.load(`700 ${FONT_PX}px "Inter"`)
            ]),
            new Promise((r) => setTimeout(r, timeoutMs))
        ]);
    }

    bakeFont(c, name, css, y0, glowY0) {
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT;
        c.font = css;
        const font = { glyphs: {}, glow: glowY0 !== undefined };
        GLYPH_CHARS.forEach((ch, i) => {
            const x = (i % GLYPH.perRow) * GLYPH.cellW;
            const y = y0 + Math.floor(i / GLYPH.perRow) * GLYPH.cellH;
            c.fillStyle = '#ffffff';
            c.fillText(ch, x + GLYPH.pad, y + GLYPH.base);
            const g = {
                adv: c.measureText(ch).width,
                u0: x / W, u1: (x + GLYPH.cellW) / W,
                v0: y / H, v1: (y + GLYPH.cellH) / H
            };
            if (font.glow) {
                // Blurred copy: draw off-canvas and let only the shadow land in the glow cell
                const gy = glowY0 + (y - y0);
                c.save();
                c.shadowColor = '#ffffff';
                c.shadowBlur = 9;
                c.shadowOffsetX = 4000;
                c.fillText(ch, x + GLYPH.pad - 4000, gy + GLYPH.base);
                c.restore();
                g.gv0 = gy / H;
                g.gv1 = (gy + GLYPH.cellH) / H;
            }
            font.glyphs[ch] = g;
        });
        this.fonts[name] = font;
    }

    buildCanvas() {
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT, Y = GuiAtlas.MISC_Y;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const c = cv.getContext('2d');

        this.bakeFont(c, 'mono', `${FONT_PX}px "Share Tech Mono", monospace`, 0, 480);
        this.bakeFont(c, 'sans', `500 ${FONT_PX}px "Inter", system-ui, sans-serif`, 1040);
        this.bakeFont(c, 'sansBold', `700 ${FONT_PX}px "Inter", system-ui, sans-serif`, 1520);

        // Cursor arrow
        c.save();
        c.translate(6, Y + 4);
        c.scale(1.5, 1.5);
        c.beginPath();
        c.moveTo(0, 0); c.lineTo(0, 30); c.lineTo(8, 23); c.lineTo(14, 36);
        c.lineTo(19, 34); c.lineTo(13, 21); c.lineTo(23, 21); c.closePath();
        c.lineWidth = 3;
        c.strokeStyle = '#000000';
        c.stroke();
        c.fillStyle = '#ffffff';
        c.fill();
        c.restore();
        this.cursor = [0, Y / H, 64 / W, (Y + 64) / H];

        // Soft round blob
        const grad = c.createRadialGradient(112, Y + 32, 0, 112, Y + 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = grad;
        c.fillRect(80, Y, 64, 64);
        this.blob = [80 / W, Y / H, 144 / W, (Y + 64) / H];

        // Solid white block; sample its centre
        c.fillStyle = '#ffffff';
        c.fillRect(160, Y, 32, 32);
        this.white = [176 / W, (Y + 16) / H];
        return cv;
    }

    // Bake and upload with a downsampled mip chain; returns the texture view
    upload(renderer) {
        const cv = this.buildCanvas();
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT;
        const texture = renderer.device.createTexture({
            size: [W, H],
            format: 'rgba8unorm',
            mipLevelCount: GuiAtlas.MIPS,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        for (let level = 0; level < GuiAtlas.MIPS; level++) {
            const w = W >> level, h = H >> level;
            let src = cv;
            if (level > 0) {
                src = document.createElement('canvas');
                src.width = w;
                src.height = h;
                const c = src.getContext('2d');
                c.imageSmoothingQuality = 'high';
                c.drawImage(cv, 0, 0, w, h);
            }
            renderer.device.queue.copyExternalImageToTexture({ source: src }, { texture, mipLevel: level }, [w, h]);
        }
        return texture.createView();
    }
}

// ---------------------------------------------------------------------------------------- js/gui/device-context.js
// GUI models and the device context that fills them.

// Per-frame triangle list of (x, y, u, v, r, g, b, a) in a GUI's virtual screen space, split into
// surfaces whenever the material changes (like idGuiModel::SetMaterial)
class GuiModel {
    constructor(maxVerts) {
        this.max = maxVerts;
        this.verts = new Float32Array(maxVerts * GUI_STRIDE);
        this.count = 0;
        this.surfaces = [];     // { material, first, count }
        this.buffer = null;
    }

    createBuffer(renderer) {
        this.buffer = renderer.createBuffer(this.verts.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    }

    reset() {
        this.count = 0;
        this.surfaces.length = 0;
    }

    upload(renderer) {
        if (this.count) renderer.device.queue.writeBuffer(this.buffer, 0, this.verts, 0, this.count * GUI_STRIDE);
    }

    get quads() {
        return (this.count / 6) | 0;
    }
}

// A minimal idDeviceContext: every drawing call turns into textured, coloured quads
class DeviceContext {
    constructor(atlas) {
        this.atlas = atlas;
        this.model = null;
        this.clip = null;
        this.ox = 0;            // horizontal offset (page slide transitions)
    }

    begin(model) {
        this.model = model;
        model.reset();
        this.clip = null;
        this.ox = 0;
        this.setMaterial('atlas');
    }

    end() {
        const surfs = this.model.surfaces;
        const last = surfs[surfs.length - 1];
        if (!last) return;
        last.count = this.model.count - last.first;
        if (last.count === 0) surfs.pop();
    }

    setMaterial(material) {
        const surfs = this.model.surfaces;
        const last = surfs[surfs.length - 1];
        if (last && last.material === material) return;
        this.end();
        surfs.push({ material, first: this.model.count, count: 0 });
    }

    vert(x, y, u, v, c) {
        const m = this.model;
        if (m.count >= m.max) return;
        const o = m.count * GUI_STRIDE, vs = m.verts;
        vs[o] = x + this.ox; vs[o + 1] = y;
        vs[o + 2] = u; vs[o + 3] = v;
        vs[o + 4] = c[0]; vs[o + 5] = c[1]; vs[o + 6] = c[2]; vs[o + 7] = c[3];
        m.count++;
    }

    setClip(x, y, w, h) { this.clip = [x, y, x + w, y + h]; }
    clearClip() { this.clip = null; }

    quad(p, uv, c) {
        for (const i of [0, 1, 2, 0, 2, 3]) this.vert(p[i][0], p[i][1], uv[i][0], uv[i][1], c);
    }

    // Axis-aligned pictures are clipped against the (absolute) clip rect, adjusting UVs
    // (idDeviceContext::ClippedCoords)
    stretchPic(x, y, w, h, u0, v0, u1, v1, c) {
        if (this.clip) {
            const [cx0, cy0, cx1, cy1] = this.clip;
            let x0 = x + this.ox, y0 = y, x1 = x + this.ox + w, y1 = y + h;
            if (x1 <= cx0 || x0 >= cx1 || y1 <= cy0 || y0 >= cy1 || w <= 0 || h <= 0) return;
            const du = (u1 - u0) / w, dv = (v1 - v0) / h;
            if (x0 < cx0) { u0 += (cx0 - x0) * du; x0 = cx0; }
            if (x1 > cx1) { u1 -= (x1 - cx1) * du; x1 = cx1; }
            if (y0 < cy0) { v0 += (cy0 - y0) * dv; y0 = cy0; }
            if (y1 > cy1) { v1 -= (y1 - cy1) * dv; y1 = cy1; }
            x = x0 - this.ox; y = y0; w = x1 - x0; h = y1 - y0;
        }
        this.quad([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], c);
    }

    // Atlas images by name ('cursor' | 'blob')
    image(name, x, y, w, h, c) {
        const [u0, v0, u1, v1] = this.atlas[name];
        this.stretchPic(x, y, w, h, u0, v0, u1, v1, c);
    }

    fillRect(x, y, w, h, c) {
        const [u, v] = this.atlas.white;
        this.stretchPic(x, y, w, h, u, v, u, v, c);
    }

    rect(x, y, w, h, size, c) {
        this.fillRect(x, y, w, size, c);
        this.fillRect(x, y + h - size, w, size, c);
        this.fillRect(x, y + size, size, h - 2 * size, c);
        this.fillRect(x + w - size, y + size, size, h - 2 * size, c);
    }

    line(x0, y0, x1, y1, width, c) {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * width * 0.5, ny = (dx / len) * width * 0.5;
        const [u, v] = this.atlas.white;
        this.quad([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], [[u, v], [u, v], [u, v], [u, v]], c);
    }

    polyline(pts, width, c, closed = false) {
        const n = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            this.line(a[0], a[1], b[0], b[1], width, c);
        }
    }

    // Fan from pts[0]; fine for convex or star-shaped outlines
    polygon(pts, c) {
        const [u, v] = this.atlas.white;
        for (let i = 1; i < pts.length - 1; i++) {
            this.vert(pts[0][0], pts[0][1], u, v, c);
            this.vert(pts[i][0], pts[i][1], u, v, c);
            this.vert(pts[i + 1][0], pts[i + 1][1], u, v, c);
        }
    }

    arcPts(cx, cy, r, a0, a1, seg) {
        const pts = [];
        for (let i = 0; i <= seg; i++) {
            const a = a0 + ((a1 - a0) * i) / seg;
            pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        return pts;
    }

    circle(cx, cy, r, c, seg = 28) {
        this.polygon(this.arcPts(cx, cy, r, 0, Math.PI * 2, seg), c);
    }

    ring(cx, cy, r, width, c, seg = 48) {
        this.polyline(this.arcPts(cx, cy, r, 0, Math.PI * 2, seg), width, c);
    }

    roundRectPts(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        const H = Math.PI / 2;
        return [
            ...this.arcPts(x + w - r, y + r, r, -H, 0, 5),
            ...this.arcPts(x + w - r, y + h - r, r, 0, H, 5),
            ...this.arcPts(x + r, y + h - r, r, H, 2 * H, 5),
            ...this.arcPts(x + r, y + r, r, 2 * H, 3 * H, 5)
        ];
    }

    roundRect(x, y, w, h, r, c) {
        if (w <= 0 || h <= 0) return;
        this.polygon(this.roundRectPts(x, y, w, h, r), c);
    }

    chamferPts(x, y, w, h, c) {
        return [[x + c, y], [x + w, y], [x + w, y + h - c], [x + w - c, y + h], [x, y + h], [x, y + c]];
    }

    playIcon(cx, cy, r, c) {
        this.polygon([[cx - r * 0.45, cy - r * 0.6], [cx + r * 0.6, cy], [cx - r * 0.45, cy + r * 0.6]], c);
    }

    spinner(cx, cy, r, t) {
        const a = t * 6;
        this.polyline(this.arcPts(cx, cy, r, a, a + 4.4, 18), 3, [1, 1, 1, 0.9]);
    }

    textWidth(str, size, font = 'mono') {
        const f = this.atlas.fonts[font];
        let w = 0;
        for (const ch of str) w += (f.glyphs[ch] || f.glyphs['?']).adv;
        return w * (size / FONT_PX);
    }

    wrapText(str, size, font, maxW) {
        const lines = [];
        let line = '';
        for (const word of str.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && this.textWidth(next, size, font) > maxW) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    // y is the baseline; align: 'left' | 'center' | 'right'. Only the mono font has a glow copy.
    text(str, x, y, size, c, align = 'left', glow = true, font = 'mono') {
        const f = this.atlas.fonts[font];
        const s = size / FONT_PX;
        let pen = x;
        if (align === 'center') pen -= this.textWidth(str, size, font) / 2;
        else if (align === 'right') pen -= this.textWidth(str, size, font);
        const top = y - GLYPH.base * s, w = GLYPH.cellW * s, h = GLYPH.cellH * s;
        if (glow && f.glow) {
            const gc = [c[0], c[1], c[2], c[3] * 0.55];
            let gp = pen;
            for (const ch of str) {
                const g = f.glyphs[ch] || f.glyphs['?'];
                if (ch !== ' ') this.stretchPic(gp - GLYPH.pad * s, top, w, h, g.u0, g.gv0, g.u1, g.gv1, gc);
                gp += g.adv * s;
            }
        }
        for (const ch of str) {
            const g = f.glyphs[ch] || f.glyphs['?'];
            if (ch !== ' ') this.stretchPic(pen - GLYPH.pad * s, top, w, h, g.u0, g.v0, g.u1, g.v1, c);
            pen += g.adv * s;
        }
    }
}

// -------------------------------------------------------------------------------------------- js/gui/entity-gui.js
// EntityGUI: a Doom 3-style GUI surface.
//
// A rectangle on an entity (the "surface") plus a GUI that draws textured quads into its own virtual
// screen space. Each frame the GUI is rebuilt into a GuiModel; the model is placed on the surface with
// a matrix derived from the surface's texture axes (R_RenderGuiSurf), and the cursor is found by
// tracing the view ray against the surface (GuiTrace).
//
// Rendering: the surface geometry (the "anchor") writes this GUI's own stencil value wherever it is
// visible, then the GUI quads draw with depth ALWAYS + stencil EQUAL. No z-fighting, correct occlusion,
// and GUIs can never draw through each other.
//
// Subclasses implement draw(dc, now) and react to input via onPress / pointerDrag / pointerUp / wheel.

class EntityGUI {
    // def: { id, size: [w, h] metres, virtual: [vw, vh], zOffset, crt, range, anchorMaterial, maxVerts }
    constructor(def) {
        this.def = def;
        this.id = def.id;
        [this.width, this.height] = def.size;
        [this.vw, this.vh] = def.virtual;
        this.crt = !!def.crt;
        this.range = def.range ?? Infinity;
        this.tri = GuiSurface.tri(this.width, this.height, def.zOffset || 0);
        this.model = new GuiModel(def.maxVerts || 16000);
        this.surfaceMatrix = M4.identity();

        this.cursor = { x: this.vw / 2, y: this.vh / 2 };
        this.active = false;        // the cursor is on this GUI and it can be used
        this.outOfRange = false;    // the cursor is on this GUI but it's too far away to use
        this.buttons = [];          // hit regions, rebuilt every frame while drawing
        this.hoverId = null;
        this.pressId = null;
        this.pressTime = 0;
        this.game = null;
    }

    attach(game) {
        const r = game.renderer;
        this.game = game;
        this.stencilRef = r.nextStencilRef();
        this.anchorInstance = r.allocInstances(1);
        this.guiInstance = r.allocInstances(1);
        this.anchorMesh = r.createMesh(new MeshBuilder(r.worldMaterials).surface(this.tri, this.def.anchorMaterial || 'glass'));
        this.model.createBuffer(r);
    }

    get audio() {
        return this.game.audio;
    }

    // ---- placement & picking ----
    setTransform(matrix) {
        this.surfaceMatrix = matrix;
    }

    center() {
        return M4.transformPoint(this.surfaceMatrix, [0, 0, 0]);
    }

    trace(origin, dir) {
        return GuiSurface.trace(this.tri, this.surfaceMatrix, this.vw, this.vh, origin, dir);
    }

    inRange(eye) {
        return V3.length(V3.sub(eye, this.center())) <= this.range;
    }

    // ---- hit regions ----
    addButton(id, x, y, w, h) {
        this.buttons.push({ id, x, y, w, h });
    }

    isHover(id) {
        return this.active && this.hoverId === id;
    }

    isPressed(id, ms = 160) {
        return this.pressId === id && performance.now() - this.pressTime < ms;
    }

    hitButton() {
        return hitIn(this.buttons, this.cursor);
    }

    canHover() {
        return this.active;
    }

    // ---- per frame ----
    update(dt, now) {}

    // Rebuild the GUI model. Hover resolves against last frame's hit regions.
    build(dc, now) {
        const hit = this.canHover() ? this.hitButton() : null;
        const hoverId = hit ? hit.id : null;
        if (hoverId !== this.hoverId) {
            this.hoverId = hoverId;
            if (hoverId) this.onHover(hoverId);
        }
        this.buttons = [];
        dc.begin(this.model);
        this.draw(dc, now);
        if (this.outOfRange) this.drawRangeHint(dc, now);
        if (this.active) this.drawCursor(dc, now);
        dc.end();
        this.model.upload(this.game.renderer);
    }

    draw(dc, now) {}
    drawRangeHint(dc, now) {}
    drawCursor(dc) {
        dc.image('cursor', this.cursor.x, this.cursor.y, 24, 24, [1, 1, 1, 1]);
    }

    // ---- input (routed by InteractionSystem) ----
    // Returns true to capture the pointer until it's released (drags)
    pointerDown() {
        const b = this.hitButton();
        if (b) {
            this.pressId = b.id;
            this.pressTime = performance.now();
        }
        return this.onPress(b) === true;
    }

    onPress(button) {}
    onHover(id) {}
    pointerDrag() {}        // every frame while captured
    pointerUp() {}
    wheel(dy) { return false; }

    // ---- rendering ----
    writeInstances(renderer) {
        renderer.setInstance(this.anchorInstance, this.surfaceMatrix);
        renderer.setInstance(this.guiInstance, GuiSurface.modelMatrix(this.tri, this.surfaceMatrix, this.vw, this.vh), [this.crt ? 1 : 0, 0, 0, 0]);
    }

    render(pass) {
        pass.anchor(this.anchorMesh, this.anchorInstance, this.stencilRef);
        pass.gui(this.model, this.guiInstance, this.stencilRef);
    }
}

// ------------------------------------------------------------------------------------------ js/gui/terminal-gui.js
// Wall terminal GUI (640x480): airlock controls, access keypad and the CCTV window.

const TERM_COLORS = {
    cyan: [110, 220, 255],
    orange: [255, 154, 46],
    red: [255, 70, 55],
    green: [90, 255, 140],
    white: [235, 245, 255],
    ink: [3, 16, 22]
};

class TerminalGUI extends EntityGUI {
    // CCTV window layout
    static CAM_LIST = { x: 22, y: 78, w: 166, h: 340 };
    static CAM_ROW_H = 62;
    static CAM_TRACK = { x: 192, y: 78, w: 6, h: 340 };
    static FEED = { x: 226, y: 78, w: 388, h: 291 };

    constructor(def, content, world) {
        super(def);
        this.content = content;
        this.world = world;
        this.page = 'main';             // 'main' | 'keypad' | 'cctv'
        this.code = '';
        this.keyMsg = null;
        this.boot = performance.now();
        this.feedSince = 0;
        this.scroll = 0;
        this.scrollTarget = 0;
        this.thumbDrag = null;
        this.scrollInfo = { maxScroll: 0, travel: 1, thumbH: 0 };
    }

    attach(game) {
        super.attach(game);
        game.cctv.onSelect.push((i) => this.revealCamera(i));
    }

    get cctv() { return this.game.cctv; }
    get door() { return this.world.get(this.content.door); }
    get accent() { return this.world.alarm ? TERM_COLORS.red : TERM_COLORS.cyan; }

    showPage(page) {
        this.page = page;
        if (page === 'cctv') this.feedSince = performance.now();
        if (page === 'keypad') { this.code = ''; this.keyMsg = null; }
    }

    // Keep a camera's row inside the list viewport
    revealCamera(i) {
        const { CAM_ROW_H, CAM_LIST } = TerminalGUI;
        const top = i * CAM_ROW_H;
        if (top < this.scrollTarget) this.scrollTarget = top;
        if (top + CAM_ROW_H > this.scrollTarget + CAM_LIST.h) this.scrollTarget = top + CAM_ROW_H - CAM_LIST.h;
    }

    update() {
        if (this.page === 'cctv') this.cctv.request();
    }

    // ---- widgets ----
    panel(dc, x, y, w, h, title) {
        const accent = this.accent;
        const pts = dc.chamferPts(x, y, w, h, 9);
        dc.polygon(pts, col([10, 40, 52], 0.45));
        dc.polyline(pts, 1.5, col(accent, 0.8), true);
        if (title) {
            const tw = dc.textWidth(title, 11) + 14;
            dc.fillRect(x + 9, y, tw, 16, col(accent, 0.85));
            dc.text(title, x + 16, y + 12, 11, col(TERM_COLORS.ink), 'left', false);
        }
    }

    button(dc, id, x, y, w, h, label, color, sub) {
        const C = TERM_COLORS;
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id);
        const pressed = this.isPressed(id);
        const pts = dc.chamferPts(x, y, w, h, Math.min(8, h / 4));
        if (hover) dc.image('blob', x - 16, y - 16, w + 32, h + 32, col(color, 0.22));
        dc.polygon(pts, col(color, pressed ? 0.95 : hover ? 0.32 : 0.1));
        dc.polyline(pts, hover ? 2 : 1.5, col(color, hover ? 1 : 0.75), true);
        if (h > 36) dc.polyline(dc.chamferPts(x + 4, y + 4, w - 8, h - 8, 5), 0.75, col(color, 0.3), true);
        const size = Math.min(22, Math.max(11, Math.floor(h * 0.32)));
        const textCol = pressed ? col(C.ink) : hover ? col(C.white) : col(color);
        dc.text(label, x + w / 2, y + h / 2 + size * 0.35 + (sub ? -6 : 0), size, textCol, 'center', !pressed);
        if (sub) dc.text(sub, x + w / 2, y + h / 2 + 18, 10, pressed ? col(C.ink) : col(color, 0.7), 'center', false);
    }

    tab(dc, id, x, y, w, h, label, selected) {
        const accent = this.accent;
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id);
        dc.fillRect(x, y, w, h, col(accent, selected ? 0.85 : hover ? 0.3 : 0.08));
        dc.rect(x, y, w, h, 1, col(accent, selected || hover ? 1 : 0.5));
        dc.text(label, x + w / 2, y + h / 2 + 4.5, 12, selected ? col(TERM_COLORS.ink) : col(hover ? TERM_COLORS.white : accent), 'center', !selected);
    }

    // ---- pages ----
    draw(dc, now) {
        const t = now / 1000, C = TERM_COLORS, accent = this.accent, W = this.vw, H = this.vh;

        // Background & grid
        dc.fillRect(0, 0, W, H, col([3, 12, 18], 0.94));
        for (let x = 20; x < W; x += 20) dc.fillRect(x, 0, 0.75, H, col(accent, 0.06));
        for (let y = 20; y < H; y += 20) dc.fillRect(0, y, W, 0.75, col(accent, 0.06));

        // Header
        const flash = this.world.alarm && Math.sin(t * 8) > 0;
        dc.fillRect(0, 0, W, 40, col(accent, flash ? 0.45 : 0.18));
        dc.fillRect(0, 39, W, 2, col(accent));
        const a = t * 0.8;
        dc.polyline([0, 1, 2, 3].map((k) => [22 + Math.cos(a + (k * Math.PI) / 2) * 10, 20 + Math.sin(a + (k * Math.PI) / 2) * 10]), 2, col(accent), true);
        dc.text(this.content.titles[this.page], 44, 27, 19, col(C.white));
        if (this.page !== 'keypad') {
            this.tab(dc, 'tab:main', 322, 8, 100, 24, 'CONTROL', this.page === 'main');
            this.tab(dc, 'tab:cctv', 428, 8, 100, 24, 'CCTV', this.page === 'cctv');
        }
        const el = Math.floor((now - this.boot) / 1000);
        const clock = [Math.floor(el / 3600), Math.floor(el / 60) % 60, el % 60].map((n) => String(n).padStart(2, '0')).join(':');
        dc.text(`T+ ${clock}`, W - 14, 26, 13, col(accent), 'right');

        if (this.page === 'main') this.drawMain(dc, t);
        else if (this.page === 'cctv') this.drawCctv(dc, t, now);
        else this.drawKeypad(dc, t, now);

        if (this.world.alarm) dc.rect(2, 2, W - 4, H - 4, 4, col(C.red, flash ? 1 : 0.35));
    }

    drawMain(dc, t) {
        const C = TERM_COLORS, accent = this.accent, door = this.door, world = this.world;
        this.panel(dc, 14, 56, 296, 300, 'ENVIRONMENT');
        const hatch = { open: ['OPEN', C.green], opening: ['CYCLING', C.orange], closing: ['CYCLING', C.orange], sealed: ['SEALED', C.orange] }[door.status];
        const rows = [
            [door.name.toUpperCase(), hatch[0], hatch[1]],
            ['PRESSURE', `${(101.3 - door.progress * 2.4 + Math.sin(t * 1.3) * 0.06).toFixed(1)} kPa`, C.white],
            ['O2 LEVEL', `${(20.9 - door.progress * 0.6).toFixed(1)} %`, C.white],
            ['LIGHTING', world.lightsOn ? 'ONLINE' : 'OFFLINE', world.lightsOn ? C.green : C.red]
        ];
        rows.forEach(([label, val, c], i) => {
            const y = 98 + i * 32;
            dc.text(label, 28, y, 13, col(accent, 0.7), 'left', false);
            dc.text(val, 296, y, 16, col(c), 'right');
            dc.fillRect(28, y + 8, 268, 1, col(accent, 0.15));
        });

        // Oscilloscope
        const sx = 28, sy = 232, sw = 268, sh = 110;
        dc.rect(sx, sy, sw, sh, 1, col(accent, 0.35));
        dc.fillRect(sx, sy + sh / 2, sw, 1, col(accent, 0.12));
        const amp = world.alarm ? 1.8 : 1;
        const pts = [];
        for (let i = 0; i <= sw; i += 3) {
            pts.push([sx + i, sy + sh / 2 + Math.sin(i * 0.07 + t * 4) * 22 * amp + Math.sin(i * 0.27 - t * 9) * 6 + (Math.random() - 0.5) * 2]);
        }
        dc.polyline(pts, 1.5, col(accent));
        dc.text(this.content.scopeLabel, sx + 6, sy + 14, 10, col(accent, 0.6), 'left', false);

        this.panel(dc, 330, 56, 296, 300, 'CONTROLS');
        const open = door.isOpen;
        this.button(dc, 'door', 348, 84, 260, 74, open ? 'SEAL HATCH' : 'OPEN HATCH', open ? C.orange : C.green,
            open ? 'CYCLE AIRLOCK CLOSED' : 'AUTHORIZATION REQUIRED');
        this.button(dc, 'lights', 348, 172, 260, 74, world.lightsOn ? 'LIGHTS OFF' : 'LIGHTS ON', C.cyan, 'ROOM ILLUMINATION');
        this.button(dc, 'alarm', 348, 260, 260, 74, world.alarm ? 'RESET ALARM' : 'SOUND ALARM', C.red,
            world.alarm ? 'ALERT IN PROGRESS' : 'EMERGENCY BEACON');

        this.panel(dc, 14, 368, 612, 98, 'SYSTEM LOG');
        const lines = world.log.slice(-3);
        lines.forEach((line, i) => {
            const newest = i === lines.length - 1;
            const text = '> ' + line + (newest && Math.floor(t * 2) % 2 ? '_' : '');
            dc.text(text, 28, 406 + i * 20, 13, newest ? col(C.white) : col(accent, 0.55), 'left', newest);
        });
    }

    drawKeypad(dc, t, now) {
        const C = TERM_COLORS, accent = this.accent, digits = this.content.hatchCode.length;
        this.panel(dc, 14, 56, 296, 410, 'ACCESS TERMINAL');
        dc.text(`RESTRICTED: ${this.door.name.toUpperCase()}`, 28, 100, 18, col(C.orange));
        dc.text(`ENTER ${digits}-DIGIT ACCESS CODE`, 28, 124, 12, col(accent, 0.75), 'left', false);

        const box = dc.chamferPts(28, 138, 268, 90, 8);
        dc.polygon(box, [0, 0, 0, 0.35]);
        dc.polyline(box, 1.5, col(accent), true);
        for (let i = 0; i < digits; i++) {
            const ch = this.code[i] ?? (i === this.code.length && Math.floor(t * 3) % 2 ? '_' : '.');
            dc.text(ch, 28 + 60 + i * 74, 202, 54, col(C.white), 'center');
        }

        const msg = this.keyMsg && now < this.keyMsg.until ? this.keyMsg : null;
        dc.text(msg ? msg.text : 'AWAITING INPUT', 28, 262, 18, msg ? col(msg.color, Math.floor(t * 6) % 2 ? 1 : 0.6) : col(accent, 0.5));
        this.content.memo.forEach((line, i) => dc.text(line, 28, 300 + i * 16, 11, col(accent, 0.55), 'left', false));

        this.button(dc, 'back', 28, 392, 130, 56, '< BACK', accent);

        this.panel(dc, 330, 56, 296, 410, 'KEYPAD');
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'ENT'].forEach((k, i) => {
            const c = k === 'CLR' ? C.orange : k === 'ENT' ? C.green : accent;
            this.button(dc, 'key:' + k, 346 + (i % 3) * 92, 84 + Math.floor(i / 3) * 92, 80, 80, k, c);
        });
    }

    drawCctv(dc, t, now) {
        const C = TERM_COLORS, accent = this.accent, cctv = this.cctv, cams = cctv.cameras;
        const { CAM_LIST: L, CAM_ROW_H, CAM_TRACK: T, FEED: F } = TerminalGUI;

        // ---- Camera list (scrollable, clipped) ----
        this.panel(dc, 14, 56, 190, 410, 'CAMERAS');
        const content = cams.length * CAM_ROW_H;
        const maxScroll = Math.max(0, content - L.h);
        this.scrollTarget = clamp(this.scrollTarget, 0, maxScroll);
        this.scroll += (this.scrollTarget - this.scroll) * 0.3;
        if (Math.abs(this.scrollTarget - this.scroll) < 0.05) this.scroll = this.scrollTarget;

        dc.setClip(L.x, L.y, L.w, L.h);
        cams.forEach((cam, i) => {
            const ry = L.y + i * CAM_ROW_H - this.scroll + 3, rh = CAM_ROW_H - 6;
            if (ry + rh < L.y || ry > L.y + L.h) return;
            const id = 'cam:' + i;
            const y0 = Math.max(ry, L.y), y1 = Math.min(ry + rh, L.y + L.h);   // only the visible part is clickable
            if (y1 > y0) this.addButton(id, L.x, y0, L.w, y1 - y0);
            const sel = i === cctv.selected;
            const hover = this.isHover(id);
            dc.fillRect(L.x, ry, L.w, rh, col(accent, sel ? 0.28 : hover ? 0.14 : 0.05));
            dc.rect(L.x, ry, L.w, rh, 1, col(accent, sel ? 0.9 : hover ? 0.6 : 0.3));
            if (sel) dc.fillRect(L.x, ry, 3, rh, col(accent));
            dc.text(cam.label, L.x + 10, ry + 22, 14, col(sel || hover ? C.white : accent), 'left', sel);
            dc.text(cam.name, L.x + 10, ry + 40, 10, col(accent, 0.65), 'left', false);
            dc.text(cam.offline ? 'NO SIG' : 'LIVE', L.x + L.w - 8, ry + 22, 10, col(cam.offline ? C.red : C.green), 'right', false);
        });
        dc.clearClip();

        // Scrollbar: the thumb is registered before the track so it wins the hit test
        const thumbH = Math.max(24, (T.h * L.h) / content);
        const travel = T.h - thumbH;
        const thumbY = T.y + (maxScroll ? this.scroll / maxScroll : 0) * travel;
        this.scrollInfo = { maxScroll, travel, thumbH };
        this.addButton('thumb', T.x - 3, thumbY, T.w + 6, thumbH);
        this.addButton('track', T.x - 3, T.y, T.w + 6, T.h);
        dc.fillRect(T.x, T.y, T.w, T.h, col(accent, 0.12));
        dc.fillRect(T.x, thumbY, T.w, thumbH, col(accent, this.thumbDrag || this.isHover('thumb') ? 1 : 0.6));

        this.button(dc, 'up', 22, 426, 80, 32, 'UP', accent);
        this.button(dc, 'down', 108, 426, 80, 32, 'DOWN', accent);

        // ---- Live feed: a surface whose material is the CCTV render target ----
        this.panel(dc, 214, 56, 412, 410, 'LIVE FEED');
        const cam = cctv.current;
        dc.fillRect(F.x - 2, F.y - 2, F.w + 4, F.h + 4, col(accent, 0.5));
        dc.setMaterial('cctv');
        dc.stretchPic(F.x, F.y, F.w, F.h, 0, 0, 1, 1, [cctv.signal(now, this.feedSince), 1, 1, 1]);
        dc.setMaterial('atlas');

        const bracket = (x, y, sx, sy) => {
            dc.fillRect(sx > 0 ? x : x - 14, y, 14, 2, col(C.white, 0.7));
            dc.fillRect(x, sy > 0 ? y : y - 14, 2, 14, col(C.white, 0.7));
        };
        bracket(F.x + 8, F.y + 8, 1, 1);
        bracket(F.x + F.w - 10, F.y + 8, -1, 1);
        bracket(F.x + 8, F.y + F.h - 10, 1, -1);
        bracket(F.x + F.w - 10, F.y + F.h - 10, -1, -1);
        dc.text(cam.label, F.x + 16, F.y + 26, 13, col(C.white, 0.9));
        dc.text(timeText(new Date()), F.x + F.w - 16, F.y + 26, 12, col(C.white, 0.85), 'right');
        if (cam.offline) {
            if (Math.floor(t * 2) % 2) dc.text('NO SIGNAL', F.x + F.w / 2, F.y + F.h / 2 + 10, 28, col(C.red), 'center');
        } else {
            const cx = F.x + F.w / 2, cy = F.y + F.h / 2;
            dc.fillRect(cx - 9, cy, 18, 1, col(C.white, 0.45));
            dc.fillRect(cx, cy - 9, 1, 18, col(C.white, 0.45));
            if (Math.floor(t * 1.5) % 2) {
                dc.image('blob', F.x + 14, F.y + F.h - 30, 14, 14, col(C.red));
                dc.text('REC', F.x + 32, F.y + F.h - 18, 12, col(C.red));
            }
        }

        const [rw, rh] = cctv.cfg.resolution;
        dc.text(`${cam.label}  ${cam.name}`, 226, 394, 15, col(C.white));
        dc.text(cam.location, 226, 412, 10, col(accent, 0.7), 'left', false);
        dc.text(cam.offline ? 'LINK DOWN - CHECK DUCT RELAY' : `PAN ${cam.panDeg >= 0 ? '+' : ''}${cam.panDeg} DEG  FOV ${Math.round(deg(cctv.cfg.fovY))}  ${rw}x${rh}`,
            226, 428, 10, col(cam.offline ? C.red : accent, 0.7), 'left', false);
        this.button(dc, 'prev', 432, 400, 86, 40, '< PREV', accent);
        this.button(dc, 'next', 526, 400, 86, 40, 'NEXT >', accent);
    }

    // Out of use range: say so on the screen itself instead of with a HUD prompt
    drawRangeHint(dc, now) {
        const C = TERM_COLORS, pulse = 0.75 + 0.25 * Math.sin((now / 1000) * 6);
        dc.fillRect(90, 196, 460, 88, col([3, 12, 18], 0.92));
        dc.rect(90, 196, 460, 88, 3, col(C.orange, pulse));
        dc.text('MOVE CLOSER TO USE', this.vw / 2, 238, 30, col(C.orange, pulse), 'center');
        dc.text(`TERMINAL RANGE ${this.range} M`, this.vw / 2, 266, 14, col(C.orange, 0.7), 'center', false);
    }

    // ---- input ----
    onHover(id) {
        if (!id.startsWith('track')) this.audio.emit('hover');
    }

    onPress(b) {
        const audio = this.audio, world = this.world, cctv = this.cctv;
        if (!b) {
            audio.emit('miss');
            return;
        }
        if (b.id !== 'thumb' && b.id !== 'track') audio.emit('press');
        const [kind, arg] = b.id.split(':');

        switch (kind) {
            case 'door':
                if (this.door.isOpen) world.setDoor(this.content.door, false);
                else this.showPage('keypad');
                break;
            case 'lights': world.setLights(!world.lightsOn); break;
            case 'alarm': world.setAlarm(!world.alarm); break;
            case 'back': this.showPage('main'); break;
            case 'tab': this.showPage(arg); break;
            case 'cam': cctv.select(Number(arg)); break;
            case 'prev': cctv.select(cctv.selected - 1); break;
            case 'next': cctv.select(cctv.selected + 1); break;
            case 'up': this.scrollTarget -= TerminalGUI.CAM_ROW_H; break;
            case 'down': this.scrollTarget += TerminalGUI.CAM_ROW_H; break;
            case 'thumb':
                this.thumbDrag = { y0: this.cursor.y, s0: this.scrollTarget };
                return true;                                            // capture for dragging
            case 'track': {
                const { maxScroll, travel, thumbH } = this.scrollInfo;
                this.scrollTarget = ((this.cursor.y - TerminalGUI.CAM_TRACK.y - thumbH / 2) / Math.max(1, travel)) * maxScroll;
                break;
            }
            case 'key': this.keyPressed(arg); break;
        }
    }

    keyPressed(k) {
        const C = TERM_COLORS, audio = this.audio, now = performance.now();
        if (k === 'CLR') {
            this.code = '';
        } else if (k === 'ENT') {
            if (this.code === this.content.hatchCode) {
                this.keyMsg = { text: 'ACCESS GRANTED', color: C.green, until: now + 1500 };
                audio.emit('granted');
                audio.later(900, () => {
                    this.showPage('main');
                    this.world.setDoor(this.content.door, true, 'ACCESS GRANTED');
                });
            } else {
                this.keyMsg = { text: 'ACCESS DENIED', color: C.red, until: now + 1500 };
                audio.emit('denied');
                this.world.pushLog(`ACCESS DENIED - INVALID CODE "${this.code || '---'}"`);
                this.code = '';
            }
        } else if (this.code.length < this.content.hatchCode.length) {
            this.code += k;
        }
    }

    pointerDrag() {
        if (!this.thumbDrag || !this.active) return;
        const { maxScroll, travel } = this.scrollInfo;
        this.scrollTarget = this.thumbDrag.s0 + (this.cursor.y - this.thumbDrag.y0) * (maxScroll / Math.max(1, travel));
    }

    pointerUp() {
        this.thumbDrag = null;
    }

    // Wheel over the camera list scrolls it
    wheel(dy) {
        const { CAM_LIST: L, CAM_TRACK: T } = TerminalGUI;
        const { x, y } = this.cursor;
        if (this.page !== 'cctv' || x < L.x || x > T.x + T.w + 3 || y < L.y || y > L.y + L.h) return false;
        this.scrollTarget += dy * 0.4;
        return true;
    }
}

// --------------------------------------------------------------------------------------------- js/gui/easel-gui.js
// Paint easel GUI (640x480): brushes, palette, size, undo / clear, and the painting itself, which is
// a surface whose material is the easel's PaintCanvas render target.

const EASEL_LIGHT = [240, 236, 228];

class EaselGUI extends EntityGUI {
    constructor(def, paint, canvas) {
        super(def);
        this.paint = paint;                 // scenario paint config: brushes, palette, area, size range...
        this.canvas = canvas;
        this.area = paint.area;             // painting rect in GUI space
        this.tool = 0;
        this.color = paint.initialColor;
        this.size = paint.size.initial;
        this.painting = false;
        this.last = null;                   // last stamped point (paint px)
        this.carry = 0;                     // distance already travelled towards the next dab
        this.sizeDrag = false;
        this.strokes = 0;
    }

    get brush() { return this.paint.brushes[this.tool]; }
    get brushRadius() { return this.size * this.brush.sizeMul; }

    inPaint(c) {
        const A = this.area;
        return c.x >= A.x && c.x <= A.x + A.w && c.y >= A.y && c.y <= A.y + A.h;
    }

    toPaintPx(c) {
        const A = this.area;
        return [((c.x - A.x) / A.w) * this.canvas.width, ((c.y - A.y) / A.h) * this.canvas.height];
    }

    // ---- painting ----
    dab(x, y) {
        const b = this.brush;
        const color = b.eraser ? this.paint.paper : this.paint.palette[this.color].map((v) => v / 255);
        this.canvas.pushDab(x, y, this.brushRadius, b, color);
    }

    // Evenly spaced dabs from the last point to the cursor, so fast strokes stay continuous
    strokeTo(cursor) {
        const [x, y] = this.toPaintPx(cursor);
        const spacing = Math.max(0.75, this.brushRadius * this.brush.spacing);
        if (!this.last) {
            this.dab(x, y);
            this.last = [x, y];
            this.carry = 0;
            return;
        }
        const [lx, ly] = this.last;
        const dx = x - lx, dy = y - ly, dist = Math.hypot(dx, dy);
        if (dist < 1e-3) return;
        let s = spacing - this.carry;
        while (s <= dist) {
            this.dab(lx + (dx * s) / dist, ly + (dy * s) / dist);
            s += spacing;
        }
        this.carry = dist - (s - spacing);
        this.last = [x, y];
    }

    sizeFromCursor() {
        const { min, max } = this.paint.size;
        this.size = min + clamp((this.cursor.x - 14) / 88, 0, 1) * (max - min);
    }

    // ---- input ----
    onPress(b) {
        if (this.inPaint(this.cursor)) {
            this.painting = true;
            this.last = null;
            this.strokes++;
            this.canvas.beginStroke();                 // one level of undo per stroke
            this.strokeTo(this.cursor);
            return true;
        }
        if (!b) return;
        this.audio.emit('easel');
        const [kind, v] = b.id.split(':');
        if (kind === 'tool') this.tool = Number(v);
        else if (kind === 'color') { this.color = Number(v); if (this.brush.eraser) this.tool = 0; }
        else if (kind === 'size') { this.sizeDrag = true; this.sizeFromCursor(); return true; }
        else if (kind === 'undo') this.canvas.undo();
        else if (kind === 'clear') this.canvas.clear();
    }

    // Every frame while held: extend the stroke under the cursor
    pointerDrag() {
        if (this.sizeDrag && this.active) this.sizeFromCursor();
        if (!this.painting) return;
        if (!this.active || !this.inPaint(this.cursor)) { this.last = null; return; }
        this.strokeTo(this.cursor);
        if (this.brush.spray) {                                // the airbrush keeps spraying while held still
            const [x, y] = this.toPaintPx(this.cursor);
            const r = this.brushRadius * 0.3;
            this.dab(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r);
        }
    }

    pointerUp() {
        this.painting = false;
        this.sizeDrag = false;
    }

    wheel(dy) {
        this.size = clamp(this.size - dy * 0.02, this.paint.size.min, this.paint.size.max);
        return true;
    }

    // ---- drawing ----
    brushPreview(dc, brush, cx, cy, selected) {
        const ink = selected ? col([40, 36, 34]) : col([225, 220, 212]);
        const a = (alpha) => [ink[0], ink[1], ink[2], alpha];
        switch (brush.preview) {
            case 'soft': dc.image('blob', cx - 14, cy - 14, 28, 28, ink); break;
            case 'zigzag': dc.polyline([[cx - 12, cy + 6], [cx - 4, cy - 6], [cx + 4, cy + 6], [cx + 12, cy - 6]], 1.6, ink); break;
            case 'spray':
                for (let k = 0; k < 28; k++) {
                    const ang = k * 2.39996, r = 12 * Math.sqrt(((k * 37) % 28) / 28);
                    dc.fillRect(cx + Math.cos(ang) * r - 0.8, cy + Math.sin(ang) * r - 0.8, 1.6, 1.6, ink);
                }
                break;
            case 'chisel': dc.line(cx - 11, cy + 7, cx + 11, cy - 7, 8, a(0.55)); break;
            case 'grain':
                for (let k = 0; k < 7; k++) {
                    const x0 = cx - 12 + k * 3.5, y0 = cy + 6 - k * 2;
                    dc.line(x0, y0 + ((k * 5) % 3) - 1, x0 + 3, y0 - 2 + ((k * 7) % 3) - 1, 3, a(0.75));
                }
                break;
            default:
                dc.roundRect(cx - 12, cy - 7, 24, 14, 3, col([245, 160, 170]));
                dc.fillRect(cx - 4, cy - 7, 2, 14, col([200, 110, 125]));
        }
    }

    smallButton(dc, id, x, y, w, h, label, enabled) {
        if (enabled) this.addButton(id, x, y, w, h);
        const hov = enabled && this.isHover(id);
        const pressed = this.isPressed(id);
        dc.roundRect(x, y, w, h, 6, col(pressed ? EASEL_LIGHT : hov ? [74, 70, 66] : [58, 54, 51]));
        dc.text(label, x + w / 2, y + h / 2 + 3.5, 10, pressed ? col([40, 36, 34]) : col(EASEL_LIGHT, enabled ? 1 : 0.3), 'center', false, 'sansBold');
    }

    draw(dc) {
        const P = this.paint, A = this.area;
        dc.fillRect(0, 0, this.vw, this.vh, col([30, 26, 24]));

        // ---- Tool panel ----
        dc.roundRect(6, 6, 104, this.vh - 12, 8, col([44, 40, 38]));
        dc.text('PAINT', 58, 28, 15, col(EASEL_LIGHT), 'center', false, 'sansBold');
        P.brushes.forEach((b, i) => {
            const x = 12 + (i % 2) * 48, y = 38 + Math.floor(i / 2) * 50;
            const id = `tool:${i}`;
            this.addButton(id, x, y, 44, 46);
            const sel = this.tool === i;
            dc.roundRect(x, y, 44, 46, 6, col(sel ? EASEL_LIGHT : this.isHover(id) ? [74, 70, 66] : [58, 54, 51]));
            this.brushPreview(dc, b, x + 22, y + 23, sel);
        });
        dc.text(this.brush.name, 58, 200, 9.5, col(EASEL_LIGHT, 0.85), 'center', false, 'sansBold');
        P.palette.forEach((c, i) => {
            const x = 14 + (i % 3) * 32, y = 210 + Math.floor(i / 3) * 32;
            const id = `color:${i}`;
            this.addButton(id, x - 2, y - 2, 30, 30);
            dc.circle(x + 13, y + 13, 12, col(c), 20);
            if (this.color === i) dc.ring(x + 13, y + 13, 15, 2, col(EASEL_LIGHT), 24);
            else if (this.isHover(id)) dc.ring(x + 13, y + 13, 15, 1.5, col(EASEL_LIGHT, 0.4), 24);
        });

        // Size slider
        const SL = { x: 14, y: 366, w: 88 };
        const { min, max } = P.size;
        dc.text(`SIZE ${Math.round(this.size)}`, SL.x, 356, 10, col(EASEL_LIGHT, 0.85), 'left', false, 'sansBold');
        this.addButton('size', SL.x - 6, SL.y - 11, SL.w + 12, 22);
        const f = (this.size - min) / (max - min);
        const swatch = P.palette[this.color];
        dc.roundRect(SL.x, SL.y - 2, SL.w, 4, 2, col([90, 86, 82]));
        dc.roundRect(SL.x, SL.y - 2, SL.w * f, 4, 2, col(swatch[0] + swatch[1] + swatch[2] > 700 ? [200, 196, 188] : swatch));
        dc.circle(SL.x + SL.w * f, SL.y, this.sizeDrag ? 8 : 7, col(EASEL_LIGHT), 16);
        this.smallButton(dc, 'undo', 12, 386, 44, 28, 'UNDO', this.canvas.canUndo);
        this.smallButton(dc, 'clear', 60, 386, 44, 28, 'CLEAR', true);
        dc.text(`${this.strokes} STROKE${this.strokes === 1 ? '' : 'S'}`, 58, 446, 9, col(EASEL_LIGHT, 0.5), 'center', false, 'sansBold');

        // ---- Painting: a surface whose material is the paint render target ----
        dc.fillRect(A.x - 6, A.y - 6, A.w + 12, A.h + 12, col([96, 62, 34]));
        dc.setMaterial(this.canvas.material);
        dc.stretchPic(A.x, A.y, A.w, A.h, 0, 0, 1, 1, [1, 1, 1, 1]);
        dc.setMaterial('atlas');
    }

    drawRangeHint(dc, now) {
        const pulse = 0.75 + 0.25 * Math.sin((now / 1000) * 6);
        dc.roundRect(180, 196, 400, 80, 10, [0, 0, 0, 0.75]);
        dc.text('MOVE CLOSER TO PAINT', 380, 245, 24, col([255, 214, 10], pulse), 'center', false, 'sansBold');
    }

    // Brush outline over the painting, arrow over the tools
    drawCursor(dc) {
        const c = this.cursor;
        if (!this.inPaint(c)) return super.drawCursor(dc);
        const r = Math.max(2, (this.brushRadius * this.area.w) / this.canvas.width);
        dc.ring(c.x, c.y, r, 1.2, [0, 0, 0, 0.6], 32);
        dc.ring(c.x, c.y, r + 1.2, 1, [1, 1, 1, 0.6], 32);
        dc.fillRect(c.x - 0.75, c.y - 0.75, 1.5, 1.5, [0, 0, 0, 0.8]);
    }
}

// --------------------------------------------------------------------------------------------- js/gui/phone-gui.js
// Phone GUI (270x570): a debug sheet in the style of UnityDebugSheet.
// List pages are pure scenario data; their cells read and write game state through named bindings
// (see Bindings). Pages with an `app` are drawn by a PhoneApp (radar, camera, gallery, IPTV...).

const IOS = {
    bg: [242, 242, 247], cell: [255, 255, 255], sep: [198, 198, 200], text: [0, 0, 0], sub: [142, 142, 147],
    blue: [0, 122, 255], green: [52, 199, 89], red: [255, 59, 48], orange: [255, 149, 0], pink: [255, 45, 85],
    press: [209, 209, 214], track: [233, 233, 234], chevron: [196, 196, 199]
};
const PHONE_NAV_H = 82;             // status bar + navigation bar
const PHONE_TRANSITION_MS = 300;
const TEXT_CELL = { size: 13, lead: 18, width: 214 };

class PhoneGUI extends EntityGUI {
    constructor(game, cfg) {
        super({ id: 'phone', size: cfg.screen, virtual: cfg.virtual, zOffset: cfg.zOffset, anchorMaterial: 'glass', maxVerts: 24000 });
        this.cfg = cfg;
        this.stack = ['root'];
        this.trans = null;          // { from, to, dir, t0 }
        this.scroll = {};
        this.scrollTarget = {};
        this.contentH = {};
        this.drag = null;           // slider binding being dragged
        this.knobs = {};            // animated switch knobs
        this.apps = {
            radar: new RadarApp(this),
            camera: new CameraApp(this),
            photos: new GalleryApp(this),
            viewer: new ViewerApp(this),
            tv: new TvApp(this)
        };
    }

    get bindings() { return this.game.bindings; }
    get currentPage() { return this.stack[this.stack.length - 1]; }

    pagesVisible() {
        return this.trans ? [this.trans.from, this.trans.to] : [this.currentPage];
    }

    // Page definition: data from the scenario, or an app
    pageDef(id) {
        if (id.startsWith('photo:')) return { title: this.apps.viewer.title(id), app: this.apps.viewer };
        const d = this.cfg.pages[id];
        if (!d) return { title: id, sections: [] };
        const title = d.titleBind ? this.bindings.text(d.titleBind) : d.title;
        return d.app ? { title, app: this.apps[d.app] } : { ...d, title };
    }

    // ---- navigation ----
    navigate(to) {
        const from = this.currentPage;
        this.stack.push(to);
        this.scrollTarget[to] = 0;
        this.scroll[to] = 0;
        this.trans = { from, to, dir: 1, t0: performance.now() };
    }

    back() {
        if (this.stack.length < 2) return;
        const from = this.stack.pop();
        this.trans = { from, to: this.currentPage, dir: -1, t0: performance.now() };
    }

    // Swap the top page (e.g. the photo viewer's newer / older), optionally sliding
    replaceTop(to, dir = 0) {
        const from = this.currentPage;
        this.stack[this.stack.length - 1] = to;
        if (dir) this.trans = { from, to, dir, t0: performance.now() };
    }

    // Hit region in absolute phone coordinates, clipped to the scrolling content area
    hit(id, x, y, w, h, clipTop = PHONE_NAV_H) {
        if (this.trans) return;
        const y0 = Math.max(y, clipTop), y1 = Math.min(y + h, this.vh);
        if (y1 > y0) this.addButton(id, x + this.game.dc.ox, y0, w, y1 - y0);
    }

    // ---- input ----
    canHover() {
        return this.active && !this.trans;
    }

    pointerDown() {
        return this.trans ? false : super.pointerDown();
    }

    onPress(b) {
        if (!b) return;
        this.audio.emit('tap');
        const [kind, key, idx] = b.id.split(':');
        const B = this.bindings;
        switch (kind) {
            case 'back': this.back(); return;
            case 'close': this.game.phone.setShown(false); return;
            case 'nav': this.navigate(b.id.slice(4)); return;
            case 'switch': B.spec(key).set(!B.spec(key).get()); return;
            case 'slider': this.drag = key; this.sliderFromCursor(key); return true;
            case 'opt': B.spec(key).set(Number(idx)); this.audio.later(120, () => this.back()); return;
            case 'action': B.action(key); return;
        }
        for (const app of Object.values(this.apps)) {
            if (app.onPress(kind, key, idx)) return;
        }
    }

    sliderFromCursor(key) {
        const s = this.bindings.spec(key);
        s.set(s.min + clamp((this.cursor.x - 28) / 214, 0, 1) * (s.max - s.min));
    }

    pointerDrag() {
        if (this.drag && this.active) this.sliderFromCursor(this.drag);
    }

    pointerUp() {
        this.drag = null;
    }

    wheel(dy) {
        const cur = this.currentPage;
        this.scrollTarget[cur] = (this.scrollTarget[cur] || 0) + dy * 0.35;
        return true;
    }

    // ---- drawing ----
    draw(dc, now) {
        const W = this.vw, H = this.vh;
        if (this.game.iptv.fullscreen) {
            this.apps.tv.drawFullscreen(dc, now);
            this.drawDisplayCorners(dc);
            return;
        }

        // Smooth scrolling for the current page
        const cur = this.currentPage;
        const maxScroll = Math.max(0, (this.contentH[cur] || 0) - (H - PHONE_NAV_H));
        this.scrollTarget[cur] = clamp(this.scrollTarget[cur] || 0, 0, maxScroll);
        this.scroll[cur] = lerp(this.scroll[cur] || 0, this.scrollTarget[cur], 0.3);

        // Pages, with an iOS-style push / pop slide
        if (this.trans) {
            const p = clamp((now - this.trans.t0) / PHONE_TRANSITION_MS, 0, 1);
            const e = easeOutCubic(p);
            const { from, to, dir } = this.trans;
            const under = dir > 0 ? from : to, over = dir > 0 ? to : from;
            const k = dir > 0 ? e : 1 - e;           // how far "over" has slid in
            dc.ox = -k * W * 0.3;
            this.drawPage(dc, under, now, under !== 'root');
            dc.ox = 0;
            dc.fillRect(0, 0, W, H, [0, 0, 0, 0.12 * k]);
            dc.ox = (1 - k) * W;
            this.drawPage(dc, over, now, true);
            dc.ox = 0;
            if (p >= 1) this.trans = null;
        } else {
            this.drawPage(dc, cur, now, this.stack.length > 1);
        }

        // Status bar
        const d = new Date();
        dc.text(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 34, 27, 14, col(IOS.text), 'left', false, 'sansBold');
        dc.roundRect(98, 10, 74, 22, 11, col([0, 0, 0]));
        for (let i = 0; i < 4; i++) dc.fillRect(196 + i * 5, 25 - (4 + i * 2.5), 3.2, 4 + i * 2.5, col(IOS.text));
        dc.rect(220, 15, 24, 12, 1.2, col(IOS.text, 0.45));
        dc.fillRect(244.5, 18.5, 1.8, 5, col(IOS.text, 0.45));
        dc.fillRect(222, 17, 17, 8, col(IOS.text));
        // Home indicator & rounded display corners
        dc.roundRect(W / 2 - 50, H - 10, 100, 4.5, 2.25, col(IOS.text, 0.85));
        this.drawDisplayCorners(dc);
    }

    drawDisplayCorners(dc) {
        const W = this.vw, H = this.vh, R = 30;
        for (const [x, y, a0] of [[0, 0, Math.PI], [W, 0, -Math.PI / 2], [W, H, 0], [0, H, Math.PI / 2]]) {
            const ccx = x === 0 ? R : W - R, ccy = y === 0 ? R : H - R;
            dc.polygon([[x, y], ...dc.arcPts(ccx, ccy, R, a0, a0 + Math.PI / 2, 8)], col([6, 6, 7]));
        }
    }

    // Touch pointer instead of an arrow
    drawCursor(dc) {
        dc.circle(this.cursor.x, this.cursor.y, 9, [0.2, 0.2, 0.25, this.drag ? 0.45 : 0.3], 20);
        dc.ring(this.cursor.x, this.cursor.y, 9, 1, [1, 1, 1, 0.6], 20);
    }

    drawPage(dc, id, now, canBack) {
        const def = this.pageDef(id);
        dc.fillRect(0, 0, this.vw, this.vh, col(IOS.bg));
        if (def.app) def.app.draw(dc, now, id);
        else this.drawListPage(dc, id, def, now);
        this.drawNavBar(dc, def.title, canBack);
    }

    drawNavBar(dc, title, canBack) {
        const W = this.vw;
        dc.fillRect(0, 0, W, PHONE_NAV_H, col([249, 249, 249], 0.97));
        dc.fillRect(0, PHONE_NAV_H - 1.5, W, 1.5, col(IOS.sep, 0.55));
        dc.text(title, W / 2, 69, 17, col(IOS.text), 'center', false, 'sansBold');
        if (canBack) {
            this.hit('back', 2, 44, 84, 38, 0);
            const c = col(IOS.blue, this.isHover('back') ? 0.55 : 1);
            dc.polyline([[21, 56], [13.5, 63.5], [21, 71]], 2.6, c);
            dc.text('Back', 26, 69, 16, c, 'left', false, 'sans');
        }
        this.hit('close', W - 48, 44, 46, 38, 0);
        const cc = col(IOS.blue, this.isHover('close') ? 0.55 : 1);
        dc.line(W - 27, 57, W - 15, 69, 2.2, cc);
        dc.line(W - 15, 57, W - 27, 69, 2.2, cc);
    }

    // ---- data-driven list pages ----
    sectionCells(sec) {
        const B = this.bindings;
        if (sec.optionsBind) {
            return B.spec(sec.optionsBind).options().map((o, i) => ({ type: 'option', bind: sec.optionsBind, index: i, title: o.title, sub: o.sub }));
        }
        return sec.cells.map((cell) => {
            const c = { ...cell };
            if (cell.titleBind) c.title = B.text(cell.titleBind);
            if (cell.subBind) c.sub = B.text(cell.subBind);
            if (cell.type === 'label' && cell.bind) c.value = B.text(cell.bind);
            return c;
        });
    }

    cellHeight(dc, c) {
        if (c.type === 'text') return 16 + dc.wrapText(c.text, TEXT_CELL.size, 'sans', TEXT_CELL.width).length * TEXT_CELL.lead;
        if (c.type === 'slider') return 64;
        return (c.type === 'nav' || c.type === 'option') && c.sub ? 54 : 44;
    }

    drawListPage(dc, id, def, now) {
        const B = this.bindings;
        const scroll = this.scroll[id] || 0;
        let y = PHONE_NAV_H + 4 - scroll;
        dc.setClip(0, PHONE_NAV_H, this.vw, this.vh - PHONE_NAV_H);
        for (const sec of def.sections) {
            if (sec.header) {
                dc.text(sec.header, 28, y + 26, 11.5, col(IOS.sub), 'left', false, 'sans');
                y += 34;
            } else {
                y += 16;
            }
            const cells = this.sectionCells(sec);
            const heights = cells.map((c) => this.cellHeight(dc, c));
            const total = heights.reduce((a, b) => a + b, 0);
            dc.roundRect(12, y, 246, total, 10, col(IOS.cell));
            let cy = y;
            cells.forEach((cell, i) => {
                this.drawCell(dc, cell, cy, heights[i], i === cells.length - 1, now);
                cy += heights[i];
            });
            y += total;
            const footer = sec.footerBind ? B.text(sec.footerBind) : sec.footer;
            if (footer) {
                const lines = dc.wrapText(footer, 11, 'sans', 214);
                lines.forEach((ln, i) => dc.text(ln, 28, y + 18 + i * 14, 11, col(IOS.sub), 'left', false, 'sans'));
                y += 10 + lines.length * 14;
            }
        }
        dc.clearClip();
        this.contentH[id] = y + scroll + 24 - PHONE_NAV_H;
    }

    chevron(dc, x, cy) {
        dc.polyline([[x - 3, cy - 5.5], [x + 2.5, cy], [x - 3, cy + 5.5]], 2, col(IOS.chevron));
    }

    drawSwitch(dc, key, x, y) {
        const on = this.bindings.spec(key).get() ? 1 : 0;
        const k = this.knobs[key] ?? on;
        const nk = Math.abs(on - k) < 0.01 ? on : lerp(k, on, 0.3);
        this.knobs[key] = nk;
        dc.roundRect(x, y, 46, 28, 14, col(mixRGB(IOS.track, IOS.green, nk)));
        const kx = x + 14 + nk * 18;
        dc.image('blob', kx - 16, y - 1, 32, 32, [0, 0, 0, 0.18]);
        dc.circle(kx, y + 14, 12, col(IOS.cell));
    }

    static hitId(cell) {
        switch (cell.type) {
            case 'nav': case 'picker': return `nav:${cell.page}`;
            case 'switch': return `switch:${cell.bind}`;
            case 'slider': return `slider:${cell.bind}`;
            case 'action': return `action:${cell.action}`;
            case 'option': return `opt:${cell.bind}:${cell.index}`;
        }
        return null;
    }

    drawCell(dc, cell, cy, h, isLast, now) {
        const B = this.bindings;
        const x0 = 12, w = 246;
        const hitId = PhoneGUI.hitId(cell);
        if (hitId) this.hit(hitId, x0, cy, w, h);
        const hover = hitId && this.isHover(hitId) && !this.trans;
        const pressed = hitId && this.isPressed(hitId, 220);
        if ((hover || pressed) && cell.type !== 'slider' && cell.type !== 'switch') {
            dc.roundRect(x0 + 2, cy + 2, w - 4, h - 4, 8, col(pressed ? IOS.press : IOS.bg));
        }

        let tx = 28;
        if (cell.icon) {
            dc.roundRect(24, cy + (h - 28) / 2, 28, 28, 7, col(cell.icon[0]));
            dc.text(cell.icon[1], 38, cy + h / 2 + 5.5, 15, col(IOS.cell), 'center', false, 'sansBold');
            tx = 62;
        }
        const mid = cy + h / 2 + 5.5;
        const title = (color = IOS.text) => dc.text(cell.title, tx, mid, 15, col(color), 'left', false, 'sans');
        switch (cell.type) {
            case 'nav':
            case 'option':
                if (cell.sub) {
                    dc.text(cell.title, tx, cy + 23, 15, col(IOS.text), 'left', false, 'sans');
                    dc.text(cell.sub, tx, cy + 40, 11.5, col(IOS.sub), 'left', false, 'sans');
                } else {
                    title();
                }
                if (cell.type === 'nav') this.chevron(dc, 240, cy + h / 2);
                else if (B.spec(cell.bind).get() === cell.index) {
                    dc.polyline([[230, cy + h / 2], [235, cy + h / 2 + 5], [244, cy + h / 2 - 6]], 2.2, col(IOS.blue));
                }
                break;
            case 'text':
                dc.wrapText(cell.text, TEXT_CELL.size, 'sans', TEXT_CELL.width).forEach((ln, i) => {
                    dc.text(ln, tx, cy + 22 + i * TEXT_CELL.lead, TEXT_CELL.size, col(IOS.text), 'left', false, 'sans');
                });
                break;
            case 'label':
                title();
                dc.text(cell.value, 244, mid, 14, col(IOS.sub), 'right', false, 'sans');
                break;
            case 'action':
                title(IOS.blue);
                break;
            case 'picker': {
                title();
                const s = B.spec(cell.bind);
                dc.text(s.label(s.get()), 230, mid, 14, col(IOS.sub), 'right', false, 'sans');
                this.chevron(dc, 240, cy + h / 2);
                break;
            }
            case 'switch':
                title();
                this.drawSwitch(dc, cell.bind, 198, cy + (h - 28) / 2);
                break;
            case 'slider': {
                const s = B.spec(cell.bind);
                const v = s.get();
                const f = clamp((v - s.min) / (s.max - s.min), 0, 1);
                const dragging = this.drag === cell.bind;
                dc.text(cell.title, tx, cy + 24, 15, col(IOS.text), 'left', false, 'sans');
                dc.text(s.fmt(v), 244, cy + 24, 14, col(IOS.sub), 'right', false, 'sans');
                const ty = cy + 45, tw = 214;
                dc.roundRect(28, ty - 2, tw, 4, 2, col(IOS.track));
                dc.roundRect(28, ty - 2, tw * f, 4, 2, col(IOS.blue));
                const kx = 28 + tw * f;
                dc.image('blob', kx - 15, ty - 13, 30, 30, [0, 0, 0, dragging ? 0.3 : 0.18]);
                dc.circle(kx, ty, dragging ? 12 : 11, col(IOS.cell));
                break;
            }
        }
        if (!isLast) dc.fillRect(tx, cy + h - 1.5, 258 - tx, 1.5, col(IOS.sep, 0.55));
    }
}

// -------------------------------------------------------------------------------------------- js/gui/phone-apps.js
// Phone apps: custom-drawn pages of the PhoneGUI.

class PhoneApp {
    constructor(phone) {
        this.phone = phone;
    }

    get game() { return this.phone.game; }
    get W() { return this.phone.vw; }
    get H() { return this.phone.vh; }

    draw(dc, now, pageId) {}
    // Handle a press on one of this app's hit regions; return true if handled
    onPress(kind, key, idx) { return false; }
}

// Far Cry-style radar: heading-up, rotating compass ring, tracked objects and sound waves
class RadarApp extends PhoneApp {
    static DISC = { x: 135, y: 254, R: 92 };

    get cfg() { return this.game.scenario.radar; }

    point(wx, wz) {
        const p = this.game.player, D = RadarApp.DISC;
        const dx = wx - p.pos[0], dz = wz - p.pos[2];
        const dist = Math.hypot(dx, dz);
        const a = Math.atan2(dx, -dz) - p.yaw;
        const r = (dist / this.cfg.range) * D.R;
        return { x: D.x + Math.sin(a) * r, y: D.y - Math.cos(a) * r, r, dist, a, bearingDeg: bearingOf(dx, dz) };
    }

    // Scenario-listed objects, resolved to current positions
    tracked() {
        const { world, player } = this.game;
        return this.cfg.tracked.map((t) => {
            if (t.nearest) {
                const pick = world.ofType(ENTITY_TYPES[t.nearest])
                    .map((e) => ({ e, d: Math.hypot(e.position[0] - player.pos[0], e.position[2] - player.pos[2]) }))
                    .sort((a, b) => a.d - b.d)[0].e;
                return { ...t, name: `${t.prefix}${pick.label}`, x: pick.position[0], z: pick.position[2] };
            }
            const e = world.get(t.entity);
            return { ...t, x: e.position[0], z: e.position[2] };
        });
    }

    draw(dc, now) {
        const t = now / 1000, G = [120, 255, 150];
        const { x: cx, y: cy, R } = RadarApp.DISC;
        const { player, world, cctv } = this.game;
        const range = this.cfg.range;
        const top = PHONE_NAV_H;

        dc.roundRect(12, top + 8, 246, 304, 14, col([8, 16, 10]));

        // Noise meter + heading readout
        dc.text('NOISE', 26, top + 28, 11, col(G), 'left', false, 'sansBold');
        dc.roundRect(70, top + 20, 100, 8, 4, col(G, 0.15));
        const n = clamp(player.noise, 0, 1);
        const nc = n < 0.4 ? G : n < 0.75 ? [255, 214, 10] : [255, 69, 58];
        if (n > 0.01) dc.roundRect(70, top + 20, 100 * n, 8, 4, col(nc));
        dc.text(`HDG ${pad3(player.heading)}°`, 246, top + 28, 12, col(G), 'right', false, 'sansBold');

        // Disc, range rings, crosshair
        dc.circle(cx, cy, R, col([12, 42, 20]), 48);
        for (const k of [1, 2]) dc.ring(cx, cy, (R * k) / 3, 1, col(G, 0.22));
        dc.ring(cx, cy, R, 1.5, col(G, 0.6));
        dc.fillRect(cx - R, cy - 0.5, R * 2, 1, col(G, 0.15));
        dc.fillRect(cx - 0.5, cy - R, 1, R * 2, col(G, 0.15));
        dc.text(`${range / 3}m`, cx + 3, cy - R / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');
        dc.text(`${(range * 2) / 3}m`, cx + 3, cy - (R * 2) / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');

        // Sweep
        const sw = t * 2.2;
        dc.polygon([[cx, cy], ...dc.arcPts(cx, cy, R - 1, sw - 0.6, sw, 10)], col(G, 0.08));
        dc.line(cx, cy, cx + Math.cos(sw) * (R - 1), cy + Math.sin(sw) * (R - 1), 1.2, col(G, 0.45));

        // Rotating compass ring
        for (let d = 0; d < 360; d += 15) {
            const a = rad(d) - player.yaw;
            const len = d % 90 === 0 ? 10 : d % 45 === 0 ? 7 : 4;
            const s = Math.sin(a), c = -Math.cos(a);
            dc.line(cx + s * (R + 3), cy + c * (R + 3), cx + s * (R + 3 + len), cy + c * (R + 3 + len), d % 90 === 0 ? 2 : 1, col(G, d % 45 === 0 ? 0.9 : 0.45));
        }
        for (const [d, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
            const a = rad(d) - player.yaw;
            dc.text(label, cx + Math.sin(a) * (R + 22), cy - Math.cos(a) * (R + 22) + 4.5, 13, col(label === 'N' ? [255, 69, 58] : G), 'center', false, 'sansBold');
        }

        // Sound waves (world-anchored rings), clipped to the disc
        for (const w of world.waves.list) {
            const age = t - w.t0;
            if (age < 0 || age > w.life) continue;
            const c = this.point(w.x, w.z);
            const rr = ((w.speed * age) / range) * R;
            const alpha = w.alpha * (1 - age / w.life);
            const pts = dc.arcPts(c.x, c.y, rr, 0, Math.PI * 2, 40);
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i], p1 = pts[i + 1];
                if (Math.hypot(p0[0] - cx, p0[1] - cy) > R - 1 || Math.hypot(p1[0] - cx, p1[1] - cy) > R - 1) continue;
                dc.line(p0[0], p0[1], p1[0], p1[1], 1.6, col(w.color, alpha));
            }
        }

        // Cameras as small squares
        for (const cam of cctv.cameras) {
            const p = this.point(cam.position[0], cam.position[2]);
            if (p.r > R - 3) continue;
            dc.fillRect(p.x - 2.5, p.y - 2.5, 5, 5, col([255, 214, 10], cam.offline ? 0.35 : 0.85));
        }
        // Tracked objects (clamped to the rim when out of range)
        const tracked = this.tracked();
        for (const o of tracked) {
            if (o.shape === 'camera') continue;
            const p = this.point(o.x, o.z);
            const out = p.r > R - 6;
            const bx = out ? cx + Math.sin(p.a) * (R - 6) : p.x;
            const by = out ? cy - Math.cos(p.a) * (R - 6) : p.y;
            const alpha = out ? 0.5 : 1;
            if (o.shape === 'pulse') {
                const pulse = (t * 1.5) % 1;
                if (!out) dc.ring(bx, by, 5 + pulse * 10, 1.2, col(o.color, 0.8 * (1 - pulse)), 24);
                dc.circle(bx, by, 5, col(o.color, alpha), 16);
            } else if (o.shape === 'diamond') {
                dc.polygon([[bx, by - 6], [bx + 6, by], [bx, by + 6], [bx - 6, by]], col(o.color, alpha));
            } else {
                dc.fillRect(bx - 6, by - 3, 12, 6, col(o.color, alpha));
            }
        }

        // Player
        dc.polygon([[cx, cy - 10], [cx + 7, cy + 7], [cx, cy + 3], [cx - 7, cy + 7]], col([255, 255, 255]));

        // Tracking list
        dc.text('TRACKING', 28, top + 338, 11.5, col(IOS.sub), 'left', false, 'sans');
        const listTop = top + 346;
        dc.roundRect(12, listTop, 246, tracked.length * 32, 10, col(IOS.cell));
        tracked.forEach((o, i) => {
            const y = listTop + i * 32;
            const p = this.point(o.x, o.z);
            dc.circle(30, y + 16, 5, col(o.color), 14);
            dc.text(o.name, 44, y + 21, 13.5, col(IOS.text), 'left', false, 'sans');
            dc.text(`${p.dist.toFixed(1)} m  ${pad3(p.bearingDeg)}°`, 244, y + 21, 12, col(IOS.sub), 'right', false, 'sans');
            if (i < tracked.length - 1) dc.fillRect(44, y + 30.5, 214, 1.5, col(IOS.sep, 0.55));
        });
    }
}

// Camera: live viewfinder (the phone camera's render target), photo / video modes
class CameraApp extends PhoneApp {
    draw(dc, now, id) {
        const t = now / 1000, W = this.W, H = this.H, phone = this.phone;
        const cam = this.game.camera, lib = cam.library;
        phone.contentH[id] = 0;
        dc.fillRect(0, PHONE_NAV_H, W, H - PHONE_NAV_H, col([0, 0, 0]));
        const video = cam.mode === 'video';
        const rec = cam.rec;

        // Live viewfinder: a surface whose material is the phone camera's render target
        const V = { x: 0, y: PHONE_NAV_H + 6, w: W, h: 360 };
        dc.setMaterial('viewfinder');
        dc.stretchPic(V.x, V.y, V.w, V.h, 0, 0, 1, 1, [1, 1, 1, 1]);
        dc.setMaterial('atlas');
        for (const k of [1, 2]) {
            dc.fillRect(V.x + (V.w * k) / 3, V.y, 1, V.h, [1, 1, 1, 0.22]);
            dc.fillRect(V.x, V.y + (V.h * k) / 3, V.w, 1, [1, 1, 1, 0.22]);
        }
        const fs = 42 + Math.sin(t * 3) * 2;
        dc.rect(W / 2 - fs / 2, V.y + V.h / 2 - fs / 2, fs, fs, 1.5, col([255, 214, 10]));
        dc.roundRect(8, V.y + 8, 72, 20, 10, [0, 0, 0, 0.45]);
        dc.text(`HDG ${pad3(this.game.player.heading)}°`, 44, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
        const right = video ? `${clipTime(cam.freeVideoSeconds)} free` : `${lib.counts().photos}/${cam.cfg.photo.capacity}`;
        dc.roundRect(W - 72, V.y + 8, 64, 20, 10, [0, 0, 0, 0.45]);
        dc.text(right, W - 40, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
        if (rec) {
            // Recording timer + progress along the bottom of the viewfinder
            const secs = cam.recordingSeconds, max = cam.cfg.video.maxSeconds;
            dc.roundRect(W / 2 - 46, V.y + 8, 92, 20, 10, col(IOS.red, 0.92));
            if (Math.floor(t * 2) % 2) dc.circle(W / 2 - 33, V.y + 18, 3.5, [1, 1, 1, 1], 12);
            dc.text(`${clipTime(secs)} / ${clipTime(max)}`, W / 2 + 6, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
            dc.fillRect(V.x, V.y + V.h - 3, V.w * Math.min(1, secs / max), 3, col(IOS.red));
        }
        const since = now - cam.lastShot;
        if (since < 280) dc.fillRect(V.x, V.y, V.w, V.h, [1, 1, 1, 1 - since / 280]);

        // Mode switch (locked while recording)
        const MY = V.y + V.h + 20;
        for (const [mode, x] of [['video', W / 2 - 38], ['photo', W / 2 + 38]]) {
            if (!rec) phone.hit(`mode:${mode}`, x - 32, MY - 14, 64, 24);
            const color = cam.mode === mode ? col([255, 214, 10]) : [1, 1, 1, rec ? 0.3 : phone.isHover(`mode:${mode}`) ? 1 : 0.7];
            dc.text(mode.toUpperCase(), x, MY + 4, 12, color, 'center', false, 'sansBold');
        }

        // Shutter: white for photos, red record / square stop for video
        const CY = H - 54;
        const hover = phone.isHover('shutter');
        const pressed = phone.isPressed('shutter', 180);
        phone.hit('shutter', W / 2 - 32, CY - 32, 64, 64);
        dc.ring(W / 2, CY, 30, 3, [1, 1, 1, 1], 40);
        if (!video) dc.circle(W / 2, CY, pressed ? 21 : 25, [1, 1, 1, hover ? 0.8 : 1], 36);
        else if (rec) dc.roundRect(W / 2 - 11, CY - 11, 22, 22, 5, col(IOS.red, hover ? 0.8 : 1));
        else dc.circle(W / 2, CY, pressed ? 21 : 24, col(IOS.red, hover ? 0.8 : 1), 36);

        // Newest item (opens the gallery)
        if (lib.items.length) {
            const item = lib.items[0];
            phone.hit('nav:photos', 18, CY - 22, 44, 44);
            lib.draw(dc, item, 18, CY - 22, 44, 44, true, item.kind === 'video' ? lib.frameAt(item, now) : 0);
            dc.rect(18, CY - 22, 44, 44, 1.5, [1, 1, 1, phone.isHover('nav:photos') ? 1 : 0.7]);
        } else {
            dc.roundRect(18, CY - 22, 44, 44, 6, [1, 1, 1, 0.12]);
        }
    }

    onPress(kind, key) {
        const cam = this.game.camera;
        if (kind === 'shutter') cam.shutter();
        else if (kind === 'mode') cam.mode = key;
        else return false;
        return true;
    }
}

// Photo / video grid
class GalleryApp extends PhoneApp {
    draw(dc, now, id) {
        const phone = this.phone, W = this.W, lib = this.game.camera.library, items = lib.items;
        const scroll = phone.scroll[id] || 0;
        const gap = 2, cs = (W - gap * 2) / 3;
        let y = PHONE_NAV_H + 6 - scroll;
        dc.setClip(0, PHONE_NAV_H, W, this.H - PHONE_NAV_H);
        dc.text(lib.summary(), 14, y + 16, 12, col(IOS.sub), 'left', false, 'sans');
        y += 26;
        if (!items.length) {
            dc.text('No photos or videos yet', W / 2, PHONE_NAV_H + 200, 17, col(IOS.text), 'center', false, 'sansBold');
            dc.text('Use the Camera page.', W / 2, PHONE_NAV_H + 222, 12, col(IOS.sub), 'center', false, 'sans');
        }
        const cell = (i) => [(i % 3) * (cs + gap), y + Math.floor(i / 3) * (cs + gap)];
        // Thumbnails grouped per material (photos, then videos) to keep the surface count low
        dc.setMaterial('photos');
        items.forEach((m, i) => {
            if (m.kind !== 'photo') return;
            const [x, ty] = cell(i);
            const [u0, v0, u1, v1] = lib.photoUV(m.slot, true);
            dc.stretchPic(x, ty, cs, cs, u0, v0, u1, v1, [1, 1, 1, 1]);
        });
        dc.setMaterial('video');
        items.forEach((m, i) => {
            if (m.kind !== 'video') return;
            const [x, ty] = cell(i);
            const inset = lib.frameSquareInset;
            dc.stretchPic(x, ty, cs, cs, 0, inset, 1, 1 - inset, [m.frames[lib.frameAt(m, now)], 1, 1, 1]);   // thumbnails play along
        });
        dc.setMaterial('atlas');
        items.forEach((m, i) => {
            const [x, ty] = cell(i);
            const hid = `nav:photo:${m.id}`;
            phone.hit(hid, x, ty, cs, cs);
            if (m.kind === 'video') {
                dc.fillRect(x, ty + cs - 20, cs, 20, [0, 0, 0, 0.35]);
                dc.playIcon(x + 11, ty + cs - 10, 8, [1, 1, 1, 0.95]);
                dc.text(clipTime(lib.duration(m)), x + cs - 6, ty + cs - 5.5, 11, col([255, 255, 255]), 'right', false, 'sansBold');
            }
            const pressed = phone.isPressed(hid, 220);
            if (phone.isHover(hid) || pressed) dc.fillRect(x, ty, cs, cs, [1, 1, 1, pressed ? 0.4 : 0.2]);
        });
        dc.clearClip();
        phone.contentH[id] = 32 + Math.ceil(items.length / 3) * (cs + gap) + 16;
    }
}

// Full photo / looping video with newer / older / delete
class ViewerApp extends PhoneApp {
    constructor(phone) {
        super(phone);
        this.player = null;         // video playback { id, start, paused, pos }
    }

    get library() { return this.game.camera.library; }

    index(pageId) {
        return this.library.indexOf(Number(pageId.slice(6)));
    }

    title(pageId) {
        const idx = this.index(pageId);
        return idx < 0 ? 'Photo' : `${idx + 1} of ${this.library.items.length}`;
    }

    draw(dc, now, id) {
        const phone = this.phone, W = this.W, lib = this.library;
        phone.contentH[id] = 0;
        const idx = this.index(id);
        const item = lib.items[idx];
        dc.fillRect(0, PHONE_NAV_H, W, this.H - PHONE_NAV_H, col([0, 0, 0]));
        if (!item) {
            dc.text('Deleted', W / 2, 300, 14, col(IOS.sub), 'center', false, 'sans');
            return;
        }
        const IY = PHONE_NAV_H + 8, IH = 360;
        let extra = '';
        if (item.kind === 'photo') {
            lib.draw(dc, item, 0, IY, W, IH, false);
        } else {
            // Playback loops; tap the picture to pause / resume
            const dur = lib.duration(item);
            if (!this.player || this.player.id !== item.id) this.player = { id: item.id, start: now, paused: false, pos: 0 };
            const pl = this.player;
            if (!pl.paused) pl.pos = ((now - pl.start) / 1000) % dur;
            lib.draw(dc, item, 0, IY, W, IH, false, Math.min(item.frames.length - 1, Math.floor(pl.pos * lib.cfg.video.fps)));
            phone.hit('pv:toggle', 0, IY, W, IH);
            if (pl.paused) {
                dc.circle(W / 2, IY + IH / 2, 30, [0, 0, 0, 0.5], 32);
                dc.playIcon(W / 2 + 3, IY + IH / 2, 24, [1, 1, 1, 0.95]);
            }
            dc.fillRect(0, IY + IH - 3, W, 3, [1, 1, 1, 0.25]);
            dc.fillRect(0, IY + IH - 3, W * (pl.pos / dur), 3, [1, 1, 1, 0.95]);
            dc.roundRect(8, IY + IH - 28, 80, 18, 9, [0, 0, 0, 0.5]);
            dc.text(`${clipTime(pl.pos)} / ${clipTime(dur)}`, 48, IY + IH - 15, 10.5, col([255, 255, 255]), 'center', false, 'sansBold');
            extra = `  ·  Video ${clipTime(dur)}`;
        }
        const Y = IY + IH;
        dc.text(item.label, 16, Y + 24, 15, col([255, 255, 255]), 'left', false, 'sansBold');
        dc.text(`Today ${timeText(item.time)}${extra}`, 16, Y + 42, 11.5, col(IOS.sub), 'left', false, 'sans');
        dc.text(`HDG ${pad3(item.hdg)}°`, W - 16, Y + 42, 11.5, col(IOS.sub), 'right', false, 'sans');

        const TY = this.H - 40;
        const tool = (hid, x, label, color, enabled) => {
            if (enabled) phone.hit(hid, x - 38, TY - 22, 76, 40);
            dc.text(label, x, TY + 5, 15, col(color, enabled ? (phone.isHover(hid) ? 0.55 : 1) : 0.3), 'center', false, 'sans');
        };
        tool('pv:prev', 48, '‹ Newer', IOS.blue, idx > 0);
        tool('pv:delete', W / 2, 'Delete', IOS.red, true);
        tool('pv:next', W - 48, 'Older ›', IOS.blue, idx < lib.items.length - 1);
    }

    onPress(kind, key) {
        if (kind !== 'pv') return false;
        const phone = this.phone, lib = this.library;
        const idx = this.index(phone.currentPage);
        if (idx < 0) return true;
        if (key === 'toggle') {
            const pl = this.player;
            if (pl) {
                if (pl.paused) pl.start = performance.now() - pl.pos * 1000;
                pl.paused = !pl.paused;
            }
        } else if (key === 'delete') {
            lib.remove(idx);
            this.game.audio.emit('delete');
            if (!lib.items.length) phone.back();
            else phone.replaceTop(`photo:${lib.items[Math.min(idx, lib.items.length - 1)].id}`);
        } else {
            const ni = idx + (key === 'next' ? 1 : -1);
            if (ni >= 0 && ni < lib.items.length) phone.replaceTop(`photo:${lib.items[ni].id}`, key === 'next' ? 1 : -1);
        }
        return true;
    }
}

// IPTV: player, transport controls and the channel list
class TvApp extends PhoneApp {
    static PLAYER_H = 152;

    get iptv() { return this.game.iptv; }
    get listTop() { return PHONE_NAV_H + TvApp.PLAYER_H + 50; }

    drawTestCard(dc, R) {
        const bars = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192]];
        const rev = [[0, 0, 192], [19, 19, 19], [192, 0, 192], [19, 19, 19], [0, 192, 192], [19, 19, 19], [192, 192, 192]];
        const bw = R.w / 7, h1 = R.h * 0.67, h2 = R.h * 0.08;
        bars.forEach((c, i) => dc.fillRect(R.x + i * bw, R.y, bw + 0.5, h1, col(c)));
        rev.forEach((c, i) => dc.fillRect(R.x + i * bw, R.y + h1, bw + 0.5, h2, col(c)));
        const y3 = R.y + h1 + h2, h3 = R.h - h1 - h2;
        [[0, 33, 76], [255, 255, 255], [50, 0, 106]].forEach((c, i) => dc.fillRect(R.x + i * bw * 1.25, y3, bw * 1.25 + 0.5, h3, col(c)));
        dc.fillRect(R.x + bw * 3.75, y3, R.w - bw * 3.75, h3, col([19, 19, 19]));
        const cx = R.x + R.w / 2, cy = R.y + R.h * 0.42;
        dc.ring(cx, cy, R.h * 0.3, 1.5, [1, 1, 1, 0.8], 48);
        dc.roundRect(cx - 48, cy - 12, 96, 24, 4, [0, 0, 0, 0.8]);
        dc.text(timeText(new Date()), cx, cy + 5, 13, col([255, 255, 255]), 'center', false, 'sansBold');
        dc.text(this.iptv.cfg.cardTitle, cx, R.y + 16, 9.5, [1, 1, 1, 0.9], 'center', false, 'sansBold');
    }

    // The current channel's picture in rect R (letterboxed)
    drawPicture(dc, R, now) {
        const tv = this.iptv, ch = tv.current, cctv = this.game.cctv;
        dc.fillRect(R.x, R.y, R.w, R.h, col([0, 0, 0]));
        if (ch.kind === 'card') {
            this.drawTestCard(dc, R);
        } else if (ch.kind === 'cctv') {
            const cam = cctv.current;
            const r = fitRect(R, cctv.aspect);
            dc.setMaterial('cctv');
            dc.stretchPic(r.x, r.y, r.w, r.h, 0, 0, 1, 1, [cctv.signal(now, tv.switchTime), 1, 1, 1]);
            dc.setMaterial('atlas');
            dc.text(`${cam.label} ${cam.name}`, r.x + 8, r.y + r.h - 8, 9.5, [1, 1, 1, 0.9], 'left', false, 'sansBold');
        } else {
            if (tv.hasFrame) {
                const r = fitRect(R, tv.aspect);
                dc.setMaterial('tv');
                dc.stretchPic(r.x, r.y, r.w, r.h, 0, 0, 1, 1, [1, 1, 1, 1]);
                dc.setMaterial('atlas');
            }
            const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
            if (tv.status === 'error') {
                dc.fillRect(R.x, R.y, R.w, R.h, [0, 0, 0, 0.7]);
                dc.text('Stream unavailable', cx, cy - 2, 14, col([255, 255, 255]), 'center', false, 'sansBold');
                dc.text(`${tv.error} · tap to retry`, cx, cy + 16, 10.5, col(IOS.sub), 'center', false, 'sans');
            } else if (tv.status === 'loading' || tv.status === 'buffering' || !tv.hasFrame) {
                dc.spinner(cx, cy, 13, now / 1000);
            } else if (!tv.playing) {
                dc.circle(cx, cy, 22, [0, 0, 0, 0.5], 28);
                dc.playIcon(cx + 2, cy, 18, [1, 1, 1, 0.95]);
            }
        }
    }

    iconButton(dc, id, cx, cy, enabled, draw) {
        const phone = this.phone;
        if (enabled) phone.hit(id, cx - 22, cy - 20, 44, 40);
        const pressed = phone.isPressed(id, 180);
        if (phone.isHover(id) || pressed) dc.circle(cx, cy, 18, col(IOS.text, pressed ? 0.12 : 0.06), 24);
        draw(col(IOS.text, enabled ? 1 : 0.25));
    }

    draw(dc, now, id) {
        const t = now / 1000, phone = this.phone, W = this.W, tv = this.iptv, ch = tv.current, v = tv.video;
        const P = { x: 0, y: PHONE_NAV_H, w: W, h: TvApp.PLAYER_H };
        const listTop = this.listTop;

        // ---- Channel list (scrolls under the player) ----
        const scroll = phone.scroll[id] || 0;
        const rowH = 52;
        let y = listTop - scroll;
        dc.setClip(0, listTop, W, this.H - listTop);
        dc.text('CHANNELS', 28, y + 20, 11.5, col(IOS.sub), 'left', false, 'sans');
        y += 28;
        dc.roundRect(12, y, 246, tv.channels.length * rowH, 10, col(IOS.cell));
        tv.channels.forEach((c, i) => {
            const ry = y + i * rowH;
            const hid = `tv:ch:${i}`;
            phone.hit(hid, 12, ry, 246, rowH, listTop);
            const pressed = phone.isPressed(hid, 220);
            if (phone.isHover(hid) || pressed) dc.roundRect(14, ry + 2, 242, rowH - 4, 8, col(pressed ? IOS.press : IOS.bg));
            dc.roundRect(24, ry + 12, 28, 28, 7, col(c.color));
            dc.text(String(i + 1), 38, ry + 31, 14, col(IOS.cell), 'center', false, 'sansBold');
            const cur = i === tv.channel;
            dc.text(c.name, 62, ry + 23, 14.5, col(cur ? IOS.blue : IOS.text), 'left', false, cur ? 'sansBold' : 'sans');
            dc.text(c.sub, 62, ry + 39, 11, col(IOS.sub), 'left', false, 'sans');
            if (cur && tv.status !== 'error') {
                for (let k = 0; k < 3; k++) {
                    const bh = tv.playing ? 4 + 10 * Math.abs(Math.sin(t * 6 + k * 1.3)) : 4;
                    dc.fillRect(228 + k * 6, ry + 33 - bh, 4, bh, col(IOS.blue));
                }
            } else if (tv.failed[i]) {
                dc.text('Offline', 244, ry + 30, 11.5, col(IOS.red), 'right', false, 'sans');
            }
            if (i < tv.channels.length - 1) dc.fillRect(62, ry + rowH - 1.5, 196, 1.5, col(IOS.sep, 0.55));
        });
        dc.clearClip();
        // The phone clamps scroll to contentH - (H - NAV_H); only the list below the player scrolls
        phone.contentH[id] = 28 + tv.channels.length * rowH + 16 + (listTop - PHONE_NAV_H);

        // ---- Player (drawn over the list's top edge) ----
        dc.fillRect(0, PHONE_NAV_H, W, listTop - PHONE_NAV_H, col(IOS.bg));
        this.drawPicture(dc, P, now);
        phone.hit('tv:toggle', P.x, P.y, P.w, P.h);
        dc.roundRect(8, P.y + 8, 22 + dc.textWidth(ch.name, 10.5, 'sansBold'), 18, 9, [0, 0, 0, 0.55]);
        dc.text(`${tv.channel + 1}`, 15, P.y + 21, 10.5, col([255, 214, 10]), 'left', false, 'sansBold');
        dc.text(ch.name, 26, P.y + 21, 10.5, col([255, 255, 255]), 'left', false, 'sansBold');
        const vod = ch.url && !ch.live && v && Number.isFinite(v.duration) && v.duration > 0;
        if (!vod) {
            dc.roundRect(W - 44, P.y + 8, 36, 18, 4, col(IOS.red));
            dc.text('LIVE', W - 26, P.y + 21, 10, col([255, 255, 255]), 'center', false, 'sansBold');
        } else {
            dc.fillRect(0, P.y + P.h - 3, W, 3, [1, 1, 1, 0.25]);
            dc.fillRect(0, P.y + P.h - 3, W * (v.currentTime / v.duration), 3, col(IOS.red));
            dc.roundRect(W - 84, P.y + 8, 76, 18, 9, [0, 0, 0, 0.55]);
            dc.text(`${clipTime(v.currentTime)} / ${clipTime(v.duration)}`, W - 46, P.y + 21, 10, col([255, 255, 255]), 'center', false, 'sansBold');
        }

        // ---- Transport controls ----
        const CY = P.y + P.h + 24;
        this.iconButton(dc, 'tv:prev', 36, CY, true, (c) => dc.text('‹', 36, CY + 9, 28, c, 'center', false, 'sans'));
        this.iconButton(dc, 'tv:toggle', 90, CY, !!ch.url, (c) => {
            if (tv.playing && ch.url) {
                dc.fillRect(83, CY - 8, 5, 16, c);
                dc.fillRect(92, CY - 8, 5, 16, c);
            } else dc.playIcon(92, CY, 14, c);
        });
        this.iconButton(dc, 'tv:next', 144, CY, true, (c) => dc.text('›', 144, CY + 9, 28, c, 'center', false, 'sans'));
        this.iconButton(dc, 'tv:mute', 196, CY, !!ch.url, (c) => {
            dc.fillRect(186, CY - 4, 5, 8, c);
            dc.polygon([[190, CY - 4], [196, CY - 9], [196, CY + 9], [190, CY + 4]], c);
            if (tv.muted || !this.game.audio.enabled) {
                dc.line(200, CY - 5, 209, CY + 5, 2, c);
                dc.line(209, CY - 5, 200, CY + 5, 2, c);
            } else {
                dc.polyline(dc.arcPts(197, CY, 6, -0.9, 0.9, 6), 1.8, c);
                dc.polyline(dc.arcPts(197, CY, 11, -0.9, 0.9, 8), 1.8, c);
            }
        });
        this.iconButton(dc, 'tv:full', 244, CY, tv.canFullscreen, (c) => {
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                const x = 244 + sx * 8, yy = CY + sy * 7;
                dc.line(x, yy, x - sx * 5, yy, 2, c);
                dc.line(x, yy, x, yy - sy * 5, 2, c);
            }
        });
    }

    // Full screen: the phone turns to landscape and the picture is drawn rotated 90 degrees in the
    // (portrait) GUI space, so it appears upright to the viewer
    drawFullscreen(dc, now) {
        const tv = this.iptv, ch = tv.current, W = this.W, H = this.H;
        dc.fillRect(0, 0, W, H, col([0, 0, 0]));
        const aspect = tv.aspect;
        // In landscape, GUI y runs left -> right (H long) and GUI x runs bottom -> top (W tall)
        let dw = H, dh = H / aspect;
        if (dh > W) { dh = W; dw = W * aspect; }
        const x0 = (W - dh) / 2, x1 = x0 + dh, y0 = (H - dw) / 2, y1 = y0 + dw;
        const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const uvs = [[0, 1], [0, 0], [1, 0], [1, 1]];
        if (ch.kind === 'cctv') {
            dc.setMaterial('cctv');
            dc.quad(pts, uvs, [this.game.cctv.current.offline ? 0 : 1, 1, 1, 1]);
        } else if (tv.hasFrame) {
            dc.setMaterial('tv');
            dc.quad(pts, uvs, [1, 1, 1, 1]);
        }
        dc.setMaterial('atlas');
        if (ch.url && (tv.status === 'buffering' || tv.status === 'loading')) dc.spinner(W / 2, H / 2, 16, now / 1000);
        this.phone.hit('tv:full', 0, 0, W, H, 0);   // tap anywhere to leave full screen
    }

    onPress(kind, key, idx) {
        if (kind !== 'tv') return false;
        const tv = this.iptv;
        if (key === 'ch') tv.tune(Number(idx));
        else if (key === 'prev') tv.tune(tv.channel - 1);
        else if (key === 'next') tv.tune(tv.channel + 1);
        else if (key === 'mute') tv.muted = !tv.muted;
        else if (key === 'toggle') tv.togglePlay();
        else if (key === 'full' && tv.canFullscreen) tv.fullscreen = !tv.fullscreen;
        return true;
    }
}

// -------------------------------------------------------------------------------------- js/systems/paint-canvas.js
// GPU paint canvas: brush dabs are stamped into a render target, which GUIs show through a material.
// One level of undo is a GPU copy taken at the start of each stroke.

const DAB_FLOATS = 12;      // x y radius type | r g b a | seed angle flow -

class PaintCanvas {
    constructor(material, cfg) {
        this.material = material;
        this.cfg = cfg;
        [this.width, this.height] = cfg.resolution;
        this.dabs = new Float32Array(cfg.maxDabs * DAB_FLOATS);
        this.dabCount = 0;
        this.pendingClear = true;       // start with blank paper
        this.pendingSnapshot = false;
        this.pendingUndo = false;
        this.canUndo = false;
    }

    init(renderer) {
        const device = renderer.device;
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
        this.texture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.undoTexture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.view = this.texture.createView();
        this.dabBuffer = renderer.createBuffer(this.dabs.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        renderer.registerMaterial(this.material, 'gui', this.view);

        const module = device.createShaderModule({ code: stampShader(this.width, this.height) });
        this.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_stamp',
                buffers: [{
                    arrayStride: DAB_FLOATS * 4,
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x4' },
                        { shaderLocation: 1, offset: 16, format: 'float32x4' },
                        { shaderLocation: 2, offset: 32, format: 'float32x4' }
                    ]
                }]
            },
            fragment: { module, entryPoint: 'fs_stamp', targets: [{ format: 'rgba8unorm', blend: ALPHA_BLEND }] },
            primitive: { topology: 'triangle-list' }
        });
    }

    // color: 0..1 RGB
    pushDab(x, y, radius, brush, color) {
        if (this.dabCount >= this.cfg.maxDabs) return;
        this.dabs.set([x, y, radius, brush.type, color[0], color[1], color[2], 1, Math.random() * 1000, brush.angle || 0, brush.flow, 0], this.dabCount * DAB_FLOATS);
        this.dabCount++;
    }

    beginStroke() {
        this.pendingSnapshot = true;
        this.canUndo = true;
    }

    undo() {
        if (!this.canUndo) return;
        this.pendingUndo = true;
        this.canUndo = false;
    }

    clear() {
        this.pendingSnapshot = true;
        this.pendingClear = true;
        this.canUndo = true;
    }

    // Record pending work into the frame's encoder (before any view samples the painting)
    flush(renderer) {
        const enc = renderer.encoder, size = [this.width, this.height];
        if (this.pendingSnapshot) {
            enc.copyTextureToTexture({ texture: this.texture }, { texture: this.undoTexture }, size);
            this.pendingSnapshot = false;
        }
        if (this.pendingUndo) {
            enc.copyTextureToTexture({ texture: this.undoTexture }, { texture: this.texture }, size);
            this.pendingUndo = false;
        }
        if (!this.pendingClear && !this.dabCount) return;
        if (this.dabCount) renderer.device.queue.writeBuffer(this.dabBuffer, 0, this.dabs, 0, this.dabCount * DAB_FLOATS);
        const [r, g, b] = this.cfg.paper;
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.view, loadOp: this.pendingClear ? 'clear' : 'load', clearValue: { r, g, b, a: 1 }, storeOp: 'store' }]
        });
        if (this.dabCount) {
            pass.setPipeline(this.pipeline);
            pass.setVertexBuffer(0, this.dabBuffer);
            pass.draw(6, this.dabCount);
        }
        pass.end();
        this.pendingClear = false;
        this.dabCount = 0;
    }
}

// ---------------------------------------------------------------------------------------------- js/systems/cctv.js
// CCTV: renders the selected security camera into a render target, exposed to GUIs as the 'cctv'
// material. Like Doom 3 subviews, it only renders when a screen asked for it this frame.

class CctvSystem {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.selected = cfg.initial;
        this.switchTime = 0;
        this.wanted = false;
        this.renderingCamera = null;
        this.onSelect = [];
    }

    init(renderer) {
        const [w, h] = this.cfg.resolution;
        this.target = new RenderTarget(renderer, w, h);
        this.target.view.exclude.add('cctv');   // can't sample the texture it renders into
        renderer.registerMaterial('cctv', 'cctv', this.target.colorView);
    }

    get cameras() {
        return this.game.world.ofType(SecurityCamera);
    }

    get current() {
        return this.cameras[this.selected];
    }

    get aspect() {
        return this.target.aspect;
    }

    select(i) {
        i = wrapIndex(i, this.cameras.length);
        if (i !== this.selected) {
            this.selected = i;
            this.switchTime = performance.now();
            this.game.audio.emit('cctv');
        }
        for (const fn of this.onSelect) fn(i);
    }

    // Screens showing the feed call this every frame
    request() {
        this.wanted = true;
    }

    // Signal strength for a feed that (re)started at `since`: static fades into the picture
    signal(now, since = this.switchTime) {
        return this.current.offline ? 0 : clamp((now - Math.max(this.switchTime, since)) / 300, 0, 1);
    }

    prepare(frame) {
        const cam = this.current;
        this.renderingCamera = this.wanted && !cam.offline ? cam : null;
        this.wanted = false;
        if (!this.renderingCamera) return;
        const p = cam.def.pos;
        this.target.view.update(M4.viewProjection(p, cam.fwd, [0, 1, 0], this.cfg.fovY, this.target.aspect, 0.05, 60), p, frame);
    }

    render() {
        if (!this.renderingCamera) return;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: true, skip: this.renderingCamera });
        pass.end();
    }
}

// --------------------------------------------------------------------------------------------- js/systems/media.js
// Phone camera and the media library it fills.
//
// Photos: the viewfinder render target is copied into a slot of a photo atlas ('photos' material).
// Videos: each recorded frame is downscaled into one layer of a texture-array frame pool ('video'
// material; the GUI vertex colour's red channel picks the layer). Everything stays on the GPU.

class MediaLibrary {
    constructor(cfg) {
        this.cfg = cfg;
        this.items = [];            // newest first: { id, kind: 'photo' | 'video', slot | frames, time, x, z, hdg, label }
        this.nextId = 1;
        const pool = cfg.video.pool;
        this.freeLayers = Array.from({ length: pool }, (_, i) => pool - 1 - i);
        const [pw, ph] = cfg.photo.size;
        const [vw, vh] = cfg.video.size;
        this.photoSquareInset = (ph - pw) / 2;
        this.frameSquareInset = (vh - vw) / 2 / vh;
    }

    init(renderer) {
        const { photo, video } = this.cfg;
        this.photoAtlas = renderer.device.createTexture({
            size: [photo.atlas, photo.atlas],
            format: renderer.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        renderer.registerMaterial('photos', 'gui', this.photoAtlas.createView());

        const [vw, vh] = video.size;
        this.framePool = renderer.device.createTexture({
            size: [vw, vh, video.pool],
            format: renderer.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.layerViews = Array.from({ length: video.pool }, (_, i) =>
            this.framePool.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
        renderer.registerMaterial('video', 'video', this.framePool.createView({ dimension: '2d-array' }));
    }

    get photoCols() {
        return Math.floor(this.cfg.photo.atlas / this.cfg.photo.size[0]);
    }

    slotOrigin(slot) {
        const [pw, ph] = this.cfg.photo.size;
        return [(slot % this.photoCols) * pw, Math.floor(slot / this.photoCols) * ph, 0];
    }

    photoUV(slot, square = false) {
        const [pw, ph] = this.cfg.photo.size;
        const A = this.cfg.photo.atlas;
        const [x, y] = this.slotOrigin(slot);
        const inset = square ? this.photoSquareInset : 0;   // centre crop for square thumbnails
        return [x / A, (y + inset) / A, (x + pw) / A, (y + ph - inset) / A];
    }

    // Draw an item's picture: photos with the 'photos' material, video frames with 'video'
    draw(dc, item, x, y, w, h, square, frame = 0) {
        if (item.kind === 'photo') {
            const [u0, v0, u1, v1] = this.photoUV(item.slot, square);
            dc.setMaterial('photos');
            dc.stretchPic(x, y, w, h, u0, v0, u1, v1, [1, 1, 1, 1]);
        } else {
            const inset = square ? this.frameSquareInset : 0;
            dc.setMaterial('video');
            dc.stretchPic(x, y, w, h, 0, inset, 1, 1 - inset, [item.frames[frame], 1, 1, 1]);
        }
        dc.setMaterial('atlas');
    }

    frameAt(item, now) {
        return Math.floor(((now / 1000) * this.cfg.video.fps) % item.frames.length);
    }

    duration(item) {
        return item.frames.length / this.cfg.video.fps;
    }

    counts() {
        const videos = this.items.filter((m) => m.kind === 'video').length;
        return { photos: this.items.length - videos, videos };
    }

    summary() {
        const c = this.counts();
        return `${c.photos} photo${c.photos === 1 ? '' : 's'}, ${c.videos} video${c.videos === 1 ? '' : 's'}`;
    }

    indexOf(id) {
        return this.items.findIndex((m) => m.id === id);
    }

    remove(idx) {
        const [item] = this.items.splice(idx, 1);
        if (item.kind === 'video') this.freeLayers.push(...item.frames);
        return item;
    }

    add(item) {
        item.id = this.nextId++;
        this.items.unshift(item);
        return item;
    }

    allocPhotoSlot() {
        const used = new Set(this.items.filter((m) => m.kind === 'photo').map((m) => m.slot));
        for (let i = 0; i < this.cfg.photo.capacity; i++) if (!used.has(i)) return i;
        for (let i = this.items.length - 1; i >= 0; i--) {                 // full: recycle the oldest photo
            if (this.items[i].kind === 'photo') return this.remove(i).slot;
        }
        return 0;
    }

    // A free frame-pool layer; when the pool is full the oldest finished video is dropped
    allocVideoLayer() {
        if (!this.freeLayers.length) {
            for (let i = this.items.length - 1; i >= 0; i--) {
                if (this.items[i].kind === 'video') { this.remove(i); break; }
            }
        }
        return this.freeLayers.length ? this.freeLayers.pop() : -1;
    }
}

class PhoneCamera {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.library = new MediaLibrary(cfg);
        this.mode = 'photo';            // 'photo' | 'video'
        this.rec = null;                // active recording
        this.captureRequested = false;
        this.lastShot = -1e9;
        this.seeds = [...cfg.seedShots];
        this.shot = null;               // camera rendering this frame
    }

    init(renderer) {
        this.library.init(renderer);
        const [w, h] = this.cfg.photo.size;
        this.target = new RenderTarget(renderer, w, h, { copySrc: true });
        this.target.view.exclude.add('viewfinder');
        renderer.registerMaterial('viewfinder', 'gui', this.target.colorView);

        const module = renderer.device.createShaderModule({ code: BLIT_SHADER });
        this.blitPipeline = renderer.device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: renderer.format }] },
            primitive: { topology: 'triangle-list' }
        });
        this.blitGroup = renderer.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: renderer.sampler }, { binding: 1, resource: this.target.colorView }]
        });
    }

    get recordingSeconds() {
        return this.rec ? this.rec.frames.length / this.cfg.video.fps : 0;
    }

    get freeVideoSeconds() {
        return this.library.freeLayers.length / this.cfg.video.fps;
    }

    // ---- actions ----
    shutter() {
        if (this.mode === 'photo') this.takePhoto();
        else if (this.rec) this.stopRecording();
        else this.startRecording();
    }

    takePhoto() {
        this.captureRequested = true;
        this.lastShot = performance.now();
        this.game.phone.kick = 1;
        this.game.audio.shutter();
    }

    startRecording() {
        const p = this.game.player;
        this.rec = { frames: [], t0: performance.now(), time: new Date(), x: p.pos[0], z: p.pos[2], hdg: p.heading, label: this.game.world.placeLabel(p.pos[0], p.pos[2]) };
        this.game.audio.chime(true);
    }

    stopRecording() {
        const rec = this.rec;
        if (!rec) return;
        this.rec = null;
        this.game.audio.chime(false);
        if (!rec.frames.length) return;
        this.library.add({ kind: 'video', frames: rec.frames, time: rec.time, x: rec.x, z: rec.z, hdg: rec.hdg, label: rec.label });
    }

    // ---- per frame ----
    // The viewfinder renders while the phone shows the Camera page; otherwise pending startup shots
    prepare(frame) {
        const phone = this.game.phone;
        this.shot = null;
        if (phone.visible && phone.gui.pagesVisible().includes('camera')) {
            const m = phone.model;
            const dir = [-m[8], -m[9], -m[10]];                 // the phone's back faces away from its screen
            this.shot = { pos: V3.add([m[12], m[13], m[14]], V3.scale(dir, 0.012)), dir, up: [m[4], m[5], m[6]], showAvatar: false };
        } else if (this.seeds.length) {
            const s = this.seeds.shift();
            this.shot = { pos: s.pos, dir: V3.normalize(V3.sub(s.target, s.pos)), up: [0, 1, 0], showAvatar: true, label: s.label };
        } else {
            this.captureRequested = false;
        }
        if (this.rec && !(this.shot && !this.shot.label)) this.stopRecording();   // viewfinder closed
        if (this.shot) {
            const s = this.shot;
            this.target.view.update(M4.viewProjection(s.pos, s.dir, s.up, this.cfg.photo.fovY, this.target.aspect, 0.03, 60), s.pos, frame);
        }
    }

    render(now) {
        const s = this.shot;
        if (!s) return;
        const r = this.game.renderer;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: s.showAvatar });
        pass.end();

        const lib = this.library;
        if (s.label || this.captureRequested) {
            const slot = lib.allocPhotoSlot();
            r.encoder.copyTextureToTexture({ texture: this.target.texture }, { texture: lib.photoAtlas, origin: lib.slotOrigin(slot) }, [...this.cfg.photo.size, 1]);
            lib.add({
                kind: 'photo', slot, time: new Date(), x: s.pos[0], z: s.pos[2],
                hdg: bearingOf(s.dir[0], s.dir[2]), label: s.label || this.game.world.placeLabel(s.pos[0], s.pos[2])
            });
            this.captureRequested = false;
        }

        // Video: downscale the viewfinder into the next frame-pool layer at the recording frame rate
        const rec = this.rec, v = this.cfg.video;
        if (rec && !s.label && rec.frames.length < Math.floor(((now - rec.t0) / 1000) * v.fps) + 1) {
            const layer = rec.frames.length < v.maxSeconds * v.fps ? lib.allocVideoLayer() : -1;
            if (layer < 0) {
                this.stopRecording();
            } else {
                const bp = r.encoder.beginRenderPass({
                    colorAttachments: [{ view: lib.layerViews[layer], clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }]
                });
                bp.setPipeline(this.blitPipeline);
                bp.setBindGroup(0, this.blitGroup);
                bp.draw(3);
                bp.end();
                rec.frames.push(layer);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------- js/systems/iptv.js
// IPTV player. Internet channels are HLS streams (hls.js is loaded on first use); each new video frame
// is copied into a GPU texture exposed as the 'tv' material. Local channels need no network.

class IptvPlayer {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.channels = cfg.channels;
        this.channel = 0;
        this.video = null;
        this.hls = null;
        this.hlsReady = null;       // promise for the hls.js script
        this.status = 'ready';      // 'ready' | 'loading' | 'buffering' | 'error'
        this.error = '';
        this.playing = true;
        this.muted = false;
        this.texW = 0;
        this.texH = 0;
        this.hasFrame = false;
        this.newFrame = false;
        this.fullscreen = false;
        this.switchTime = 0;
        this.failed = {};           // channel index -> last error
    }

    init(renderer) {
        this.renderer = renderer;
        this.tex = this.createTexture(16, 16);
        renderer.registerMaterial('tv', 'gui', this.tex.createView());
    }

    createTexture(w, h) {
        return this.renderer.device.createTexture({
            size: [w, h],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
    }

    get current() {
        return this.channels[this.channel];
    }

    get canFullscreen() {
        const ch = this.current;
        return ch.kind === 'cctv' || !!(ch.url && this.hasFrame && this.status !== 'error');
    }

    get aspect() {
        return this.current.kind === 'cctv' ? this.game.cctv.aspect : this.texW / this.texH;
    }

    videoElement() {
        if (this.video) return this.video;
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';   // needed to upload frames to WebGPU
        v.playsInline = true;
        v.preload = 'auto';
        v.addEventListener('playing', () => { if (this.status !== 'error') this.status = 'ready'; });
        v.addEventListener('waiting', () => { if (this.status !== 'error') this.status = 'buffering'; });
        // hls.js reports its own (fatal) errors; the element's error only matters for native HLS.
        // Stream teardown on a channel switch also fires one, which must not hit the new channel.
        v.addEventListener('error', () => {
            const ch = this.current;
            if (!this.hls && this.status !== 'ready' && ch.url && v.getAttribute('src') === ch.url) this.fail(this.channel, 'Media error');
        });
        if ('requestVideoFrameCallback' in v) {
            const onFrame = () => { this.newFrame = true; v.requestVideoFrameCallback(onFrame); };
            v.requestVideoFrameCallback(onFrame);
        }
        this.video = v;
        return v;
    }

    loadHls() {
        if (window.Hls) return Promise.resolve();
        if (!this.hlsReady) {
            this.hlsReady = new Promise((resolve, reject) => {
                const sc = document.createElement('script');
                sc.src = this.cfg.hlsScript;
                sc.onload = resolve;
                sc.onerror = () => { this.hlsReady = null; reject(new Error('hls.js failed to load')); };
                document.head.appendChild(sc);
            });
        }
        return this.hlsReady;
    }

    stopStream() {
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        const v = this.video;
        if (v && v.getAttribute('src')) {
            v.pause();
            v.removeAttribute('src');
            v.load();
        }
    }

    fail(index, msg) {
        if (index !== this.channel) return;
        this.status = 'error';
        this.error = msg;
        this.failed[index] = msg;
        this.fullscreen = false;
        this.stopStream();
    }

    tune(i) {
        i = wrapIndex(i, this.channels.length);
        this.stopStream();
        this.channel = i;
        this.error = '';
        this.hasFrame = false;
        this.playing = true;
        this.switchTime = performance.now();
        const ch = this.current;
        if (!ch.url) {
            this.status = 'ready';
            if (ch.kind === 'card') this.fullscreen = false;
            return;
        }
        this.status = 'loading';
        delete this.failed[i];
        const v = this.videoElement();
        const start = () => {
            if (this.channel !== i) return;
            v.muted = this.muted || !this.game.audio.enabled;
            v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
        };
        // Prefer hls.js (MSE) everywhere it works; native HLS is the fallback (e.g. iOS Safari)
        const playNative = () => {
            if (this.channel !== i) return;
            if (!v.canPlayType('application/vnd.apple.mpegurl')) { this.fail(i, 'HLS not supported'); return; }
            v.src = ch.url;
            start();
        };
        this.loadHls().then(() => {
            if (this.channel !== i) return;
            if (!window.Hls || !window.Hls.isSupported()) { playNative(); return; }
            const hls = new window.Hls({ maxBufferLength: 12 });
            this.hls = hls;
            hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) this.fail(i, d.details || d.type); });
            hls.on(window.Hls.Events.MANIFEST_PARSED, start);
            hls.loadSource(ch.url);
            hls.attachMedia(v);
        }).catch(playNative);
    }

    togglePlay() {
        const v = this.video;
        if (!this.current.url || !v) return;
        if (this.status === 'error') { this.tune(this.channel); return; }   // tap to retry
        this.playing = !this.playing;
        if (this.playing) v.play().catch(() => {}); else v.pause();
    }

    // Every frame: pause when the app isn't on screen; upload new frames when it is
    update(visible) {
        if (visible && this.current.kind === 'cctv') this.game.cctv.request();
        const v = this.video;
        if (!v || !this.current.url) return;
        v.muted = this.muted || !this.game.audio.enabled;
        const active = !!(this.hls || v.getAttribute('src'));
        if (!visible) {
            if (!v.paused) v.pause();
            return;
        }
        if (this.playing && v.paused && active && this.status !== 'error' && v.readyState >= 2) v.play().catch(() => {});
        if (v.readyState >= 2 && v.videoWidth && (this.newFrame || !this.hasFrame || !('requestVideoFrameCallback' in v))) {
            if (v.videoWidth !== this.texW || v.videoHeight !== this.texH) {
                this.tex.destroy();
                this.texW = v.videoWidth;
                this.texH = v.videoHeight;
                this.tex = this.createTexture(this.texW, this.texH);
                this.renderer.setMaterialTexture('tv', this.tex.createView());
            }
            try {
                this.renderer.device.queue.copyExternalImageToTexture({ source: v }, { texture: this.tex }, [this.texW, this.texH]);
                this.hasFrame = true;
                this.newFrame = false;
            } catch (e) {
                this.fail(this.channel, 'Blocked (no CORS)');
            }
        }
    }
}

// -------------------------------------------------------------------------------------------- js/world/entities.js
// World entities. Each is constructed from a scenario definition ({ type, id, ... }).

class Entity {
    constructor(def, world) {
        this.def = def;
        this.id = def.id;
        this.world = world;
    }

    get game() { return this.world.game; }
    get position() { return this.def.pos; }
    get guis() { return []; }

    init(renderer) {}
    update(dt, t) {}
    writeInstances(renderer) {}
    render(pass, ctx) {}        // ctx: { showAvatar, skip }
    lights(out) {}              // push [x, y, z, intensity, r, g, b, 0]
    collide(p) {}               // push the player's [x, y, z] out of the entity
}

// One model placed at pos / yaw
class ModelEntity extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(1);
        this.matrix = M4.placement(this.def.pos || [0, 0, 0], this.def.yaw || 0);
        this.tint = null;
    }

    visibleTo(ctx) { return true; }

    writeInstances(renderer) {
        renderer.setInstance(this.instance, this.matrix, this.tint);
    }

    render(pass, ctx) {
        if (this !== ctx.skip && this.visibleTo(ctx)) pass.mesh(this.mesh, this.instance);
    }
}

// Door whose panels slide apart along their `slide` directions
class SlidingDoor extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(this.def.panels.length);
        this.target = 0;
        this.progress = 0;
        this.lastWave = 0;
    }

    get name() { return this.def.name; }
    get isOpen() { return this.target === 1; }
    get passable() { return this.progress > 0.95; }
    get openAmount() { return smooth01(this.progress); }
    get status() {
        if (this.isOpen) return this.progress > 0.99 ? 'open' : 'opening';
        return this.progress < 0.01 ? 'sealed' : 'closing';
    }

    setOpen(open) {
        if (this.isOpen === open) return false;
        this.target = open ? 1 : 0;
        return true;
    }

    update(dt, t) {
        const d = this.target - this.progress;
        this.progress += Math.sign(d) * Math.min(Math.abs(d), dt * this.def.speed);
        if (Math.abs(d) > 0.001 && t - this.lastWave > 0.5) {
            this.lastWave = t;
            this.world.waves.emit('door', this.position[0], this.position[2]);
        }
    }

    writeInstances(renderer) {
        const o = this.openAmount * this.def.travel;
        this.def.panels.forEach((p, i) => {
            renderer.setInstance(this.instance + i, M4.translation(...V3.add(p.pos, V3.scale(p.slide, o))));
        });
    }

    render(pass) {
        pass.mesh(this.mesh, this.instance, this.def.panels.length);
    }
}

// Lamp hanging from a pivot, swinging around Z; its bulb is the scene's first light
class SwingingLamp extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.swing = 0;
        this.flicker = 1;
    }

    get position() { return this.def.pivot; }

    update(dt, t) {
        const s = this.def.swing;
        this.swing = s.amp * Math.sin(t * s.freq) + s.amp2 * Math.sin(t * s.freq2);
        this.flicker = Math.sin(t * 13.1) * Math.sin(t * 3.7 + 1) > 0.92 ? 0.2 + 0.3 * Math.random() : 1;
        this.matrix = M4.multiply(M4.translation(...this.def.pivot), M4.rotationZ(this.swing));
    }

    lights(out) {
        const p = this.def.pivot, L = this.def.bulbLength;
        const on = this.world.lightsOn ? this.def.intensity * this.flicker * this.world.lampScale : 0;
        out.push([p[0] + Math.sin(this.swing) * L, p[1] - Math.cos(this.swing) * L, p[2], on, ...this.def.color, 0]);
    }
}

// Rotating alarm beacon: siren, radar waves and a pulsing red light while the alarm is on
class AlarmBeacon extends Entity {
    init() {
        this.lastTone = 0;
        this.lastWave = 0;
        this.high = false;
    }

    update(dt, t) {
        if (!this.world.alarm) return;
        const d = this.def;
        if (t - this.lastTone > d.toneEvery) {
            this.lastTone = t;
            this.high = !this.high;
            this.game.audio.emit('alarm', { freq: this.high ? d.tones[0] : d.tones[1] });
        }
        if (t - this.lastWave > d.waveEvery) {
            this.lastWave = t;
            this.world.waves.emit('alarm', d.wave[0], d.wave[1]);
        }
    }

    lights(out) {
        out.push([...this.def.pos, this.world.alarmPulse * this.def.intensity, ...this.def.color, 0]);
    }
}

// Point light, optionally tied to the room lights, a door's opening or the alarm colour
class PointLight extends Entity {
    lights(out) {
        const d = this.def, w = this.world;
        let intensity = d.intensity;
        if (d.roomLights && !w.lightsOn) intensity = 0;
        if (d.door) intensity *= lerp(d.door.min, 1, w.get(d.door.id).openAmount);
        const color = w.alarm && d.alarmColor ? d.alarmColor : d.color;
        out.push([...d.pos, intensity, ...color, 0]);
    }
}

// Drone flying an elliptical patrol loop, pinging the radar and lighting its surroundings red
class PatrolDrone extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.angle = 0;
        this.pos = [...this.def.center];
        this.fwd = [0, 0, -1];
        this.lastPing = 0;
        this.tint = [1, 0, 0, 0];   // blinking eye
    }

    get position() { return this.pos; }

    update(dt, t) {
        const d = this.def;
        this.angle += dt * d.speed;
        const [rx, rz] = d.radius;
        this.pos = [d.center[0] + rx * Math.cos(this.angle), d.center[1] + d.bob.amp * Math.sin(t * d.bob.freq), d.center[2] + rz * Math.sin(this.angle)];
        this.fwd = V3.normalize([-rx * Math.sin(this.angle), 0, rz * Math.cos(this.angle)]);
        this.matrix = M4.facing(this.pos, this.fwd);
        if (t - this.lastPing > d.pingEvery) {
            this.lastPing = t;
            this.world.waves.emit('drone', this.pos[0], this.pos[2]);
        }
    }

    lights(out) {
        const e = this.def.eyeLight;
        out.push([...V3.add(this.pos, V3.scale(this.fwd, e.ahead)), e.intensity, ...e.color, 0]);
    }
}

// Security camera that pans; the CCTV system renders through the selected one
class SecurityCamera extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.fwd = V3.normalize(V3.sub(this.def.target, this.def.pos));
        this.panDeg = 0;
    }

    get label() { return this.def.label; }
    get name() { return this.def.name; }
    get location() { return this.def.loc; }
    get offline() { return !!this.def.offline; }

    update(dt, t) {
        const d = this.def;
        const base = V3.normalize(V3.sub(d.target, d.pos));
        const pan = d.sweep * Math.sin(t * d.speed + d.pos[0]);
        this.panDeg = Math.round(deg(pan));
        const c = Math.cos(pan), s = Math.sin(pan);
        this.fwd = [base[0] * c + base[2] * s, base[1], -base[0] * s + base[2] * c];
        this.matrix = M4.facing(d.pos, this.fwd);
        this.tint = [this.game.cctv.renderingCamera === this ? 1 : 0, 0, 0, 0];   // tally light
    }
}

// The player's body, only seen from other cameras
class Avatar extends ModelEntity {
    update() {
        const p = this.game.player;
        this.matrix = M4.multiply(M4.translation(p.pos[0], 0, p.pos[2]), M4.rotationY(-p.yaw));
    }

    get position() { return this.game.player.pos; }

    visibleTo(ctx) { return !!ctx.showAvatar; }
}

// Wall terminal: housing model + the terminal GUI on its screen
class Terminal extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.gui = new TerminalGUI(def.gui, def.content, world);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.gui.setTransform(this.matrix);
    }
}

// Painting easel: wooden model, a paint render target and the easel GUI
class Easel extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.canvas = new PaintCanvas(`paint:${def.id}`, def.paint);
        this.gui = new EaselGUI(def.gui, def.paint, this.canvas);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.canvas.init(renderer);
        this.gui.setTransform(this.matrix);
    }

    collide(p) {
        const r = this.def.collider;
        const ex = p[0] - this.def.pos[0], ez = p[2] - this.def.pos[2], d = Math.hypot(ex, ez);
        if (d < r) {
            p[0] = this.def.pos[0] + (ex / (d || 1)) * r;
            p[2] = this.def.pos[2] + (ez / (d || 1)) * r;
        }
    }
}

const ENTITY_TYPES = {
    static: ModelEntity,
    door: SlidingDoor,
    lamp: SwingingLamp,
    alarmBeacon: AlarmBeacon,
    light: PointLight,
    drone: PatrolDrone,
    securityCamera: SecurityCamera,
    avatar: Avatar,
    terminal: Terminal,
    easel: Easel
};

// ----------------------------------------------------------------------------------------------- js/world/world.js
// The facility: entities built from scenario data, shared facility state and actions.

// Expanding rings for the phone radar (footsteps, drone pings, alarm, doors)
class SoundWaves {
    constructor(kinds) {
        this.kinds = kinds;         // kind -> { speed, life, color }
        this.list = [];
    }

    emit(kind, x, z, strength = 1) {
        const k = this.kinds[kind];
        this.list.push({
            kind, x, z, t0: performance.now() / 1000, life: k.life, color: k.color,
            speed: k.speed * (kind === 'step' ? strength : 1),
            alpha: kind === 'step' ? clamp(0.5 + strength * 0.35, 0, 1) : 0.8
        });
    }

    prune(t) {
        this.list = this.list.filter((w) => t - w.t0 < w.life);
    }
}

class World {
    constructor(game, scenario) {
        this.game = game;
        this.scenario = scenario;
        this.lightsOn = true;
        this.alarm = false;
        this.alarmPulse = 0;
        this.lampScale = 1;
        this.log = [...scenario.facility.log];
        this.waves = new SoundWaves(scenario.waves);
        this.entities = [];
        this.byId = new Map();
        this.meshes = new Map();
        this.guis = [];

        for (const def of scenario.entities) {
            const Type = ENTITY_TYPES[def.type];
            if (!Type) throw new Error(`Unknown entity type "${def.type}"`);
            const e = new Type(def, this);
            this.entities.push(e);
            if (def.id) this.byId.set(def.id, e);
        }
        this.guis = this.entities.flatMap((e) => e.guis);
    }

    init(renderer) {
        for (const e of this.entities) e.init(renderer);
        for (const g of this.guis) g.attach(this.game);
    }

    get(id) {
        const e = this.byId.get(id);
        if (!e) throw new Error(`No entity "${id}"`);
        return e;
    }

    ofType(Type) {
        return this.entities.filter((e) => e instanceof Type);
    }

    // Model meshes are shared between entities that use the same model
    mesh(name) {
        if (!this.meshes.has(name)) {
            const parts = this.scenario.models[name];
            if (!parts) throw new Error(`No model "${name}"`);
            this.meshes.set(name, this.game.renderer.createMesh(new MeshBuilder(this.game.renderer.worldMaterials).parts(parts)));
        }
        return this.meshes.get(name);
    }

    // ---- facility actions (terminal, phone) ----
    pushLog(text) {
        this.log.push(text);
        if (this.log.length > 20) this.log.shift();
    }

    setDoor(id, open, source) {
        const door = this.get(id);
        if (!door.setOpen(open)) return;
        const name = door.name.toUpperCase();
        this.pushLog(open ? `${source} - ${name} OPENING` : `${name} SEALING...`);
        this.game.audio.door();
        this.waves.emit('door', door.position[0], door.position[2]);
    }

    setLights(on) {
        this.lightsOn = on;
        this.pushLog(on ? 'ILLUMINATION RESTORED' : 'ILLUMINATION CUT - AUX POWER ONLY');
    }

    setAlarm(on) {
        this.alarm = on;
        this.pushLog(on ? '!! EMERGENCY ALARM ENGAGED !!' : 'ALARM RESET BY OPERATOR');
    }

    // Named place nearest to a position (photo / video captions)
    placeLabel(x, z) {
        const { zones, spots } = this.scenario.places;
        const zone = zones.find((zn) => z < zn.zBelow);
        if (zone) return zone.name;
        return spots.reduce((best, sp) => (Math.hypot(sp.at[0] - x, sp.at[1] - z) < Math.hypot(best.at[0] - x, best.at[1] - z) ? sp : best)).name;
    }

    // ---- per frame ----
    update(dt, t) {
        this.alarmPulse = this.alarm ? Math.pow(0.5 + 0.5 * Math.sin(t * 7), 3) : 0;
        for (const e of this.entities) e.update(dt, t);
        this.waves.prune(t);
    }

    // Uniform inputs shared by every view this frame
    frameState(t) {
        const lights = [];
        for (const e of this.entities) e.lights(lights);
        while (lights.length < MAX_LIGHTS) lights.push([0, 0, 0, 0, 0, 0, 0, 0]);
        const f = this.game.scenario.facility || {};
        return { time: t, lightsOn: this.lightsOn, alarmPulse: this.alarmPulse, lights, fog: f.fog ?? 0.05, ambient: f.ambient ?? 0 };
    }

    writeInstances(renderer) {
        for (const e of this.entities) e.writeInstances(renderer);
        for (const g of this.guis) g.writeInstances(renderer);
    }

    // Draw the world into a scene pass: entity meshes, then every GUI surface (anchor + GUI)
    render(pass, ctx) {
        for (const e of this.entities) e.render(pass, ctx);
        for (const g of this.guis) g.render(pass);
    }

    collide(p) {
        for (const e of this.entities) e.collide(p);
    }
}

// ----------------------------------------------------------------------------------------------- js/game/player.js
// First-person player: movement, collision, footsteps and noise.

class PlayerController {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.pos = [...cfg.start.pos];
        this.yaw = cfg.start.yaw;
        this.pitch = cfg.start.pitch;
        this.fovDeg = cfg.fovDeg;
        this.stepAccum = 0;
        this.stepPhase = 0;
        this.moving = false;
        this.running = false;
        this.noise = 0;
    }

    get eye() { return this.pos; }
    get fovy() { return rad(this.fovDeg); }
    get heading() { return wrapIndex(Math.round(deg(this.yaw)) % 360, 360); }

    basis() {
        const cp = Math.cos(this.pitch);
        const fwd = [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
        const right = V3.normalize([-fwd[2], 0, fwd[0]]);
        return { fwd, right, up: V3.cross(right, fwd) };
    }

    viewMatrix() {
        return M4.lookAt(this.pos, V3.add(this.pos, this.basis().fwd), [0, 1, 0]);
    }

    // Ray through the mouse position for a projection with vertical fov `fovy`
    viewRay(mouse, fovy) {
        const { fwd, right, up } = this.basis();
        const nx = (mouse.x / window.innerWidth) * 2 - 1;
        const ny = 1 - (mouse.y / window.innerHeight) * 2;
        const th = Math.tan(fovy / 2);
        const aspect = window.innerWidth / window.innerHeight;
        return [0, 1, 2].map((k) => fwd[k] + right[k] * nx * th * aspect + up[k] * ny * th);
    }

    look(dx, dy) {
        this.yaw += dx * 0.004;
        this.pitch = clamp(this.pitch - dy * 0.004, -1.3, 1.3);
    }

    stepForward(dist) {
        this.step(Math.sin(this.yaw) * dist, -Math.cos(this.yaw) * dist);
    }

    update(dt, keys) {
        this.noise *= Math.exp(-dt * 0.7);
        const k = keys;
        const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        this.running = k.has('ShiftLeft') || k.has('ShiftRight');
        this.moving = false;
        if (!f && !s) {
            this.stepAccum = Math.min(this.stepAccum, 0.35);
            return;
        }
        const speed = (this.running ? this.cfg.runSpeed : this.cfg.walkSpeed) * dt;
        const len = Math.hypot(f, s);
        const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const before = [this.pos[0], this.pos[2]];
        this.step(((fx * f - fz * s) / len) * speed, ((fz * f + fx * s) / len) * speed);
        const moved = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[1]);
        if (moved < 1e-5) return;
        this.moving = true;

        // Footsteps: one per stride; running is louder and makes bigger radar waves
        const stride = this.running ? this.cfg.stride.run : this.cfg.stride.walk;
        this.stepPhase += (moved / stride) * Math.PI;
        this.stepAccum += moved;
        if (this.stepAccum >= stride) {
            this.stepAccum -= stride;
            this.game.audio.step(this.running);
            this.game.world.waves.emit('step', this.pos[0], this.pos[2], this.running ? 1.4 : 0.8);
            this.noise = clamp(this.noise + (this.running ? 0.3 : 0.14), 0, 1);
        }
    }

    // Move with collision: room bounds, a doorway that opens with its door, entity colliders
    step(dx, dz) {
        const p = this.pos, { bounds, doorway } = this.cfg;
        let x = p[0] + dx;
        const z = p[2] + dz;
        const [dx0, dx1] = doorway.x;
        if (p[2] < doorway.enterZ) x = clamp(x, dx0, dx1);            // inside the doorway / corridor
        const canPass = this.game.world.get(doorway.door).passable && x > dx0 && x < dx1;
        p[0] = clamp(x, bounds.x[0], bounds.x[1]);
        p[2] = clamp(z, canPass ? doorway.minZ : bounds.z[0], bounds.z[1]);
        this.game.world.collide(p);
    }
}

// ------------------------------------------------------------------------------------------------ js/game/input.js
// Mouse / keyboard. Presses go to the GUI under the cursor first; otherwise dragging looks around.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.mouse = { x: 0, y: 0, inside: false };
        this.keys = new Set();
        this.looking = false;       // dragging to look around
    }

    attach() {
        const { canvas, game, io } = this;
        const track = (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
            this.mouse.inside = true;
        };
        io.listen(canvas, 'pointermove', (e) => {
            track(e);
            if (this.looking && !game.fx.cameraLocked) game.player.look(e.movementX, e.movementY);
        });
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', (e) => {
            track(e);
            const taken = game.interaction.pointerDown();
            if (!taken) this.looking = true;
            if (taken !== 'gui') canvas.setPointerCapture(e.pointerId);
        });
        const release = () => {
            this.looking = false;
            game.interaction.pointerUp();
        };
        io.listen(canvas, 'pointerup', release);
        io.listen(canvas, 'pointercancel', release);
        io.listen(window, 'pointerup', release);
        io.listen(canvas, 'wheel', (e) => {
            e.preventDefault();
            // Wheel over a GUI (lists, brush size...) goes to it; otherwise it steps the player
            if (!game.interaction.wheel(e.deltaY) && !game.fx.cameraLocked) game.player.stepForward(-e.deltaY * 0.003);
        }, { passive: false });

        io.listen(window, 'keydown', (e) => {
            if (e.code === 'Tab') {
                e.preventDefault();
                if (!e.repeat) game.phone.setShown(!game.phone.target);
                return;
            }
            if (e.code === 'Escape') game.phone.setShown(false);
            this.keys.add(e.code);
            if (e.code.startsWith('Arrow')) e.preventDefault();
        });
        io.listen(window, 'keyup', (e) => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }

    get cursorStyle() {
        if (this.game.interaction.focus) return 'none';    // the GUI draws its own cursor
        return this.looking ? 'grabbing' : 'crosshair';
    }
}

// ------------------------------------------------------------------------------------------ js/game/interaction.js
// Routes the mouse to EntityGUIs, like Doom 3 tracing the view against gui surfaces.
// The view-model GUI (the phone) is in front of everything; otherwise the nearest world GUI under the
// cursor gets it, as long as the player is within its use range.

class InteractionSystem {
    constructor(game) {
        this.game = game;
        this.focus = null;      // GUI under the cursor
        this.capture = null;    // GUI holding the pointer during a drag
    }

    get guis() {
        return [this.game.phone.gui, ...this.game.world.guis];
    }

    hover() {
        const { input, player, phone, world } = this.game;
        for (const g of this.guis) {
            g.active = false;
            g.outOfRange = false;
        }
        this.focus = null;
        if (!input.mouse.inside || input.looking) return;

        if (phone.interactive) {
            const pt = phone.gui.trace(player.eye, player.viewRay(input.mouse, phone.fovy));
            if (pt) return this.setFocus(phone.gui, pt);
        }

        const dir = player.viewRay(input.mouse, player.fovy);
        let best = null;
        for (const g of world.guis) {
            const pt = g.trace(player.eye, dir);
            if (pt && (!best || pt.t < best.pt.t)) best = { gui: g, pt };
        }
        if (!best) return;
        if (!best.gui.inRange(player.eye)) {
            best.gui.outOfRange = true;
            return;
        }
        this.setFocus(best.gui, best.pt);
    }

    setFocus(gui, pt) {
        gui.active = true;
        gui.cursor.x = pt.x;
        gui.cursor.y = pt.y;
        this.focus = gui;
    }

    // Called every frame after hover
    drag() {
        if (this.capture) this.capture.pointerDrag();
    }

    // Returns 'capture' (a GUI took the press and wants drags), 'gui' (a GUI took it) or null
    pointerDown() {
        this.hover();
        if (!this.focus) return null;
        if (this.focus.pointerDown()) {
            this.capture = this.focus;
            return 'capture';
        }
        return 'gui';
    }

    pointerUp() {
        if (this.capture) this.capture.pointerUp();
        this.capture = null;
    }

    wheel(dy) {
        return !!(this.focus && this.focus.wheel(dy));
    }
}

// ------------------------------------------------------------------------------------------------ js/game/phone.js
// The handheld phone: a view model carrying the PhoneGUI. It's drawn in its own pass with fresh
// depth/stencil and a fixed field of view, so it never clips into walls and the FOV setting can't
// move it under the cursor (Doom 3's weaponDepthHack idea).

class PhoneDevice {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.gui = new PhoneGUI(game, cfg);
        this.target = cfg.startShown;
        this.anim = 0;              // 0 hidden .. 1 in hand
        this.kick = 0;              // shutter recoil
        this.land = 0;              // 0 portrait .. 1 landscape (full-screen TV)
        this.model = M4.identity();
        this.fovy = rad(cfg.fovDeg);
    }

    init(renderer) {
        this.mesh = this.game.world.mesh(this.cfg.model);
        this.instance = renderer.allocInstances(1);
        this.view = renderer.createView();
        this.gui.attach(this.game);
    }

    get visible() { return this.anim > 0.001; }
    get interactive() { return this.target && this.anim > 0.9; }

    setShown(on) {
        if (this.target === on) return;
        this.target = on;
        this.gui.drag = null;
        if (!on) this.game.iptv.fullscreen = false;
        this.game.audio.emit('phone', { on });
    }

    update(dt, t) {
        this.anim = clamp(this.anim + ((this.target ? 1 : -1) * dt) / this.cfg.showSeconds, 0, 1);
        this.kick *= Math.exp(-dt * 14);
        this.land = clamp(this.land + ((this.game.iptv.fullscreen ? 1 : -1) * dt) / 0.35, 0, 1);
        this.model = this.pose(t);
        this.gui.setTransform(this.model);
    }

    // Pose relative to the eye: swings up from below with an overshoot when shown, sways while
    // walking, turns to landscape for full-screen TV
    pose(t) {
        const player = this.game.player, P = this.cfg.pose;
        const a = this.anim;
        const e = this.target ? easeOutBack(a) : smooth01(a);
        const bob = player.moving ? 1 : 0;
        const bx = Math.sin(player.stepPhase) * 0.0025 * bob;
        const by = Math.abs(Math.cos(player.stepPhase)) * 0.003 * bob + Math.sin(t * 1.3) * 0.0008;
        const L = smooth01(this.land);
        const off = [
            lerp(lerp(P.hidden.offset[0], P.shown.offset[0], e), P.landscape.offset[0], L) + bx,
            lerp(P.hidden.offset[1], P.shown.offset[1], e) + by * (1 - L),
            lerp(P.shown.offset[2], P.landscape.offset[2], L) + this.kick * 0.006
        ];
        return M4.chain(
            M4.facing(player.eye, player.basis().fwd),
            M4.translation(...off),
            M4.rotationY(lerp(lerp(P.hidden.yaw, P.shown.yaw, e), 0, L)),
            M4.rotationX(lerp(P.hidden.tilt, P.shown.tilt, e) + this.kick * 0.04),
            M4.rotationZ((L * Math.PI) / 2)
        );
    }

    prepare(frame, viewMatrix) {
        const r = this.game.renderer;
        this.view.update(M4.multiply(M4.perspective(this.fovy, r.aspect, 0.02, 100), viewMatrix), this.game.player.eye, frame);
    }

    writeInstances(renderer) {
        renderer.setInstance(this.instance, this.model);
        this.gui.writeInstances(renderer);
    }

    render() {
        if (!this.visible) return;
        const r = this.game.renderer;
        const pass = r.beginScenePass(r.swapView, r.phoneDepthView, this.view, { load: true, forceStencil: true });
        pass.mesh(this.mesh, this.instance);
        this.gui.render(pass);
        pass.end();
    }
}

// --------------------------------------------------------------------------------------------- js/game/bindings.js
// Named bindings between data-driven GUI pages and game state.
//   value:  { get, set?, min?, max?, fmt?, label?, options? }  (switch / slider / picker / option cells)
//   text:   { text }                                         (label values, dynamic titles and footers)
// Actions are named commands for 'action' cells.

class Bindings {
    constructor(game) {
        this.game = game;
        this.specs = this.createSpecs(game);
        this.actions = this.createActions(game);
    }

    spec(key) {
        const s = this.specs[key];
        if (!s) throw new Error(`No binding "${key}"`);
        return s;
    }

    text(key) {
        const s = this.spec(key);
        return s.text ? s.text() : String(s.get());
    }

    action(name) {
        const fn = this.actions[name];
        if (!fn) throw new Error(`No action "${name}"`);
        fn();
    }

    createSpecs(g) {
        const links = g.scenario.phone.links;
        const door = () => g.world.get(links.door);
        const pct = (v) => `${Math.round(v)}%`;
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        return {
            // settings
            lights: { get: () => g.world.lightsOn, set: (v) => g.world.setLights(v) },
            alarm: { get: () => g.world.alarm, set: (v) => g.world.setAlarm(v) },
            stencil: { get: () => g.renderer.useStencil, set: (v) => { g.renderer.useStencil = v; } },
            sound: { get: () => g.audio.enabled, set: (v) => { g.audio.enabled = v; } },
            fov: { get: () => g.player.fovDeg, set: (v) => { g.player.fovDeg = v; }, min: 45, max: 95, fmt: (v) => `${Math.round(v)}°` },
            lamp: { get: () => g.world.lampScale * 100, set: (v) => { g.world.lampScale = v / 100; }, min: 0, max: 200, fmt: pct },
            stepVolume: { get: () => g.audio.stepVolume * 100, set: (v) => { g.audio.stepVolume = v / 100; }, min: 0, max: 100, fmt: pct },
            cctv: {
                get: () => g.cctv.selected,
                set: (i) => g.cctv.select(i),
                label: (i) => g.cctv.cameras[i].label,
                options: () => g.cctv.cameras.map((c) => ({ title: c.label, sub: c.offline ? `${c.name} (offline)` : c.name }))
            },

            // read-only text
            'player.position': { text: () => `${g.player.pos[0].toFixed(1)}, ${g.player.pos[2].toFixed(1)}` },
            'player.heading': { text: () => `${pad3(g.player.heading)}° ${cardinal(g.player.heading)}` },
            'player.noise': { text: () => pct(g.player.noise * 100) },
            'hatch.status': { text: () => cap(door().status) },
            'hatch.code': { text: () => g.world.get(links.terminal).gui.content.hatchCode },
            'hatch.action': { text: () => (door().isOpen ? 'Seal hatch' : 'Open hatch (override)') },
            'media.summary': { text: () => g.camera.library.summary() },
            'iptv.summary': { text: () => `${g.iptv.channels.length} channels · ${g.iptv.current.name}` },
            'stencil.description': {
                text: () => (g.renderer.useStencil
                    ? 'Each GUI surface writes its own stencil value where it wins the depth test. GUI quads draw with depth ALWAYS + stencil EQUAL in painter\'s order: no z-fighting, and the swinging lamp still occludes them.'
                    : 'Depth test only: GUI quads test LEQUAL against the co-planar screen. They reach the wall through a different matrix path than the screen, so their depth rounds differently and the terminal z-fights.')
            },
            'stats.fps': { text: () => `${g.stats.fps} fps` },
            'stats.resolution': { text: () => `${g.renderer.width} × ${g.renderer.height}` },
            'stats.guiMask': { text: () => (g.renderer.useStencil ? 'Stencil' : 'Depth only') },
            'stats.guiSurfaces': { text: () => String(g.interaction.guis.length) },
            'stats.terminal': { text: () => g.stats.gui(g.world.get(links.terminal).gui) },
            'stats.easel': { text: () => g.stats.gui(g.world.get(links.easel).gui) },
            'stats.phone': { text: () => g.stats.gui(g.phone.gui) },
            'stats.cctv': { text: () => (g.cctv.renderingCamera ? `${g.cctv.renderingCamera.label} rendering` : 'Idle') },
            'stats.camera': { text: () => (g.camera.shot ? 'Rendering' : 'Idle') },
            'stats.photos': { text: () => `${g.camera.library.counts().photos} / ${g.camera.cfg.photo.capacity}` },
            'stats.videoFrames': { text: () => `${g.camera.cfg.video.pool - g.camera.library.freeLayers.length} / ${g.camera.cfg.video.pool}` },
            'stats.iptv': { text: () => (g.iptv.hasFrame ? `${g.iptv.texW}×${g.iptv.texH}` : 'Idle') }
        };
    }

    createActions(g) {
        const links = g.scenario.phone.links;
        return {
            toggleHatch: () => {
                const door = g.world.get(links.door);
                g.world.setDoor(links.door, !door.isOpen, 'DEBUG OVERRIDE');
            },
            showCctvOnTerminal: () => g.world.get(links.terminal).gui.showPage('cctv')
        };
    }
}

// ------------------------------------------------------------------------------------------------- js/game/game.js
// Game: builds every system from the scenario and runs the frame.
//
// Frame order:
//   simulate (player, world, phone) -> route the cursor -> update + rebuild GUI models
//   -> decide which render targets are needed -> write instances -> encode passes:
//      paint canvases, CCTV, phone camera, player view, phone view model -> submit

class FrameStats {
    constructor() {
        this.fps = '--';
        this.acc = 0;
        this.frames = 0;
    }

    tick(dt) {
        this.acc += dt;
        this.frames++;
        if (this.acc > 0.5) {
            this.fps = String(Math.round(this.frames / this.acc));
            this.acc = 0;
            this.frames = 0;
        }
    }

    gui(g) {
        return `${g.model.quads} quads, ${g.model.surfaces.length} surf.`;
    }
}

class Game {
    constructor(fx) {
        this.fx = fx;
        this.scenario = fx.native;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.audio = new AudioSystem(fx);
        this.far = fx.native.player.far || 100;
        this.input = new InputSystem(this, fx.io);
        this.stats = new FrameStats();
        this.lastTime = performance.now();
    }

    async start() {
        const r = this.renderer;
        await r.init();
        await GuiAtlas.loadFonts();
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(this.scenario.materials));

        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);

        const s = this.scenario;
        this.world = new World(this, s);
        this.player = new PlayerController(this, s.player);
        this.cctv = new CctvSystem(this, s.cctv);
        this.camera = new PhoneCamera(this, s.media);
        this.iptv = new IptvPlayer(this, s.iptv);
        this.phone = new PhoneDevice(this, s.phone);
        this.interaction = new InteractionSystem(this);
        this.bindings = new Bindings(this);

        this.cctv.init(r);
        this.camera.init(r);
        this.iptv.init(r);
        this.world.init(r);
        this.phone.init(r);
        r.finalizeInstances();
        this.mainView = r.createView();

        this.input.attach();
    }

    get guis() {
        return [...this.world.guis, this.phone.gui];
    }

    // update: player, world, phone, GUIs; render: views, render targets, passes. The host runs both, or (in a
    // composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        dt = Math.min(0.05, dt);
        const t = now / 1000;
        const { renderer: r, world, player, phone, interaction, dc } = this;
        if (update) this.update(now, dt, t);
        if (render) this.render(now, dt, t);
    }

    update(now, dt, t) {
        const { world, player, phone, interaction, dc } = this;
        // Simulation
        if (!this.fx.cameraLocked) player.update(dt, this.input.keys);
        world.update(dt, t);
        phone.update(dt, t);

        // GUIs: cursor routing, logic, then rebuild their models
        interaction.hover();
        interaction.drag();
        this.canvas.style.cursor = this.input.cursorStyle;
        for (const g of this.guis) g.update(dt, now);
        for (const g of world.guis) g.build(dc, now);
        if (phone.visible) phone.gui.build(dc, now);
    }

    render(now, dt, t) {
        const { renderer: r, world, player, phone } = this;
        r.resize();
        // Views and render targets for this frame
        const frame = world.frameState(t);
        const view = player.viewMatrix();
        this.mainView.update(M4.multiply(M4.perspective(player.fovy, r.aspect, 0.02, this.far), view), player.eye, frame);
        phone.prepare(frame, view);
        if (!phone.visible) this.iptv.fullscreen = false;
        this.iptv.update(phone.visible && (this.iptv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        this.cctv.prepare(frame);
        this.camera.prepare(frame);

        world.writeInstances(r);
        phone.writeInstances(r);

        // Passes
        r.beginFrame();
        for (const easel of world.ofType(Easel)) easel.canvas.flush(r);
        this.cctv.render();
        this.camera.render(now);
        const pass = r.beginScenePass(r.swapView, r.depthView, this.mainView);
        world.render(pass, { showAvatar: false });
        pass.end();
        phone.render();
        r.endFrame();

        this.stats.tick(dt);
    }
}

// ------------------------------------------------------------------------------------- feature world
// This demo as one world of the engine (js/engine/host.js calls these). All of its UI is in the 3D scene.
class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = '';
    }

    async init() {
        this.game = new Game(this.fx);
        await this.game.start();
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // classic 0..1 depth, near 0.02, far 100 or the scenario's player.far (depth-stencil, the depth aspect)
    depth() {
        const r = this.game.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.02, far: this.game.far };
    }

    get view() {
        const P = this.game.player, { fwd, up } = P.basis();
        return { pos: [...P.pos], fwd, up, fov: P.fovy };
    }

    setView(v) {
        const P = this.game.player;
        P.pos[0] = v.pos[0]; P.pos[1] = v.pos[1]; P.pos[2] = v.pos[2];
        P.yaw = Math.atan2(v.fwd[0], -v.fwd[2]);
        P.pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd[1])));
        if (v.fov) P.fovDeg = v.fov * 180 / Math.PI;
    }

    stats() {
        const g = this.game, w = g.world, P = g.player;
        return {
            fps: Number(g.stats.fps) || 0, lightsOn: w.lightsOn, alarm: w.alarm, phone: g.phone.visible, moving: P.moving, running: P.running,
            noise: P.noise, gui: g.interaction.focus ? g.interaction.focus.name || 'gui' : '', sound: g.audio.enabled,
        };
    }

    set(key, v) {
        const w = this.game.world;
        if (key === 'lights' && !!v !== w.lightsOn) w.setLights(!!v);
        else if (key === 'alarm' && !!v !== w.alarm) w.setAlarm(!!v);
        else if (key === 'phone') this.game.phone.setShown(!!v);
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
