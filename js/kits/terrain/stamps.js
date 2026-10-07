'use strict';
// Entities that stand on a heightfield, and the terrain stamps any of them can be.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { clamp, lerp, smoothstep } = Common;
const { Entity } = kits.world;
const { fbm } = kits.noise;
const { floodFill } = kit;

// An entity of a world with a heightfield (world.field): it may stamp(field) at build time, and its label stands
// `labelHeight` m (default labelLift) over the ground at its labelPos or pos ([x, z]).
class TerrainEntity extends Entity {
    get labelLift() { return 16; }

    // label anchor in world space
    get anchor() {
        const p = this.def.labelPos || this.def.pos;
        if (!p) return null;
        return [p[0], this.world.field.sample(p[0], p[1]) + (this.def.labelHeight ?? this.labelLift), p[1]];
    }

    stamp(field) {}
}

// The stamps every terrain world has, as subclasses of its own entity base (Base, a TerrainEntity): a tilt, hills,
// mountains and lakes. A mountain's label stands `peakLabel` m higher than the base's labels. `lake` holds the feature's
// lake defaults: `radius` (a lake without one leaves the terrain as it is) and `label` (m over the lake's level; else
// it stands like any label).
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

    return { Tilt, Hills, Mountain, Lake };
}

return { TerrainEntity, terrainStamps };
});
