'use strict';
// Entities that shape the terrain (and the Entity base every entity extends).

Features.part('water', (engine, feature) => {
const { Common, kits } = engine;
const { lerp, smoothstep, polylineLengths, polylineNearest, polylineBox } = Common;
const { fbm } = kits.noise;

// Entities
// Built from scenario definitions ({ type, id, label, ... }) in order. Hooks, all optional:
//   stamp(field)   shape the terrain (build time)
//   fill(water)    initial water depth per cell (build time)
//   spawn()        register with the world (debris emitters, sea level, ...)
//   sources(out)   per frame: push water sources / sinks, or add to out.rain
//   update(dt, t)  per frame (dams animate their breach)
class Entity extends kits.terrain.TerrainEntity {
    get labelLift() { return 16; }

    fill(water) {}
    spawn() {}
    sources(out) {}
    update(dt, t) {}
}

// --- terrain features

const { Tilt, Hills, Mountain, Lake } = kits.terrain.terrainStamps(Entity, { peakLabel: 10, lake: { label: 12 } });

// carves a river valley along a polyline: channel bed from levels[0] to levels[1], smooth banks
class Valley extends Entity {
    get anchor() { const p = this.def.path[0]; return [p[0], this.world.field.sample(p[0], p[1]) + 16, p[1]]; }
    stamp(f) {
        const d = this.def, pts = d.path, lens = polylineLengths(pts), total = lens[lens.length - 1] || 1;
        const halfW = (d.width || 20) / 2, bank = d.bank ?? d.width * 3, ch = d.channel ?? 2, pad = halfW + bank;
        const [a, b] = d.levels, wig = d.wiggle || 0, ws = d.wiggleScale || 140, seed = d.seed || 11;
        f.each(...polylineBox(pts, pad + wig), (idx, x, z) => {
            const px = x + wig * fbm(x / ws, z / ws, { octaves: 3, seed }), pz = z + wig * fbm(x / ws, z / ws, { octaves: 3, seed: seed + 7 });
            const { dist, s } = polylineNearest(pts, lens, px, pz);
            if (dist >= pad) return;
            const bottom = lerp(a, b, s / total);
            const target = dist < halfW ? bottom - ch * (1 - (dist / halfW) ** 2) : bottom;
            const k = Math.sqrt(smoothstep(halfW, pad, dist)), h = f.h[idx];
            f.h[idx] = Math.min(h, target + (h - target) * k);
        });
    }
}

// lowers a round bowl towards `floor`; `rim` first raises a flat ring (up to radius + rimWidth) so the lake holds
class Basin extends Entity {
    stamp(f) {
        const d = this.def, [cx, cz] = d.pos, r = d.radius, fl = d.floor, seed = d.seed || 5, rw = d.rimWidth || 0, reach = r * 1.2 + rw;
        f.each(cx - reach, cz - reach, cx + reach, cz + reach, (idx, x, z) => {
            const dist = Math.hypot(x - cx, z - cz), t = dist / r + 0.15 * fbm(x / (r * 0.5), z / (r * 0.5), { octaves: 3, seed });
            if (d.rim !== undefined && dist < r + rw) f.h[idx] = Math.max(f.h[idx], lerp(d.rim, f.h[idx], smoothstep(r + rw * 0.5, r + rw, dist)));
            if (t >= 1) return;
            const h = f.h[idx];
            f.h[idx] = Math.min(h, fl + (h - fl) * smoothstep(0, 1, t));
        });
    }
}

// lowers everything past `at` (along `dir`) to the sea floor
class Coast extends Entity {
    stamp(f) {
        const d = this.def, [dx, dz] = d.dir || [0, 1], l = Math.hypot(dx, dz) || 1, w = d.width || 200, seed = d.seed || 9;
        f.eachAll((idx, x, z) => {
            const s = (x * dx + z * dz) / l + w * 0.5 * fbm(x / 300, z / 300, { octaves: 3, seed });
            const k = smoothstep(d.at - w, d.at + w, s);
            if (k > 0) f.h[idx] = lerp(f.h[idx], d.floor, k);
        });
    }
}

// earth dam with a spillway notch; X breaches it (a gap erodes down to the original valley) and restores it
class Dam extends Entity {
    get anchor() { const [a, b] = [this.def.from, this.def.to]; return [(a[0] + b[0]) / 2, this.def.crest + 14, (a[1] + b[1]) / 2]; }
    stamp(f) {
        const d = this.def, [ax, az] = d.from, [bx, bz] = d.to, len = Math.hypot(bx - ax, bz - az);
        const halfTop = (d.top || 8) / 2, side = d.side || 1.6, crest = d.crest;
        const spill = d.spillway || { width: 0, depth: 0 }, gap = d.gap || { at: 0.5, width: 40 };
        const reach = halfTop + (crest - f.min + 10) * side;
        const cells = [];
        const rect = f.each(Math.min(ax, bx) - reach, Math.min(az, bz) - reach, Math.max(ax, bx) + reach, Math.max(az, bz) + reach, (idx, x, z) => {
            const { dist, s } = polylineNearest([d.from, d.to], [0, len], x, z);
            const along = Math.abs(s - len / 2);
            const top = crest - spill.depth * (1 - smoothstep(spill.width / 2, spill.width / 2 + 4, along));
            const wall = top - Math.max(0, dist - halfTop) / side;
            if (wall <= f.h[idx] - 20) return;
            const gapMask = 1 - smoothstep(gap.width / 2, gap.width / 2 + 12, Math.abs(s - gap.at * len));
            cells.push([idx, f.h[idx], wall, gapMask]);
        });
        this.rect = rect;
        this.cells = cells;
        this.breach = 0;
        this.target = 0;
        this.apply(f);
    }

    apply(f) {
        const b = Math.sqrt(this.breach);
        for (const [idx, base, wall, gapMask] of this.cells) f.h[idx] = Math.max(base, wall - b * gapMask * (wall - base + 6));
        f.touch(this.rect);
    }

    toggle() { this.target = this.target ? 0 : 1; return this.target; }

    update(dt) {
        if (this.breach === this.target) return;
        const step = dt / (this.def.breachTime || 10);
        this.breach = this.target > this.breach ? Math.min(this.target, this.breach + step) : Math.max(this.target, this.breach - step * 3);
        this.apply(this.world.field);
    }
}

return { Entity, Tilt, Hills, Mountain, Lake, Valley, Basin, Coast, Dam };
});
