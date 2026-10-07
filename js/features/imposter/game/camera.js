'use strict';
// The fly camera and its input.

Features.part('imposter', (engine, feature) => {
const { Common, kits } = engine;
const { DEG } = Common;

// The fly camera (a FirstPersonView): WASD / the arrows, E / Space up, Q / C down, Shift 4x; the drag turns it the
// less the narrower its view; the wheel sets its speed
class FlyCamera extends kits.view.FirstPersonView {
    constructor() {
        super({ pos: [0, 2, 10], speed: 14, sensitivity: 0.0035, fovScaled: true, normalize: true, keys: FLY_KEYS,
            boost: { keys: ['ShiftLeft', 'ShiftRight'], factor: 4 }, wheel: { step: 1.25, min: 1, max: 600 } });
    }

    // to the scenario's camera { pos (its height above the ground), yaw, pitch, fov (degrees), speed }
    reset(def = {}, world) {
        const p = def.pos || [0, 2, 10];
        this.pos = [p[0], p[1] + (world ? world.heightAt(p[0], p[2]) : 0), p[2]];
        this.yaw = (def.yaw || 0) * DEG;
        this.pitch = (def.pitch || 0) * DEG;
        this.fov = (def.fov || 60) * DEG;
        this.speed = def.speed || 14;
    }
}
const FLY_KEYS = { forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], right: ['KeyD', 'ArrowRight'], left: ['KeyA', 'ArrowLeft'],
    up: ['KeyE', 'Space'], down: ['KeyQ', 'KeyC'] };

class InputSystem {
    constructor(game) {
        this.game = game;
        this.keys = new Set();
        this.drag = null;
    }

    attach() {
        const c = this.game.canvas, cam = () => this.game.camera, io = this.game.fx.io;
        io.listen(c, 'pointerdown', e => { c.setPointerCapture(e.pointerId); this.drag = [e.clientX, e.clientY]; });
        io.listen(c, 'pointermove', e => {
            if (!this.drag) return;
            cam().look(e.clientX - this.drag[0], e.clientY - this.drag[1]);
            this.drag = [e.clientX, e.clientY];
        });
        const end = () => { this.drag = null; };
        io.listen(c, 'pointerup', end);
        io.listen(c, 'pointercancel', end);
        io.listen(c, 'wheel', e => { e.preventDefault(); cam().zoomSpeed(Math.sign(e.deltaY)); this.game.toast(`Speed ${cam().speed.toFixed(1)} m/s`, 700); }, { passive: false });
        io.listen(window, 'keydown', e => {
            if (e.target.closest && e.target.closest('input, select, textarea')) return;
            if (!this.keys.has(e.code)) this.game.onKey(e.code);
            this.keys.add(e.code);
            if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        });
        io.listen(window, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }

    update(dt) {
        if (!this.game.fx.cameraLocked) this.game.camera.move(dt, this.keys, this.game.fx.floor);
    }
}

return { FlyCamera, InputSystem };
});
