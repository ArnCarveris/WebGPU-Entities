'use strict';
// Keyboard and mouse input.

Features.world('gui', (engine, kit) => {
// Mouse / keyboard. Presses go to the GUI under the cursor first; otherwise dragging looks around. While the canvas has
// the mouse (pointer lock: walking, the engine takes it on a click) every motion looks, and the cursor is the screen's
// centre (the crosshair).

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.mouse = { x: 0, y: 0, inside: false };
        this.keys = new Set();
        this.looking = false;       // dragging to look around
    }

    attach() {
        const { canvas, game, io } = this;
        const locked = () => document.pointerLockElement === canvas;
        const track = (e) => {
            const r = locked() && canvas.getBoundingClientRect();
            this.mouse.x = r ? r.left + r.width / 2 : e.clientX;
            this.mouse.y = r ? r.top + r.height / 2 : e.clientY;
            this.mouse.inside = true;
        };
        io.listen(canvas, 'pointermove', (e) => {
            track(e);
            if ((this.looking || locked()) && !game.fx.cameraLocked) game.player.look(e.movementX, e.movementY);
        });
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', (e) => {
            track(e);
            const taken = game.interaction.pointerDown();
            if (!taken) this.looking = true;
            if (taken === 'gui') e.preventDefault();         // a press on a screen doesn't take the mouse
            else if (!locked()) canvas.setPointerCapture(e.pointerId);
        });
        const release = () => {
            this.looking = false;
            game.interaction.pointerUp();
        };
        io.listen(canvas, 'pointerup', release);
        io.listen(canvas, 'pointercancel', release);
        io.listen(window, 'pointerup', release);
        io.listen(canvas, 'wheel', (e) => {
            e.preventDefault();
            // Wheel over a GUI (lists, brush size...) goes to it; otherwise it steps the player
            if (!game.interaction.wheel(e.deltaY) && !game.fx.cameraLocked) game.player.stepForward(-e.deltaY * 0.003);
        }, { passive: false });

        io.listen(window, 'keydown', (e) => {
            if (e.code === 'Tab') return;           // the engine's handheld
            this.keys.add(e.code);
            if (e.code.startsWith('Arrow')) e.preventDefault();
        });
        io.listen(window, 'keyup', (e) => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }

    get cursorStyle() {
        if (this.game.interaction.focus) return 'none';    // the GUI draws its own cursor
        return this.looking ? 'grabbing' : 'crosshair';
    }
}

return { InputSystem };
});
