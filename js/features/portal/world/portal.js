'use strict';
// Portals and occluders (the interior kit's).

Features.part('portal', (engine, feature) => {
const { Portal, Occluder } = engine.kits.interior;

return { Portal, Occluder };
});
