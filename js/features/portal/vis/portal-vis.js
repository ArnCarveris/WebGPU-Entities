'use strict';
// Portal visibility: the interior kit's PortalVis traversal over this world's areas and portals (its AreaSet graph).

Features.part('portal', (engine, feature) => {
const { kits } = engine;
const { MAX_DEPTH, MAX_ENTRIES, NEAR_PASS } = feature;

class PortalVis extends kits.interior.PortalVis {
    constructor(world) {
        super(world.visGraph({ nearPass: () => NEAR_PASS }), { maxDepth: MAX_DEPTH, maxEntries: MAX_ENTRIES, nearPass: NEAR_PASS });
        this.world = world;
    }
}

return { PortalVis };
});
