'use strict';
// Point lights: what one shines with at a time, whatever world it is in.

Features.kit('entities', (engine, kit) => {
const { lerp } = engine.Common;

// A point light from its def. Options, each optional:
//   signal      'flicker' (a failing tube) | 'pulse' (a slow beacon)
//   roomLights  off while its world's room lights are (world.lightsOn === false)
//   door        { id, min }: dimmed to `min` while that door (world.get(id), a kits.entities door) is shut
//   alarmColor  its colour while its world's alarm is on (world.alarm)
// The world options need the light's `world`. def: { pos, color ([1, 1, 1]), intensity (1), radius (8), ... }
class LightSource {
    constructor(def, world = null) {
        this.pos = def.pos;
        this.color = def.color || [1, 1, 1];
        this.intensity = def.intensity ?? 1;
        this.radius = def.radius || 8;
        this.signal = def.signal;
        this.roomLights = !!def.roomLights;
        this.door = def.door || null;
        this.alarmColor = def.alarmColor || null;
        this.world = world;
    }

    intensityAt(t) {
        let I = this.intensity;
        if (this.signal === 'flicker') I *= (Math.sin(t * 23.0 + this.pos[0]) * Math.sin(t * 7.3 + 1.0 + this.pos[2]) > -0.25) ? 1 : 0.1;
        else if (this.signal === 'pulse') I *= 0.2 + 0.8 * Math.max(0, Math.sin(t * 4.0));
        const w = this.world;
        if (!w) return I;
        if (this.roomLights && w.lightsOn === false) I = 0;
        if (this.door) I *= lerp(this.door.min, 1, w.get(this.door.id).openAmount);
        return I;
    }

    get colorNow() { return this.alarmColor && this.world?.alarm ? this.alarmColor : this.color; }
}

return { LightSource };
});
