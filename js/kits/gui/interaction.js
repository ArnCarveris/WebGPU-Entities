'use strict';
// Interaction: aiming at and using world-space GUIs, for any feature that has some.

Features.kit('gui', (engine, kit) => {
// Routes a pointer to EntityGUIs, like Doom 3 tracing the view against gui surfaces. Each frame hover() asks `aim` for
// the view ray ({ eye, dir }, or null while nothing may be aimed at: the mouse looks around, the handheld has the
// cursor, the camera is another world's) and traces it against every GUI of `guis`; the nearest one hit gets the cursor
// when it is in its use range (gui.inRange(eye, hit)), else, nearer than its hintRange, its "move closer" hint. A GUI
// holding the pointer (a drag) keeps the cursor even out of range. Presses, drags and the wheel go to the GUI with the
// cursor; the feature's input calls pointerDown / pointerUp / wheel.
//   guis: () => EntityGUI list          aim: () => { eye, dir } | null

class InteractionSystem {
    constructor(guis, aim) {
        this.guis = guis;
        this.aim = aim;
        this.focus = null;      // GUI under the cursor, in reach
        this.capture = null;    // GUI holding the pointer during a drag
    }

    hover() {
        const guis = this.guis();
        for (const g of guis) {
            g.active = false;
            g.outOfRange = false;
        }
        this.focus = null;
        const ray = this.aim();
        if (!ray) return;
        let best = null;
        for (const g of guis) {
            const hit = g.trace(ray.eye, ray.dir);
            if (hit && (!best || hit.t < best.hit.t)) best = { gui: g, hit };
        }
        if (!best) return;
        const { gui, hit } = best;
        if (gui.inRange(ray.eye, hit) || this.capture === gui) {
            gui.active = true;
            gui.cursor.x = hit.x;
            gui.cursor.y = hit.y;
            this.focus = gui;
        } else gui.outOfRange = hit.t < gui.hintRange;
    }

    // every frame after hover
    drag() {
        if (this.capture) this.capture.pointerDrag();
    }

    // 'capture' (a GUI took the press and wants drags), 'gui' (a GUI took it) or null
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

    reset() {
        this.focus = this.capture = null;
    }
}

return { InteractionSystem };
});
