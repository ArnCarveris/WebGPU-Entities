'use strict';
// Small helpers: yielding a frame, number and path formatting, colour conversion.

Features.part('imposter', (engine, feature) => {
const sgn = x => (x >= 0 ? 1 : -1);
// yield to the browser (lets a toast paint); the timer covers background tabs, where rAF is paused
const nextFrame = () => new Promise(r => { requestAnimationFrame(r); setTimeout(r, 50); });
const fmtK = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const basename = p => p.split(/[\\/]/).pop();

function srgbToLinear(c) { return c.map(x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); }
function hexToSrgb(h) {
    if (Array.isArray(h)) return h.slice(0, 3);
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255);
}
const lin = h => srgbToLinear(hexToSrgb(h));

return { sgn, nextFrame, fmtK, basename, srgbToLinear, lin };
});
