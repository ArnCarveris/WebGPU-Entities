'use strict';
// VisDebug: a PortalVis traversal as debug lines (the sector and portal frames): portal outlines by state, clipped
// apertures, occluders, area volumes and (while the visibility is frozen) the frozen frustum and the portal cones.

Features.kit('interior', (engine, kit) => {
const { v3 } = engine.Common;

const VIS_COLORS = {
    passed: [0.3, 1.0, 0.45, 0.95], sky: [0.35, 0.85, 1.0, 0.95], culled: [1.0, 0.75, 0.2, 0.6], closed: [1.0, 0.25, 0.2, 0.9],
    idle: [0.55, 0.6, 0.65, 0.35], clipped: [1, 1, 1, 0.9], occluder: [0.8, 0.4, 1.0, 0.9], frustum: [0.4, 0.9, 1.0, 0.8],
};
const DEPTH_COLORS = [[0.4, 0.9, 1.0], [0.3, 1.0, 0.45], [1.0, 0.85, 0.3], [1.0, 0.5, 0.25], [1.0, 0.3, 0.6], [0.7, 0.4, 1.0]];

// this frame's traversal state of portal i (1 culled, 2 passed): vis.portalState is an array or a Map
const stateOf = (vis, i) => vis.portalState.get ? vis.portalState.get(i) : vis.portalState[i];

// colour of a portal from its flags and this frame's traversal state
function portalColor(P, state) {
    return P.closed ? VIS_COLORS.closed : state === 2 ? (P.skyOnly ? VIS_COLORS.sky : VIS_COLORS.passed) : state === 1 ? VIS_COLORS.culled : VIS_COLORS.idle;
}

// a world point of area a's footprint at height y (an area aboard a vehicle is in its frame)
const areaPoint = (a, x, y, z) => a.vehicle ? a.vehicle.toWorld([x, y, z]) : [x, y, z];

// line list ([x, y, z, r, g, b, a] per vertex, about `origin`): depth-tested lines first, overlay lines after
class Lines {
    constructor(origin = [0, 0, 0]) { this.depth = []; this.overlay = []; this.o = origin; }
    line(a, b, c, overlay = false) {
        const t = overlay ? this.overlay : this.depth, o = this.o;
        t.push(a[0] - o[0], a[1] - o[1], a[2] - o[2], c[0], c[1], c[2], c[3], b[0] - o[0], b[1] - o[1], b[2] - o[2], c[0], c[1], c[2], c[3]);
    }
    loop(pts, c, overlay) { for (let i = 0; i < pts.length; i++) this.line(pts[i], pts[(i + 1) % pts.length], c, overlay); }
    build() { const a = new Float32Array(this.depth.length + this.overlay.length); a.set(this.depth); a.set(this.overlay, this.depth.length); return { data: a, depthCount: this.depth.length / 7 }; }
}

// set: { areas, portals, occluders } (an AreaSet; empty slots allowed). A big one (a city of towers) has its portals
// drawn only where the traversal tested them or near the eye, and its volumes only where it reached (`many`)
class VisDebug {
    constructor(set, { many = 3000, near = 30 } = {}) { Object.assign(this, { set, many, near }); }

    // opts: { portals, volumes }; frozen: { eye, basis, aspect } | null; origin: what the lines are about (a world far
    // from its origin draws them about the eye)
    build(vis, opts, frozen, fov, origin) {
        const L = new Lines(origin);
        if (!vis) return L.build();
        if (opts.portals) this.portals(L, vis);
        if (opts.volumes) this.volumes(L, vis);
        if (frozen) this.frustum(L, vis, frozen, fov);
        return L.build();
    }

    portals(L, vis) {
        const list = this.set.portals, big = list.length > this.many, e0 = vis.eye, R = this.near;
        for (const P of list) {
            if (!P) continue;
            const st = stateOf(vis, P.index);
            if (big && !st && (P.max[0] < e0[0] - R || P.min[0] > e0[0] + R || P.max[1] < e0[1] - R || P.min[1] > e0[1] + R || P.max[2] < e0[2] - R || P.min[2] > e0[2] + R)) continue;
            const c = portalColor(P, st);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, 0.004)), c);
            L.loop(P.verts.map(v => v3.madd(v, P.normal, -0.004)), c);
        }
        for (const e of vis.entries) if (e.clipped && e.clipped !== e.via?.verts) L.loop(e.clipped, VIS_COLORS.clipped, false);
        for (const oc of vis.occluders) L.loop(oc.verts, VIS_COLORS.occluder, false);
    }

    volumes(L, vis) {
        const areas = this.set.areas, big = areas.length > this.many;
        const seen = i => vis.nodes.get ? vis.nodes.get(i) : vis.nodes[i];
        for (let i = 1; i < areas.length; i++) {
            const a = areas[i];
            if (!a || (big && !seen(i) && i !== vis.root)) continue;
            const c = seen(i) ? [0.3, 1, 0.5, 0.7] : [0.5, 0.55, 0.6, 0.25];
            // a tall one (a shaft): its storeys near the eye only
            const y0 = Math.max(a.y + 0.02, vis.eye[1] - 40), y1 = Math.min(a.top - 0.02, vis.eye[1] + 40);
            if (y1 <= y0) continue;
            const lo = a.shape.map(p => areaPoint(a, p[0], y0, p[1])), hi = a.shape.map(p => areaPoint(a, p[0], y1, p[1]));
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

return { VIS_COLORS, DEPTH_COLORS, portalColor, portalStateOf: stateOf, VisLines: Lines, VisDebug };
});
