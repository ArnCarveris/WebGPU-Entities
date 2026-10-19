'use strict';
// WGSL: the forest cover the terrain is shaded with (the land use's woods, or the canopy map of a real place). The plants
// themselves are the vegetation feature's.

Features.kit('atmosphere', (engine, kit) => {

// the forest cover the ground is shaded with (fsTerrain), the plants scattered by and the canopy raised over (0..1): the
// canopy map's where there is one (F.tdetail.w 2: geoCanopy), else the land use's woods, broken up a little
const WGSL_FOREST = /* wgsl */`
// the canopy map at xz: cover (0..1), mean height (m)
fn canopyAt(xz: vec2f) -> vec2f {
    let c = textureSampleLevel(canopyTex, clampSamp, (xz - F.tdomain.xy) / F.tdomain.z, 0.0).xy;
    return vec2f(c.x, c.y * 255.0);
}

// the canopy map's cover at xz as the ground is shaded by it: a cubic B-spline over its texels (four bilinear taps), so
// the 18 m cells round off into blobs instead of bilinear squares and diamonds
fn canopySmooth(xz: vec2f) -> f32 {
    let sz = vec2f(textureDimensions(canopyTex));
    let c = (xz - F.tdomain.xy) / F.tdomain.z * sz - 0.5;
    let f = fract(c);
    let i = c - f;
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1;
    let g1 = w2 + w3;
    let h0 = (i - 0.5 + w1 / g0) / sz;
    let h1 = (i + 1.5 + w3 / g1) / sz;
    let a = textureSampleLevel(canopyTex, clampSamp, h0, 0.0).x;
    let b = textureSampleLevel(canopyTex, clampSamp, vec2f(h1.x, h0.y), 0.0).x;
    let d = textureSampleLevel(canopyTex, clampSamp, vec2f(h0.x, h1.y), 0.0).x;
    let e = textureSampleLevel(canopyTex, clampSamp, h1, 0.0).x;
    return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * d + g1.x * e);
}

fn forestCover(xz: vec2f, woods: f32) -> f32 {
    if (F.tdetail.w > 1.5) { return sat(canopyAt(xz).x * 1.15); }
    return sat(woods * (0.4 + vnoise2(xz / 300.0)) * 1.3);
}
`;

return { WGSL_FOREST };
});
