'use strict';
// Entities that add water: seas, springs, drains, rain and debris (lakes are the terrain kit's).

Features.part('water', (engine, feature) => {
const { kits } = engine;
const { floodFill } = kits.terrain;
const { Entity } = feature;

// --- water

// fills every cell below `level` connected to the map edge, and holds the edge at that level
class Sea extends Entity {
    fill(water) {
        const f = this.world.field, n = f.n, seeds = [];
        for (let k = 0; k < n; k++) seeds.push(k, (n - 1) * n + k, k * n, k * n + n - 1);
        floodFill(f, water, seeds, this.def.level);
    }
    spawn() { this.world.seaLevel = this.def.level; }
}

class Spring extends Entity {
    sources(out) {
        const d = this.def, boost = this.world.boost ? (d.boost ?? 8) : 1;
        out.list.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 12, rate: (d.rate || 1) * boost });
    }
}

class Drain extends Entity {
    sources(out) {
        const d = this.def;
        out.list.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 12, rate: -(d.rate || 1), flat: true });
    }
}

// mm/h everywhere, or over a disc; R toggles all rain
class Rain extends Entity {
    spawn() { if (this.def.enabled) this.world.rainOn = true; }
    sources(out) {
        if (!this.world.rainOn) return;
        const d = this.def, ms = (d.rate || 10) / 3.6e6;
        if (d.pos) out.list.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 100, rate: ms * Math.PI * (d.radius || 100) ** 2, flat: true });
        else out.rain += ms;
    }
}

// floating logs that drift with the current, respawning upstream
class Debris extends Entity {
    spawn() {
        const d = this.def;
        this.world.emitters.push({ x: d.pos[0], z: d.pos[1], radius: d.radius || 20, life: d.life || 600, color: d.color || [0.4, 0.28, 0.16], size: d.size || 2, count: d.count || 200 });
    }
}

return { Sea, Spring, Drain, Rain, Debris };
});
