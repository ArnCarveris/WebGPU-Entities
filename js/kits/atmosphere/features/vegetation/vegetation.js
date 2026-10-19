'use strict';
// The plants (the scenario's terrain says vegetation: true): scattered each frame about the eye and drawn near as meshes,
// further as octahedral imposters (the imposter kit), the canopy carpet beyond them. Its WGSL joins the scene module;
// without it the terrain's forest cover is all there is of the woods, and neither this nor the imposter kit loads.

Features.feature('atmosphere/vegetation', (engine, kit) => {
const { imposterWGSL } = engine.kits.imposter;
const { VegetationPass } = kit;

class VegetationRenderer {
    constructor(r) {
        this.r = r;
        this.carpet = true;         // false: no carpet (the far forest is the ground's shade alone)
    }

    wgsl(lib, modules) {
        lib.define('VEG_SITE', kit.WGSL_VEG_SITE, { needs: ['FOREST'] });
        lib.define('VEG_SCATTER', kit.WGSL_VEG_SCATTER, { needs: ['VEG_SITE'] });
        lib.define('VEG_ALBEDO', kit.WGSL_VEG_ALBEDO);
        lib.define('VEG', kit.WGSL_VEG);
        lib.define('IMPOSTER', imposterWGSL({ group: 3 }));
        lib.define('VEG_IMP', kit.WGSL_VEG_IMP);
        lib.define('VEG_CARPET', kit.WGSL_VEG_CARPET, { needs: ['VEG_SITE'] });
        modules.scene.push('VEG_ALBEDO', 'VEG', 'IMPOSTER', 'VEG_IMP', 'VEG_CARPET');
    }

    // the canopy carpet: the far forest over the terrain's patches (vsCanopy / fsCanopy), tested against the depth, not
    // written (its upper side alone: a hillside's shell seen from behind would march for nothing)
    pipelines({ scene, layoutA }) {
        const r = this.r;
        this.pCanopy = r.device.createRenderPipeline({
            label: 'vsCanopy', layout: layoutA,
            vertex: { module: scene, entryPoint: 'vsCanopy', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
            // premultiplied by its coverage; the target's alpha (the rain surface code) is left as the ground wrote it
            fragment: { module: scene, entryPoint: 'fsCanopy', targets: [{ format: 'rgba16float', blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: { format: r.depthFormat, depthWriteEnabled: false, depthCompare: 'greater' },
        });
    }

    // the plants of a new world (r.vegetation: the frame tells the shaders they are there)
    setWorld() {
        const r = this.r;
        r.vegetation?.destroy();
        r.vegetation = new VegetationPass(r);
        this.pipes = r.vegetation.pipelines(r.sceneModule, [r.worldSet.layout, r.busLayout], 'rgba16float', r.depthFormat);
    }

    encode(enc, prof) { this.r.vegetation.encode(enc, prof); }

    outdoor(a, { drawPatches }) {
        const r = this.r;
        r.vegetation.draw(a, this.pipes, r.busGroup);
        if (!this.carpet) return;
        a.setPipeline(this.pCanopy);
        a.setIndexBuffer(r.terrainIndex, 'uint32');
        a.setVertexBuffer(0, r.terrainNodes);
        drawPatches();
    }
}

return { extensions: { renderer: VegetationRenderer } };
});
