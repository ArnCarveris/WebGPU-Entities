'use strict';
// The common mesh interface: how an entity of any kit gets itself drawn in whatever world it is in.
//
// A world offers it as `world.meshes` (each feature implements it over its own renderer; the kits' entity types use
// nothing else, so none of them needs a feature's renderer). A world implements what its renderer draws:
//
//   builder(opts)                 a builder to make geometry with (kits.mesh MeshBuilder's methods): box(c, axes, half,
//                                 mat), cuboid(min, max, mat), poly(pts, n, mat), quad(a, b, c, d, mat), tri(a, b, c,
//                                 mat), cylinder(base, r, h, seg, mat), cone(base, r, h, seg, mat), model(name, M) (a
//                                 scenario model's parts), point(p, n, uv, color) -> index + face(a, b, c, d) (an indexed
//                                 surface); its `M` (a matrix every vertex goes through while set), min / max (bounds so
//                                 far) and finish() (what the world keeps of it). opts.layer: one of the world's layers
//   add(builder | () => builder, opts)    static geometry; what the world made of it (opts are the world's: where it
//                                 belongs, whether it is solid, how it is drawn...; a function is only called if needed)
//   part(builder, opts)           a part that moves (drawn with its own matrix): a handle, or null if empty
//   bounds(part, M)               a part's world bounds { min, max } placed with matrix M
//   split(builder, plane)         [behind, in front] of plane [nx, ny, nz, d]
//   instance(model, pose, opts)   an instance of a scenario model (or of what add() made): a handle with set(pose, i, opts)
//                                 (and radius, the model's, where the world knows it). A pose is { pos, q, scale } (q a quaternion; pos what the world's positions
//                                 are), or { matrix }; opts.count instances of it, opts.tint, opts.lod ('mesh' |
//                                 'imposter'), opts.visible(ctx) (drawn in that view or not), opts.owner (not drawn in its
//                                 own view)
//   rotation(rot)                 a scenario `rot` as a quaternion, in the world's convention
//   color(spec)                   a scenario colour as the world's renderer takes it
//
// A material reference is a scenario material name, or { color: [r, g, b], kind, ...flags } where the world draws
// colours: kind is one of KINDS (matte by default; a layer may have kinds of its own), and the flags are the world's.
//
//   portal    builder (MeshBuilder: materials by name, scenario models), add (into the area trees: opts name, owners,
//             lightArea, vehicle, dockedOnly, solid, climbable), part (pool chunks), bounds, split
//   cloud     builder (cuboid, quad, tri over Structures: { color, kind, inside, leaf }; layer 'glass': kinds 'side',
//             'screen')
//   origin    instance ({ pos: WorldPos, q, scale }; tint, seed), rotation ([yaw, pitch, roll] degrees)
//   imposter  builder (point / face), add (a generated asset: key, material, castShadows), instance (archetype slots;
//             lod), rotation (a yaw, or [x, y, z] degrees), color (hex -> linear)
//   gui       instance ({ matrix }; count, tint, owner, visible: drawn by the world each view)

Features.kit('mesh', (engine, kit) => {

// what a coloured surface is made of, for the worlds that draw colours with a material kind
const KINDS = ['matte', 'paint', 'glass', 'road', 'metal', 'window', 'water', 'lamp'];

// the colours structures are built in: walls and roofs to pick from, and each material's
const PALETTE = {
    walls: [[0.78, 0.74, 0.66], [0.74, 0.72, 0.68], [0.70, 0.55, 0.38], [0.56, 0.32, 0.25], [0.58, 0.63, 0.64], [0.68, 0.64, 0.50]],
    roofs: [[0.40, 0.15, 0.11], [0.22, 0.23, 0.25], [0.32, 0.23, 0.17], [0.28, 0.31, 0.28]],
    plinth: [0.30, 0.29, 0.28], door: [0.22, 0.14, 0.09], window: [0.06, 0.08, 0.10], brick: [0.36, 0.20, 0.16],
    asphalt: [0.12, 0.12, 0.13], paint: [0.72, 0.72, 0.66], gravel: [0.40, 0.37, 0.32], concrete: [0.50, 0.49, 0.47],
    stone: [0.46, 0.43, 0.40], wood: [0.36, 0.25, 0.16], metal: [0.24, 0.26, 0.27], glass: [0.36, 0.42, 0.45], sign: [0.85, 0.70, 0.12],
};

return { KINDS, PALETTE };
});
