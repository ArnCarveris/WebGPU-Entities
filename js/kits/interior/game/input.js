'use strict';
// Keyboard and mouse input.

Features.world('portal', (engine, kit) => {
// InputSystem: held keys, mouse look and key presses routed to the game. Walking, the mouse looks while the canvas has
// it (pointer lock: the engine takes it on a click, Esc gives it back); flying, dragging looks. Presses on the GUI screen
// under the cursor (Game.interaction.focus: the screens feature's) go to it, and don't take the mouse for looking.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.keys = new Set();
        this.mouse = { x: 0, y: 0, inside: false };
        this.dragging = false;
    }

    attach() {
        const canvas = this.canvas, io = this.io, g = this.game;
        const track = e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true; };
        const look = e => {
            const p = this.game.player;
            if (!p || this.game.fx.cameraLocked) return;
            const s = p.cfg.mouseSensitivity;
            p.cam.look(e.movementX * s, e.movementY * s);
        };
        io.listen(canvas, 'pointermove', e => { track(e); if (this.dragging && document.pointerLockElement !== canvas) look(e); });
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', e => {
            track(e);
            if (e.button !== 0) return;
            if (!g.interaction?.focus) { this.dragging = true; return; }
            e.preventDefault();         // a press on a screen doesn't take the mouse
            g.interaction.pointerDown();
        });
        io.listen(window, 'pointerup', () => { this.dragging = false; g.interaction?.pointerUp(); });
        io.listen(canvas, 'wheel', e => { if (g.interaction?.wheel(e.deltaY)) e.preventDefault(); });
        io.listen(document, 'mousemove', e => { if (document.pointerLockElement === canvas) look(e); });
        io.listen(document, 'keydown', e => {
            this.keys.add(e.code);
            if (this.game.world && e.code === 'KeyF') this.game.onKey(e.code);     // the door at hand, the helm: the one command key
        });
        io.listen(document, 'keyup', e => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }
}

return { InputSystem };
});
