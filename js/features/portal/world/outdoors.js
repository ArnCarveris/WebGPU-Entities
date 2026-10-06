'use strict';
// The outdoors: the island terrain and water.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3, mulberry32, smoothstep } = Common;
const { m4, vnoise, fbm, g2, MeshBuilder } = feature;

// The outdoors (scenario `outdoor`): terrain height field and chunks, scattered models and the sea.

// Animated sea plane minus the waterline of every hull (moving hulls cut a moving hole)
class Water {
    constructor(def) {
        const [x0, z0, x1, z1] = def.extent, y = def.level;
        this.level = y;
        this.color = def.color || [0.1, 0.3, 0.32, 0.8];
        this.verts = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
        this.min = [x0, y - 0.5, z0];
        this.max = [x1, y + 0.5, z1];
        this.pieces = [];
    }

    update(hulls) {
        const a = this.verts[0], c = this.verts[2], y = this.level;
        let pieces = [[[a[0], a[2]], [c[0], a[2]], [c[0], c[2]], [a[0], c[2]]]];
        for (const h of hulls) pieces = g2.subtract(pieces, h.worldWaterline());
        this.pieces = pieces.map(pc => pc.map(q => [q[0], y, q[1]]));
    }
}

class Outdoors {
    constructor(world, def = {}) {
        this.world = world;
        this.def = def;
        this.terrain = def.terrain || null;
        this.water = def.water ? new Water(def.water) : null;
    }

    // terrain height: fbm hills flattened around buildings and `flatten` rects, sinking into the sea
    // towards the island edge and beyond the coast line
    height(x, z) {
        const t = this.terrain;
        if (!t) return 0;
        const areas = this.world.areas;
        let dist = Infinity;
        const near = (bx0, bz0, bx1, bz1) => Math.hypot(Math.max(bx0 - x, 0, x - bx1), Math.max(bz0 - z, 0, z - bz1));
        for (let i = 1; i < areas.length; i++) {
            const a = areas[i];
            if (a.y > 0.01 || !a.terrain) continue;
            dist = Math.min(dist, near(a.bbox[0], a.bbox[1], a.bbox[2], a.bbox[3]));
        }
        for (const r of t.flatten || []) dist = Math.min(dist, near(r[0], r[1], r[2], r[3]));
        const f = t.freq || 0.035, mask = smoothstep(t.flat ?? 5, (t.flat ?? 5) + (t.blend ?? 20), dist);
        let h = (fbm(x * f + 11.3, z * f - 3.7) - 0.45) * 2 * (t.amp ?? 2.5) * mask - 0.03;
        // island: the land sinks into the sea towards the edges of the terrain
        if (t.island) {
            const [x0, z0, x1, z1] = t.extent, de = Math.min(x - x0, x1 - x, z - z0, z1 - z);
            const s = smoothstep(0, t.island.falloff ?? 30, de + (vnoise(x * 0.04, z * 0.04) - 0.5) * 10);
            h = h * s - (t.island.depth ?? 12) * (1 - s);
        }
        // coast: the land sinks to the seabed beyond a shore line (point + normal pointing out to sea)
        const c = t.coast;
        if (c) {
            const d = (x - c.point[0]) * c.normal[0] + (z - c.point[1]) * c.normal[1];
            const wob = (vnoise(x * 0.05, z * 0.05) - 0.5) * (c.wobble ?? 8);
            const s = smoothstep(-c.width * 0.35, c.width, d + wob);
            h = h * (1 - s) - c.depth * s;
        }
        return h;
    }

    build() {
        if (this.terrain) this.buildTerrain();
        for (const s of this.def.scatter || []) this.scatter(s);
        if (this.def.water && this.def.water.seabed) this.buildSeabed();
    }

    buildTerrain() {
        const w = this.world, o = this.def, t = this.terrain;
        const [x0, z0, x1, z1] = t.extent, cs = t.chunk || 20, st = t.step || 1, m = w.mat(t.mat || 'grass');
        const beach = t.beachMat ? w.mat(t.beachMat) : m, beachY = (o.water ? o.water.level : -Infinity) + (t.beachHeight ?? 0.6);
        for (let cz = z0; cz < z1; cz += cs) for (let cx = x0; cx < x1; cx += cs) {
            const b = new MeshBuilder(), n = Math.round(Math.min(cs, x1 - cx, z1 - cz) / st);
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
                const x = cx + i * st, z = cz + j * st, e = 0.5;
                const nx = this.height(x - e, z) - this.height(x + e, z), nz = this.height(x, z - e) - this.height(x, z + e);
                const y = this.height(x, z);
                b.vert([x, y, z], v3.norm([nx, 2 * e, nz]), y < beachY ? beach : m);
            }
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
                const a = j * (n + 1) + i;
                b.idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
            }
            w.addStatic(b, { name: `terrain:${cx},${cz}`, owners: [0], lightArea: 0, terrain: true });
        }
    }

    // seeded random placement outside buildings, `avoid` rects and the sea
    scatter(s) {
        const w = this.world, o = this.def;
        const rnd = mulberry32(s.seed || 1), [x0, z0, x1, z1] = s.extent, [s0, s1] = s.scale || [1, 1];
        let placed = 0;
        for (let tries = 0; placed < s.count && tries < s.count * 30; tries++) {
            const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0), rot = rnd() * 360, sc = s0 + rnd() * (s1 - s0);
            const cl = s.clearance || 4;
            if (w.areas.some((a, i) => i > 0 && x > a.bbox[0] - cl && x < a.bbox[2] + cl && z > a.bbox[1] - cl && z < a.bbox[3] + cl)) continue;
            if ((s.avoid || []).some(r => x > r[0] && x < r[2] && z > r[1] && z < r[3])) continue;
            if (o.water && this.height(x, z) < o.water.level + (s.shore ?? 1.0)) continue;
            const b = new MeshBuilder();
            w.addModel(b, s.model, m4.trs([x, this.height(x, z), z], rot, sc));
            w.addStatic(b, { name: `${s.model}#${placed}`, owners: [0], lightArea: 0 });
            placed++;
        }
    }

    buildSeabed() {
        const w = this.world, W = this.def.water, [x0, z0, x1, z1] = W.extent;
        const b = new MeshBuilder(), sy = W.seabed.y, m = w.mat(W.seabed.mat || 'sand');
        b.poly([[x0, sy, z0], [x1, sy, z0], [x1, sy, z1], [x0, sy, z1]], [0, 1, 0], m);
        w.addStatic(b, { name: 'seabed', owners: [0], lightArea: 0, terrain: true });
    }
}

return { Outdoors };
});
