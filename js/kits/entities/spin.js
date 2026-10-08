'use strict';
// Spinning props: how far a `spin` has turned, and where that leaves a rotation.

Features.kit('entities', (engine, kit) => {
const { DEG } = engine.Common;

// The angle (radians) a prop's `spin` { axis, rpm | speed (deg/s) } has turned by t seconds. Either rate works in any
// feature; `fallback` is the feature's default when the def gives neither (origin: { rpm: 1 }, imposter: { speed: 20 }).
function spinAngle(s, t, fallback = { rpm: 1 }) {
    if (s.rpm !== undefined || (s.speed === undefined && fallback.rpm !== undefined)) return t * (s.rpm || fallback.rpm || 1) * Math.PI / 30;
    return (s.speed ?? fallback.speed) * DEG * t;
}

// q0 turned by its `spin` at t (spinAngle), with a world's quat (mul, axisAngle): about the spin's axis in q0's frame
// (`local`, a prop's own axis), or else in the world's
function spinQuat(quat, q0, s, t, fallback, local = false) {
    const r = quat.axisAngle(s.axis || [0, 1, 0], spinAngle(s, t, fallback));
    return local ? quat.mul(q0, r) : quat.mul(r, q0);
}

return { spinAngle, spinQuat };
});
