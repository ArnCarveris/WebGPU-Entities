'use strict';
// InputRouter: every feature world listens through its own scope (io.listen(target, type, fn, opts), target the
// canvas, window or document) instead of addEventListener, so several worlds can share one page. Input events go to
// the focused world (plus "always" owners such as the engine's fly camera); state events (blur, resize, key releases,
// pointer lock) go to everyone. Events aimed at the engine's own UI (the scenario and GPU pickers...) reach no world.

class InputRouter {
    static BROADCAST = new Set(['blur', 'focus', 'resize', 'keyup', 'pointerlockchange', 'pointerlockerror', 'visibilitychange', 'pointerup', 'pointercancel', 'mouseup']);

    constructor(canvas) {
        this.canvas = canvas;
        this.focus = null;
        this.always = new Set();         // owners that get input whatever has focus
        this.lists = new Map();          // target -> type -> [{ owner, fn, opts }]
        this.onFocus = null;
    }

    scope(owner) {
        return {
            owner,
            canvas: this.canvas,
            listen: (target, type, fn, opts) => this.listen(owner, target, type, fn, opts),
            focused: () => this.focus === owner || this.always.has(owner),
        };
    }

    setFocus(owner) {
        if (owner === this.focus) return;
        const prev = this.focus;
        this.focus = owner;
        // the world losing focus lets go of held keys and buttons
        if (prev) this.deliver(prev, window, 'blur', new FocusEvent('blur'));
        this.onFocus?.(owner, prev);
    }

    listen(owner, target, type, fn, opts) {
        let types = this.lists.get(target);
        if (!types) this.lists.set(target, types = new Map());
        let list = types.get(type);
        if (!list) {
            types.set(type, list = []);
            // one real listener per (target, type); wheel / touch must be able to preventDefault
            const passive = type === 'wheel' || type.startsWith('touch') ? { passive: false } : undefined;
            target.addEventListener(type, e => this.dispatch(target, type, e), passive);
        }
        list.push({ owner, fn, opts });
    }

    engineUi(e) {
        const t = e.target;
        return t instanceof Element && !!t.closest('.engine-ui');
    }

    dispatch(target, type, e) {
        const list = this.lists.get(target)?.get(type);
        if (!list) return;
        const broadcast = InputRouter.BROADCAST.has(type);
        if (!broadcast && this.engineUi(e)) return;
        for (const h of list.slice()) {
            if (broadcast || h.owner === this.focus || this.always.has(h.owner)) h.fn.call(target, e);
        }
    }

    deliver(owner, target, type, e) {
        for (const h of this.lists.get(target)?.get(type) || []) if (h.owner === owner) h.fn.call(target, e);
    }
}
