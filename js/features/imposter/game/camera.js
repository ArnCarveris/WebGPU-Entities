'use strict';
// The fly camera and its input.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3 } = Common;
const { m4 } = feature;

class FlyCamera {
    constructor() {
        this.pos = [0, 2, 10];
        this.yaw = 0;
        this.pitch = 0;
        this.fov = 60;
        this.speed = 14;
    }

    reset(def = {}, world) {
        const p = def.pos || [0, 2, 10];
        this.pos = [p[0], p[1] + (world ? world.heightAt(p[0], p[2]) : 0), p[2]];
        this.yaw = (def.yaw || 0) * DEG;
        this.pitch = (def.pitch || 0) * DEG;
        this.fov = def.fov || 60;
        this.speed = def.speed || 14;
    }

    forward() { const c = Math.cos(this.pitch); return [-Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c]; }
    right() { return [Math.cos(this.yaw), 0, -Math.sin(this.yaw)]; }
    view() { return m4.lookAt(this.pos, v3.add(this.pos, this.forward()), [0, 1, 0]); }
}

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
            const k = 0.0035 * (cam().fov / 60);
            cam().yaw -= (e.clientX - this.drag[0]) * k;
            cam().pitch = clamp(cam().pitch - (e.clientY - this.drag[1]) * k, -1.55, 1.55);
            this.drag = [e.clientX, e.clientY];
        });
        const end = () => { this.drag = null; };
        io.listen(c, 'pointerup', end);
        io.listen(c, 'pointercancel', end);
        io.listen(c, 'wheel', e => { e.preventDefault(); cam().speed = clamp(cam().speed * (e.deltaY > 0 ? 0.8 : 1.25), 1, 600); this.game.toast(`Speed ${cam().speed.toFixed(1)} m/s`, 700); }, { passive: false });
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
        if (this.game.fx.cameraLocked) return;
        const k = this.keys, cam = this.game.camera, f = cam.forward(), r = cam.right();
        let mv = [0, 0, 0];
        if (k.has('KeyW') || k.has('ArrowUp')) mv = v3.add(mv, f);
        if (k.has('KeyS') || k.has('ArrowDown')) mv = v3.sub(mv, f);
        if (k.has('KeyD') || k.has('ArrowRight')) mv = v3.add(mv, r);
        if (k.has('KeyA') || k.has('ArrowLeft')) mv = v3.sub(mv, r);
        if (k.has('KeyE') || k.has('Space')) mv[1] += 1;
        if (k.has('KeyQ') || k.has('KeyC')) mv[1] -= 1;
        if (v3.len(mv) === 0) return;
        const sp = cam.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1);
        cam.pos = v3.madd(cam.pos, v3.norm(mv), sp * dt);
    }
}

return { FlyCamera, InputSystem };
});
