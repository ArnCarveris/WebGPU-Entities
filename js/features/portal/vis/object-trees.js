'use strict';
// Object trees for culling: BVH and quadtree (the interior kit's).

Features.part('portal', (engine, feature) => {
const { BVHTree, QuadTree } = engine.kits.interior;

return { BVHTree, QuadTree };
});
