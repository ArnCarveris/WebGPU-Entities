'use strict';
// Texture formats, buffer layouts, LOD modes and the panel's choices (the atlas's are the imposter kit's).

Features.part('imposter', (engine, feature) => {
const { MESH_VF } = engine.kits.imposter;
const MSAA = 4;
const DEPTH_FORMAT = 'depth32float';        // reversed Z, infinite far plane
const CASCADES = 4;                         // shadow map cascades (layers of one depth32float array)
const SHADOW_FLOATS = 172;                  // Shadow uniform: 4 matrices, splits, texel sizes, 24 planes, params
const LISTS = 1 + CASCADES;                 // culled instance lists per archetype: camera, then one per cascade
const CHEAP_CASCADE = 2;                    // from this cascade on, imposters cast from one frame at their quad's depth
const VF = MESH_VF;                         // vertex floats: position 3, normal 3, uv 2, color 3 (the kit's standard mesh)
const INSTANCE_FLOATS = 12;                 // posScale, rotation quaternion, extra (x: forced LOD in, fade out)
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const GLOBAL_FLOATS = 108;
const FORCE = { auto: 0, mesh: 1, imposter: 2 };
const LOD_MODES = ['auto', 'mesh', 'imposter'];
const ATLAS_VIEWS = ['off', 'albedo', 'normal', 'depth', 'ao', 'surface', 'emissive'];
const GRID_CHOICES = [4, 6, 8, 10, 12, 16, 20, 24, 32];
const RES_CHOICES = [64, 128, 192, 256, 384, 512];

return {
    MSAA, DEPTH_FORMAT, CASCADES, SHADOW_FLOATS, LISTS, CHEAP_CASCADE, VF, INSTANCE_FLOATS,
    INSTANCE_BYTES, GLOBAL_FLOATS, FORCE, LOD_MODES, ATLAS_VIEWS, GRID_CHOICES, RES_CHOICES,
};
});
