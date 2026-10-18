'use strict';
// The baker: renders a source (any mesh a renderer can draw) into its octahedral atlas; meshSource, the source for the
// kit's standard mesh, and bakeVertexAO, that mesh's per-vertex ambient occlusion.

Features.kit('imposter', (engine, kit) => {
const { ImposterGpu, Oct, FRAME_FLOATS, orthoFrame, BAKE_MSAA, BAKE_DEPTH_FORMAT, atlasLayers, atlasMipLevels, ImposterAtlas } = kit;

const AO_DIRS = 48;                         // directions of the per-vertex ambient occlusion bake
const AO_RES = 256;

// ImposterBaker: renders a source's unlit surface into an N x N octahedral atlas (one texture per G-buffer layer).
// Each frame goes through small 4x MSAA targets, is resolved (premultiplied by coverage) and copied into its cell;
// then the mip chains are built. Lighting is applied at runtime, so it never needs a rebake.
//
// source: { center, radius (its bounding sphere, object space; the bake adds 2%), emissive (bake the emission layer),
//           draw(pass) (record its draws: group 0, the frame, is bound; it binds its pipelines, made with
//           ImposterGpu.bakePipeline, and its own groups) }
// options: { grid (frames per side), res (px per frame; halved until the atlas fits the device), full (whole sphere,
//           else the upper hemisphere) }
class ImposterBaker {
    constructor(device) { this.gpu = ImposterGpu.of(device); }

    async bake(source, { grid, res, full = false }) {
        const g = this.gpu, d = g.device, U = GPUTextureUsage, N = grid, maxDim = d.limits.maxTextureDimension2D;
        while (N * res > maxDim && res > 16) res = Math.floor(res / 2);
        const size = N * res, levels = atlasMipLevels(res), t0 = performance.now(), layers = atlasLayers(source.emissive);
        const tex = {}, ms = [], cells = [];
        for (const [name, format] of layers) {
            tex[name] = d.createTexture({ size: [size, size], format, mipLevelCount: levels, usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT | U.COPY_DST });
            ms.push(d.createTexture({ size: [res, res], format, sampleCount: BAKE_MSAA, usage: U.RENDER_ATTACHMENT }));
            cells.push(d.createTexture({ size: [res, res], format, usage: U.RENDER_ATTACHMENT | U.COPY_SRC }));
        }
        const msD = d.createTexture({ size: [res, res], format: BAKE_DEPTH_FORMAT, sampleCount: BAKE_MSAA, usage: U.RENDER_ATTACHMENT });
        const colorAttachments = layers.map((l, k) => ({ view: ms[k].createView(), resolveTarget: cells[k].createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'discard' }));
        const depthView = msD.createView();

        const R = source.radius * 1.02, c = source.center, data = new Float32Array(N * N * FRAME_FLOATS);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) orthoFrame(data, (j * N + i) * FRAME_FLOATS, Oct.frameDir(i, j, N, full), c, R);
        const ub = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(ub, 0, data);
        const bg = d.createBindGroup({ layout: g.frameLayout, entries: [{ binding: 0, resource: { buffer: ub, size: 96 } }, { binding: 1, resource: g.repSampler }] });

        const enc = d.createCommandEncoder();
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const pass = enc.beginRenderPass({ colorAttachments, depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' } });
            pass.setBindGroup(0, bg, [(j * N + i) * FRAME_FLOATS * 4]);
            source.draw(pass);
            pass.end();
            layers.forEach(([name], k) => enc.copyTextureToTexture({ texture: cells[k] }, { texture: tex[name], origin: [i * res, j * res] }, [res, res]));
        }
        for (const [name, format] of layers) this.mips(enc, tex[name], g.mipPipe(format), levels);
        d.queue.submit([enc.finish()]);
        await d.queue.onSubmittedWorkDone();
        for (const t of [...ms, ...cells, msD]) t.destroy();
        ub.destroy();
        let bytes = 0;
        for (let l = 0; l < levels; l++) bytes += (size >> l) * (size >> l) * 4 * layers.length;
        return new ImposterAtlas(g, tex, { grid: N, res, full, levels, center: c, radius: R, bytes, bakeMs: performance.now() - t0 });
    }

    // box-filter mip chain; premultiplied values average correctly
    mips(enc, tex, pipe, levels) {
        const g = this.gpu, d = g.device;
        for (let l = 1; l < levels; l++) {
            const bg = d.createBindGroup({ layout: g.mipLayout, entries: [
                { binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }, { binding: 1, resource: g.clampSampler },
            ] });
            const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] });
            pass.setPipeline(pipe);
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }
    }
}

// The standard mesh as a bake source: { vertices (MESH_VF floats a vertex: MESH_BUFFERS), ao (an f32 a vertex),
// indices (uint32), count (vertices), submeshes: [{ first, count, doubleSided, material (a bind group in ImposterGpu.materialLayout) }],
// center, radius, emissive }
function meshSource(device, m) {
    const g = ImposterGpu.of(device);
    return {
        center: m.center, radius: m.radius, emissive: !!m.emissive,
        draw(pass) {
            pass.setVertexBuffer(0, m.vertices);
            pass.setVertexBuffer(1, m.ao);
            pass.setIndexBuffer(m.indices, 'uint32');
            for (const sm of m.submeshes) {
                pass.setPipeline(g.meshBakePipe(!!m.emissive, sm.doubleSided));
                pass.setBindGroup(1, sm.material);
                pass.drawIndexed(sm.count, 1, sm.first, 0, 0);
            }
        },
    };
}

// The standard mesh's per-vertex ambient occlusion into its `ao` buffer (needs STORAGE on vertices and ao): AO_DIRS
// depth views of it (a Fibonacci sphere), then one compute pass tests every vertex against them. strength 0..1.
function bakeVertexAO(device, m, strength) {
    const g = ImposterGpu.of(device), d = device, U = GPUBufferUsage, R = m.radius * 1.02, c = m.center, count = m.count;
    const data = new Float32Array(AO_DIRS * FRAME_FLOATS);
    for (let k = 0; k < AO_DIRS; k++) {
        const y = 1 - 2 * (k + 0.5) / AO_DIRS, rr = Math.sqrt(1 - y * y), phi = k * 2.399963;
        orthoFrame(data, k * FRAME_FLOATS, [Math.cos(phi) * rr, y, Math.sin(phi) * rr], c, R);
    }
    const frames = d.createBuffer({ size: data.byteLength, usage: U.UNIFORM | U.STORAGE | U.COPY_DST });
    d.queue.writeBuffer(frames, 0, data);
    const params = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }), pb = new ArrayBuffer(16);
    new Uint32Array(pb, 0, 2).set([count, AO_DIRS]);
    new Float32Array(pb, 8, 2).set([R * 0.01, strength]);
    d.queue.writeBuffer(params, 0, pb);
    const depth = d.createTexture({ size: [AO_RES, AO_RES, AO_DIRS], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const bg = d.createBindGroup({ layout: g.frameLayout, entries: [{ binding: 0, resource: { buffer: frames, size: 96 } }, { binding: 1, resource: g.repSampler }] });
    const enc = d.createCommandEncoder();
    for (let k = 0; k < AO_DIRS; k++) {
        const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
            view: depth.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
        } });
        pass.setPipeline(g.aoDepthPipe);
        pass.setVertexBuffer(0, m.vertices);
        pass.setVertexBuffer(1, m.ao);
        pass.setIndexBuffer(m.indices, 'uint32');
        pass.setBindGroup(0, bg, [k * FRAME_FLOATS * 4]);
        for (const sm of m.submeshes) {
            pass.setBindGroup(1, sm.material);
            pass.drawIndexed(sm.count, 1, sm.first, 0, 0);
        }
        pass.end();
    }
    const cp = enc.beginComputePass();
    cp.setPipeline(g.aoPipe);
    cp.setBindGroup(0, d.createBindGroup({ layout: g.aoLayout, entries: [
        { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: m.vertices } }, { binding: 2, resource: { buffer: frames } },
        { binding: 3, resource: depth.createView({ dimension: '2d-array' }) }, { binding: 4, resource: { buffer: m.ao } },
    ] }));
    cp.dispatchWorkgroups(Math.ceil(count / 64));
    cp.end();
    d.queue.submit([enc.finish()]);
    d.queue.onSubmittedWorkDone().then(() => { depth.destroy(); frames.destroy(); params.destroy(); });
}

return { AO_DIRS, AO_RES, ImposterBaker, meshSource, bakeVertexAO };
});
