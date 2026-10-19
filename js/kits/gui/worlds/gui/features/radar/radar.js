'use strict';
// The phone radar (the scenario's `waves` and `radar`): the facility's sound waves (footsteps, doors, drone pings, the
// alarm: world.waves) and the radar app on the handheld. Without it nothing makes waves (the world's NO_WAVES).

Features.feature('gui/gui/radar', (engine, kit) => {
const { clamp } = engine.kits.gui;
const { RadarApp } = kit;

// Expanding rings for the phone radar (footsteps, drone pings, alarm, doors)
class SoundWaves {
    constructor(kinds) {
        this.kinds = kinds;         // kind -> { speed, life, color }
        this.list = [];
    }

    emit(kind, x, z, strength = 1) {
        const k = this.kinds[kind];
        this.list.push({
            kind, x, z, t0: performance.now() / 1000, life: k.life, color: k.color,
            speed: k.speed * (kind === 'step' ? strength : 1),
            alpha: kind === 'step' ? clamp(0.5 + strength * 0.35, 0, 1) : 0.8
        });
    }

    prune(t) {
        this.list = this.list.filter((w) => t - w.t0 < w.life);
    }
}

// the world's: its waves
class RadarWorld {
    static key = 'radar';
    constructor(world) { world.waves = new SoundWaves(world.scenario.waves); }
}

// the game's: the radar app it lends the handheld
class RadarGame {
    static key = 'radar';
    constructor(game) { this.game = game; }
    apps(phone) { return { radar: new RadarApp(phone, this.game) }; }
}

return { SoundWaves, extensions: { world: RadarWorld, app: RadarGame } };
});
