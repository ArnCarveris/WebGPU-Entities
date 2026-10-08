'use strict';
// Stamps that carve the ground along lines and edges: rivers, valleys, basins, coasts and dams.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { lerp, smoothstep, polylineLengths, polylineNearest, polylineBox } = Common;
const { fbm } = kits.noise;

// The carving stamps, as subclasses of a world's own entity base (Base, a TerrainEntity). `riverLabel` / `valleyLabel`:
// m their labels stand over the ground (a river's at the middle of its path, a valley's at its start).
function terrainChannels(Base, { riverLabel = 200, valleyLabel = 16 } = {}) {
    // carves a river bed along a polyline and paints it as water (and woods along its banks): `width` (60), `bank` (600),
    // `depth` (5) m
    class River extends Base {
        get anchor() { const p = this.def.path[Math.floor(this.def.path.length / 2)]; return [p[0], this.world.field.sample(p[0], p[1]) + riverLabel, p[1]]; }
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
                f.wet(idx, 1 - smoothstep(halfW - f.cell * 0.5, halfW + f.cell * 0.5, dist));
                f.paint(idx, 1, 0.5 * (1 - smoothstep(halfW, halfW + bank * 0.6, dist)));        // cottonwoods along the banks
            });
        }
    }

    // carves a river valley along a polyline: channel bed from levels[0] to levels[1], smooth banks
    class Valley extends Base {
        get anchor() { const p = this.def.path[0]; return [p[0], this.world.field.sample(p[0], p[1]) + valleyLabel, p[1]]; }
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
    class Basin extends Base {
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
    class Coast extends Base {
        stamp(f) {
            const d = this.def, [dx, dz] = d.dir || [0, 1], l = Math.hypot(dx, dz) || 1, w = d.width || 200, seed = d.seed || 9;
            f.eachAll((idx, x, z) => {
                const s = (x * dx + z * dz) / l + w * 0.5 * fbm(x / 300, z / 300, { octaves: 3, seed });
                const k = smoothstep(d.at - w, d.at + w, s);
                if (k > 0) f.h[idx] = lerp(f.h[idx], d.floor, k);
            });
        }
    }

    // earth dam with a spillway notch; toggle() breaches it (a gap erodes down to the original valley over `breachTime`
    // s) and restores it. Needs a field with touch(rect) (re-upload) and a world that calls update(dt)
    class Dam extends Base {
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

    return { River, Valley, Basin, Coast, Dam };
}

return { terrainChannels };
});
