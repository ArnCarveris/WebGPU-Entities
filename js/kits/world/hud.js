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

// in-world labels on a 2D canvas over the world: begin() sizes and clears it, place() projects a point, mark() draws one
class LabelLayer {
    constructor(canvas) {
        this.canvas = canvas;
        this.g = canvas.getContext('2d');
        this.W = this.H = 0;
        this.dpr = 1;
    }

    begin() {
        const c = this.canvas, dpr = this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = this.W = Math.floor(c.clientWidth * dpr), H = this.H = Math.floor(c.clientHeight * dpr);
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        this.g.clearRect(0, 0, W, H);
        return this.g;
    }

    // ready to write labels: 11 px monospace, vertically centred
    font() {
        this.g.font = `${11 * this.dpr}px 'Share Tech Mono', monospace`;
        this.g.textBaseline = 'middle';
    }

    // canvas pixel [x, y] of world point p under viewProj, or null behind the eye or well off the screen
    place(viewProj, p) {
        const clip = m4.project(viewProj, p);
        if (clip[3] <= 0) return null;
        const x = (clip[0] / clip[3] * 0.5 + 0.5) * this.W, y = (0.5 - clip[1] / clip[3] * 0.5) * this.H;
        return x < -50 || x > this.W + 50 || y < -20 || y > this.H + 20 ? null : [x, y];
    }

    // a diamond at [x, y] and the text to its right
    mark([x, y], color, text) {
        const g = this.g, dpr = this.dpr;
        g.strokeStyle = g.fillStyle = color;
        g.lineWidth = dpr;
        g.beginPath();
        g.moveTo(x, y - 4 * dpr); g.lineTo(x + 4 * dpr, y); g.lineTo(x, y + 4 * dpr); g.lineTo(x - 4 * dpr, y); g.closePath();
        g.stroke();
        g.fillText(text, x + 8 * dpr, y);
    }
}

// A world's HUD: toasts (ui's "toast" element), in-world labels (its "labels" canvas, with `labels`), and the readout
// `lines` the handheld shows (Pages.status), rebuilt at most every `every` ms (due)
class WorldHud {
    constructor(ui, { labels = false, every = 150, toastMs = 2200 } = {}) {
        this.lines = [];
        this.toaster = new Toast(ui.$('toast'));
        this.labels = labels ? new LabelLayer(ui.$('labels')) : null;
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

return { Toast, LabelLayer, WorldHud };
});
