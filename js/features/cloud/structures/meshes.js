'use strict';
// The cloud's side of the common mesh interface (kits.mesh): builders over Structures' coloured triangles.

Features.part('cloud', (engine, feature) => {
const { GroundFrame } = engine.Common;
const { KINDS } = engine.kits.mesh;
const { Structures, BUS_IN, BUS_LEAF } = feature;

// the glass layer's kinds (fsGlass): a side pane (streaked by the wind of a bus's speed), a windscreen or rear window
const GLASS_KINDS = ['side', 'screen'];
const ORIGIN = new GroundFrame([0, 0], 0);

// A builder of the mesh interface over a Structures of its own (a mesh in its own frame: a bus's body, or its glass with
// layer 'glass'). Materials are { color, kind, inside, leaf }: the vertex material is the kind's index (KINDS, or
// GLASS_KINDS), plus BUS_IN for a cabin's inside and BUS_LEAF[leaf] for a sliding door leaf. finish(): the vertices.
class StructureMesh {
    constructor(layer) {
        this.S = new Structures(null);
        this.kinds = layer === 'glass' ? GLASS_KINDS : KINDS;
    }
    code(m) {
        const k = m.kind === undefined ? 0 : this.kinds.indexOf(m.kind);
        if (k < 0) throw new Error(`no material kind "${m.kind}" here`);
        return k + (m.inside ? BUS_IN : 0) + (m.leaf !== undefined ? BUS_LEAF[m.leaf] : 0);
    }
    cuboid(lo, hi, m) { this.S.box(ORIGIN, (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2, (hi[0] - lo[0]) / 2, (hi[2] - lo[2]) / 2, lo[1], hi[1], m.color, this.code(m)); }
    quad(a, b, c, d, m) { this.S.quad(a, b, c, d, m.color, this.code(m)); }
    tri(a, b, c, m) { this.S.tri(a, b, c, m.color, this.code(m)); }
    finish() { return this.S.v; }
}

// the world's meshes (World.meshes): builders only (what is built on the terrain goes through Structures itself)
const cloudMeshes = { builder: (opts = {}) => new StructureMesh(opts.layer) };

return { StructureMesh, cloudMeshes };
});
