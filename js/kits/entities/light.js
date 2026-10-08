'use strict';
// Point lights: what one shines with at a time, whatever world it is in.

Features.kit('entities', (engine, kit) => {
const { lerp } = engine.Common;

// A point light from its def. Options, each optional:
//   signal      'flicker' (a failing tube) | 'pulse' (a slow beacon)
//   roomLights  off while its world's room lights are (world.lightsOn === false)
//   door        { id, min }: dimmed to `min` while that door (world.get(id), a kits.entities door) is shut
//   alarmColor  its colour while its world's alarm is on (world.alarm)
//   size        the emitter's size (m): how soft the shadows it casts are (0.1)
// The world options need the light's `world`. A light may ride a vehicle (ride). def: { pos, color ([1, 1, 1]), intensity (1), radius (8), ... }
class LightSource {
    constructor(def, world = null) {
        this.pos = def.pos;
        this.color = def.color || [1, 1, 1];
        this.intensity = def.intensity ?? 1;
        this.radius = def.radius || 8;
        this.size = def.size ?? 0.1;
        this.signal = def.signal;
        this.roomLights = !!def.roomLights;
        this.door = def.door || null;
        this.alarmColor = def.alarmColor || null;
        this.world = world;
        this.vehicle = null;        // set when the light rides a vehicle (ride): pos is then `local` through its Origin
        this.local = null;
    }

    // ride vehicle veh (with an Origin, kits.interior, and a poseStamp): its position stays `local` in the vehicle's frame
    // and is worked out through the vehicle's Origin when read after the vehicle moved (nothing to do per light when it moves)
    ride(veh) {
        this.vehicle = veh;
        this.local = this.pos.slice();
        let at = null, stamp = -1;
        Object.defineProperty(this, 'pos', { get: () => { if (stamp !== veh.poseStamp) { at = veh.origin.toWorld(this.local); stamp = veh.poseStamp; } return at; }, configurable: true });
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
