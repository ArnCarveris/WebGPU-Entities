'use strict';
// GPU meshes: vertex, index and ambient occlusion buffers.

Features.world('imposter', (engine, kit) => {
const { bakeVertexAO } = engine.kits.imposter;
const { VF } = kit;

// GpuMesh: vertex / index buffers plus a per-vertex ambient occlusion buffer (1 where not baked): the imposter kit's
// standard mesh, so its bake (bakeVertexAO) and the imposter bake (ModelAsset.bakeSource) read it as it is
class GpuMesh {
    constructor(r, mesh, ao = 0) {
        const d = r.device, U = GPUBufferUsage, n = Math.max(1, mesh.vertices.length / VF);
        this.vbuf = d.createBuffer({ size: Math.max(16, mesh.vertices.byteLength), usage: U.VERTEX | U.STORAGE | U.COPY_DST });
        this.ibuf = d.createBuffer({ size: Math.max(16, mesh.indices.byteLength), usage: U.INDEX | U.COPY_DST });
        this.aoBuf = d.createBuffer({ size: Math.max(16, n * 4), usage: U.VERTEX | U.STORAGE | U.COPY_DST });
        d.queue.writeBuffer(this.vbuf, 0, mesh.vertices);
        d.queue.writeBuffer(this.ibuf, 0, mesh.indices);
        d.queue.writeBuffer(this.aoBuf, 0, new Float32Array(n).fill(1));
        if (ao > 0 && mesh.indices.length) bakeVertexAO(d, this.standard(r, mesh), ao);
    }

    // this mesh as the imposter kit's standard mesh (its materials' bind groups made on the way)
    standard(r, mesh) {
        return {
            vertices: this.vbuf, ao: this.aoBuf, indices: this.ibuf, count: mesh.vertices.length / VF, center: mesh.center, radius: mesh.radius,
            submeshes: mesh.submeshes.map(s => ({ first: s.first, count: s.count, doubleSided: s.material.doubleSided, material: s.material.bindGroup(r) })),
        };
    }

    destroy() { this.vbuf.destroy(); this.ibuf.destroy(); this.aoBuf.destroy(); }
}

return { GpuMesh };
});
