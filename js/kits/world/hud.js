'use strict';
// What a world keeps on the screen: toasts, in-world labels, and its readout for the handheld.

Features.kit('world', (engine, kit) => {
const { Common } = engine;
const { m4 } = Common;

// a world's toast: shown for `ms` (kept up when ms <= 0)
class Toast {
    constructor(el) { this.el = el; }

    show(msg, ms = 2200) {
        this.el.textContent = msg;
        this.el.style.display = 'block';
        clearTimeout(this.timer);
        if (ms > 0) this.timer = setTimeout(() => { this.el.style.display = 'none'; }, ms);
    }
}

// What of the outdoors the eye sees from inside an interior: null, all of it (the eye is outdoors), or { seen (any of it),
// rect ([x0, y0, x1, y1] px of a W x H frame: the screen rectangle of the portals it is seen through; null: the whole
// screen), W, H }: a world's own (its portal traversal's) or the other sites' (fx.outdoors: the camera inside another
// site's interior, Host.inside)
const Outdoors = {
    SEALED: { seen: false, rect: null },

    // r's rectangle in a W x H frame (whole pixels, covering)
    scaled(r, W, H) {
        if (!r?.rect || !r.W || (r.W === W && r.H === H)) return r;
        const [x0, y0, x1, y1] = r.rect, sx = W / r.W, sy = H / r.H;
        return { seen: r.seen, rect: [Math.floor(x0 * sx), Math.floor(y0 * sy), Math.ceil(x1 * sx), Math.ceil(y1 * sy)], W, H };
    },

    // what both let through, in a W x H frame
    meet(a, b, W, H) {
        a = Outdoors.scaled(a, W, H);
        b = Outdoors.scaled(b, W, H);
        if (!a || !b) return a || b || null;
        if (!a.seen || !b.seen) return Outdoors.SEALED;
        if (!a.rect || !b.rect) return { seen: true, rect: a.rect || b.rect, W, H };
        const r = [Math.max(a.rect[0], b.rect[0]), Math.max(a.rect[1], b.rect[1]), Math.min(a.rect[2], b.rect[2]), Math.min(a.rect[3], b.rect[3])];
        return r[2] > r[0] && r[3] > r[1] ? { seen: true, rect: r, W, H } : Outdoors.SEALED;
    },

    // whether r hides point [x, y] of a w x h frame
    hides(r, x, y, w, h) {
        if (!r) return false;
        if (!r.seen) return true;
        if (!r.rect) return false;
        const u = x * (r.W || w) / w, v = y * (r.H || h) / h;
        return !(u >= r.rect[0] && u <= r.rect[2] && v >= r.rect[1] && v <= r.rect[3]);
    },
};

// in-world labels on a 2D canvas over the world: begin() sizes and clears it, place() projects a point, mark() draws one.
// What of the outdoors they may show: their world's own `region` and the other sites' (outer(): fx.outdoors); how much
// the other sites hide a point beyond them (veil(x, y, W, H, d): fx.ui.veil, an atmosphere's daytime sky
// what is in space). frame(): the frame's number, when the canvas is shared by every kit's labels (cleared once a frame)
class LabelLayer {
    constructor(canvas, outer = null, veil = null, frame = null) {
        this.canvas = canvas;
        this.outer = outer;
        this.veil = veil;
        this.frame = frame;
        this.g = canvas.getContext('2d');
        this.W = this.H = 0;
        this.dpr = 1;
    }

    begin() {
        const c = this.canvas, dpr = this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = this.W = Math.floor(c.clientWidth * dpr), H = this.H = Math.floor(c.clientHeight * dpr);
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const f = this.frame?.();
        if (f === undefined || c.cleared !== f) this.g.clearRect(0, 0, W, H);
        c.cleared = f;
        return this.g;
    }

    // ready to write labels: 11 px monospace, vertically centred
    font() {
        this.g.font = `${11 * this.dpr}px 'Share Tech Mono', monospace`;
        this.g.textBaseline = 'middle';
    }

    // canvas pixel [x, y, alpha] of world point p under viewProj, or null behind the eye or well off the screen, or where
    // what of the outdoors the eye sees from inside (Outdoors: its `region`, the world's portal traversal's, and the
    // other sites') hides it; d (m from the eye, if given): faded by what the other sites hide of it (veil), null where
    // they hide it all
    place(viewProj, p, d) {
        const clip = m4.project(viewProj, p);
        if (clip[3] <= 0) return null;
        const x = (clip[0] / clip[3] * 0.5 + 0.5) * this.W, y = (0.5 - clip[1] / clip[3] * 0.5) * this.H;
        if (x < -50 || x > this.W + 50 || y < -20 || y > this.H + 20) return null;
        if (Outdoors.hides(this.region, x, y, this.W, this.H) || Outdoors.hides(this.outer?.(), x, y, this.W, this.H)) return null;
        const a = d > 0 && this.veil ? 1 - this.veil(x, y, this.W, this.H, d) : 1;
        return a > 0.02 ? [x, y, Math.min(a, 1)] : null;
    }

    // a diamond at [x, y] and the text to its right (alpha: how much of it shows)
    mark([x, y, alpha = 1], color, text) {
        const g = this.g, dpr = this.dpr;
        g.globalAlpha = alpha;
        g.strokeStyle = g.fillStyle = color;
        g.lineWidth = dpr;
        g.beginPath();
        g.moveTo(x, y - 4 * dpr); g.lineTo(x + 4 * dpr, y); g.lineTo(x, y + 4 * dpr); g.lineTo(x - 4 * dpr, y); g.closePath();
        g.stroke();
        g.fillText(text, x + 8 * dpr, y);
        g.globalAlpha = 1;
    }
}

// A world's HUD: toasts (ui's "toast" element), in-world labels (its "labels" canvas, with `labels`), and the readout
// `lines` the handheld shows (Pages.status), rebuilt at most every `every` ms (due)
class WorldHud {
    constructor(ui, { labels = false, every = 150, toastMs = 2200 } = {}) {
        this.lines = [];
        this.toaster = new Toast(ui.$('toast'));
        this.labels = labels ? new LabelLayer(ui.$('labels'), ui.region, ui.veil, ui.frame) : null;
        this.showLabels = true;
        this.every = every;
        this.toastMs = toastMs;
        this.last = 0;
    }

    toast(msg, ms = this.toastMs) { this.toaster.show(msg, ms); }

    // whether the readout is due again at `now` (ms)
    due(now) {
        if (now - this.last < this.every) return false;
        this.last = now;
        return true;
    }
}

return { Outdoors, Toast, LabelLayer, WorldHud };
});
