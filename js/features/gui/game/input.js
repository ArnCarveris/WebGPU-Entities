'use strict';
// Keyboard and mouse input.

Features.part('gui', (engine, feature) => {
// Mouse / keyboard. Presses go to the GUI under the cursor first; otherwise dragging looks around.

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
        const track = (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
            this.mouse.inside = true;
        };
        io.listen(canvas, 'pointermove', (e) => {
            track(e);
            if (this.looking && !game.fx.cameraLocked) game.player.look(e.movementX, e.movementY);
        });
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', (e) => {
            track(e);
            const taken = game.interaction.pointerDown();
            if (!taken) this.looking = true;
            if (taken !== 'gui') canvas.setPointerCapture(e.pointerId);
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
