'use strict';
// WGSL: the scene / GUI, video and blit shaders.

Features.kit('gui', (engine, kit) => {
const { clamp, col } = kit;

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

return { sceneShader, VIDEO_SHADER, BLIT_SHADER };
});
