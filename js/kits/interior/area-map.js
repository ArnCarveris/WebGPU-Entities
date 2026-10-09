'use strict';
// AreaMap: a floor map of a world's areas round the eye, with its PortalVis traversal on it.

Features.kit('interior', (engine, kit) => {
const { v3 } = engine.Common;
const { VIS_COLORS, portalColor, portalStateOf } = kit;

// Top-down, centred on the eye: the areas (the eye's own, the ones the traversal reached, the rest of its level dimmer),
// the portals by state, the view cones through them, the occluders, the eye and its heading. Tap to teleport. It draws
// into an off-screen canvas that the engine's handheld shows (and passes taps back from).
//   set       the world's areas (an AreaSet: areasIn; or anything with `areas`, `portals`, `occluders`)
//   o.spans   { near, far } (m across: around you, the wide view)
//   o.level   m: only areas within this of the eye's height (storeys stacked over one footprint: the eye's storey and
//             the tall areas through it); 0: every area, those off the eye's level dimmer
//   o.teleport(x, z, area)   a tap on the map (world x, z; the area there at the eye's height, or 0)
//   o.under(g, m), o.over(g, m)   a world's own layers below and above the areas (m: { X, Y, path, s, b, eye })
class AreaMap {
    static SIZE = 240;          // css px; the canvas is twice that

    constructor(set, o = {}) {
        this.set = set;
        this.o = o;
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvas.height = AreaMap.SIZE * 2;
        this.xf = null;
        this.eye = null;
    }

    get spans() { return { near: 110, far: 420, ...(this.o.spans || {}) }; }

    click(u, v) {
        const m = this.xf;
        if (!m || !this.o.teleport) return;
        const x = m.ix(u * AreaMap.SIZE), z = m.iz(v * AreaMap.SIZE), y = this.eye ? this.eye[1] : 0;
        this.o.teleport(x, z, this.set.areaAt ? this.set.areaAt([x, y, z]) : 0);
    }

    // vis: the traversal; view: { eye, fwd, wide, frozenEye }
    draw(vis, { eye, fwd, wide = false, frozenEye = null }) {
        const set = this.set, cvs = this.canvas, dpr = 2, cw = AreaMap.SIZE, ch = AreaMap.SIZE, level = this.o.level || 0;
        this.eye = eye.slice();
        const g = cvs.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, cw, ch);
        const span = wide ? this.spans.far : this.spans.near;
        const b = [eye[0] - span / 2, eye[2] - span / 2, eye[0] + span / 2, eye[2] + span / 2], s = Math.min((cw - 12) / (b[2] - b[0]), (ch - 12) / (b[3] - b[1]));
        const ox = (cw - (b[2] - b[0]) * s) / 2, oy = (ch - (b[3] - b[1]) * s) / 2;
        // a right-handed, y-up world from above: +z points up the map, +x points left
        const X = x => ox + (b[2] - x) * s, Y = z => ch - (oy + (z - b[1]) * s);
        const path = pts => { g.beginPath(); pts.forEach((v, i) => i ? g.lineTo(X(v[0]), Y(v[1])) : g.moveTo(X(v[0]), Y(v[1]))); g.closePath(); };
        this.xf = { ix: px => b[2] - (px - ox) / s, iz: py => (ch - py - oy) / s + b[1] };
        const seenOf = i => { const n = vis && (vis.nodes.get ? vis.nodes.get(i) : vis.nodes[i]); return !!n && n.some(e => !e.skyOnly); };
        g.fillStyle = vis && seenOf(0) ? 'rgba(60,110,70,0.25)' : 'rgba(40,50,55,0.2)';
        g.fillRect(0, 0, cw, ch);
        const m = { X, Y, path, s, b, eye, g };
        this.o.under?.(g, m);
        const y0 = level ? eye[1] - level : -Infinity, y1 = level ? eye[1] + level : Infinity;
        const areas = set.areasIn ? set.areasIn(b[0], b[1], b[2], b[3], y0, y1) : set.areas.filter(a => a && a.index && a.top > y0 && a.y < y1);
        const root = vis ? vis.root : set.areaAt?.(eye) ?? 0;
        const portals = new Set();
        for (const a of areas.sort((p, q) => (p.top - p.y) - (q.top - q.y) || p.y - q.y)) {
            path(a.shape2D ? a.shape2D() : a.shape);
            const seen = seenOf(a.index), here = eye[1] >= a.y - 0.5 && eye[1] <= a.top + 0.5;
            g.fillStyle = a.index === root ? 'rgba(110,220,255,0.35)' : seen ? 'rgba(98,240,138,0.22)' : here ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)';
            g.fill();
            g.setLineDash(a.top <= 0.01 ? [2, 3] : a.y > 0.01 && !level ? [5, 3] : []);
            g.strokeStyle = seen || a.index === root ? 'rgba(200,240,255,0.8)' : a.top <= 0.01 ? 'rgba(200,160,110,0.45)' : 'rgba(160,180,190,0.4)';
            g.lineWidth = 1; g.stroke();
            g.setLineDash([]);
            for (const i of a.portals) portals.add(i);
        }
        // view cones through the portals
        if (vis) for (const en of vis.entries) {
            if (!en.clipped || en.skyOnly) continue;
            g.beginPath();
            g.moveTo(X(vis.eye[0]), Y(vis.eye[2]));
            for (const p of en.clipped) {
                const d = v3.sub(p, vis.eye), l = Math.hypot(d[0], d[2]) || 1, far = 70;
                g.lineTo(X(vis.eye[0] + d[0] / l * far), Y(vis.eye[2] + d[2] / l * far));
            }
            g.closePath();
            g.fillStyle = 'rgba(255,220,90,0.05)';
            g.fill();
        }
        const rgba = c => `rgba(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0},${Math.min(1, c[3] + 0.2)})`;
        for (const i of portals) {
            const P = set.portals[i];
            if (!P || (level && (P.max[1] < y0 || P.min[1] > y1))) continue;
            g.strokeStyle = rgba(portalColor(P, vis ? portalStateOf(vis, P.index) : 0));
            g.lineWidth = 3;
            g.beginPath();
            if (P.horizontal) { const v = P.verts; g.moveTo(X(v[0][0]), Y(v[0][2])); for (const p of v.slice(1)) g.lineTo(X(p[0]), Y(p[2])); g.closePath(); g.lineWidth = 1.5; }
            else { g.moveTo(X(P.verts[0][0]), Y(P.verts[0][2])); g.lineTo(X(P.verts[1][0]), Y(P.verts[1][2])); }
            g.stroke();
        }
        g.strokeStyle = rgba(VIS_COLORS.occluder); g.lineWidth = 2;
        if (vis) for (const O of set.occluders || []) {
            if (!O) continue;
            const { verts } = O.verts(vis.eye);
            g.beginPath(); g.moveTo(X(verts[0][0]), Y(verts[0][2])); g.lineTo(X(verts[1][0]), Y(verts[1][2])); g.stroke();
        }
        this.o.over?.(g, m);
        // the eye and its heading
        const ang = Math.atan2(Y(eye[2] + fwd[2]) - Y(eye[2]), X(eye[0] + fwd[0]) - X(eye[0]));
        const cx = Math.max(4, Math.min(cw - 4, X(eye[0]))), cy = Math.max(4, Math.min(ch - 4, Y(eye[2])));
        g.strokeStyle = 'rgba(110,220,255,0.9)'; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang - 0.6) * 18, cy + Math.sin(ang - 0.6) * 18);
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang + 0.6) * 18, cy + Math.sin(ang + 0.6) * 18);
        g.stroke();
        g.fillStyle = '#6edcff';
        g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill();
        if (frozenEye) {
            g.strokeStyle = '#ffc94a';
            g.beginPath(); g.arc(X(frozenEye[0]), Y(frozenEye[2]), 5, 0, Math.PI * 2); g.stroke();
        }
        // the eye's height (a tower's storeys all look alike from above)
        g.fillStyle = 'rgba(220,235,245,0.75)'; g.font = '9px monospace';
        g.fillText(`y ${eye[1].toFixed(1)} m · ${span} m`, 5, ch - 5);
    }
}

return { AreaMap };
});
