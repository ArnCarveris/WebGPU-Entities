'use strict';
// Entities that stand on a heightfield, and the terrain stamps any of them can be.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { smoothstep } = Common;
const { Entity } = kits.world;
const { fbm } = kits.noise;

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

// The stamps every terrain world has, as subclasses of its own entity base (Base, a TerrainEntity): a tilt, hills and
// mountains. A mountain's label stands `peakLabel` m higher than the base's labels.
function terrainStamps(Base, { peakLabel = 10 } = {}) {
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

    return { Tilt, Hills, Mountain };
}

return { TerrainEntity, terrainStamps };
});
