'use strict';
// WGSL: the storms' cloud shapes, one for every renderer that draws them: the atmosphere's weather map (its cells and
// hurricane, at the camera) and a planet's cloud shell (the origin's bodies, the same storms seen from space). Each
// shape is a coverage on the ground plane about the storm (m), its top (m) the caller's from it; the shader that takes
// them has fbm2(p: vec2f, octaves: i32) -> f32 (0 .. 1).

Features.kit('weather', (engine, kit) => {
const StormWGSL = /* wgsl */`
// a hurricane at xz (m), rel from its eye, H as Storms.hurricane packs it ([x, z, eye radius, strength] [eyewall top,
// turn, rain bands, outer radius] [precipitation, band top, eye floor cover, raggedness]): the eyewall ring, the spiral
// rain bands wound in towards it (and their noise, bn), the central dense overcast spreading from the eyewall top,
// the eye (each 0 .. 1, the strength not in)
struct HurricaneShape { wall: f32, band: f32, bn: f32, cdo: f32, eye: f32 };
fn hurricaneShape(xz: vec2f, rel: vec2f, H0: vec4f, H1: vec4f, H2: vec4f) -> HurricaneShape {
    let r = length(rel);
    let a = atan2(rel.y, rel.x);
    let re = H0.z;
    let rag = fbm2(xz / 7000.0 - H1.y * 3.0, 3) - 0.5;
    let rn = r * (1.0 + rag * H2.w);
    var s: HurricaneShape;
    s.wall = smoothstep(re * 0.9, re * 1.1, rn) * (1.0 - smoothstep(re * 2.0, re * 3.2, rn));
    // log spiral: inwards the bands turn the way the storm does; bands fray and break up
    let ph = a - H1.y + log(max(r, re) / re) * 2.4;
    s.bn = fbm2(xz / 9000.0 + H1.y * 2.0, 4);
    s.band = smoothstep(0.4, 0.85, 0.5 + 0.5 * cos(H1.z * ph) + (s.bn - 0.5) * 0.7)
        * smoothstep(re * 1.6, re * 2.6, r) * (1.0 - smoothstep(H1.w * 0.55, H1.w, r)) * (0.55 + 0.45 * clamp(1.0 - r / H1.w, 0.0, 1.0));
    s.cdo = (1.0 - smoothstep(H1.w * 0.25, H1.w * 0.55, rn)) * smoothstep(re * 1.0, re * 1.6, rn);
    s.eye = 1.0 - smoothstep(re * 0.8, re * 1.0, rn);
    return s;
}

// a storm cell's tower at xz (m), d from its centre, of radius (m), seed; drift: how far the wind carried the noise
// (m): its footprint (0 .. 1, smooth-edged) and its outline's noise
fn cellTower(xz: vec2f, d: vec2f, radius: f32, seed: f32, drift: vec2f) -> vec2f {
    let outline = fbm2((xz - drift * 0.5) / (radius * 0.7) + seed * 31.0, 3);
    let g = clamp(1.0 - length(d) / radius * (0.75 + 0.5 * outline), 0.0, 1.0);
    return vec2f(g * g * (3.0 - 2.0 * g), outline);
}

// a tall cell's anvil at xz, d from its centre, dist = length(d): the sheet it spreads downwind (wd, unit) under the
// tropopause, at the equilibrium level under the overshooting top (top, the tower's dome rises out of it); its top
// sinks away from the updraft and is lumpy, so seen from above it is no flat lid. cloud: the layer's [base, top];
// coverage: the cell's. vec2f(cover, top), cover 0 for a cell too low for one
fn cellAnvil(xz: vec2f, d: vec2f, dist: f32, radius: f32, top: f32, coverage: f32, seed: f32, wd: vec2f, cloud: vec2f) -> vec2f {
    let tall = clamp((top - cloud.y - 2500.0) / 4000.0, 0.0, 1.0) * clamp(coverage * 2.0, 0.0, 1.0);
    if (tall <= 0.0) { return vec2f(0.0); }
    let ad = d - wd * radius * 0.8;
    let along = dot(ad, wd);
    let fo = fbm2(xz / 5000.0 + seed * 7.0, 3);
    let ra = length(vec2f(along * 0.6, dot(ad, vec2f(-wd.y, wd.x)))) / (radius * 1.6) * (0.8 + 0.4 * fo);
    let ga = clamp(1.0 - ra, 0.0, 1.0);
    let sink = clamp(dist / (radius * 3.0), 0.0, 1.0);
    return vec2f(ga * ga * (3.0 - 2.0 * ga) * tall * 0.85, top - 400.0 - 0.1 * (top - cloud.x) - 1100.0 * sink * sink + (fo - 0.5) * 1000.0);
}
`;

return { StormWGSL };
});
