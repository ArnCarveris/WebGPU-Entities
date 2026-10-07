'use strict';
// GuiKit: the Doom 3-style GUI toolkit of WebGPU Entities, shared by the engine's handheld (js/engine/handheld.js) and the
// gui feature's world-space screens (js/features/gui/): math, the world material table, meshes and GUI surfaces, the WGSL
// scene / GUI shaders, the Renderer (views, render targets, scene passes), the baked font atlas, the DeviceContext that
// turns drawing calls into GUI models, EntityGUI, and the data-driven PhoneGUI with its PhoneApp base.

const GuiKit = (() => {
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
// built when a Renderer starts: the noise kit (an engine kit, Features.ENGINE_KITS) is loaded by then
const sceneShader = () => /* wgsl */`
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

    ${Features.kits.noise.NoiseWGSL.hashSin2('hash')}

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
        this.mirror = null;             // another renderer (the handheld's) that gets this one's GUI materials too
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
        const module = device.createShaderModule({ code: sceneShader() });
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
        if (this.mirror && name !== 'atlas') this.mirror.registerMaterial(name, shading, textureView);
    }

    setMaterialTexture(name, textureView) {
        const m = this.materials.get(name);
        m.view = textureView;
        m.version++;
        if (this.mirror && name !== 'atlas') this.mirror.setMaterialTexture(name, textureView);
    }

    // Lends this renderer's GUI materials (render targets: CCTV, viewfinder, photos...) to `other`, now and later
    mirrorTo(other) {
        this.mirror = other;
        for (const [name, m] of this.materials) if (name !== 'atlas') other.registerMaterial(name, m.shading, m.view);
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
const GLYPH_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '°', '•', '×', '‹', '›', '·', '²', '³', '→', '…'];

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

// --------------------------------------------------------------------------------------------- js/gui/phone-gui.js
// Phone GUI (270x570): a debug sheet in the style of UnityDebugSheet, the screen of the engine's handheld.
// List pages are pure scenario data; their cells read and write state through named bindings, or show `expr` templates
// read against the host's frame scope. Pages with an `app` are drawn by a PhoneApp (radar, camera, gallery, IPTV...)
// that a world lends the handheld. `this.game` is the handheld (js/engine/handheld.js): renderer, dc, audio, bindings,
// scope, setShown, fullscreen.

const IOS = {
    bg: [242, 242, 247], cell: [255, 255, 255], sep: [198, 198, 200], text: [0, 0, 0], sub: [142, 142, 147],
    blue: [0, 122, 255], green: [52, 199, 89], red: [255, 59, 48], orange: [255, 149, 0], pink: [255, 45, 85],
    press: [209, 209, 214], track: [233, 233, 234], chevron: [196, 196, 199]
};
const PHONE_NAV_H = 82;             // status bar + navigation bar
const PHONE_TRANSITION_MS = 300;
const TEXT_CELL = { size: 13, lead: 18, width: 214 };

class PhoneGUI extends EntityGUI {
    constructor(cfg, pages) {
        super({ id: 'phone', size: cfg.screen, virtual: cfg.virtual, zOffset: cfg.zOffset, anchorMaterial: 'glass', maxVerts: 24000 });
        this.cfg = cfg;
        this.pages = pages;
        this.templates = new Map();
        this.stack = ['root'];
        this.trans = null;          // { from, to, dir, t0 }
        this.scroll = {};
        this.scrollTarget = {};
        this.contentH = {};
        this.drag = null;           // slider binding being dragged
        this.knobs = {};            // animated switch knobs
        this.rects = {};            // image cells' rects, for the (u, v) of a press
        this.apps = {};             // name -> PhoneApp, lent by worlds
    }

    get bindings() { return this.game.bindings; }
    get currentPage() { return this.stack[this.stack.length - 1]; }

    pagesVisible() {
        return this.trans ? [this.trans.from, this.trans.to] : [this.currentPage];
    }

    // Page definition: data from the scenario, or an app
    pageDef(id) {
        if (id.startsWith('photo:') && this.apps.viewer) return { title: this.apps.viewer.title(id), app: this.apps.viewer };
        const d = this.pages[id];
        if (!d || (d.app && !this.apps[d.app])) return { title: d?.title || id, sections: [] };
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
            case 'close': this.game.setShown(false); return;
            case 'nav': this.navigate(b.id.slice(4)); return;
            case 'switch': B.spec(key).set(!B.spec(key).get()); return;
            case 'slider': this.drag = key; this.sliderFromCursor(key); return true;
            case 'opt': B.spec(key).set(Number(idx)); this.audio.later(120, () => this.back()); return;
            case 'action': B.action(key); return;
            case 'img': {
                const r = this.rects[key], spec = B.spec(key);
                if (r && spec.click) spec.click(clamp((this.cursor.x - r.x) / r.w, 0, 1), clamp((this.cursor.y - r.y) / r.h, 0, 1));
                return;
            }
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
        if (this.game.fullscreen && this.apps.tv) {
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
        const size = Math.min(17, (17 * 120) / Math.max(1, dc.textWidth(title, 17, 'sansBold')));    // clear of Back / close
        dc.text(title, W / 2, 69, size, col(IOS.text), 'center', false, 'sansBold');
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
            // `expr`: a template ({expr|format}, see js/engine/expr.js) read against the host's frame scope, i.e. what
            // the scenario's HUD panels read: every world's stats, focus, fps...
            if (cell.expr) c[cell.type === 'text' ? 'text' : 'value'] = this.exprText(cell.expr);
            if (cell.subExpr) c.sub = this.exprText(cell.subExpr);
            return c;
        });
    }

    exprText(src) {
        let fn = this.templates.get(src);
        if (!fn) this.templates.set(src, fn = Expr.template(src));
        try {
            return fn(this.game.scope).replace(/<[^>]*>/g, '');
        } catch (err) {
            return err.message;
        }
    }

    cellHeight(dc, c) {
        if (c.type === 'text') return 16 + dc.wrapText(c.text, TEXT_CELL.size, 'sans', TEXT_CELL.width).length * TEXT_CELL.lead;
        if (c.type === 'slider') return 64;
        if (c.type === 'image') return Math.round(246 / (c.aspect || 1));
        if (c.type === 'label') {
            // a value too long for beside its title goes under it, wrapped
            const tw = c.title ? dc.textWidth(c.title, 15, 'sans') + 14 : 0;
            c.wrap = c.value && tw + dc.textWidth(c.value, 14, 'sans') > 216 ? dc.wrapText(c.value, 13, 'sans', 214) : null;
            if (c.wrap) return (c.title ? 34 : 14) + c.wrap.length * 17;
        }
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

    // `str` cut to `maxW` (an ellipsis at the end)
    static fit(dc, str, size, maxW, font = 'sans') {
        str = String(str ?? '');
        if (dc.textWidth(str, size, font) <= maxW) return str;
        while (str.length > 1 && dc.textWidth(`${str}…`, size, font) > maxW) str = str.slice(0, -1);
        return `${str.trimEnd()}…`;
    }

    static hitId(cell) {
        switch (cell.type) {
            case 'image': return cell.click ? `img:${cell.bind}` : null;
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
        if ((hover || pressed) && cell.type !== 'slider' && cell.type !== 'switch' && cell.type !== 'image') {
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
                    dc.text(PhoneGUI.fit(dc, cell.title, 15, 222 - tx), tx, cy + 23, 15, col(IOS.text), 'left', false, 'sans');
                    dc.text(PhoneGUI.fit(dc, cell.sub, 11.5, 222 - tx), tx, cy + 40, 11.5, col(IOS.sub), 'left', false, 'sans');
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
                if (cell.wrap) {
                    let ly = cy + 22;
                    if (cell.title) { dc.text(cell.title, tx, ly, 15, col(IOS.text), 'left', false, 'sans'); ly += 20; }
                    cell.wrap.forEach((ln, i) => dc.text(ln, tx, ly + i * 17, 13, col(IOS.sub), 'left', false, 'sans'));
                } else {
                    title();
                    dc.text(cell.value, 244, mid, 14, col(IOS.sub), 'right', false, 'sans');
                }
                break;
            case 'image': {
                const spec = B.spec(cell.bind);
                this.rects[cell.bind] = { x: x0 + dc.ox, y: cy, w, h };
                dc.roundRect(x0, cy, w, h, 10, col([14, 18, 22]));
                dc.setMaterial(spec.material);
                dc.stretchPic(x0, cy, w, h, 0, 0, 1, 1, [1, 1, 1, 1]);
                dc.setMaterial('atlas');
                break;
            }
            case 'action':
                title(IOS.blue);
                break;
            case 'picker': {
                title();
                const s = B.spec(cell.bind);
                const room = 218 - tx - dc.textWidth(cell.title, 15, 'sans');
                dc.text(PhoneGUI.fit(dc, s.label(s.get()), 14, room), 230, mid, 14, col(IOS.sub), 'right', false, 'sans');
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
    // game: the world the app belongs to (its player, camera, library...)
    constructor(phone, game) {
        this.phone = phone;
        this.game = game;
    }

    get W() { return this.phone.vw; }
    get H() { return this.phone.vh; }

    draw(dc, now, pageId) {}
    // Handle a press on one of this app's hit regions; return true if handled
    onPress(kind, key, idx) { return false; }
}

return {
    V3, M4, clamp, lerp, smooth01, easeOutBack, easeOutCubic, wrapIndex, deg, rad, col, mixRGB, fitRect, timeText, clipTime, pad3, cardinal, bearingOf, hitIn, MATERIAL_PATTERNS, MATERIAL_SIGNALS, MATERIAL_FLOATS, MaterialTable, MeshBuilder, GuiSurface, sceneShader, VIDEO_SHADER, BLIT_SHADER, UNIFORM_FLOATS, MAX_LIGHTS, INSTANCE_FLOATS, GUI_STRIDE, DEPTH_FORMAT, CLEAR_COLOR, WORLD_VERTEX_LAYOUT, GUI_VERTEX_LAYOUT, ALPHA_BLEND, Renderer, RenderView, RenderTarget, ScenePass, FONT_PX, GLYPH, GLYPH_CHARS, GuiAtlas, GuiModel, DeviceContext, EntityGUI, IOS, PHONE_NAV_H, PHONE_TRANSITION_MS, TEXT_CELL, PhoneGUI, PhoneApp,
};
})();
