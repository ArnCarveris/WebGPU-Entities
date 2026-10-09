'use strict';
// Ground frames (Common's: a centre and yaw on the terrain) and rectangles less holes (the mesh kit's): what every structure is
// laid out with.

Features.part('cloud', (engine, feature) => {

// the ground frame is Common's
const { GroundFrame } = engine.Common;

// rectangles less holes are the mesh kit's
const { rectMinusHoles } = engine.kits.mesh;

return { GroundFrame, rectMinusHoles };
});
