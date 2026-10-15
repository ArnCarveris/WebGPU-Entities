'use strict';
// Events for the scenario's sound cues (sound.cue): a bus door starting to open or shut, a bus coming to rest (its air
// brakes: busHiss), a driven bus bumping into something (busBump: speed m/s), a footstep every 0.75 m walked (1.1 m
// running). host: { world (its buses), walker, camera, input (keys held), near (what falls on the camera: rain),
// indoors, inBus, fx.emit }.

Features.kit('settlement', (engine, kit) => {

class SoundEvents {
    constructor(app) {
        this.app = app;
        this.busDoors = new Map();      // each bus's doors (0..1) last frame
        this.busMoving = new Map();     // and whether it has driven faster than 1 m/s since it last stood
        this.stepPos = null;
        this.stepDist = 0;
    }

    update() {
        const a = this.app, w = a.world, cam = a.camera.pos;
        for (const b of w.buses) {
            const was = this.busDoors.get(b);
            if (was !== undefined && ((was <= 0 && b.doors > 0) || (was >= 1 && b.doors < 1)))
                a.fx.emit('busDoor', { dist: Math.hypot(b.pose.x - cam[0], b.pose.y - cam[1], b.pose.z - cam[2]) });
            this.busDoors.set(b, b.doors);
            const dist = Math.hypot(b.pose.x - cam[0], b.pose.y - cam[1], b.pose.z - cam[2]), v = Math.abs(b.v);
            if (v > 1) this.busMoving.set(b, true);
            else if (v < 0.05 && this.busMoving.get(b)) { this.busMoving.set(b, false); a.fx.emit('busHiss', { dist }); }
            if (b.bumped) { a.fx.emit('busBump', { dist, speed: b.bumped }); b.bumped = 0; }
        }
        const wk = a.walker;
        if (wk.active && !wk.bus && this.stepPos) {
            const keys = a.input.keys, run = keys.has('ShiftLeft') || keys.has('ShiftRight');
            const dx = Math.hypot(cam[0] - this.stepPos[0], cam[2] - this.stepPos[2]);
            this.stepDist += dx < 5 ? dx : 0;
            if (this.stepDist > (run ? 1.1 : 0.75)) { this.stepDist = 0; a.fx.emit('step', { wet: a.near.rain > 0.05 && !(a.indoors || a.inBus), run }); }
        }
        this.stepPos = [...cam];
    }
}

return { SoundEvents };
});
