'use strict';
// The renderer: culling, shadows, meshes, imposters and the overlay.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, lerp, v3, frustumPlanes } = Common;
const {
    MSAA, DEPTH_FORMAT, BAKE_DEPTH_FORMAT, ALBEDO_FORMAT, NORMAL_FORMAT, EMISSIVE_FORMAT, CASCADES, SHADOW_FLOATS,
    LISTS, CHEAP_CASCADE, VF, GLOBAL_FLOATS, LOD_MODES, ATLAS_VIEWS, m4, TextureFactory, uploadImage, WGSL_SKY,
    WGSL_MESH, WGSL_BAKE, WGSL_AO, WGSL_MIP, WGSL_CULL, WGSL_IMPOSTER, WGSL_OVERLAY, atlasLayers,
} = feature;

class Renderer {
    // fx: the feature context (the host's device, canvas size, target; see js/engine/host.js)
    constructor(fx) {
        this.fx = fx;
        this.onError = msg => console.error(msg);
        this.globals = new Float32Array(GLOBAL_FLOATS);
        this.patterns = new Map();
        this.readBuf = null;
        this.readPending = false;
        this.queryPending = false;
        this.camPlanes = [];
        this.cascadePlanes = [];
        this.lastRead = -1;
    }

    async init() {
        // GPU pass timings for the HUD where the browser allows them
        const device = this.device = this.fx.device;
        const timing = device.features.has('timestamp-query');
        if (timing) {
            this.querySet = device.createQuerySet({ type: 'timestamp', count: 12 });
            this.queryBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
            this.queryRead = device.createBuffer({ size: 96, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            this.gpuTimes = null;               // { cull, shadow: [4], main } in ms
        }
        this.format = this.fx.format;
        this.width = this.height = 0;

        const U = GPUBufferUsage, S = GPUShaderStage;
        this.globalBuf = device.createBuffer({ size: GLOBAL_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
        this.overlayBuf = device.createBuffer({ size: 64, usage: U.UNIFORM | U.COPY_DST });
        this.repSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
        this.clampSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.whiteTexture = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: this.whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        this.blackTexture = device.createTexture({ size: [1, 1], format: EMISSIVE_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        device.queue.writeTexture({ texture: this.blackTexture }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);

        const tex = (binding, visibility = S.FRAGMENT) => ({ binding, visibility, texture: {} });
        const smp = binding => ({ binding, visibility: S.FRAGMENT, sampler: {} });
        this.bgl0 = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, buffer: { type: 'uniform' } }, smp(1), smp(2),
            { binding: 3, visibility: S.VERTEX | S.FRAGMENT | S.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 4, visibility: S.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
            { binding: 5, visibility: S.FRAGMENT, sampler: { type: 'comparison' } },
        ] });
        this.viewBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } }] });
        this.matBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, tex(1)] });
        this.instBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } }] });
        this.impBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, tex(1), tex(2), tex(3), tex(4)] });
        this.cullBgl = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } }, { binding: 1, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.COMPUTE, buffer: { type: 'storage' } }, { binding: 3, visibility: S.COMPUTE, buffer: { type: 'storage' } },
            { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        ] });
        this.bakeBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } }, smp(1)] });
        this.mipBgl = device.createBindGroupLayout({ entries: [tex(0), smp(1)] });
        this.ovBgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } }, smp(1), tex(2), tex(3), tex(4), tex(5)] });
        this.aoBgl = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } }, { binding: 1, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: S.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: S.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
            { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
        ] });
        this.shadowBuf = device.createBuffer({ size: SHADOW_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
        this.shadowData = new Float32Array(SHADOW_FLOATS);
        this.viewBuf = device.createBuffer({ size: LISTS * 256, usage: U.UNIFORM | U.COPY_DST });
        this.viewData = new Float32Array(LISTS * 64);
        this.viewBG = device.createBindGroup({ layout: this.viewBgl, entries: [{ binding: 0, resource: { buffer: this.viewBuf, size: 96 } }] });
        this.shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
        // shadow passes bind this 1-layer stand-in: the real map is their render target
        this.dummyShadow = device.createTexture({ size: [1, 1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
        this.shadowPassBG = this.makeGlobalBG(this.dummyShadow);
        this.ensureShadowMap(2048);

        const layout = (...bgls) => device.createPipelineLayout({ bindGroupLayouts: bgls });
        const mod = code => device.createShaderModule({ code });
        const vertexLayout = [{ arrayStride: VF * 4, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' },
        ] }, { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }] }];      // + per-vertex AO
        const mainDepth = (write, compare) => ({ format: DEPTH_FORMAT, depthWriteEnabled: write, depthCompare: compare });
        const target = [{ format: this.format }], ms = { count: MSAA }, a2c = { count: MSAA, alphaToCoverageEnabled: true };

        const meshMod = mod(WGSL_MESH), meshLayout = layout(this.bgl0, this.matBgl, this.instBgl, this.viewBgl);
        const mesh = cullMode => device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: meshMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
            depthStencil: mainDepth(true, 'greater'), multisample: a2c,
        });
        this.meshPipe = mesh('back');
        this.meshTwoSided = mesh('none');
        const shadowDepth = bias => ({ format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: bias, depthBiasSlopeScale: bias ? 2 : 0 });
        this.shadowMeshPipe = device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: meshMod, entryPoint: 'fsShadow', targets: [] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: shadowDepth(2),
        });
        // opaque casters (terrain, bark, stone...): no fragment stage, the fast depth-only path
        this.shadowOpaquePipe = device.createRenderPipeline({
            layout: meshLayout,
            vertex: { module: meshMod, entryPoint: 'vs', buffers: vertexLayout },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: shadowDepth(2),
        });

        const impMod = mod(WGSL_IMPOSTER), impLayout = layout(this.bgl0, this.impBgl, this.instBgl, this.viewBgl);
        this.shadowImpPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fsShadow', targets: [] },
            primitive: { topology: 'triangle-list' },
            depthStencil: shadowDepth(0),
        });
        this.shadowImpCheapPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fsShadowCheap', targets: [] },
            primitive: { topology: 'triangle-list' },
            depthStencil: shadowDepth(1),
        });
        this.impPipe = device.createRenderPipeline({
            layout: impLayout,
            vertex: { module: impMod, entryPoint: 'vs' },
            fragment: { module: impMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' },
            depthStencil: mainDepth(true, 'greater'), multisample: a2c,
        });

        const skyMod = mod(WGSL_SKY);
        this.skyPipe = device.createRenderPipeline({
            layout: layout(this.bgl0),
            vertex: { module: skyMod, entryPoint: 'vs' }, fragment: { module: skyMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' }, depthStencil: mainDepth(false, 'always'), multisample: ms,
        });

        const ovMod = mod(WGSL_OVERLAY);
        this.ovPipe = device.createRenderPipeline({
            layout: layout(this.ovBgl),
            vertex: { module: ovMod, entryPoint: 'vs' }, fragment: { module: ovMod, entryPoint: 'fs', targets: target },
            primitive: { topology: 'triangle-list' }, depthStencil: mainDepth(false, 'always'), multisample: ms,
        });

        const cullMod = mod(WGSL_CULL);
        this.cullPipe = device.createComputePipeline({ layout: layout(this.bgl0, this.cullBgl), compute: { module: cullMod, entryPoint: 'cull' } });

        const mipMod = mod(WGSL_MIP), mipLayout = layout(this.mipBgl);
        const mip = format => device.createRenderPipeline({
            layout: mipLayout, vertex: { module: mipMod, entryPoint: 'vs' }, fragment: { module: mipMod, entryPoint: 'fs', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        this.mipAlbedo = mip(ALBEDO_FORMAT);
        this.mipNormal = mip(NORMAL_FORMAT);

        const bakeMod = mod(WGSL_BAKE), bakeLayout = layout(this.bakeBgl, this.matBgl);
        const bake = (emissive, cullMode) => device.createRenderPipeline({
            layout: bakeLayout,
            vertex: { module: bakeMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: bakeMod, entryPoint: 'fs', targets: atlasLayers(this, emissive).map(([, format]) => ({ format })) },
            primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
            depthStencil: { format: BAKE_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' }, multisample: ms,
        });
        this.bakePipes = [false, true].map(e => [bake(e, 'back'), bake(e, 'none')]);        // [emissive][two-sided]
        this.aoDepthPipe = device.createRenderPipeline({
            layout: bakeLayout,
            vertex: { module: bakeMod, entryPoint: 'vs', buffers: vertexLayout },
            fragment: { module: bakeMod, entryPoint: 'fsDepth', targets: [] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });
        this.aoPipe = device.createComputePipeline({ layout: layout(this.aoBgl), compute: { module: mod(WGSL_AO), entryPoint: 'main' } });
        this.resize();
    }

    makeGlobalBG(shadowTex) {
        return this.device.createBindGroup({ layout: this.bgl0, entries: [
            { binding: 0, resource: { buffer: this.globalBuf } }, { binding: 1, resource: this.repSampler }, { binding: 2, resource: this.clampSampler },
            { binding: 3, resource: { buffer: this.shadowBuf } }, { binding: 4, resource: shadowTex.createView({ dimension: '2d-array' }) },
            { binding: 5, resource: this.shadowSampler },
        ] });
    }

    ensureShadowMap(res) {
        res = clamp(res, 256, this.device.limits.maxTextureDimension2D);
        if (this.shadowTex && this.shadowRes === res) return;
        this.shadowTex?.destroy();
        this.shadowRes = res;
        this.shadowTex = this.device.createTexture({ size: [res, res, CASCADES], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.shadowLayers = Array.from({ length: CASCADES }, (_, k) => this.shadowTex.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }));
        this.globalBG = this.makeGlobalBG(this.shadowTex);
    }

    // Cascades: split the camera range [near, shadowDistance] (log / uniform mix by lambda); fit each slice's
    // bounding sphere with an orthographic light box, snapped to whole texels so shadows do not shimmer, and
    // stretched far back toward the sun so casters outside the slice still land in the map.
    writeShadows(cam, env, st, aspect) {
        const S = this.shadowData, res = this.shadowRes, far = st.shadowDistance, near = 0.5, lambda = st.shadowLambda;
        const { fwd, right, up } = cam.basis();
        const th = Math.tan(cam.fov / 2), tw = th * aspect, L = env.sunDir;
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
            const n = -cl[2] - radius - 800, f = -cl[2] + radius;
            const P = new Float64Array(16);
            P[0] = 1 / radius; P[5] = 1 / radius; P[10] = -1 / (f - n); P[12] = -x / radius; P[13] = -y / radius; P[14] = -n / (f - n); P[15] = 1;
            const M = m4.mul(P, LV);
            S.set(M, c * 16);
            S[64 + c] = split;
            S[68 + c] = texel;
            const row = r => [M[r], M[4 + r], M[8 + r], M[12 + r]];
            const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), comb = (a, b, k) => a.map((q, i) => q + k * b[i]);
            this.cascadePlanes[c] = [comb(r3, r0, 1), comb(r3, r0, -1), comb(r3, r1, 1), comb(r3, r1, -1), r2, comb(r3, r2, -1)].map((pl, k) => {
                const l = Math.hypot(pl[0], pl[1], pl[2]) || 1, n = pl.map(q => q / l);
                S.set(n, 72 + (c * 6 + k) * 4);
                return n;
            });
            this.viewData.set(M, (c + 1) * 64);
            this.viewData.set([0, 0, 0, 0, -L[0], -L[1], -L[2], c >= CHEAP_CASCADE ? 1 : 0], (c + 1) * 64 + 16);
            prev = split;
        }
        S.set([CASCADES, res, st.cascadeTint ? 1 : 0, st.shadows ? 1 : 0], 168);
        this.device.queue.writeBuffer(this.shadowBuf, 0, S);
    }

    patternTexture(def) {
        const key = JSON.stringify([def.pattern, def.colors, def.seed, def.size, def.alphaCutoff]);
        let t = this.patterns.get(key);
        if (!t) this.patterns.set(key, t = uploadImage(this.device, TextureFactory.canvas(def), def.alphaCutoff || 0));
        return t;
    }

    resize() {
        const [w, h] = this.fx.size();
        if (this.msaaTex && this.width === w && this.height === h) return;
        this.width = w; this.height = h;
        this.msaaTex?.destroy(); this.depthTex?.destroy();
        const U = GPUTextureUsage.RENDER_ATTACHMENT;
        this.msaaTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: MSAA, usage: U });
        // sampled too: a composition reads it (js/engine/compositor.js)
        this.depthTex = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, sampleCount: MSAA, usage: U | GPUTextureUsage.TEXTURE_BINDING });
        this.msaaView = this.msaaTex.createView();
        this.depthView = this.depthTex.createView();
    }

    writeGlobals(cam, env, st, time) {
        const g = this.globals, W = this.width, H = this.height;
        const vp = m4.mul(m4.reversedInfinite(cam.fov, W / H, 0.1), cam.viewMatrix());
        g.set(vp, 0);
        g.set([...cam.pos, time], 16);
        g.set([...env.sunDir, env.exposure], 20);
        g.set([...env.sunColor, env.sunIntensity], 24);
        g.set([...env.skyTop, 0], 28);
        g.set([...env.skyHorizon, 0], 32);
        g.set([...env.ambientSky, 0], 36);
        g.set([...env.ambientGround, env.ambientStrength], 40);
        g.set([...env.fogColor, env.fogDensity], 44);
        this.camPlanes = frustumPlanes(vp, { reversed: true });
        this.camPlanes.forEach((p, i) => g.set(p, 48 + i * 4));
        g.set([st.lodDistance, st.fade, st.far, LOD_MODES.indexOf(st.lodMode)], 72);
        g.set([st.blend ? 1 : 0, st.parallax ? 1 : 0, st.depthOffset ? 1 : 0, st.tint ? 1 : 0], 76);
        g.set(m4.invert(vp), 80);
        g.set([W, H, 1 / W, 1 / H], 96);
        g.set([env.emission, 0, 0, 0], 100);
        g.set([...cam.basis().fwd, 0], 104);
        this.device.queue.writeBuffer(this.globalBuf, 0, g);
        this.viewData.set(vp, 0);
        this.viewData.set([...cam.pos, 1, ...cam.basis().fwd, 0], 16);
    }

    stamps(i) { return this.querySet ? { querySet: this.querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } : undefined; }

    // is a static archetype's bounding sphere inside list `list`'s volume (camera frustum + far, or a cascade box)
    sees(a, list, st, cam) {
        const planes = list ? this.cascadePlanes[list - 1] : this.camPlanes, c = a.sphere[0], r = a.sphere[1];
        if (!list && v3.len(v3.sub(c, cam.pos)) - r > st.far) return false;
        return planes.every(p => p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] >= -r);
    }

    // draw every archetype's list `list` (0: camera, 1 + c: cascade c); meshPipe(material) picks the mesh pipeline.
    // GPU-culled archetypes draw indirect; static ones (terrain chunks) are culled here and drawn directly,
    // which spares the browser's per-draw validation of hundreds of indirect draws.
    drawLists(pass, archs, list, meshPipe, impPipe, shadow, st, cam) {
        let cur = null;
        for (const a of archs) {
            if (!a.count || (shadow && !a.asset.castShadows)) continue;
            if (a.static) {
                const seen = this.sees(a, list, st, cam);
                if (list) a.cpuCasters += seen ? 1 : 0; else a.visible[0] = seen ? 1 : 0;
                if (!seen) continue;
            }
            const gm = a.asset.gpu(this), base = list * a.setStride;
            pass.setVertexBuffer(0, gm.vbuf);
            pass.setVertexBuffer(1, gm.aoBuf);
            pass.setIndexBuffer(gm.ibuf, 'uint32');
            pass.setBindGroup(2, a.static ? a.srcBG : a.meshBG[list]);
            a.asset.mesh.submeshes.forEach((s, i) => {
                const p = meshPipe(s.material);
                if (p !== cur) { pass.setPipeline(p); cur = p; }
                pass.setBindGroup(1, s.material.bindGroup(this));
                if (a.static) pass.drawIndexed(s.count, a.count, s.first, 0, 0);
                else pass.drawIndexedIndirect(a.args, base + 16 + 20 * i);
            });
        }
        pass.setPipeline(impPipe);
        for (const a of archs) {
            if (!a.count || a.static || !a.asset.atlas || (shadow && !a.asset.castShadows)) continue;
            pass.setBindGroup(1, a.asset.atlas.bg);
            pass.setBindGroup(2, a.impBG[list]);
            pass.drawIndirect(a.args, list * a.setStride);
        }
    }

    // one frame: cull (compute: camera + cascades) -> counts into the indirect args -> shadow cascades ->
    // sky, meshes, imposters, atlas overlay
    render(world, cam, st, time, overlay, env) {
        this.resize();
        const d = this.device, archs = world ? world.list : [];
        this.writeGlobals(cam, env, st, time);
        this.writeShadows(cam, env, st, this.width / this.height);
        for (let k = 0; k < LISTS; k++) d.queue.writeBuffer(this.viewBuf, k * 256, this.viewData, k * 64, 24);
        const enc = d.createCommandEncoder();
        for (const a of archs) a.upload(this);
        if (archs.length) {
            const cp = enc.beginComputePass({ timestampWrites: this.stamps(0) });
            cp.setPipeline(this.cullPipe);
            cp.setBindGroup(0, this.globalBG);
            for (const a of archs) if (a.count && !a.static) { cp.setBindGroup(1, a.cullBG); cp.dispatchWorkgroups(Math.ceil(a.count / 64)); }
            cp.end();
        }
        // a few times a second: copy the indirect args back for the HUD's counts
        const doRead = archs.length > 0 && !this.readPending && time - this.lastRead > 0.25;
        const offsets = [];
        let readBytes = 0;
        for (const a of archs) { offsets.push(readBytes); readBytes += a.static ? 0 : a.setStride * LISTS; }
        if (doRead) {
            if (!this.readBuf || this.readBuf.size < readBytes) {
                this.readBuf?.destroy();
                this.readBuf = d.createBuffer({ size: readBytes * 2, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            }
            archs.forEach((a, i) => { if (!a.static) enc.copyBufferToBuffer(a.args, 0, this.readBuf, offsets[i], a.setStride * LISTS); });
        }

        if (st.shadows && archs.length) for (let c = 0; c < CASCADES; c++) {
            const pass = enc.beginRenderPass({ colorAttachments: [], timestampWrites: this.stamps(2 + c * 2),
                depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
            pass.setBindGroup(0, this.shadowPassBG);
            pass.setBindGroup(3, this.viewBG, [(c + 1) * 256]);
            this.drawLists(pass, archs, c + 1, m => (m.alphaCutoff > 0 ? this.shadowMeshPipe : this.shadowOpaquePipe), c >= CHEAP_CASCADE ? this.shadowImpCheapPipe : this.shadowImpPipe, true, st, cam);
            pass.end();
        }

        const pass = enc.beginRenderPass({
            timestampWrites: this.stamps(10),
            colorAttachments: [{ view: this.msaaView, resolveTarget: this.fx.target(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' }],
            depthStencilAttachment: { view: this.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        pass.setPipeline(this.skyPipe);
        pass.setBindGroup(0, this.globalBG);
        pass.draw(3);
        pass.setBindGroup(3, this.viewBG, [0]);
        this.drawLists(pass, archs, 0, m => (m.doubleSided ? this.meshTwoSided : this.meshPipe), this.impPipe, false, st, cam);
        for (const a of archs) if (a.static) { a.casters[0] = st.shadows ? a.cpuCasters : 0; a.cpuCasters = 0; }
        if (overlay) {
            // bottom right, left of the control panel when that is showing
            const W = this.width, H = this.height, dpr = W / Math.max(1, this.fx.canvas.clientWidth), m = 12 * dpr;
            const right = (overlay.rightInset || 0) * dpr + m, px = Math.max(64, Math.min(H * 0.42, (W - right) * 0.45, 440 * dpr));
            const s = overlay.sel, x0 = W - right - px, y0 = H - m - px;
            d.queue.writeBuffer(this.overlayBuf, 0, new Float32Array([
                x0 / W * 2 - 1, 1 - y0 / H * 2, (x0 + px) / W * 2 - 1, 1 - (y0 + px) / H * 2,
                ...s.cells[0], ...s.cells[1], ...s.cells[2], overlay.atlas.grid, ATLAS_VIEWS.indexOf(overlay.view), ...s.w, 0,
            ]));
            pass.setPipeline(this.ovPipe);
            pass.setBindGroup(0, overlay.atlas.overlayBG);
            pass.draw(6);
        }
        pass.end();
        const doTime = this.querySet && !this.queryPending && doRead;
        if (doTime) {
            enc.resolveQuerySet(this.querySet, 0, 12, this.queryBuf, 0);
            enc.copyBufferToBuffer(this.queryBuf, 0, this.queryRead, 0, 96);
        }
        d.queue.submit([enc.finish()]);
        if (doTime) {
            this.queryPending = true;
            const shadowsOn = st.shadows && archs.length > 0;
            this.queryRead.mapAsync(GPUMapMode.READ).then(() => {
                const t = new BigUint64Array(this.queryRead.getMappedRange()), ms = k => Math.max(0, Number(t[k + 1] - t[k])) / 1e6;
                this.gpuTimes = { cull: ms(0), shadow: shadowsOn ? [0, 1, 2, 3].map(c => ms(2 + c * 2)) : null, main: ms(10) };
                this.queryRead.unmap();
                this.queryPending = false;
            }).catch(() => { this.queryPending = false; });
        }

        if (doRead) {
            this.readPending = true;
            this.lastRead = time;
            const list = archs.slice(), buf = this.readBuf, n = readBytes;
            buf.mapAsync(GPUMapMode.READ, 0, n).then(() => {
                const u = new Uint32Array(buf.getMappedRange(0, n));
                list.forEach((a, i) => {
                    if (a.static) return;
                    const words = a.setStride / 4, subs = a.asset.mesh.submeshes.length;
                    const count = (k, mesh) => u[offsets[i] / 4 + k * words + (mesh ? 5 : 1)] * (mesh ? (subs ? 1 : 0) : 1);
                    a.visible[0] = count(0, true);
                    a.visible[1] = count(0, false);
                    a.casters = [0, 0];
                    for (let c = 1; c < LISTS; c++) { a.casters[0] += count(c, true); a.casters[1] += count(c, false); }
                });
                buf.unmap();
                this.readPending = false;
            }).catch(() => { this.readPending = false; });
        }
    }
}

return { Renderer };
});
