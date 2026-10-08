'use strict';
// Entities that stand on a heightfield, and the terrain stamps that raise or level it.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { DEG, clamp, lerp, smoothstep, polylineLengths, polylineNearest, polylineBox } = Common;
const { Entity } = kits.world;
const { fbm } = kits.noise;
const { floodFill } = kit;

// An entity of a world with a heightfield (world.field). Its world calls the hooks it has, all optional here:
//   stamp(field)          shape the terrain and paint land use (build time)
//   build(structures)     add meshes and shader boxes on the finished terrain (build time; worlds with structures)
//   fill(water)           initial water depth per cell (build time; worlds with standing water)
//   spawn()               register with the world
//   sources(out)          per frame: push water sources / sinks, or add to out.rain (worlds with a water simulation)
//   update(...)           per frame (the world's own arguments)
//   features(out)         per frame: analytic sky features (supercell plates, shelf clouds)
//   cell()                per frame: a storm cell for the GPU or null
// It may set `dead` to be removed after the frame. Its label stands `labelHeight` m (default labelLift) over the ground
// at its labelPos or pos ([x, z]).
class TerrainEntity extends Entity {
    constructor(def, world) {
        super(def, world);
        this.dead = false;
    }

    get labelLift() { return 16; }

    // label anchor in world space
    get anchor() {
        const p = this.def.labelPos || this.def.pos;
        if (!p) return null;
        return [p[0], this.world.field.sample(p[0], p[1]) + (this.def.labelHeight ?? this.labelLift), p[1]];
    }

    stamp(field) {}
    build(structures) {}
    fill(water) {}
    sources(out) {}
    features(out) {}
    cell() { return null; }
}

// The stamps that raise and level the ground, as subclasses of a world's own entity base (Base, a TerrainEntity): a
// tilt, hills, mountains, mountain ranges, lakes and clearings. A mountain's label stands `peakLabel` m higher than the
// base's labels. `lake` holds the feature's lake defaults: `radius` (a lake without one leaves the terrain as it is)
// and `label` (m over the lake's level; else it stands like any label).
function terrainStamps(Base, { peakLabel = 10, lake: lakeOpts = {} } = {}) {
    // global slope along `dir` (downhill): the far side is `drop` metres lower than the near side
    class Tilt extends Base {
        stamp(f) {
            const [dx, dz] = this.def.dir || [0, 1], l = Math.hypot(dx, dz) || 1, drop = this.def.drop || 0;
            f.eachAll((idx, x, z) => { f.h[idx] -= drop * (x * dx + z * dz) / l / f.size; });
        }
    }

    // fractal noise over the whole field: `amplitude` m at `scale` m
    class Hills extends Base {
        stamp(f) {
            const d = this.def, s = d.scale || 400, amp = d.amplitude || 20, opt = { octaves: d.octaves || 5, seed: d.seed || 1, ridged: !!d.ridged };
            f.eachAll((idx, x, z) => { f.h[idx] += amp * fbm(x / s, z / s, opt); });
        }
    }

    // a ridged peak `height` m tall, `radius` m round, at pos
    class Mountain extends Base {
        get anchor() { const a = super.anchor; return a && [a[0], a[1] + peakLabel, a[2]]; }
        stamp(f) {
            const d = this.def, [cx, cz] = d.pos, r = d.radius, hgt = d.height, rough = d.roughness ?? 0.4, seed = d.seed || 3;
            f.each(cx - r, cz - r, cx + r, cz + r, (idx, x, z) => {
                const t = Math.hypot(x - cx, z - cz) / r;
                if (t >= 1) return;
                const shape = Math.pow(1 - smoothstep(0, 1, t), 1.6);
                const ridge = fbm(x / (r * 0.35), z / (r * 0.35), { octaves: 5, seed, ridged: true });
                f.h[idx] += hgt * shape * (1 - rough + rough * 1.6 * ridge);
            });
        }
    }

    // mountain range along a polyline: a ridged massif `width` wide, `height` above the plain
    class Range extends Base {
        stamp(f) {
            const d = this.def, pts = d.path, lens = polylineLengths(pts), w = d.width || 6000, hgt = d.height || 1500;
            const rough = d.roughness ?? 0.5, seed = d.seed || 4, [x0, z0, x1, z1] = polylineBox(pts, w);
            f.each(x0, z0, x1, z1, (idx, x, z) => {
                const { dist } = polylineNearest(pts, lens, x + 1500 * fbm(x / 9000, z / 9000, { seed }), z);
                const t = dist / w;
                if (t >= 1) return;
                const shape = Math.pow(1 - smoothstep(0, 1, t), 1.4);
                const ridge = fbm(x / 3500, z / 3500, { octaves: 6, seed: seed + 3, ridged: true });
                f.h[idx] += hgt * shape * (1 - rough + rough * 1.5 * ridge);
            });
        }
    }

    // a lake whose surface is `level`, at pos [x, z]. With a `radius` it digs its own bowl: `depth` m (6) at the middle,
    // its shore wandering by `shore` (0.25 of the radius; noise `seed` 5), a bank raised just above the level out to 1.6
    // radii, and the cells under it wet (land use). In a world with standing water (fill) it is flood-filled from pos up
    // to the level, over whatever basin holds it.
    class Lake extends Base {
        get anchor() {
            if (lakeOpts.label === undefined || this.def.labelPos) return super.anchor;
            const [x, z] = this.def.pos;
            return [x, this.def.level + (this.def.labelHeight ?? lakeOpts.label), z];
        }

        stamp(f) {
            const d = this.def, r = d.radius || lakeOpts.radius;
            if (!r) return;
            const [cx, cz] = d.pos, reach = r * 1.6, depth = d.depth ?? 6, shore = d.shore ?? 0.25, seed = d.seed || 5;
            f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
                const t = Math.hypot(x - cx, z - cz) / r + shore * fbm(x / (r * 0.6), z / (r * 0.6), { octaves: 3, seed });
                if (t < 1) { f.h[idx] = Math.min(f.h[idx], d.level - depth * (1 - t)); f.wet(idx, 1); }
                else if (t < 1.6) f.h[idx] = Math.max(Math.min(f.h[idx], lerp(d.level + 2, f.h[idx], (t - 1) / 0.6)), d.level + 0.5);
            });
        }

        fill(water) {
            const f = this.world.field, n = f.n, [x, z] = this.def.pos;
            const i = clamp(Math.round(f.ci(x)), 0, n - 1), j = clamp(Math.round(f.ci(z)), 0, n - 1);
            this.cells = floodFill(f, water, [j * n + i], this.def.level);
        }
    }

    // Levels the ground to `level` over a rectangle (size [x, z] m, yaw degrees) or a disc (radius): a site where another
    // world of a composition stands (js/engine/compositor.js). The ground eases back to the terrain over `blend` m,
    // outside the site; with `inset` inside it instead, so the terrain meets the other world's edge at its own height
    // and the levelled ground stays hidden under that world. `water` paints the site as water.
    class Clearing extends Base {
        stamp(f) {
            const d = this.def, [cx, cz] = d.pos, blend = d.blend ?? 600, yaw = (d.yaw || 0) * DEG, cs = Math.cos(yaw), sn = Math.sin(yaw);
            const [hx, hz] = d.size ? [d.size[0] / 2, d.size[1] / 2] : [d.radius || 1000, d.radius || 1000], reach = Math.hypot(hx, hz) + blend;
            f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
                const rx = x - cx, rz = z - cz, lx = rx * cs + rz * sn, lz = -rx * sn + rz * cs;
                // signed distance to the site's edge (negative inside)
                const ox = Math.abs(lx) - hx, oz = Math.abs(lz) - hz;
                const sd = d.size ? Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0) : Math.hypot(lx, lz) - hx;
                const k = d.inset ? smoothstep(-blend, 0, sd) : smoothstep(0, blend, sd);
                f.h[idx] = lerp(d.level, f.h[idx], k);
                if (d.water) f.wet(idx, 1 - smoothstep(0, f.cell, sd));
            });
        }
    }

    return { Tilt, Hills, Mountain, Range, Lake, Clearing };
}

return { TerrainEntity, terrainStamps };
});
