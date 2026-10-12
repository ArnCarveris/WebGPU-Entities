'use strict';
// Using doors: E opens or shuts the one in view (on foot or flying, not aboard a bus): a building's outer door (the
// structures' Doors: their leaves' mesh rewritten only while one moves) or a planned building's doorway's (InteriorDoors:
// drawn as boxes, a shut one closing its portal). host: { world (its structures), walker, camera, fx.emit }; moved():
// the outer doors' leaves moved (their mesh to rewrite).

Features.kit('settlement', (engine, kit) => {

class DoorControl {
    constructor(app, { moved = () => {} } = {}) {
        this.app = app;
        this.moved = moved;
        this.door = null;               // the door in view, if any
    }

    update(dt, io) {
        const a = this.app, S = a.world.structures, wk = a.walker, cam = a.camera.pos;
        const fwd = a.camera.basis().fwd, outer = wk.bus ? null : S.doors.at(cam, fwd), inner = wk.bus ? null : S.innerDoors.at(cam, fwd);
        const dist = d => d ? Math.hypot(d.centre[0] - cam[0], d.centre[1] - cam[1], d.centre[2] - cam[2]) : Infinity;
        const door = this.door = dist(inner) < dist(outer) ? inner : outer;
        if (door && io.pressed.includes('KeyE')) {
            if (door === inner) S.innerDoors.send(inner, inner.target <= 0.5);
            else door.target = door.target > 0.5 ? 0 : 1;
            a.fx.emit('door', { dist: Math.hypot(door.hinge[0] - cam[0], door.y - cam[1], door.hinge[1] - cam[2]), open: door.target > 0.5 });
        }
        if (wk.active && !wk.bus) {
            wk.aim = door;
            wk.prompt = door ? `E ${door.target > 0.5 ? 'shut' : 'open'} the door` : wk.liftPrompt || '';
        }
        S.innerDoors.update(dt);
        if (S.doors.update(dt)) this.moved();
    }
}

return { DoorControl };
});
