'use strict';
// Cascaded sun shadows (the scenario's `shadows`): four cascades fitted to the camera's view, their caster lists culled with
// the camera's (castShadows), meshes and imposters drawn into a depth32float array, sampled with 3 x 3 PCF (shadowAt).
// Without them the sun reaches everything: no map, no shadow passes, the cull fills the camera's lists alone.

Features.feature('imposter/imposter/shadows', (engine, kit) => {
const { Common } = engine;
const { clamp, lerp, v3 } = Common;
const { CASCADES, SHADOW_FLOATS, CHEAP_CASCADE, m4, WGSL_SHADOW, WGSL_CASTERS, WGSL_MESH_SHADOW, WGSL_IMPOSTER_SHADOW } = kit;

// the renderer's extension (renderer.ext.shadows)
class ShadowsRenderer {
    static key = 'shadows';

    constructor(r) {
        this.r = r;
    }

    wgsl(lib, modules) {
        lib.replace('SHADOW', WGSL_SHADOW, { needs: ['COMMON'] });
        lib.replace('CASTERS', WGSL_CASTERS);
        lib.define('MESH_SHADOW', WGSL_MESH_SHADOW, { needs: ['MESH'] });
        lib.define('IMPOSTER_SHADOW', WGSL_IMPOSTER_SHADOW, { needs: ['IMPOSTER'] });
        modules.mesh.push('MESH_SHADOW');
        modules.imposter.push('IMPOSTER_SHADOW');
    }

    // bind group 0's: the Shadow uniform (3), the map (4) and its comparison sampler (5)
    globals() {
        const S = GPUShaderStage, device = this.r.device;
        this.buf = device.createBuffer({ size: SHADOW_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.shadowData = new Float32Array(SHADOW_FLOATS);
        this.sampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
        // shadow passes bind this 1-layer stand-in: the real map is their render target
        this.dummy = device.createTexture({ size: [1, 1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
        const entries = tex => [
            { binding: 3, resource: { buffer: this.buf } }, { binding: 4, resource: tex.createView({ dimension: '2d-array' }) },
            { binding: 5, resource: this.sampler },
        ];
        this.global = {
            layout: [
                { binding: 3, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 4, visibility: S.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
                { binding: 5, visibility: S.FRAGMENT, sampler: { type: 'comparison' } },
            ],
            resources: () => entries(this.shadowTex || this.dummy),
        };
        this.passEntries = { of: this.global, resources: entries(this.dummy) };
        return this.global;
    }

    init({ modules, meshLayout, impLayout, vertexLayout }) {
        const device = this.r.device, meshMod = modules.mesh, impMod = modules.imposter;
        this.passBG = this.r.makeGlobalBG(this.passEntries);
        this.ensureShadowMap(2048);
        const shadowDepth = bias => ({ format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: bias, depthBiasSlopeScale: bias ? 2 : 0 });
        this.meshPipe = device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: meshMod, entryPoint: 'fsShadow', targets: [] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: shadowDepth(2),
        });
        // opaque casters (terrain, bark, stone...): no fragment stage, the fast depth-only path
        this.opaquePipe = device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: shadowDepth(2),
        });
        this.impPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fsShadow', targets: [] },
            primitive: { topology: 'triangle-list' },
            depthStencil: shadowDepth(0),
        });
        this.impCheapPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fsShadowCheap', targets: [] },
            primitive: { topology: 'triangle-list' },
            depthStencil: shadowDepth(1),
        });
    }

    // the map's resolution (the scenario's shadows.resolution)
    ensureShadowMap(res) {
        const r = this.r;
        res = clamp(res, 256, r.device.limits.maxTextureDimension2D);
        if (this.shadowTex && this.shadowRes === res) return;
        this.shadowTex?.destroy();
        this.shadowRes = res;
        this.shadowTex = r.device.createTexture({ size: [res, res, CASCADES], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.shadowLayers = Array.from({ length: CASCADES }, (_, k) => this.shadowTex.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }));
        r.globalBG = r.makeGlobalBG();
    }

    // Cascades: split the camera range [near, shadowDistance] (log / uniform mix by lambda); fit each slice's
    // bounding sphere with an orthographic light box, snapped to whole texels so shadows do not shimmer, and
    // stretched back toward the sun so casters outside the slice still land in the map. How far back: to the
    // highest caster (`top`, metres) seen along the sun ray from the slice's lowest point. A low sun throws shadows
    // kilometres long, so a fixed reach dropped the shadows of distant ridges. Its rows of the view uniforms and the
    // renderer's cascadePlanes (static casters culled on the CPU) are the cascades'
    frame(cam, env, st, aspect, top) {
        const r = this.r;
        const S = this.shadowData, res = this.shadowRes, far = st.shadowDistance, near = 0.5, lambda = st.shadowLambda;
        const { fwd, right, up } = cam.basis();
        const th = Math.tan(cam.fov / 2), tw = th * aspect, L = env.sunDir;
        const sinSun = Math.max(L[1], 0.02);
        const LV = m4.lookAt(L, [0, 0, 0], Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
        let prev = near;
        for (let c = 0; c < CASCADES; c++) {
            const t = (c + 1) / CASCADES, split = lerp(near + (far - near) * t, near * Math.pow(far / near, t), lambda);
            let center = [0, 0, 0];
            const corners = [];
            for (const dd of [prev, split]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                const p = v3.add(v3.add(v3.madd(cam.pos, fwd, dd), v3.mul(right, sx * tw * dd)), v3.mul(up, sy * th * dd));
                corners.push(p);
                center = v3.add(center, v3.mul(p, 1 / 8));
            }
            const radius = Math.ceil(Math.max(...corners.map(p => v3.len(v3.sub(p, center)))) * 2) / 2;
            const texel = 2 * radius / res;
            const cl = [0, 1, 2].map(k => LV[k] * center[0] + LV[4 + k] * center[1] + LV[8 + k] * center[2] + LV[12 + k]);
            const x = Math.floor(cl[0] / texel) * texel, y = Math.floor(cl[1] / texel) * texel;
            const reach = Math.max(800, (top - (center[1] - radius)) / sinSun);
            const n = -cl[2] - radius - reach, f = -cl[2] + radius;
            const P = new Float64Array(16);
            P[0] = 1 / radius; P[5] = 1 / radius; P[10] = -1 / (f - n); P[12] = -x / radius; P[13] = -y / radius; P[14] = -n / (f - n); P[15] = 1;
            const M = m4.mul(P, LV);
            S.set(M, c * 16);
            S[64 + c] = split;
            S[68 + c] = texel;
            const row = r => [M[r], M[4 + r], M[8 + r], M[12 + r]];
            const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), comb = (a, b, k) => a.map((q, i) => q + k * b[i]);
            r.cascadePlanes[c] = [comb(r3, r0, 1), comb(r3, r0, -1), comb(r3, r1, 1), comb(r3, r1, -1), r2, comb(r3, r2, -1)].map((pl, k) => {
                const l = Math.hypot(pl[0], pl[1], pl[2]) || 1, n = pl.map(q => q / l);
                S.set(n, 72 + (c * 6 + k) * 4);
                return n;
            });
            r.viewData.set(M, (c + 1) * 64);
            r.viewData.set([0, 0, 0, 0, -L[0], -L[1], -L[2], c >= CHEAP_CASCADE ? 1 : 0], (c + 1) * 64 + 16);
            prev = split;
        }
        S.set([CASCADES, res, st.cascadeTint ? 1 : 0, st.shadows ? 1 : 0], 168);
        r.device.queue.writeBuffer(this.buf, 0, S);
    }

    // the cascades' passes, after the cull
    passes(enc, archs, st, cam) {
        const r = this.r;
        if (st.shadows && archs.length) for (let c = 0; c < CASCADES; c++) {
            const pass = enc.beginRenderPass({ colorAttachments: [], timestampWrites: r.stamps(2 + c * 2),
                depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
            pass.setBindGroup(0, this.passBG);
            pass.setBindGroup(3, r.viewBG, [(c + 1) * 256]);
            r.drawLists(pass, archs, c + 1, m => (m.alphaCutoff > 0 ? this.meshPipe : this.opaquePipe), c >= CHEAP_CASCADE ? this.impCheapPipe : this.impPipe, true, st, cam);
            pass.end();
        }
    }

    // the HUD's GPU timings: the cascades' passes, when they ran
    timed(st, archs) { return st.shadows && archs.length > 0; }
    gpuTimes(on, ms) { return { shadow: on ? [0, 1, 2, 3].map(c => ms(2 + c * 2)) : null }; }
}

return { extensions: { renderer: ShadowsRenderer } };
});
