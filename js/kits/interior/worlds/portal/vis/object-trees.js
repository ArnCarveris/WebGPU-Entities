'use strict';
// Object trees for culling: BVH and quadtree (the interior kit's).

Features.world('portal', (engine, kit) => {
const { BVHTree, QuadTree } = engine.kits.interior;

return { BVHTree, QuadTree };
});
