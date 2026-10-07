'use strict';
// Small helpers: yielding a frame, path names, colour conversion.

Features.part('imposter', (engine, feature) => {
const sgn = x => (x >= 0 ? 1 : -1);
// yield to the browser (lets a toast paint); the timer covers background tabs, where rAF is paused
const nextFrame = () => new Promise(r => { requestAnimationFrame(r); setTimeout(r, 50); });
const basename = p => p.split(/[\\/]/).pop();

function srgbToLinear(c) { return c.map(x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); }
function hexToSrgb(h) {
    if (Array.isArray(h)) return h.slice(0, 3);
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255);
}
const lin = h => srgbToLinear(hexToSrgb(h));

return { sgn, nextFrame, basename, srgbToLinear, lin };
});
