'use strict';
// The baker: renders a model into its octahedral atlas.

Features.part('imposter', (engine, feature) => {
const { MSAA, BAKE_DEPTH_FORMAT, Oct, orthoFrame, atlasLayers, ImposterAtlas, atlasMipLevels } = feature;

// ImposterBaker: renders a model's unlit surface into an N x N octahedral atlas (one texture per G-buffer
// layer). Each frame goes through small 4x MSAA targets, is resolved (premultiplied by coverage) and copied
// into its cell; then the mip chains are built. Lighting is applied at runtime, so it never needs a rebake.
class ImposterBaker {
    constructor(r) { this.r = r; }

    async bake(asset) {
        const r = this.r, d = r.device, U = GPUTextureUsage, s = asset.settings, mesh = asset.mesh, gm = asset.gpu(r);
        const N = s.grid, full = s.mode === 'full', maxDim = d.limits.maxTextureDimension2D;
        let res = s.res;
        while (N * res > maxDim && res > 16) res = Math.floor(res / 2);
        const size = N * res, levels = atlasMipLevels(res), t0 = performance.now(), layers = atlasLayers(r, asset.emissive);
        const tex = {}, ms = [], cells = [];
        for (const [name, format] of layers) {
            tex[name] = d.createTexture({ size: [size, size], format, mipLevelCount: levels, usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT | U.COPY_DST });
            ms.push(d.createTexture({ size: [res, res], format, sampleCount: MSAA, usage: U.RENDER_ATTACHMENT }));
            cells.push(d.createTexture({ size: [res, res], format, usage: U.RENDER_ATTACHMENT | U.COPY_SRC }));
        }
        const msD = d.createTexture({ size: [res, res], format: BAKE_DEPTH_FORMAT, sampleCount: MSAA, usage: U.RENDER_ATTACHMENT });
        const colorAttachments = layers.map((l, k) => ({ view: ms[k].createView(), resolveTarget: cells[k].createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'discard' }));
        const depthView = msD.createView();

        const R = mesh.radius * 1.02, c = mesh.center, data = new Float32Array(N * N * 64);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) orthoFrame(data, (j * N + i) * 64, Oct.frameDir(i, j, N, full), c, R);
        const ub = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(ub, 0, data);
        const bg = d.createBindGroup({ layout: r.bakeBgl, entries: [{ binding: 0, resource: { buffer: ub, size: 96 } }, { binding: 1, resource: r.repSampler }] });
        const pipes = r.bakePipes[asset.emissive ? 1 : 0];

        const enc = d.createCommandEncoder();
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const pass = enc.beginRenderPass({ colorAttachments, depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' } });
            pass.setVertexBuffer(0, gm.vbuf);
            pass.setVertexBuffer(1, gm.aoBuf);
            pass.setIndexBuffer(gm.ibuf, 'uint32');
            pass.setBindGroup(0, bg, [(j * N + i) * 256]);
            for (const sm of mesh.submeshes) {
                pass.setPipeline(pipes[sm.material.doubleSided ? 1 : 0]);
                pass.setBindGroup(1, sm.material.bindGroup(r));
                pass.drawIndexed(sm.count, 1, sm.first, 0, 0);
            }
            pass.end();
            layers.forEach(([name], k) => enc.copyTextureToTexture({ texture: cells[k] }, { texture: tex[name], origin: [i * res, j * res] }, [res, res]));
        }
        for (const [name, , pipe] of layers) this.mips(enc, tex[name], pipe, levels);
        d.queue.submit([enc.finish()]);
        await d.queue.onSubmittedWorkDone();
        for (const t of [...ms, ...cells, msD]) t.destroy();
        ub.destroy();
        let bytes = 0;
        for (let l = 0; l < levels; l++) bytes += (size >> l) * (size >> l) * 4 * layers.length;
        return new ImposterAtlas(r, tex, { grid: N, res, full, levels, center: c, radius: R, bytes, bakeMs: performance.now() - t0 });
    }

    // box-filter mip chain; premultiplied values average correctly
    mips(enc, tex, pipe, levels) {
        const d = this.r.device;
        for (let l = 1; l < levels; l++) {
            const bg = d.createBindGroup({ layout: this.r.mipBgl, entries: [
                { binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }, { binding: 1, resource: this.r.clampSampler },
            ] });
            const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] });
            pass.setPipeline(pipe);
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }
    }
}

return { ImposterBaker };
});
