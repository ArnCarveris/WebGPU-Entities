'use strict';
// Limits and defaults of the simulation, the waves and the water's look.

Features.part('water', (engine, feature) => {
const NEAR = 0.5;
const MAX_SOURCES = 128;
const MAX_LAYERS = 4;
const MAX_PARTICLES = 16384;
const SOURCE_FLOATS = 8;
const FRAME_FLOATS = 112;
const RENDER_MODES = ['shaded', 'depth', 'velocity', 'foam / turbulence', 'wave cascades'];
const SIM_DEFAULTS = {
    stepsPerFrame: 32, stepTime: 0.12, gravity: 9.81, acceleration: null, diffusion: 0.06, linDamping: 0.99, sqrDamping: 0.05,
    absorption: 1, evaporation: 0, frictionMinDepth: 0, frictionMaxDepth: 1, frictionAmount: 0.9,
    minDepth: 0.03, wetDecay: 0.9998, warmup: 12000, edges: 'open', cfl: 0.3, turbulenceSpeed: 8,
};
const WAVE_DEFAULTS = { speed: 5, damping: 0.985, noise: 1, foam: 1, layers: [] };
const WATER_DEFAULTS = { deep: [0.03, 0.085, 0.08], absorb: [0.38, 0.13, 0.11], refraction: 0.035, foam: 1, detail: 1, flowScale: 3 };

return {
    NEAR, MAX_SOURCES, MAX_LAYERS, MAX_PARTICLES, SOURCE_FLOATS, FRAME_FLOATS, RENDER_MODES, SIM_DEFAULTS,
    WAVE_DEFAULTS, WATER_DEFAULTS,
};
});
