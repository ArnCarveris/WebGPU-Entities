'use strict';
// Interaction: aiming at and using world-space screens.

Features.part('gui', (engine, feature) => {
// Routes the mouse to EntityGUIs, like Doom 3 tracing the view against gui surfaces.
// The engine's handheld is in front of everything (while it has the cursor, no world GUI does); otherwise the nearest
// world GUI under the cursor gets it, as long as the player is within its use range.

class InteractionSystem {
    constructor(game) {
        this.game = game;
        this.focus = null;      // GUI under the cursor
        this.capture = null;    // GUI holding the pointer during a drag
    }

    get guis() {
        return this.game.world.guis;
    }

    hover() {
        const { input, player, world, handheld } = this.game;
        for (const g of this.guis) {
            g.active = false;
            g.outOfRange = false;
        }
        this.focus = null;
        if (!input.mouse.inside || input.looking || handheld.hasCursor) return;

        const dir = player.viewRay(input.mouse, player.fovy);
        let best = null;
        for (const g of world.guis) {
            const pt = g.trace(player.eye, dir);
            if (pt && (!best || pt.t < best.pt.t)) best = { gui: g, pt };
        }
        if (!best) return;
        if (!best.gui.inRange(player.eye)) {
            best.gui.outOfRange = true;
            return;
        }
        this.setFocus(best.gui, best.pt);
    }

    setFocus(gui, pt) {
        gui.active = true;
        gui.cursor.x = pt.x;
        gui.cursor.y = pt.y;
        this.focus = gui;
    }

    // Called every frame after hover
    drag() {
        if (this.capture) this.capture.pointerDrag();
    }

    // Returns 'capture' (a GUI took the press and wants drags), 'gui' (a GUI took it) or null
    pointerDown() {
        this.hover();
        if (!this.focus) return null;
        if (this.focus.pointerDown()) {
            this.capture = this.focus;
            return 'capture';
        }
        return 'gui';
    }

    pointerUp() {
        if (this.capture) this.capture.pointerUp();
        this.capture = null;
    }

    wheel(dy) {
        return !!(this.focus && this.focus.wheel(dy));
    }
}

return { InteractionSystem };
});
