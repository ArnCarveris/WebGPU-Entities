'use strict';
// Doors: how far one is open, where it is going, and who opens it.

Features.kit('entities', (engine, kit) => {

// A door entity over a feature's own entity base: `open` (0 shut .. 1 open) runs toward `target` (0 | 1) at `speed` per
// second (step); its eased opening is openAmount. An `auto` door opens while someone is near (sense) and shuts `delay` s
// after they left; a `locked` one (a feature may keep the flag elsewhere: override the getter) neither toggles nor senses.
// The feature poses its panels (or leaves) from open / openAmount.
// def: { open (starts open; not auto doors), auto, radius (3.2, how near "near" is), delay (1.2), speed (auto 2.6, else 1.4), locked }
function door(Base) {
    return class Door extends Base {
        constructor(def, world) {
            super(def, world);
            const e = def || {};
            this.auto = !!e.auto;
            this.radius = e.radius || 3.2;
            this.delay = e.delay ?? 1.2;
            this.hold = 0;
            this.open = e.open && !e.auto ? 1 : 0;
            this.target = this.open;
            this.speed = e.speed || (e.auto ? 2.6 : 1.4);
        }

        get locked() { return !!this.def?.locked; }
        get isOpen() { return this.target === 1; }
        get passable() { return this.open > 0.95; }
        get openAmount() { const o = this.open; return o * o * (3 - 2 * o); }
        get status() {
            if (this.isOpen) return this.open > 0.99 ? 'open' : 'opening';
            return this.open < 0.01 ? 'sealed' : 'closing';
        }

        // send it open or shut; false if it already goes there (or is locked)
        setOpen(open) {
            if (this.isOpen === open || this.locked) return false;
            this.target = open ? 1 : 0;
            return true;
        }

        // the use key: 'locked' | 'auto' (it opens by itself) | 'ok'
        toggle() {
            if (this.locked) return 'locked';
            if (this.auto) return 'auto';
            this.target = this.target > 0.5 ? 0 : 1;
            return 'ok';
        }

        // an automatic door: someone is near (open, and hold it `delay` s) or not
        sense(near, dt) {
            if (!this.auto || this.locked) return;
            if (near) { this.target = 1; this.hold = this.delay; }
            else if ((this.hold -= dt) <= 0) this.target = 0;
        }

        // moves toward the target; returns how far it still had to go (0: it stood still)
        step(dt) {
            const d = this.target - this.open;
            this.open += Math.sign(d) * Math.min(Math.abs(d), this.speed * dt);
            return d;
        }
    };
}

return { door };
});
