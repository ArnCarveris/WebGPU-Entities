'use strict';
// Light through portals: what of the neighbouring areas' lights and of the sun shines into each area.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { MAX_THROUGH, LIGHT_DEPTH, SUN_SOFT, SUN_FAR } = feature;

// An area is lit by its own lights (Area.lights, the dynamic ones in it) and, through each open portal, by those of the
// areas behind it, up to LIGHT_DEPTH portals away; an indoor area gets the sun the same way through portals out to the
// outdoors. Each such light carries the apertures it passes; the scene shader lets it reach a point only along a ray
// through all of them, so the walls around a doorway or window shadow it and it falls into the area in the aperture's
// shape (a sunlit patch under a skylight, a wedge of lamplight out of a door), its edges as soft as the emitter is big.
// Glass tints and dims what passes it; a door lets light through the part its panel has slid off.
//
// The lights an area gets this way are ranked by how bright they are at the aperture they come in by and how near the
// eye that is; the first MAX_THROUGH go to the area's lighting table (World.lightingTable).

// a portal's opening as light sees it: centre c, half extents r (along right) and u (along up), normal n, and the
// colour it passes (glass); null when shut
function aperture(P) {
    if (P.closed) return null;
    let c = P.center, r = v3.mul(P.right, P.w / 2), u = v3.mul(P.up, P.h / 2);
    const d = P.door;
    if (d) {
        // the panel has slid toward `slide` by this much of its width (height): the opening is what it left
        const f = Math.min(1, d.openAmount * 0.97), vertical = d.slide === 'up' || d.slide === 'down', sign = d.slide === 'left' || d.slide === 'down' ? -1 : 1;
        if (f <= 0.01) return null;
        c = v3.madd(c, vertical ? u : r, -sign * (1 - f));
        if (vertical) u = v3.mul(u, f); else r = v3.mul(r, f);
    }
    const g = P.glass, pass = g ? [0, 1, 2].map(k => 1 - g[3] + g[3] * g[k]) : [1, 1, 1];
    return { P, c, r, u, n: P.normal, pass };
}

// distance from p to an aperture's rectangle
function reach(p, ap) {
    const d = v3.sub(p, ap.c), rl = v3.len(ap.r) || 1e-6, ul = v3.len(ap.u) || 1e-6;
    return Math.hypot(Math.max(0, Math.abs(v3.dot(d, ap.r) / rl) - rl), Math.max(0, Math.abs(v3.dot(d, ap.u) / ul) - ul), v3.dot(d, ap.n));
}

// do sun rays (toward s) through aperture a reach aperture b's rectangle? (a's corners cast along the rays onto b's plane)
function beam(a, s, b) {
    const sn = v3.dot(s, b.n);
    if (Math.abs(sn) < 1e-4) return false;
    const rl = v3.len(b.r), ul = v3.len(b.u);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const q = v3.madd(v3.madd(a.c, a.r, sx), a.u, sy), h = v3.sub(v3.madd(q, s, -v3.dot(v3.sub(q, b.c), b.n) / sn), b.c);
        const x = v3.dot(h, b.r) / rl, y = v3.dot(h, b.u) / ul;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return x1 >= -rl && x0 <= rl && y1 >= -ul && y0 <= ul;
}

class LightTransport {
    constructor(world) {
        this.world = world;
    }

    // the area on the other side of portal P from area a
    static across(P, a) { return P.front === a ? P.back : P.front; }

    // on: per area, the lights shining in it now. Per area, the lights that come in through portals, brightest first:
    // { L (a light, or null for the sun), I (intensity), pass (rgb the apertures let through), aps (apertures with the
    // side `far` of each one the light comes from, the one into the area last), weight }
    gather(on, t, eye) {
        const w = this.world, sun = v3.norm(w.sunDir), sunAmt = w.areas[0].sun, apertures = new Map();
        const ap = P => { if (!apertures.has(P)) apertures.set(P, aperture(P)); return apertures.get(P); };
        return w.areas.map((A, a) => {
            const into = [];
            const near = x => 1 / (1 + (v3.dist(eye, x.c) / 15) ** 2);
            // the lights of area b, through aps (the last into A): those that reach every one of them from its far side
            const lights = (b, aps) => {
                for (const L of on[b]) {
                    const I = L.intensityAt(t);
                    if (I <= 0) continue;
                    let weight = I * near(aps[aps.length - 1]);
                    for (const x of aps) {
                        const d = reach(L.pos, x);
                        if (v3.dot(v3.sub(L.pos, x.c), x.n) * x.far <= 0) { weight = 0; break; }
                        if (d >= L.radius) { weight = 0; break; }
                        weight *= (1 - d / L.radius) ** 2;
                    }
                    if (weight > 1e-4) into.push({ L, I, pass: pass(aps), aps, weight });
                }
            };
            // the sun, from the outdoors on the far side of aps[0]
            const sunlight = aps => {
                if (sunAmt <= 0 || aps.some(x => v3.dot(sun, x.n) * x.far <= 0.02)) return;
                if (aps.length > 1 && !beam(aps[0], sun, aps[1])) return;
                into.push({ L: null, I: sunAmt, pass: pass(aps), aps, weight: 8 * sunAmt * near(aps[aps.length - 1]) });
            };
            const walk = (b, aps, from) => {
                for (const i of w.areas[b].portals) {
                    const P = w.portals[i], c = LightTransport.across(P, b), x = c === a || P === from ? null : ap(P);
                    if (!x) continue;
                    // far: the side of its plane the light comes from (c's); a light must be there for every aperture
                    const path = [{ ...x, far: P.back === c ? 1 : -1 }, ...aps];
                    if (c === 0) sunlight(path);
                    lights(c, path);
                    if (path.length < LIGHT_DEPTH) walk(c, path, P);
                }
            };
            walk(a, [], null);
            into.sort((x, y) => y.weight - x.weight);
            if (into.length > MAX_THROUGH) into.length = MAX_THROUGH;
            return into;
        });
    }

    // a light's record in the lighting table (THROUGH_FLOATS at o): pos radius (radius 0: the sun), colour intensity,
    // then each aperture's centre, right and up half extents; [o + 8].w = the emitter's size, [o + 12].w = how many
    static write(data, o, x) {
        const L = x.L, c = L ? L.color : [1, 1, 1];
        data.set(L ? [L.pos[0], L.pos[1], L.pos[2], L.radius] : [0, 0, 0, 0], o);
        data.set([c[0] * x.pass[0], c[1] * x.pass[1], c[2] * x.pass[2], x.I], o + 4);
        x.aps.forEach((ap, k) => {
            const q = o + 8 + k * 12;
            data.set([ap.c[0], ap.c[1], ap.c[2], 0, ap.r[0], ap.r[1], ap.r[2], 0, ap.u[0], ap.u[1], ap.u[2], 0], q);
        });
        data[o + 11] = L ? L.size : SUN_SOFT * SUN_FAR;
        data[o + 15] = x.aps.length;
    }
}

// what the apertures let through together
function pass(aps) {
    return aps.reduce((s, x) => [s[0] * x.pass[0], s[1] * x.pass[1], s[2] * x.pass[2]], [1, 1, 1]);
}

return { LightTransport };
});
