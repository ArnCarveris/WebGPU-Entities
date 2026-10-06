'use strict';
// Scenario materials: surface properties only (lighting is applied per frame).

Features.part('imposter', (engine, feature) => {
const { lin, uploadImage } = feature;

// Scenario materials: { pattern, colors, seed, tint (sRGB), alphaCutoff, doubleSided, backfaceFlip, wrap, uvScale,
// spec, gloss, emissive: { color, strength } }. Imported ones carry `color` (linear) and an `image`.
// Only surface properties live here; how they are lit is decided per frame by the lighting scenario.
class Material {
    constructor(name, def = {}) {
        this.name = name;
        this.def = def;
        this.color = def.color ? def.color.slice(0, 3) : def.tint ? lin(def.tint) : [1, 1, 1];
        this.alpha = def.alpha ?? 1;
        this.alphaCutoff = def.alphaCutoff ?? 0;
        this.wrap = def.wrap ?? 0;
        this.uvScale = def.uvScale ?? 1;
        this.doubleSided = !!def.doubleSided;
        this.backfaceFlip = def.backfaceFlip ?? true;
        this.spec = def.spec ?? 0.1;               // specular strength
        this.gloss = def.gloss ?? 0.3;             // 0 rough .. 1 mirror-like
        const em = def.emissive;
        this.emissive = em ? (em.linear ? em.color.slice(0, 3) : lin(em.color || '#ffffff')).map(x => x * (em.strength ?? 1)) : [0, 0, 0];
        this.image = def.image || null;
        this.gpu = null;
    }

    bindGroup(r) {
        if (this.gpu) return this.gpu.bg;
        const d = r.device;
        let tex = r.whiteTexture, own = false;
        if (this.image) { tex = uploadImage(d, this.image, this.alphaCutoff); own = true; }
        else if (this.def.pattern) tex = r.patternTexture(this.def);
        const ub = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(ub, 0, new Float32Array([...this.color, this.alpha, this.alphaCutoff, this.wrap, this.uvScale, this.backfaceFlip ? 1 : 0,
            this.spec, this.gloss, 0, 0, ...this.emissive, 0]));
        const bg = d.createBindGroup({ layout: r.matBgl, entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: tex.createView() }] });
        this.gpu = { tex, own, ub, bg };
        return bg;
    }

    get isEmissive() { return this.emissive.some(x => x > 0); }

    destroy() {
        if (!this.gpu) return;
        this.gpu.ub.destroy();
        if (this.gpu.own) this.gpu.tex.destroy();
        this.gpu = null;
    }
}

return { Material };
});
