'use strict';
// Frustums: box tests, polygon clipping and screen rectangles (the interior kit's).

Features.part('portal', (engine, feature) => {
const { planeDist, aabbVisible, aabbContained, classify, clipPoly3, planesFromHull, screenRect, rectIntersect, rectUnion } = engine.kits.interior;

return {
    planeDist, aabbVisible, aabbContained, classify, clipPoly3, planesFromHull, screenRect,
    rectIntersect, rectUnion,
};
});
