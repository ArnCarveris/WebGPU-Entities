'use strict';
// The buses as the renderer draws them (its RendererExtension, renderer.ext.buses): each in its own frame (an object
// frame of busData: its slot), its body in the scene, its windows in the final pass after the rain outside them.

Features.feature('atmosphere/buses', (engine, kit) => {
const { makeBuffer } = engine.Common;
const { BUS_UNIFORM, STRUCT_VERTS } = kit;
const { STRUCT_FLOATS } = engine.kits.settlement;

class BusesRenderer {
    static key = 'buses';

    constructor(r) {
        this.r = r;
        this.draws = [];                // the buses to draw this frame, nearest first: their slots (FrameWriter)
    }

    wgsl(lib, modules) {
        lib.define('BUS_VERTEX', kit.WGSL_BUS_VERTEX);
        lib.define('BUS_SCENE', kit.WGSL_BUS_SCENE, { needs: ['STRUCT', 'OBJECT1', 'BUS_VERTEX'] });
        lib.define('BUS_GLASS', kit.WGSL_BUS_GLASS, { needs: ['OBJECT2', 'BUS_VERTEX'] });
        modules.scene.push('BUS_SCENE');
        modules.final.push('BUS_GLASS');
    }

    pipelines({ scene, final, layoutBus, layoutGlass, pipe, blendAlpha }) {
        this.pBus = pipe(layoutBus, scene, 'vsBus', 'fsBus', 'rgba16float', { write: true, compare: 'greater' }, undefined, STRUCT_VERTS);
        this.pGlass = pipe(layoutGlass, final, 'vsGlass', 'fsGlass', this.r.format, { write: false, compare: 'greater' }, blendAlpha, STRUCT_VERTS);
    }

    // one frame per bus (its slot)
    frames(world) { return world.buses.length; }

    // each bus's opaque mesh and glass
    setWorld(world) {
        const d = this.r.device;
        for (const m of this.meshes || []) { m.buf?.destroy(); m.glass?.destroy(); }
        this.meshes = world.buses.map(b => {
            const bv = new Float32Array(b.mesh.v), gv = new Float32Array(b.mesh.glass);
            return { count: bv.length / STRUCT_FLOATS, glassCount: gv.length / STRUCT_FLOATS,
                buf: bv.length ? makeBuffer(d, bv.byteLength, GPUBufferUsage.VERTEX, bv) : null,
                glass: gv.length ? makeBuffer(d, gv.byteLength, GPUBufferUsage.VERTEX, gv) : null };
        });
        this.draws = [];
    }

    outdoor(a) {
        if (!this.draws.length) return;
        a.setPipeline(this.pBus);
        for (const k of this.draws) {
            const m = this.meshes[k];
            if (!m.count) continue;
            a.setBindGroup(1, this.r.busGroup, [(this.frameBase + k) * BUS_UNIFORM]);
            a.setVertexBuffer(0, m.buf);
            a.draw(m.count);
        }
    }

    // the buses' windows after the rain outside them (seen from inside, the drops on the glass are in front of it),
    // furthest first
    final(b) {
        if (!this.draws.length) return;
        b.setPipeline(this.pGlass);
        for (let i = this.draws.length - 1; i >= 0; i--) {
            const k = this.draws[i], m = this.meshes[k];
            if (!m.glassCount) continue;
            b.setBindGroup(2, this.r.busGroup, [(this.frameBase + k) * BUS_UNIFORM]);
            b.setVertexBuffer(0, m.glass);
            b.draw(m.glassCount);
        }
    }
}

return { BusesRenderer };
});
