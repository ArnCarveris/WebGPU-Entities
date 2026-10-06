'use strict';
// GPU meshes: vertex, index and ambient occlusion buffers.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { AO_DIRS, AO_RES, VF, Oct } = feature;

// orthographic view of the bounding sphere (centre c, radius R) looking along -dir, written as one 256-byte
// slot: viewProj (depth 0..1 front to back), dir + 1 / R, centre
function orthoFrame(out, o, dir, c, R) {
    const rt = Oct.right(dir), up = v3.cross(dir, rt);
    out.set([rt[0] / R, up[0] / R, -dir[0] / (2 * R), 0, rt[1] / R, up[1] / R, -dir[1] / (2 * R), 0, rt[2] / R, up[2] / R, -dir[2] / (2 * R), 0,
        -v3.dot(rt, c) / R, -v3.dot(up, c) / R, 0.5 + v3.dot(dir, c) / (2 * R), 1], o);
    out.set([...dir, 1 / R, ...c, 0], o + 16);
}

// GpuMesh: vertex / index buffers plus a per-vertex ambient occlusion buffer (1 where not baked)
class GpuMesh {
    constructor(r, mesh, ao = 0) {
        const d = r.device, U = GPUBufferUsage, n = Math.max(1, mesh.vertices.length / VF);
        this.vbuf = d.createBuffer({ size: Math.max(16, mesh.vertices.byteLength), usage: U.VERTEX | U.STORAGE | U.COPY_DST });
        this.ibuf = d.createBuffer({ size: Math.max(16, mesh.indices.byteLength), usage: U.INDEX | U.COPY_DST });
        this.aoBuf = d.createBuffer({ size: Math.max(16, n * 4), usage: U.VERTEX | U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.vbuf, 0, mesh.vertices);
        d.queue.writeBuffer(this.ibuf, 0, mesh.indices);
        d.queue.writeBuffer(this.aoBuf, 0, new Float32Array(n).fill(1));
        if (ao > 0 && mesh.indices.length) this.bakeAO(r, mesh, ao);
    }

    // AO_DIRS depth views of the model (Fibonacci sphere), then one compute pass tests every vertex against them
    bakeAO(r, mesh, strength) {
        const d = r.device, U = GPUBufferUsage, R = mesh.radius * 1.02, c = mesh.center, count = mesh.vertices.length / VF;
        const data = new Float32Array(AO_DIRS * 64);
        for (let k = 0; k < AO_DIRS; k++) {
            const y = 1 - 2 * (k + 0.5) / AO_DIRS, rr = Math.sqrt(1 - y * y), phi = k * 2.399963;
            orthoFrame(data, k * 64, [Math.cos(phi) * rr, y, Math.sin(phi) * rr], c, R);
        }
        const frames = d.createBuffer({ size: data.byteLength, usage: U.UNIFORM | U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(frames, 0, data);
        const params = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }), pb = new ArrayBuffer(16);
        new Uint32Array(pb, 0, 2).set([count, AO_DIRS]);
        new Float32Array(pb, 8, 2).set([R * 0.01, strength]);
        d.queue.writeBuffer(params, 0, pb);
        const depth = d.createTexture({ size: [AO_RES, AO_RES, AO_DIRS], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        const bg = d.createBindGroup({ layout: r.bakeBgl, entries: [{ binding: 0, resource: { buffer: frames, size: 96 } }, { binding: 1, resource: r.repSampler }] });
        const enc = d.createCommandEncoder();
        for (let k = 0; k < AO_DIRS; k++) {
            const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
                view: depth.createView({ dimension: '2d', baseArrayLayer: k, arrayLayerCount: 1 }), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
            } });
            pass.setPipeline(r.aoDepthPipe);
            pass.setVertexBuffer(0, this.vbuf);
            pass.setVertexBuffer(1, this.aoBuf);
            pass.setIndexBuffer(this.ibuf, 'uint32');
            pass.setBindGroup(0, bg, [k * 256]);
            for (const sm of mesh.submeshes) {
                pass.setBindGroup(1, sm.material.bindGroup(r));
                pass.drawIndexed(sm.count, 1, sm.first, 0, 0);
            }
            pass.end();
        }
        const cp = enc.beginComputePass();
        cp.setPipeline(r.aoPipe);
        cp.setBindGroup(0, d.createBindGroup({ layout: r.aoBgl, entries: [
            { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: this.vbuf } }, { binding: 2, resource: { buffer: frames } },
            { binding: 3, resource: depth.createView({ dimension: '2d-array' }) }, { binding: 4, resource: { buffer: this.aoBuf } },
        ] }));
        cp.dispatchWorkgroups(Math.ceil(count / 64));
        cp.end();
        d.queue.submit([enc.finish()]);
        d.queue.onSubmittedWorkDone().then(() => { depth.destroy(); frames.destroy(); params.destroy(); });
    }

    destroy() { this.vbuf.destroy(); this.ibuf.destroy(); this.aoBuf.destroy(); }
}

return { orthoFrame, GpuMesh };
});
