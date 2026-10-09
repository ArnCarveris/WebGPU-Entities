'use strict';
// Using doors: E opens or shuts the one in view (on foot or flying, not aboard a bus); they swing, and their leaves'
// mesh is rewritten only while one moves.

Features.part('cloud', (engine, feature) => {

class DoorControl {
    constructor(app) {
        this.app = app;
        this.door = null;               // the door in view, if any
    }

    update(dt, io) {
        const a = this.app, S = a.world.structures, wk = a.walker, cam = a.camera.pos;
        const door = this.door = wk.bus ? null : S.doors.at(cam, a.camera.basis().fwd);
        if (door && io.pressed.includes('KeyE')) {
            door.target = door.target > 0.5 ? 0 : 1;
            a.fx.emit('door', { dist: Math.hypot(door.hinge[0] - cam[0], door.y - cam[1], door.hinge[1] - cam[2]), open: door.target > 0.5 });
        }
        if (wk.active && !wk.bus) {
            wk.aim = door;
            wk.prompt = door ? `E ${door.target > 0.5 ? 'shut' : 'open'} the door` : wk.liftPrompt || '';
        }
        if (S.doors.update(dt)) { a.renderer.writeDoors(S.doors.mesh()); a.renderer.writeBuildings(S.buildings); }
    }
}

return { DoorControl };
});
