'use strict';
// Meshes: building (the mesh kit's), pooling and splitting them by plane.

Features.part('portal', (engine, feature) => {

// Geometry: MeshBuilder (one chunk; the mesh kit's), GeometryPool (every chunk in one vertex / index buffer), splitMesh
// and worldBounds (the mesh kit's).
// vertex = pos(3f) normal(3f) material(u32) -> 28 bytes
const { newell, MeshBuilder, splitMesh, worldBounds } = engine.kits.mesh;

class GeometryPool {
    constructor() { this.vdata = []; this.idata = []; this.vcount = 0; this.chunks = []; }
    add(b, info) {
        if (!b.idx.length) return null;
        const c = Object.assign({ first: this.idata.length, count: b.idx.length, baseVertex: this.vcount, min: b.min.slice(), max: b.max.slice() }, info);
        for (let i = 0; i < b.data.length; i++) this.vdata.push(b.data[i]);
        for (let i = 0; i < b.idx.length; i++) this.idata.push(b.idx[i]);
        this.vcount += b.count; this.chunks.push(c);
        return c;
    }
    arrays() {
        const v = new Float32Array(this.vdata.length), u = new Uint32Array(v.buffer);
        for (let i = 0; i < this.vdata.length; i++) { if (i % 7 === 6) u[i] = this.vdata[i]; else v[i] = this.vdata[i]; }
        return { vertices: v, indices: new Uint32Array(this.idata) };
    }
}

return { newell, MeshBuilder, GeometryPool, splitMesh, worldBounds };
});
