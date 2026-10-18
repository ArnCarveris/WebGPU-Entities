'use strict';
// The imposter atlas: its G-buffer layers, their formats and mip levels, and ImposterAtlas (the textures a bake made and
// the bind group a draw reads them through).

Features.kit('imposter', (engine, kit) => {
const BAKE_MSAA = 4;                        // bake targets: resolving them premultiplies every layer by coverage
const BAKE_DEPTH_FORMAT = 'depth24plus';
const ALBEDO_FORMAT = 'rgba8unorm-srgb';    // layer 0: albedo (premultiplied by coverage), coverage
const NORMAL_FORMAT = 'rgba8unorm';         // layer 1: object-space normal, depth along the frame direction
const SURFACE_FORMAT = 'rgba8unorm';        // layer 2: ambient occlusion, specular, gloss, translucency (wrap)
const EMISSIVE_FORMAT = 'rgba8unorm-srgb';  // layer 3 (sources with emission only): emission / EMISSIVE_RANGE
const EMISSIVE_RANGE = 8;

// The baked G-buffer layers: [name, format]. `emissive` only for sources with emission.
function atlasLayers(emissive) {
    const l = [['albedo', ALBEDO_FORMAT], ['normal', NORMAL_FORMAT], ['surface', SURFACE_FORMAT]];
    if (emissive) l.push(['emissive', EMISSIVE_FORMAT]);
    return l;
}

// mip levels whose cells stay whole texels (res divisible by 2^(levels-1)) and at least 8 px wide
function atlasMipLevels(res) {
    let l = 1;
    while (l < 6 && res % (1 << l) === 0 && (res >> l) >= 8) l++;
    return l;
}

// ImposterAtlas: one bake's textures and how to draw from them. `bg` binds them in ImposterGpu.atlasLayout (the
// layout imposterWGSL(group) declares): the ImpAtlas uniform (bound centre + radius; frames per side, full, 1 / frames,
// uv inset), the four layers (a 1 x 1 black emissive without emission) and the clamped sampler. `views` are those four
// texture views, for anything else that shows the atlas (a debug overlay).
class ImposterAtlas {
    constructor(gpu, tex, info) {
        Object.assign(this, info);      // grid, res, full, levels, center, radius, bakeMs, bytes
        this.tex = tex;                 // albedo, normal, surface, emissive?
        const d = gpu.device;
        this.ub = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(this.ub, 0, new Float32Array([...this.center, this.radius, this.grid, this.full ? 1 : 0, 1 / this.grid, 1 / this.res]));
        this.views = [tex.albedo, tex.normal, tex.surface, tex.emissive || gpu.blackTexture].map(t => t.createView());
        this.bg = d.createBindGroup({ layout: gpu.atlasLayout, entries: [
            { binding: 0, resource: { buffer: this.ub } }, ...this.views.map((v, i) => ({ binding: i + 1, resource: v })), { binding: 5, resource: gpu.clampSampler },
        ] });
    }
    get layers() { return Object.keys(this.tex).length; }
    destroy() { for (const t of Object.values(this.tex)) t.destroy(); this.ub.destroy(); }
}

return {
    BAKE_MSAA, BAKE_DEPTH_FORMAT, ALBEDO_FORMAT, NORMAL_FORMAT, SURFACE_FORMAT, EMISSIVE_FORMAT, EMISSIVE_RANGE,
    atlasLayers, atlasMipLevels, ImposterAtlas,
};
});
