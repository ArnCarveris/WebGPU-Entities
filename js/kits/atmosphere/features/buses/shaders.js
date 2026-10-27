'use strict';
// WGSL of the buses: a bus vertex in its frame (its door leaves), the bus in the scene (its body, its cabin lit inside),
// its windows' glass in the final pass.

Features.feature('atmosphere/buses', (engine, kit) => {
const { LIGHT_CABIN } = kit;
const { BUS, BUS_IN, BUS_LEAF } = engine.kits.transit;

const WGSL_BUS_VERTEX = /* wgsl */`
// a bus vertex in its frame: door leaves (material flags ${BUS_LEAF[0]}, ${BUS_LEAF[1]}) slide apart outside the body as the doors open
fn busVertex(p: vec3f, mat: f32) -> vec3f {
    let m = u32(mat + 0.5);
    let o = busU.info.y;
    if ((m & ${BUS_LEAF[0]}u) != 0u) { return p + vec3f(-0.6 * o, 0.0, 0.07 * smoothstep(0.0, 0.25, o)); }
    if ((m & ${BUS_LEAF[1]}u) != 0u) { return p + vec3f(0.6 * o, 0.0, 0.07 * smoothstep(0.0, 0.25, o)); }
    return p;
}
`;

const WGSL_BUS_SCENE = /* wgsl */`
// a moving bus (BusLine): its mesh is in its own frame (busVertex), drawn with busU.mvp
@vertex fn vsBus(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> StructOut {
    let q = busVertex(p, c.a);
    var o: StructOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n, 0.0)).xyz;
    o.col = c;
    o.pos = curveClip(busU.mvp * vec4f(q, 1.0), o.world);
    return o;
}

// the sun reaches q (in the bus's frame) through glass: where its ray d leaves the body, if that is in a side window (not a
// pillar), the windscreen or the rear window. O(1): one box exit
fn throughGlass(q: vec3f, d: vec3f) -> f32 {
    let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
    let t = max((vec3f(${-BUS.hl}, ${BUS.skirt}, ${-BUS.hw}) - q) * inv, (vec3f(${BUS.hl}, ${BUS.roof}, ${BUS.hw}) - q) * inv);
    let te = min(t.x, min(t.y, t.z));
    let e = q + d * te;
    if (te == t.z) {
        // side: the window band, or a door's glass (lower) on the right
        let k = (e.x - ${BUS.bay0}) / ${BUS.bay};
        let bay = floor(k);
        let inPane = abs(fract(k) - 0.5) * ${BUS.bay} < ${(BUS.bay - BUS.pillar) / 2} && bay >= 0.0 && bay < ${BUS.bays}.0;
        let door = d.z > 0.0 && (bay == ${BUS.doorBays[0]}.0 || bay == ${BUS.doorBays[1]}.0);
        let lo = select(${BUS.winLo}, ${BUS.floor + 0.35}, door);
        return select(0.0, 1.0, inPane && e.y > lo && e.y < ${BUS.winHi});
    }
    if (te == t.x) {
        if (d.x > 0.0) { return select(0.0, 1.0, e.y > 0.95 && e.y < 2.45); }
        return select(0.0, 1.0, e.y > 1.4 && e.y < 2.3 && abs(e.z) < 0.9);
    }
    return 0.0;                                                          // roof or floor
}

// the lights on p inside the cabin (q: p in the bus's frame), as lampsAt has them, but one outside the body only through
// its glass (throughGlass): its own tail lights and headlights stand just outside it, and the body is no shelter box that
// holds them (lightSeen lets them out)
fn cabinLamps(p: vec3f, n: vec3f, v: vec3f, q: vec3f) -> Lamps {
    var o = Lamps(vec3f(0.0), vec3f(0.0));
    let m = lightCell(p);
    for (var w = 0u; w < 2u; w++) {
        var bits = m[w];
        while (bits != 0u) {
            let k = i32(w * 32u + countTrailingZeros(bits));
            bits &= bits - 1u;
            if ((u32(F.lights[k * 4 + 3].x) & ${LIGHT_CABIN}u) != 0u) { continue; }
            var l = vec3f(0.0, 1.0, 0.0);
            let c = lightAt(k, p, &l);
            let nl = dot(n, l);
            if (nl <= 0.0 || c.r + c.g + c.b < 1e-5) { continue; }
            let a = (busU.inv * vec4f(F.lights[k * 4].xyz, 1.0)).xyz;
            let inside = all(a > vec3f(${-BUS.hl}, ${BUS.skirt}, ${-BUS.hw})) && all(a < vec3f(${BUS.hl}, ${BUS.roof}, ${BUS.hw}));
            let seen = lightSeen(k, p) * select(throughGlass(q, normalize(a - q)), 1.0, inside);
            if (seen <= 0.0) { continue; }
            o.d += c * nl * seen;
            let h = normalize(l + v);
            o.s += c * nl * seen * pow(max(dot(n, h), 0.0), 40.0) * 6.0 / PI;
        }
    }
    return o;
}

// inside the cabin: sky light that comes in through the windows (less low down, under them), the sun where it shines in
// through glass, and the ceiling lamps, whose light the eye adapts to (so they read the same at any exposure)
fn shadeCabin(p: vec3f, nIn: vec3f, colIn: vec3f, mat: i32) -> vec3f {
    let v = normalize(F.cam.xyz - p);
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) { n = -n; }
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let q = (busU.inv * vec4f(p + n * 0.02, 1.0)).xyz;
    let ls = (busU.inv * vec4f(s, 0.0)).xyz;
    var sun = 0.0;
    if (s.y > 0.0 && sh.x * dot(n, s) > 0.002) { sun = throughGlass(q, ls); }
    let out = structureLight(p, sun > 0.0, false);                     // a canopy over the bus shades it too
    let low = smoothstep(${BUS.floor}, ${BUS.winHi}, q.y);
    let sky = F.ambient.rgb * sh.y * out.z * (0.10 + 0.22 * low) * (0.7 + 0.3 * abs(n.y));
    let lamp = vec3f(1.0, 0.93, 0.80) * 0.16 / max(F.sunCol.w, 0.2) * (0.35 + 0.65 * sat(-n.y * 0.5 + 0.5));
    let alb = colIn * (0.92 + 0.16 * vnoise2(vec2f(q.x + q.z, q.y) * 9.0));
    // the lights outside, through the windows, and a flashlight aboard (not the cabin's own glow: that is the lamps here)
    let lp = cabinLamps(p + n * 0.02, n, v, q);
    var col = alb * (F.sunCol.rgb * max(dot(n, s), 0.0) * sh.x * sun * out.x + sky + lamp + lp.d);
    if (mat == 4) {
        let r = reflect(-v, n);
        col += (skyColor(r) * sh.y * 0.25 + lamp * 0.5 + lp.s) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)) * 0.3;
    }
    return col;
}

@fragment fn fsBus(i: StructOut) -> @location(0) vec4f {
    let m = u32(i.col.a + 0.5);
    let mat = i32(m & 7u);
    if (mat == 7) { return vec4f(i.col.rgb * 1.6 / max(F.sunCol.w, 0.2), 0.0); }   // lamps, lights, the destination display
    if ((m & ${BUS_IN}u) != 0u) { return vec4f(shadeCabin(i.world, i.n, i.col.rgb, mat), 0.0); }
    return vec4f(shadeStruct(i.world, i.n, i.col.rgb, mat).rgb, 0.0);          // no splashes on a moving bus
}
`;

const WGSL_BUS_GLASS = /* wgsl */`
// the bus's windows, drawn over the composite (they write no depth, so the march and the particles see through them):
// a faint grey tint, the sky reflected at grazing angles, and rain drops on them while it rains, which the wind of the
// bus's speed streaks back along the side windows. O(1) per pixel: one hash per 2.5 cm cell
struct GlassOut { @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) n: vec3f, @location(2) local: vec3f, @location(3) kind: f32 };

@vertex fn vsGlass(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> GlassOut {
    let q = busVertex(p, c.a);
    var o: GlassOut;
    o.world = (busU.model * vec4f(q, 1.0)).xyz;
    o.n = (busU.model * vec4f(n, 0.0)).xyz;
    o.local = q;
    o.kind = f32(u32(c.a + 0.5) & 7u);
    o.pos = curveClip(busU.mvp * vec4f(q, 1.0), o.world);
    return o;
}

@fragment fn fsGlass(i: GlassOut) -> @location(0) vec4f {
    let p = i.world;
    let v = normalize(F.cam.xyz - p);
    var n = normalize(i.n);
    if (dot(n, v) < 0.0) { n = -n; }
    let sh = shadowAt(p);
    let s = F.sunDir.xyz;
    let r = reflect(-v, n);
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, v)), 5.0);
    let spec = skyColor(r) * sh.y + F.sunCol.rgb * sh.x * pow(max(dot(r, s), 0.0), 600.0) * 6.0 + lampsAt(p + n * 0.02, n, v, 900.0, 0u).s;
    // drops: a hashed 2 cm cell holds one or not (more of them the harder it rains), 2-5 mm across; they come and go.
    // On the side windows the wind of the bus's speed draws them out backwards into thin streaks (cells up to 8 times
    // longer along the bus, the drop as long), and sweeps some away
    let rain = sat(F.near.x * 1.5);
    var drop = 0.0;
    var rim = 0.0;
    if (rain > 0.01) {
        let side = i.kind < 0.5;
        let u = select(i.local.z, i.local.x, side);
        let k = select(0.0, sat(busU.info.x / 15.0), side);
        let stretch = 1.0 + 7.0 * k;
        let g = vec2f(u / (0.02 * stretch), i.local.y / 0.02 + u * 3.0 * k);    // streaks run back and a little down
        let cell = floor(g);
        let cx = u32(cell.x + 100000.0);
        let cy = u32(cell.y + 1000.0);
        let life = floor(F.cam.w * mix(0.4, 1.5, k) + rnd(cx * 7919u + cy));
        let h = rnd((cx * 73856093u) ^ (cy * 19349663u) ^ (u32(life) * 83492791u));
        if (h < rain * mix(0.35, 0.2, k)) {
            let c = vec2f(rnd(u32(h * 1e6)), rnd(u32(h * 1e6) + 7u)) * 0.5 + 0.25;
            let d = length(fract(g) - c) / (0.12 + 0.12 * fract(h * 13.0));
            drop = 1.0 - smoothstep(0.6, 1.0, d);
            rim = smoothstep(0.25, 0.85, d);
        }
    }
    // a drop is a little lens: the dark ground below shows in its middle, the bright sky above in its rim
    let sky = F.ambient.rgb * sh.y;
    let dropCol = mix(sky * 0.25, sky * 2.2 + F.sunCol.rgb * sh.x * 0.05, rim);
    let a = sat(0.06 + fres * 0.85 + drop * 0.6);
    let col = (spec * fres * (1.0 - drop) + vec3f(0.02, 0.025, 0.03) * F.ambient.rgb + dropCol * drop * 0.6) / a;
    return vec4f(tonemap(col), a);
}
`;

return { WGSL_BUS_VERTEX, WGSL_BUS_SCENE, WGSL_BUS_GLASS };
});
