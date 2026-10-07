'use strict';
// Entities that stamp the terrain and paint land use (and the Entity base every entity extends).

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { lerp, smoothstep, polylineLengths, polylineNearest, polylineBox } = Common;
const { fbm } = kits.noise;

// Entities
// Built from scenario definitions ({ type, id, label, ... }) in order. Hooks, all optional:
//   stamp(field)          shape the terrain and paint land use (build time)
//   build(structures)     add meshes and shader boxes on the finished terrain (build time, see Structures)
//   spawn()               register with the world (spawners pre-populate the sky)
//   update(dt, wdt, t)    per frame; dt real seconds, wdt weather seconds
//   cell()                per frame: a storm cell for the GPU ({ x, z, radius, top, coverage, precip, seed, virga, core }) or null
// Entities may set `dead` to be removed after the frame.
class Entity extends kits.terrain.TerrainEntity {
    constructor(def, world) {
        super(def, world);
        this.dead = false;
    }

    get labelLift() { return 300; }

    build(structures) {}
    spawn() {}
    features(out) {}
    update(dt, wdt, t) {}
    cell() { return null; }
}

// --- terrain features

const { Tilt, Hills, Mountain } = kits.terrain.terrainStamps(Entity, { peakLabel: 100 });

// mountain range along a polyline: a ridged massif `width` wide, `height` above the plain
class Range extends Entity {
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

// carves a river bed along a polyline and paints it as water
class River extends Entity {
    get anchor() { const p = this.def.path[Math.floor(this.def.path.length / 2)]; return [p[0], this.world.field.sample(p[0], p[1]) + 200, p[1]]; }
    // distance from x, z to the centre line, which wanders off the path with a little noise
    distance(x, z) {
        const wig = 350 * fbm(x / 2500, z / 2500, { octaves: 3, seed: 17 });
        return polylineNearest(this.def.path, this.lens ??= polylineLengths(this.def.path), x, z + wig).dist;
    }
    stamp(f) {
        const d = this.def, pts = d.path, halfW = (d.width || 60) / 2, bank = d.bank || 600, depth = d.depth || 5;
        const [x0, z0, x1, z1] = polylineBox(pts, halfW + bank + 400);
        f.each(x0, z0, x1, z1, (idx, x, z) => {
            const dist = this.distance(x, z);
            if (dist >= halfW + bank + f.cell) return;
            const k = smoothstep(halfW, halfW + bank, dist);
            f.h[idx] -= depth * (1 - k);
            f.paint(idx, 2, 1 - smoothstep(halfW - f.cell * 0.5, halfW + f.cell * 0.5, dist));
            f.paint(idx, 1, 0.5 * (1 - smoothstep(halfW, halfW + bank * 0.6, dist)));        // cottonwoods along the banks
        });
    }
}

class Lake extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, r = d.radius || 1000, reach = r * 1.6;
        f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
            const t = Math.hypot(x - cx, z - cz) / r + 0.25 * fbm(x / (r * 0.6), z / (r * 0.6), { octaves: 3, seed: 5 });
            if (t < 1) { f.h[idx] = Math.min(f.h[idx], d.level - 6 * (1 - t)); f.paint(idx, 2, 1); }
            else if (t < 1.6) f.h[idx] = Math.max(Math.min(f.h[idx], lerp(d.level + 2, f.h[idx], (t - 1) / 0.6)), d.level + 0.5);
        });
    }
}

class Town extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, r = d.radius || 2000, dens = d.density ?? 1;
        f.each(cx - r, cz - r, cx + r, cz + r, (idx, x, z) => {
            const t = Math.hypot(x - cx, z - cz) / r + 0.3 * fbm(x / 1500, z / 1500, { octaves: 3, seed: 8 });
            if (t < 1) f.paint(idx, 0, dens * (1 - smoothstep(0.5, 1, t)));
        });
    }
}

class Forest extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, r = d.radius || 2000, dens = d.density ?? 1, seed = d.seed || 2;
        f.each(cx - r, cz - r, cx + r, cz + r, (idx, x, z) => {
            const t = Math.hypot(x - cx, z - cz) / r;
            if (t < 1) f.paint(idx, 1, dens * (1 - smoothstep(0.6, 1, t)) * smoothstep(-0.1, 0.3, fbm(x / 2500, z / 2500, { seed })));
        });
    }
}

return { Entity, Tilt, Hills, Mountain, Range, River, Lake, Town, Forest };
});
