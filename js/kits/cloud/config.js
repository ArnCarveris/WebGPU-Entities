'use strict';
// Walking (Walker): body radius, highest step, eye height (m), speeds (m/s), climbing a ladder (m/s).

Features.kit('cloud', (engine, kit) => {
const WALK = { radius: 0.2, step: 0.5, head: 1.75, eye: 1.62, speed: 1.5, run: 4.5, climb: 0.9, climbFast: 1.8 };

return { WALK };
});
