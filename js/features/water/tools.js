'use strict';
// Interactive tools: pour, drain, terrain and splash.

Features.part('water', (engine, feature) => {
// Game

// Applied with the right mouse button (or Ctrl + left) where the cursor ray meets the terrain.
class Tool {
    constructor(def) { this.def = def; this.key = def.key; }
    get name() { return this.def.type; }
    apply(app, hit, dt) {}
}
class PourTool extends Tool {
    apply(app, hit) { app.extraSources.push({ x: hit[0], z: hit[2], radius: app.brush, rate: this.def.rate ?? 40 }); }
}
class DrainTool extends Tool {
    apply(app, hit) { app.extraSources.push({ x: hit[0], z: hit[2], radius: app.brush, rate: -(this.def.rate ?? 40), flat: true }); }
}
class TerrainTool extends Tool {
    constructor(def, sign) { super(def); this.sign = sign; }
    apply(app, hit, dt) { app.world.field.brush(hit[0], hit[2], app.brush, this.sign * (this.def.rate ?? 6) * dt); }
}
class SplashTool extends Tool {
    apply(app, hit) {
        app.waves.splash([hit[0], hit[2], app.brush, this.def.strength ?? 0.9]);
        app.extraSources.push({ x: hit[0], z: hit[2], radius: app.brush * 0.5, rate: 10 });
    }
}
const TOOL_TYPES = {
    pour: d => new PourTool(d),
    drain: d => new DrainTool(d),
    raise: d => new TerrainTool(d, 1),
    dig: d => new TerrainTool(d, -1),
    splash: d => new SplashTool(d),
};

return { TOOL_TYPES };
});
