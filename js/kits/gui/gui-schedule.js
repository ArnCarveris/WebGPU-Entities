'use strict';
// GuiSchedule: which EntityGUIs rebuild their models this frame. A GUI the cursor is on (or just left) rebuilds every
// frame; the others by their size on screen (their surface's corners through the camera): big ones every frame, small
// ones every few frames, ones out of view or facing away about once a second. A GUI not rebuilt keeps its last model on
// the GPU and draws it, so what nobody sees costs (almost) nothing, and what's tiny on screen updates a little later.

Features.kit('gui', (engine, kit) => {
const { M4 } = kit;

// [projected height in px, rebuild every n frames], first match from the top
const EVERY = [[160, 1], [64, 2], [24, 4], [0, 8]];
const HIDDEN = 60;                  // frames between rebuilds of a GUI out of view (other views, CCTV, still show it)

class GuiSchedule {
    constructor({ every = EVERY, hidden = HIDDEN } = {}) {
        this.every = every;
        this.hidden = hidden;
        this.frame = 0;
        this.stats = { built: 0, seen: 0, total: 0 };
    }

    // camera: { viewProj, eye, height (px) }; the GUIs to rebuild, in order
    due(guis, { viewProj, eye, height }) {
        const f = ++this.frame, out = [];
        let seen = 0;
        guis.forEach((g, i) => {
            const near = g.active || g.outOfRange || g.wasFocused;
            g.wasFocused = g.active || g.outOfRange;
            if (g.lastBuild === undefined) g.lastBuild = -((i * 7) % this.hidden);     // spread the first rounds
            const px = this.screenSize(g, viewProj, eye, height);
            if (px > 0) seen++;
            const n = near ? 1 : px > 0 ? this.every.find(([h]) => px >= h)[1] : this.hidden;
            if (f - g.lastBuild >= n) { g.lastBuild = f; out.push(g); }
        });
        this.stats = { built: out.length, seen, total: guis.length };
        return out;
    }

    // the GUI's size on screen in px (its corners' larger extent, in screen heights), Infinity when it crosses the
    // plane of the eye (some corners behind it), 0 when it's out of view (all behind, or off one side) or faces away
    screenSize(g, vp, eye, height) {
        const m = g.surfaceMatrix, c = M4.transformPoint(m, [0, 0, 0]);
        const n = [m[8], m[9], m[10]];
        if (n[0] * (eye[0] - c[0]) + n[1] * (eye[1] - c[1]) + n[2] * (eye[2] - c[2]) <= 0) return 0;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = 0;
        for (const p of g.tri.xyz.concat([g.tri.corner])) {
            const w = M4.transformPoint(m, p);
            const cx = vp[0] * w[0] + vp[4] * w[1] + vp[8] * w[2] + vp[12];
            const cy = vp[1] * w[0] + vp[5] * w[1] + vp[9] * w[2] + vp[13];
            const cw = vp[3] * w[0] + vp[7] * w[1] + vp[11] * w[2] + vp[15];
            if (cw <= 1e-4) { behind++; continue; }
            const sx = cx / cw, sy = cy / cw;
            x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
        if (behind === 4) return 0;
        if (behind) return Infinity;
        if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return 0;
        return Math.max(y1 - y0, x1 - x0) * height / 2;
    }
}

return { GuiSchedule };
});
