'use strict';
// The minimap.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { VIS_COLORS, portalColor } = feature;

// Minimap: top-down view centred on the player (areas, portals by state, view cones through the portals,
// occluders, the ship and its route, drones). Click to teleport. Spans come from the scenario's `minimap`. It draws
// into an off-screen canvas that the engine's handheld shows (and passes clicks back from).

class Minimap {
    static SIZE = 240;          // css px; the canvas is twice that

    constructor(game, canvas) {
        this.game = game;
        this.canvas = canvas;
        canvas.width = canvas.height = Minimap.SIZE * 2;
        this.xf = null;
    }

    get spans() { return Object.assign({ near: 110, far: 420 }, this.game.world.scn.minimap); }

    // teleport to the clicked spot: an indoor floor, or the ground / deck under it
    click(u, v) {
        const m = this.xf, g = this.game;
        if (!m || !g.world) return;
        const x = m.ix(u * Minimap.SIZE), z = m.iz(v * Minimap.SIZE);
        const w = g.world, a = w.areas[w.areaAt([x, 1.0, z])];
        const y = !a.outdoor && !a.vehicle ? a.y : w.groundAt([x, 60, z], 0).y;
        g.player.teleport([x, y + g.player.cfg.eyeHeight, z]);
    }

    draw(vis) {
        const game = this.game, w = game.world, cvs = this.canvas, dpr = 2;
        const cw = Minimap.SIZE, ch = Minimap.SIZE;
        const g = cvs.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, cw, ch);
        // the map is centred on the player; N switches between a close and an island-wide span
        const span = game.opts.island ? this.spans.far : this.spans.near, cam = game.player.cam, cp0 = cam.pos;
        const b = [cp0[0] - span / 2, cp0[2] - span / 2, cp0[0] + span / 2, cp0[2] + span / 2], s = Math.min((cw - 12) / (b[2] - b[0]), (ch - 12) / (b[3] - b[1]));
        const ox = (cw - (b[2] - b[0]) * s) / 2, oy = (ch - (b[3] - b[1]) * s) / 2;
        // top-down view of a right-handed, y-up world: +z points up the map, +x points left
        const X = x => ox + (b[2] - x) * s, Y = z => ch - (oy + (z - b[1]) * s);
        const path = pts => { g.beginPath(); pts.forEach((v, i) => i ? g.lineTo(X(v[0]), Y(v[1])) : g.moveTo(X(v[0]), Y(v[1]))); g.closePath(); };
        this.xf = { ix: px => b[2] - (px - ox) / s, iz: py => (ch - py - oy) / s + b[1] };
        g.fillStyle = vis.nodes[0] && vis.nodes[0].some(e => !e.skyOnly) ? 'rgba(60,110,70,0.25)' : 'rgba(40,50,55,0.2)';
        g.fillRect(0, 0, cw, ch);
        const coast = ((w.scn.outdoor || {}).terrain || {}).coast;
        if (w.water && coast) {
            const n = coast.normal, p = coast.point, d = [-n[1], n[0]], F = 2000;
            path([[p[0] + d[0] * F, p[1] + d[1] * F], [p[0] + d[0] * F + n[0] * F, p[1] + d[1] * F + n[1] * F], [p[0] - d[0] * F + n[0] * F, p[1] - d[1] * F + n[1] * F], [p[0] - d[0] * F, p[1] - d[1] * F]]);
            g.fillStyle = 'rgba(40,110,150,0.35)'; g.fill();
        }
        for (const veh of w.vehicles) {
            g.setLineDash([3, 4]); g.strokeStyle = 'rgba(160,200,230,0.35)'; g.lineWidth = 1;
            path(veh.route.samples.map(sm => sm.p)); g.stroke();
            g.setLineDash([]);
        }
        for (const h of w.hulls) {
            const veh = h.vehicle;
            path(veh ? h.outline.map(q => { const r = veh.toWorld([q[0], h.deck, q[1]]); return [r[0], r[2]]; }) : h.outline);
            g.fillStyle = 'rgba(150,50,35,0.45)'; g.fill();
        }
        const root = vis.root, camY = cam.pos[1];
        for (const a of w.areas.slice(1).sort((a, c) => a.y - c.y)) {
            path(a.shape2D());
            const seen = vis.nodes[a.index] && vis.nodes[a.index].some(e => !e.skyOnly);
            const level = camY >= a.y - 0.5 && camY <= a.top + 0.5;
            g.fillStyle = a.index === root ? 'rgba(110,220,255,0.35)' : seen ? 'rgba(98,240,138,0.22)' : level ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)';
            g.fill();
            g.setLineDash(a.top <= 0.01 ? [2, 3] : a.y > 0.01 ? [5, 3] : []);
            g.strokeStyle = seen || a.index === root ? 'rgba(200,240,255,0.8)' : a.top <= 0.01 ? 'rgba(200,160,110,0.45)' : 'rgba(160,180,190,0.4)';
            g.lineWidth = 1; g.stroke();
            g.setLineDash([]);
        }
        // view cones through the portals
        const e0 = vis.eye;
        for (const en of vis.entries) {
            if (!en.clipped || en.skyOnly) continue;
            g.beginPath();
            g.moveTo(X(e0[0]), Y(e0[2]));
            for (const p of en.clipped) {
                const d = v3.sub(p, e0), l = Math.hypot(d[0], d[2]) || 1, far = 70;
                g.lineTo(X(e0[0] + d[0] / l * far), Y(e0[2] + d[2] / l * far));
            }
            g.closePath();
            g.fillStyle = 'rgba(255,220,90,0.05)';
            g.fill();
        }
        const rgba = c => `rgba(${c[0] * 255 | 0},${c[1] * 255 | 0},${c[2] * 255 | 0},${Math.min(1, c[3] + 0.2)})`;
        for (const P of w.portals) {
            g.strokeStyle = rgba(portalColor(P, vis.portalState[P.index]));
            g.lineWidth = 3;
            g.beginPath();
            if (P.horizontal) { const v = P.verts; g.moveTo(X(v[0][0]), Y(v[0][2])); for (const p of v.slice(1)) g.lineTo(X(p[0]), Y(p[2])); g.closePath(); g.lineWidth = 1.5; }
            else { g.moveTo(X(P.verts[0][0]), Y(P.verts[0][2])); g.lineTo(X(P.verts[1][0]), Y(P.verts[1][2])); }
            g.stroke();
        }
        g.strokeStyle = rgba(VIS_COLORS.occluder); g.lineWidth = 2;
        for (const O of w.occluders) {
            const { verts } = O.verts(vis.eye);
            g.beginPath(); g.moveTo(X(verts[0][0]), Y(verts[0][2])); g.lineTo(X(verts[1][0]), Y(verts[1][2])); g.stroke();
        }
        g.fillStyle = '#ff5a40';
        for (const d of w.drones) { g.beginPath(); g.arc(X(d.pos[0]), Y(d.pos[2]), 3.5, 0, Math.PI * 2); g.fill(); }
        // camera
        const cp = cam.pos, { fwd } = game.player.basis();
        const ang = Math.atan2(Y(cp[2] + fwd[2]) - Y(cp[2]), X(cp[0] + fwd[0]) - X(cp[0]));
        const cx = Math.max(4, Math.min(cw - 4, X(cp[0]))), cy = Math.max(4, Math.min(ch - 4, Y(cp[2])));
        g.strokeStyle = 'rgba(110,220,255,0.9)'; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang - 0.6) * 18, cy + Math.sin(ang - 0.6) * 18);
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang + 0.6) * 18, cy + Math.sin(ang + 0.6) * 18);
        g.stroke();
        g.fillStyle = '#6edcff';
        g.beginPath(); g.arc(cx, cy, 3.5, 0, Math.PI * 2); g.fill();
        if (game.opts.freeze && game.frozen) {
            const fe = game.frozen.eye;
            g.strokeStyle = '#ffc94a';
            g.beginPath(); g.arc(X(fe[0]), Y(fe[2]), 5, 0, Math.PI * 2); g.stroke();
        }
    }
}

return { Minimap };
});
