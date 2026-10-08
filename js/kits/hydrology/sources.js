'use strict';
// Entities that add water to a water simulation: seas, springs, drains, rain and debris (lakes are the terrain kit's).

Features.kit('hydrology', (engine, kit) => {
const { floodFill } = engine.kits.terrain;

// The water entities, as subclasses of a world's own entity base (Base, a kits.terrain TerrainEntity). The world they
// are in has a heightfield (field), and calls fill(water) at build time and sources(out) per frame, out being
// { list: [{ x, z, radius, rate (m³/s, < 0 drains), flat }], rain (m/s everywhere) }. They read and set: seaLevel,
// boost (springs give `boost` x their rate), rainOn, emitters (debris).
function hydrologyTypes(Base) {
    // fills every cell below `level` connected to the map edge, and holds the edge at that level
    class Sea extends Base {
        fill(water) {
            const f = this.world.field, n = f.n, seeds = [];
            for (let k = 0; k < n; k++) seeds.push(k, (n - 1) * n + k, k * n, k * n + n - 1);
            floodFill(f, water, seeds, this.def.level);
        }
        spawn() { this.world.seaLevel = this.def.level; }
    }

    // water coming in (or going out) over a disc: `pos`, `radius` (12 m), `rate` (1 m³/s)
    class Source extends Base {
        get rate() { return this.def.rate || 1; }
        get flat() { return false; }
        sources(out) {
            const d = this.def, s = { x: d.pos[0], z: d.pos[1], radius: d.radius || 12, rate: this.rate };
            if (this.flat) s.flat = true;
            out.list.push(s);
        }
    }

    // a spring: `boost` (8) x its rate while the world's boost is on
    class Spring extends Source {
        get rate() { const d = this.def; return (d.rate || 1) * (this.world.boost ? (d.boost ?? 8) : 1); }
    }

    // a drain: takes `rate` m³/s out
    class Drain extends Source {
        get rate() { return -(this.def.rate || 1); }
        get flat() { return true; }
    }

    // `rate` mm/h everywhere, or over a disc (`pos`, `radius` 100 m); `enabled` starts it; the world's rainOn toggles all rain
    class Rain extends Base {
        spawn() { if (this.def.enabled) this.world.rainOn = true; }
        sources(out) {
            if (!this.world.rainOn) return;
            const d = this.def, ms = (d.rate || 10) / 3.6e6;
            if (d.pos) out.list.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 100, rate: ms * Math.PI * (d.radius || 100) ** 2, flat: true });
            else out.rain += ms;
        }
    }

    // floating logs that drift with the current, respawning upstream
    class Debris extends Base {
        spawn() {
            const d = this.def;
            this.world.emitters.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 20, life: d.life || 600, color: d.color || [0.4, 0.28, 0.16], size: d.size || 2, count: d.count || 200 });
        }
    }

    return { Sea, Source, Spring, Drain, Rain, Debris };
}

return { hydrologyTypes };
});
