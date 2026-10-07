'use strict';
// Spinning props: how far a `spin` has turned.

Features.kit('entities', (engine, kit) => {
const { DEG } = engine.Common;

// The angle (radians) a prop's `spin` { axis, rpm | speed (deg/s) } has turned by t seconds. Either rate works in any
// feature; `fallback` is the feature's default when the def gives neither (origin: { rpm: 1 }, imposter: { speed: 20 }).
function spinAngle(s, t, fallback = { rpm: 1 }) {
    if (s.rpm !== undefined || (s.speed === undefined && fallback.rpm !== undefined)) return t * (s.rpm || fallback.rpm || 1) * Math.PI / 30;
    return (s.speed ?? fallback.speed) * DEG * t;
}

return { spinAngle };
});
