'use strict';
// Distances as text.

Features.part('cloud', (engine, feature) => {
const fmtKm = d => d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)} km`;

return { fmtKm };
});
