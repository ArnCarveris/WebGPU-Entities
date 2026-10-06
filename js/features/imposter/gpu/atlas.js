'use strict';
// The imposter atlas: its G-buffer layers and mip levels.

Features.part('imposter', (engine, feature) => {
const { ALBEDO_FORMAT, NORMAL_FORMAT, SURFACE_FORMAT, EMISSIVE_FORMAT } = feature;

// The baked G-buffer layers: [name, format, mip pipeline]. `emissive` only for models with emissive materials.
function atlasLayers(r, emissive) {
    const l = [['albedo', ALBEDO_FORMAT, r.mipAlbedo], ['normal', NORMAL_FORMAT, r.mipNormal], ['surface', SURFACE_FORMAT, r.mipNormal]];
    if (emissive) l.push(['emissive', EMISSIVE_FORMAT, r.mipAlbedo]);
    return l;
}

class ImposterAtlas {
    constructor(r, tex, info) {
        Object.assign(this, info);      // grid, res, full, levels, center, radius, bakeMs, bytes
        this.tex = tex;                 // albedo, normal, surface, emissive?
        const d = r.device;
        this.ub = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(this.ub, 0, new Float32Array([...this.center, this.radius, this.grid, this.full ? 1 : 0, 1 / this.grid, 1 / this.res]));
        const views = [tex.albedo, tex.normal, tex.surface, tex.emissive || r.blackTexture].map(t => t.createView());
        this.bg = d.createBindGroup({ layout: r.impBgl, entries: [{ binding: 0, resource: { buffer: this.ub } }, ...views.map((v, i) => ({ binding: i + 1, resource: v }))] });
        this.overlayBG = d.createBindGroup({ layout: r.ovBgl, entries: [
            { binding: 0, resource: { buffer: r.overlayBuf } }, { binding: 1, resource: r.clampSampler }, ...views.map((v, i) => ({ binding: i + 2, resource: v })),
        ] });
    }
    get layers() { return Object.keys(this.tex).length; }
    destroy() { for (const t of Object.values(this.tex)) t.destroy(); this.ub.destroy(); }
}

// mip levels whose cells stay whole texels (res divisible by 2^(levels-1)) and at least 8 px wide
function atlasMipLevels(res) {
    let l = 1;
    while (l < 6 && res % (1 << l) === 0 && (res >> l) >= 8) l++;
    return l;
}

return { atlasLayers, ImposterAtlas, atlasMipLevels };
});
