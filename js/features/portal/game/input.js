'use strict';
// Keyboard and mouse input.

Features.part('portal', (engine, feature) => {
// InputSystem: held keys, pointer-lock mouse look and key presses routed to the game.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.keys = new Set();
    }

    attach() {
        const canvas = this.canvas, io = this.io;
        io.listen(canvas, 'click', () => canvas.requestPointerLock?.());
        io.listen(document, 'mousemove', e => {
            const p = this.game.player;
            if (document.pointerLockElement !== canvas || !p) return;
            const s = p.cfg.mouseSensitivity;
            if (this.game.fx.cameraLocked) return;
            p.cam.look(e.movementX * s, e.movementY * s);
        });
        io.listen(document, 'keydown', e => {
            this.keys.add(e.code);
            if (this.game.world) this.game.onKey(e.code);
        });
        io.listen(document, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }
}

return { InputSystem };
});
