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
// coverage: the cell's; spread: how many times a cell's length its plume reaches downwind (1: a cell's; a supercell's
// some 4: a plume hundreds of km long, half as wide, its edges sharp, spread out flat under the tropopause), and
// the reach of every cell's anvil (3.4 radii x spread). vec2f(cover, top), cover 0 for a cell too low for one
fn cellAnvil(xz: vec2f, d: vec2f, dist: f32, radius: f32, top: f32, coverage: f32, seed: f32, wd: vec2f, cloud: vec2f, spread: f32) -> vec2f {
    let tall = clamp((top - cloud.y - 2500.0) / 4000.0, 0.0, 1.0) * clamp(coverage * 2.0, 0.0, 1.0);
    if (tall <= 0.0) { return vec2f(0.0); }
    let ad = d - wd * radius * 0.8 * spread;
    let along = dot(ad, wd);
    let fo = fbm2(xz / 5000.0 + seed * 7.0, 3);
    let ra = length(vec2f(along * 0.6 / spread, dot(ad, vec2f(-wd.y, wd.x)) / (0.5 + 0.5 * spread))) / (radius * 1.6) * (0.8 + 0.4 * fo);
    // downwind it frays: the ice falling out of it is drawn into fibres along the wind, the edge soft and combed out,
    // the plume thinning between them (upwind, where the updraft pushes it out against the wind, it stays sharp)
    let dw = smoothstep(0.3, 1.0, along / (radius * 2.67 * spread));
    let fib = smoothstep(0.35, 0.65, fbm2(vec2f(along / (radius * 3.0), dot(ad, vec2f(-wd.y, wd.x)) / (radius * 0.3)) + seed * 13.0, 3));
    let ga = clamp((1.0 - ra - (fib - 0.5) * 0.8 * dw) * mix(spread, 1.2, dw), 0.0, 1.0);
    let sink = clamp(dist / (radius * 3.0 * spread), 0.0, 1.0);
    return vec2f(ga * ga * (3.0 - 2.0 * ga) * tall * 0.85 * mix(1.0, 0.15 + 0.85 * fib, dw),
        top - 400.0 - 0.1 * (top - cloud.x) - 1100.0 * sink * sink + (fo - 0.5) * 1000.0);
}

// the relief on a tall cell's anvil top at d from its centre (wd the wind), as cellAnvil spreads it (spread): the
// gravity waves the overshooting top sets off, rings rippling out over the sheet from it some 0.9 radii apart, and the
// plume of cirrus it blows above the anvil downwind. vec3f(how far it lifts the top (m), its slope along d's x, y): what
// a sun low over it lights on one side of every ripple and not the other (none for an ordinary cell's 1)
fn anvilRelief(d: vec2f, radius: f32, spread: f32, wd: vec2f) -> vec3f {
    let s = clamp((spread - 1.0) / 3.0, 0.0, 1.0);
    if (s <= 0.0) { return vec3f(0.0); }
    let r = max(length(d), 1.0);
    let k = 6.2832 / (radius * 0.9);
    let env = smoothstep(radius * 0.4, radius * 0.7, r) * exp(-r / (radius * 4.0)) * 150.0 * s;
    var o = vec3f(env * cos(k * r), -env * k * sin(k * r) * d / r);
    // (the above-anvil plume: a ridge from the dome downwind, widening and settling as it goes)
    let along = dot(d, wd);
    let across = dot(d, vec2f(-wd.y, wd.x));
    let w = radius * (0.3 + 0.15 * max(along, 0.0) / radius);
    let p = 900.0 * s * exp(-across * across / (w * w)) * smoothstep(0.0, radius * 0.5, along) * (1.0 - smoothstep(radius * 1.5, radius * 6.0, along));
    o += vec3f(p, -2.0 * p * across / (w * w) * vec2f(-wd.y, wd.x));
    return o;
}

// how far a cell's overshooting top rises above its top at d from its centre (m): a dome over the updraft, as wide as
// its radius, the higher the stronger the storm (spread, as cellAnvil's: none for an ordinary cell's 1, 2 km
// for a supercell's 4), throwing its shadow on the anvil about it
fn cellOvershoot(d: vec2f, radius: f32, spread: f32) -> f32 {
    let q = clamp(1.0 - length(d) / (radius * 0.5), 0.0, 1.0);
    return clamp((spread - 1.0) * 700.0, 0.0, 2000.0) * sqrt(q * q * (3.0 - 2.0 * q));
}

// cellOvershoot's dome with its slope, and the turrets boiling on it: rounded bubbles a quarter of its width and smaller, two sizes
// of them, the creases between them dark (seed: the cell's). vec3f(height (m), slope along d's x, y): a sun low over it
// lights its sunward flank and each bubble's sunward side, the far flank in its own shade
fn overshootRelief(d: vec2f, radius: f32, spread: f32, seed: f32) -> vec3f {
    let H = clamp((spread - 1.0) * 700.0, 0.0, 2000.0);
    let R = radius * 0.5;
    let r = max(length(d), 1.0);
    let q = clamp(1.0 - r / R, 0.0, 1.0);
    if (H <= 0.0 || q <= 0.0) { return vec3f(0.0); }
    let u = q * q * (3.0 - 2.0 * q);
    let dome = sqrt(u);
    var o = vec3f(H * dome, -H * 3.0 * q * (1.0 - q) / max(dome, 1e-3) / R * d / r);
    for (var i = 0; i < 2; i++) {
        let k = 6.2832 / (R * select(0.9, 0.5, i == 1));
        let a = seed * 5.0 + f32(i) * 1.7;
        let m = mat2x2f(cos(a), sin(a), -sin(a), cos(a));
        let v = m * d * k + vec2f(seed * 11.0, f32(i) * 3.3);
        let c = cos(v.x) * cos(v.y);
        let A = H * select(0.12, 0.05, i == 1) * sqrt(q);
        o += vec3f(A * abs(c), A * sign(c) * k * (transpose(m) * vec2f(-sin(v.x) * cos(v.y), -cos(v.x) * sin(v.y))));
    }
    return o;
}

// the clear slot a tornadic supercell's rear-flank downdraft cuts round its updraft (at d from its centre, wd the
// wind): a crescent on its upwind, right-hand flank, wrapping round the wall cloud the tornado hangs from (0 .. 1:
// how much of the low cloud it clears)
fn rearSlot(d: vec2f, radius: f32, wd: vec2f) -> f32 {
    let r = length(d) / radius;
    let rear = normalize(-wd + vec2f(wd.y, -wd.x) * 0.8);
    let a = dot(d / max(length(d), 1.0), rear);
    return smoothstep(0.35, 0.75, a) * smoothstep(0.12, 0.2, r) * (1.0 - smoothstep(0.42, 0.55, r));
}
`;

return { StormWGSL };
});
