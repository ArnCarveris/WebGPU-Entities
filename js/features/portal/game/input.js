'use strict';
// Keyboard and mouse input.

Features.part('portal', (engine, feature) => {
// InputSystem: held keys, pointer-lock mouse look and key presses routed to the game. Presses on the GUI screen under the
// cursor (Game.screenFocus) go to it, and don't take the mouse for looking.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.keys = new Set();
        this.mouse = { x: 0, y: 0, inside: false };
        this.guiPress = false;
    }

    attach() {
        const canvas = this.canvas, io = this.io, g = this.game;
        const track = e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true; };
        io.listen(canvas, 'pointermove', track);
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', e => {
            track(e);
            this.guiPress = false;
            if (e.button !== 0 || !g.screenFocus) return;
            this.guiPress = true;
            if (g.screenFocus.pointerDown()) g.screenCapture = g.screenFocus;
        });
        io.listen(window, 'pointerup', () => { g.screenCapture?.pointerUp(); g.screenCapture = null; });
        io.listen(canvas, 'wheel', e => { if (g.screenFocus?.wheel(e.deltaY)) e.preventDefault(); });
        io.listen(canvas, 'click', () => { if (this.guiPress) this.guiPress = false; else canvas.requestPointerLock?.(); });
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
