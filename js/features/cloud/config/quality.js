'use strict';
// Render modes, quality presets and the default render settings.

Features.part('cloud', (engine, feature) => {
const RENDER_MODES = ['shaded', 'no volumetrics', 'clouds only', 'precipitation only'];
// scale: volumetric resolution; steps / light: march and light-march steps; interleave: march 1 of every 1, 2
// (checkerboard) or 4 (one of each 2x2 block) pixels per frame, in turn, the resolve fills in the others from history;
// detail: distance (m) within which the detail noise erodes clouds (beyond, cheaper LODs);
// blur: radius (volumetric texels) of the edge-aware blur that smooths the clouds' march noise at low resolution;
// smooth: soft painterly clouds (broad billows, powder-darkened clefts) instead of the eroded detail, which the low
// resolution only turns into grain, and a steadier temporal resolve (longer history, bicubic, outliers clamped) that
// keeps the interleaved march from shimmering; it skips the detail noise and samples a coarser mip, so it costs less
const QUALITY = [
    { name: 'low', scale: 0.5, steps: 64, light: 3, interleave: 4, detail: 10000, blur: 1.0, smooth: 1 },
    { name: 'medium', scale: 0.5, steps: 96, light: 4, interleave: 4, detail: 16000, blur: 0.7 },
    { name: 'high', scale: 0.75, steps: 128, light: 5, interleave: 4, detail: 22000, blur: 0 },
    { name: 'ultra', scale: 1.0, steps: 160, light: 6, interleave: 1, detail: 30000, blur: 0 },
];
// froxel lighting volume: frustum cells across x, y and exponential depth slices from FROXEL_NEAR (m) to the march distance
const FROXEL = [160, 96, 128];
const FROXEL_NEAR = 40;
const SHADOW_SLICES = 4;             // the cloud shadow map refreshes 1/4 of its rows per frame while nothing jumps
const RENDER_DEFAULTS = {
    quality: 1, shapeScale: 11000, detailScale: 1700, detailStrength: 0.32, maxTop: 12500, maxDistance: 60000, weatherSize: 128000,
    rainExtinction: 0.0011, snowExtinction: 0.0026, slant: 0.09, fallSpeed: 40, timeScale: 20, particles: 24000,
    bloom: 1.5, bloomThreshold: 1.0, bloomKnee: 0.5, bloomBolt: 0.1,
};
const BLOOM_LEVELS = 6;              // bloom mip chain from half resolution down (fewer where the screen is small)

return { RENDER_MODES, QUALITY, FROXEL, FROXEL_NEAR, SHADOW_SLICES, RENDER_DEFAULTS, BLOOM_LEVELS };
});
