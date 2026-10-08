'use strict';
// Land use: discs of town and forest painted into a heightfield's land-use channels.

Features.kit('terrain', (engine, kit) => {
const { Common, kits } = engine;
const { smoothstep } = Common;
const { fbm } = kits.noise;

// The land-use stamps, as subclasses of a world's own entity base (Base, a TerrainEntity, on a field with paint(idx,
// channel, amount)). Each paints a disc (`pos`, `radius` 2000 m, `density` 1) into its channel, fading out at its edge.
function terrainLandUse(Base) {
    class LandUse extends Base {
        get channel() { return 0; }
        // where x, z is in the disc (0 centre .. 1 edge), and how much of `density` it gets there
        edge(t, x, z) { return t; }
        amount(t, x, z, density) { return density; }

        stamp(f) {
            const d = this.def, [cx, cz] = d.pos, r = d.radius || 2000, dens = d.density ?? 1, ch = this.channel;
            f.each(cx - r, cz - r, cx + r, cz + r, (idx, x, z) => {
                const t = this.edge(Math.hypot(x - cx, z - cz) / r, x, z);
                if (t < 1) f.paint(idx, ch, this.amount(t, x, z, dens));
            });
        }
    }

    // a town's built-up ground (channel 0), its edge wandering a little
    class Town extends LandUse {
        edge(t, x, z) { return t + 0.3 * fbm(x / 1500, z / 1500, { octaves: 3, seed: 8 }); }
        amount(t, x, z, dens) { return dens * (1 - smoothstep(0.5, 1, t)); }
    }

    // woods (channel 1), in patches (noise `seed` 2)
    class Forest extends LandUse {
        get channel() { return 1; }
        amount(t, x, z, dens) { return dens * (1 - smoothstep(0.6, 1, t)) * smoothstep(-0.1, 0.3, fbm(x / 2500, z / 2500, { seed: this.def.seed || 2 })); }
    }

    return { LandUse, Town, Forest };
}

// Every terrain type of this kit over Base (terrainStamps, terrainChannels, terrainLandUse with their options)
function terrainTypes(Base, opts = {}) {
    return { ...kit.terrainStamps(Base, opts), ...kit.terrainChannels(Base, opts), ...terrainLandUse(Base) };
}

return { terrainLandUse, terrainTypes };
});
