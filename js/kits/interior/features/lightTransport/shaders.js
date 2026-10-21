'use strict';
// WGSL: light through portals, over the core's stand-in (render/shaders.js NO_THROUGH: an area lit by its own lights).

Features.feature('interior/portal/lightTransport', (engine, kit) => {
const { SUN_FAR } = kit;

// The lights of the areas behind an area's portals, and the sun through them (its lighting table's `through`, written by
// LightTransport), each only along rays through its apertures: the scene shader's throughLight
const WGSL_THROUGH = /* wgsl */`
// how much of a light at L reaches p through a portal aperture (centre c, half extents r, u): the segment from p to L
// must cross it. Its edges cast a penumbra as wide as an emitter of that size at L makes it at p
fn aperture(p: vec3f, L: vec3f, c: vec3f, r: vec3f, u: vec3f, size: f32) -> f32 {
    let n = normalize(cross(r, u));
    let sp = dot(p - c, n);
    let sl = dot(L - c, n);
    if (sp * sl > 0.0 || abs(sp - sl) < 1e-5) { return 0.0; }
    let h = p + (L - p) * (sp / (sp - sl)) - c;
    let rl = max(length(r), 1e-4);
    let ul = max(length(u), 1e-4);
    let edge = min(rl - abs(dot(h, r)) / rl, ul - abs(dot(h, u)) / ul);
    let w = size * abs(sp) / max(abs(sl), 1e-3) + 0.01;
    return smoothstep(-w, w, edge);
}

// col lit by the lights of the areas behind area ai's portals, and the sun through them: only along rays through their
// apertures (wpos the point, N its normal, V toward the eye, spec its material's specular)
fn throughLight(col0: vec3f, ai: u32, wpos: vec3f, N: vec3f, V: vec3f, albedo: vec3f, spec: f32) -> vec3f {
    var col = col0;
    let through = u32(areas[ai].info.z);
    for (var k = 0u; k < through; k++) {
        let T = areas[ai].through[k];
        var lc = T.color.rgb * T.color.w;
        var L = normalize(G.sunDir.xyz);
        var lp = wpos + L * ${SUN_FAR}.0;
        var att = 1.0;
        var shine = 48.0;
        if (T.posRad.w > 0.0) {
            lp = T.posRad.xyz;
            let dv = lp - wpos;
            let dist = length(dv);
            L = dv / max(dist, 1e-4);
            att = pow(clamp(1.0 - dist / T.posRad.w, 0.0, 1.0), 2.0);
            shine = 32.0;
        } else {
            lc *= G.sunColor.rgb;
        }
        let ndl = max(dot(N, L), 0.0);
        if (ndl * att <= 0.0) { continue; }
        var vis = aperture(wpos, lp, T.ap[0].xyz, T.ap[1].xyz, T.ap[2].xyz, T.ap[0].w);
        if (T.ap[1].w > 1.5) { vis *= aperture(wpos, lp, T.ap[3].xyz, T.ap[4].xyz, T.ap[5].xyz, T.ap[0].w); }
        let H = normalize(L + V);
        col += (albedo + vec3f(pow(max(dot(N, H), 0.0), shine) * spec)) * ndl * lc * att * vis;
    }
    return col;
}
`;

return { WGSL_THROUGH };
});
