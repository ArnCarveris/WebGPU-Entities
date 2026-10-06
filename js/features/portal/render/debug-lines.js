'use strict';
// Debug lines: portals, areas and bounds.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;

// Debug lines: portal outlines by state, clipped apertures, occluders, area volumes and (while the
// visibility is frozen) the frozen frustum and the portal cones.

const VIS_COLORS = {
    passed: [0.3, 1.0, 0.45, 0.95], sky: [0.35, 0.85, 1.0, 0.95], culled: [1.0, 0.75, 0.2, 0.6], closed: [1.0, 0.25, 0.2, 0.9],
    idle: [0.55, 0.6, 0.65, 0.35], clipped: [1, 1, 1, 0.9], occluder: [0.8, 0.4, 1.0, 0.9], frustum: [0.4, 0.9, 1.0, 0.8],
};
const DEPTH_COLORS = [[0.4, 0.9, 1.0], [0.3, 1.0, 0.45], [1.0, 0.85, 0.3], [1.0, 0.5, 0.25], [1.0, 0.3, 0.6], [0.7, 0.4, 1.0]];

// colour of a portal from its flags and this frame's traversal state (1 culled, 2 passed)
function portalColor(P, state) {
    return P.closed ? VIS_COLORS.closed : state === 2 ? (P.skyOnly ? VIS_COLORS.sky : VIS_COLORS.passed) : state === 1 ? VIS_COLORS.culled : VIS_COLORS.idle;
}

// line list: depth-tested lines first, overlay lines after
class Lines {
    constructor() { this.depth = []; this.overlay = []; }
    line(a, b, c, overlay = false) { const t = overlay ? this.overlay : this.depth; t.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]); }
    loop(pts, c, overlay) { for (let i = 0; i < pts.length; i++) this.line(pts[i], pts[(i + 1) % pts.length], c, overlay); }
    build() { const a = new Float32Array(this.depth.length + this.overlay.length); a.set(this.depth); a.set(this.overlay, this.depth.length); return { data: a, depthCount: this.depth.length / 7 }; }
}

class DebugLines {
    constructor(world) {
        this.world = world;
    }

    // opts: { portals, volumes }, frozen: { eye, basis, aspect } | null
    build(vis, opts, frozen, fov) {
        const L = new Lines();
        if (opts.portals) this.portals(L, vis);
        if (opts.volumes) this.volumes(L, vis);
        if (frozen) this.frustum(L, vis, frozen, fov);
        return L.build();
    }

    portals(L, vis) {
        for (const P of this.world.portals) {
            const c = portalColor(P, vis.portalState[P.index]);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, 0.004)), c);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, -0.004)), c);
        }
        for (const e of vis.entries) if (e.clipped && e.clipped !== e.via?.verts) L.loop(e.clipped, VIS_COLORS.clipped, false);
        for (const oc of vis.occluders) L.loop(oc.verts, VIS_COLORS.occluder, false);
    }

    volumes(L, vis) {
        const areas = this.world.areas;
        for (let i = 1; i < areas.length; i++) {
            const a = areas[i], c = vis.nodes[i] ? [0.3, 1, 0.5, 0.7] : [0.5, 0.55, 0.6, 0.25];
            const W3 = q => a.vehicle ? a.vehicle.toWorld(q) : q;
            const lo = a.shape.map(p => W3([p[0], a.y + 0.02, p[1]])), hi = a.shape.map(p => W3([p[0], a.top - 0.02, p[1]]));
            L.loop(lo, c, true); L.loop(hi, c, true);
            for (let k = 0; k < lo.length; k++) L.line(lo[k], hi[k], c, true);
        }
    }

    frustum(L, vis, f, fov) {
        const e = f.eye, { fwd, right, up } = f.basis, dist = 40;
        const th = Math.tan(fov / 2) * dist, tw = th * f.aspect, cen = v3.madd(e, fwd, dist);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => v3.madd(v3.madd(cen, right, sx * tw), up, sy * th));
        for (const c of corners) L.line(e, c, VIS_COLORS.frustum, true);
        L.loop(corners, VIS_COLORS.frustum, true);
        for (const en of vis.entries) {
            if (!en.clipped) continue;
            const dc = DEPTH_COLORS[(en.depth - 1) % DEPTH_COLORS.length], col = [dc[0], dc[1], dc[2], 0.85];
            L.loop(en.clipped, col, true);
            for (const p of en.clipped) {
                L.line(e, p, [dc[0], dc[1], dc[2], 0.35], true);
                const dir = v3.norm(v3.sub(p, e));
                L.line(p, v3.madd(p, dir, 6), [dc[0], dc[1], dc[2], 0.18], true);
            }
        }
    }
}

return { VIS_COLORS, portalColor, DebugLines };
});
