'use strict';
// Portals and occluders (the interior kit's).

Features.world('portal', (engine, kit) => {
const { Portal, Occluder } = engine.kits.interior;

return { Portal, Occluder };
});
