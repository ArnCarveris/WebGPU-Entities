'use strict';
// The frame builder: turns the visibility result into the frame's draws.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { POLY_FLOATS, NEAR_PASS, aabbVisible, aabbContained, rectUnion } = feature;

// FrameBuilder: visibility entries -> object tree queries -> command list for Renderer.render.
//
// A GUI screen (o.gui, world/entities.js Screen) is drawn by a 'gui' command after its entry's objects: its quads are
// depth-tested against them (just in front of its own surface) and masked by the entry's stencil ref like the rest.
//
// Stencil mode draws the portal tree depth-first. Each child's clipped portal polygon is marked into the
// stencil where the parent's ref is; the child's objects and sky then draw with stencil EQUAL. Every draw
// carries the chain of portals it is seen through (plane + fog of the area in front of each), so the scene
// shader fogs each stretch of the view ray with the air it crosses. After a child, its portal gets its
// glass pane; water draws last in every outdoor entry. Siblings are marked nearest first: where a nearer
// portal's aperture covers a farther one on screen, the nearer one's room owns those pixels (its walls hide
// what lies behind it), so a far portal never shows through a near doorway.
// (A portal's distance: from the eye to the nearest point of its clipped polygon, portalDistance.)
// Scissor / none modes draw every visible object once, clipped to the union of its entries' rects; fog
// through portals is then approximated by fog veils over the apertures.

const NO_FOG_CHAIN = [];

// distance from the eye to the nearest point of a convex planar polygon (normal n)
function portalDistance(eye, poly, n) {
    const h = v3.dot(v3.sub(eye, poly[0]), n), q = v3.madd(eye, n, -h);
    let inside = true, edge = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], ab = v3.sub(b, a), aq = v3.sub(q, a);
        if (v3.dot(v3.cross(ab, aq), n) < 0) inside = false;
        const t = Math.max(0, Math.min(1, v3.dot(aq, ab) / (v3.dot(ab, ab) || 1)));
        edge = Math.min(edge, v3.dist(q, v3.madd(a, ab, t)));
    }
    // the polygon may wind either way: inside means on the same side of every edge
    if (!inside) {
        inside = true;
        for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if (v3.dot(v3.cross(v3.sub(b, a), v3.sub(q, a)), n) > 0) inside = false; }
    }
    return Math.hypot(h, inside ? 0 : edge);
}

let STAMP = 0;      // shared by every FrameBuilder (the main view's, the view targets'), as objects keep the last one

class FrameBuilder {
    // renderer: how many stencil regions its layout gave the portal tree (regions.capacity), and its render
    // extensions' overlay commands (a visible object's GUI screen...)
    constructor(world, renderer) {
        this.world = world;
        this.refs = renderer.regions.capacity;
        this.overlays = renderer.overlays;
        this.stamp = 0;
    }

    // the extensions' commands for objects of an entry, after the entry's objects: in the object's draw slot and region
    overlay(objs, slotOf, ref, rectOf) {
        for (const x of this.overlays) for (const o of objs) {
            const c = x.overlay(o);
            if (c) this.cmds.push({ ...c, chunk: o.chunk, slot: slotOf(o), ref, rect: rectOf(o) });
        }
    }

    build(vis, mode, W, H) {
        this.stamp = ++STAMP;
        this.vis = vis;
        this.cmds = [];
        this.objs = [];
        this.draws = [];
        this.polys = [];
        this.st = { outNodes: 0, outObjs: 0, inNodes: 0, inObjs: 0, occluded: 0, marks: 0, refs: 1, glass: 0, water: 0, veils: 0 };
        if (mode === 'stencil') this.buildStencil();
        else this.buildFlat(mode, [0, 0, W, H]);
        return { cmds: this.cmds, objs: this.objs, draws: this.draws, polys: new Float32Array(this.polys), stats: this.st };
    }

    // draw slot of an object seen through a fog chain: one per (object, chain) this frame
    slot(o, fog = NO_FOG_CHAIN) {
        if (o.stamp !== this.stamp) { o.stamp = this.stamp; o.slots = new Map(); o.rect = null; this.objs.push(o); }
        let s = o.slots.get(fog);
        if (s === undefined) { s = this.draws.length; this.draws.push({ o, fog }); o.slots.set(fog, s); }
        return s;
    }

    occluded(o) {
        const occ = this.vis.occluders;
        if (!occ.length) return false;
        const b = o.vehicle ? o.vehicle.bounds(o) : null;
        return occ.some(oc => aabbContained(b ? b.wmin : o.min, b ? b.wmax : o.max, oc.planes));
    }

    // query the tree of the entry's area only (outdoor quadtree or the area's BVH + its dynamic members)
    collect(e) {
        const w = this.world, st = this.st, out = [];
        if (e.skyOnly) return out;
        const counter = { nodes: 0, objs: 0 };
        const visit = o => { if (o.dockedOnly && !o.vehicle.docked) return; if (this.occluded(o)) st.occluded++; else out.push(o); };
        if (e.area === 0) {
            w.outdoorTree.query(e.planes, visit, counter);
            for (const veh of w.vehicles) if (veh.inPlanes(e.planes)) veh.outdoorTree.query(veh.localPlanes(e.planes), visit, counter);   // vehicle space
        } else {
            const veh = w.areas[e.area].vehicle;
            w.areaTrees[e.area].query(veh ? veh.localPlanes(e.planes) : e.planes, visit, counter);
        }
        for (const d of w.dynamicByArea[e.area]) { counter.objs++; if (aabbVisible(d.min, d.max, e.planes)) visit(d); }
        if (e.area === 0) { st.outNodes += counter.nodes; st.outObjs += counter.objs; } else { st.inNodes += counter.nodes; st.inObjs += counter.objs; }
        return out;
    }

    addPoly(pts, n, c, area = 0) {
        const polys = this.polys, first = polys.length / POLY_FLOATS;
        for (let k = 1; k < pts.length - 1; k++) for (const p of [pts[0], pts[k], pts[k + 1]]) polys.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], c[3], area);
        return { first, count: polys.length / POLY_FLOATS - first };
    }

    addPolys(list, n, c) {
        const first = this.polys.length / POLY_FLOATS;
        for (const pts of list) this.addPoly(pts, n, c);
        return { first, count: this.polys.length / POLY_FLOATS - first };
    }

    // after what lies behind a portal is drawn: its glass pane, or (veil = true) a fog veil if the air in
    // front is foggy
    portalCover(P, pts, area, rect, veil) {
        if (P.glass) { this.cmds.push(Object.assign({ op: 'glass', rect }, this.addPoly(pts, P.normal, P.glass, area))); this.st.glass++; }
        else if (veil && this.world.areas[area].fog[3] > 0) { this.cmds.push(Object.assign({ op: 'veil', rect }, this.addPoly(pts, P.normal, [0, 0, 0, 0], area))); this.st.veils++; }
    }

    waterVisible(e) {
        const w = this.world;
        return e.area === 0 && w.water && !e.skyOnly && aabbVisible(w.water.min, w.water.max, e.planes);
    }

    buildStencil() {
        const w = this.world, cmds = this.cmds, st = this.st;
        let nextRef = 1;
        const walk = e => {
            const objs = this.collect(e);
            for (const o of objs) cmds.push({ op: 'draw', chunk: o.chunk, slot: this.slot(o, e.fog), ref: e.ref, rect: e.rect });
            // overlays (GUI screens over their surfaces), once everything of the entry that may hide them has its depth
            this.overlay(objs, o => this.slot(o, e.fog), e.ref, () => e.rect);
            if (e.area === 0) cmds.push({ op: 'sky', ref: e.ref, rect: e.rect });
            const kids = e.children.length > 1 ? e.children.map(c => [c.share ? -1 : portalDistance(this.vis.eye, c.clipped, c.via.normal), c]).sort((a, b) => a[0] - b[0]).map(x => x[1]) : e.children;
            for (const c of kids) {
                // the air in front of the portal fogs the ray up to its plane
                const P = c.via;
                c.fog = c.share ? e.fog : e.fog.concat([{ plane: [P.normal[0], P.normal[1], P.normal[2], P.d], fog: w.areas[e.area].fog }]);
                if (c.share || nextRef > this.refs) c.ref = e.ref;             // camera in the aperture: same region as the parent
                else {
                    c.ref = nextRef++;
                    cmds.push(Object.assign({ op: 'mark', parent: e.ref, child: c.ref, rect: c.rect }, this.addPoly(c.clipped, c.via.normal, [0, 0, 0, 0])));
                    st.marks++;
                }
                walk(c);
                if (!c.share) this.portalCover(c.via, c.clipped, e.area, c.rect, false);
            }
            // water last: it blends over this outdoor entry only (children already own their stencil refs)
            if (this.waterVisible(e)) {
                cmds.push(Object.assign({ op: 'water', ref: e.ref, rect: e.rect }, this.addPolys(w.water.pieces, [0, 1, 0], w.water.color)));
                st.water++;
            }
        };
        for (const r of this.vis.entries) if (!r.parent) { r.ref = 0; r.fog = NO_FOG_CHAIN; walk(r); }
        st.refs = nextRef;
    }

    buildFlat(mode, full) {
        const w = this.world, vis = this.vis, cmds = this.cmds;
        for (const e of vis.entries) for (const o of this.collect(e)) { this.slot(o); o.rect = rectUnion(o.rect, e.rect); }
        for (const o of this.objs) cmds.push({ op: 'draw', chunk: o.chunk, slot: o.slots.get(NO_FOG_CHAIN), ref: 0, rect: mode === 'scissor' ? o.rect : full });
        this.overlay(this.objs, o => o.slots.get(NO_FOG_CHAIN), 0, o => (mode === 'scissor' ? o.rect : full));
        if (vis.sky) cmds.push({ op: 'sky', ref: 0, rect: mode === 'scissor' ? vis.skyRect : full });
        const outs = (vis.nodes[0] || []).filter(e => this.waterVisible(e));
        if (outs.length) {
            const r = outs.reduce((a, e) => rectUnion(a, e.rect), null);
            cmds.push(Object.assign({ op: 'water', ref: 0, rect: mode === 'scissor' ? r : full }, this.addPolys(w.water.pieces, [0, 1, 0], w.water.color)));
            this.st.water++;
        }
        // glass panes and fog veils, back to front
        const seen = vis.enabled ? [...new Set(vis.entries.filter(e => e.via && !e.share).map(e => e.via))] : this.portalsInView(vis);
        seen.sort((a, b) => v3.dist(b.center, vis.eye) - v3.dist(a.center, vis.eye));
        for (const P of seen) this.portalCover(P, P.verts, v3.dot(P.normal, vis.eye) + P.d < 0 ? P.front : P.back, full, true);
    }

    // with portal culling off, no traversal went through the portals: cover every open portal in the
    // view frustum, except one the camera stands in
    portalsInView(vis) {
        const planes = vis.entries[0].planes, eye = vis.eye;
        return this.world.portals.filter(P => !P.closed && aabbVisible(P.min, P.max, planes) &&
            !(Math.abs(v3.dot(P.normal, eye) + P.d) < NEAR_PASS && P.containsProjected(eye)));
    }
}

return { FrameBuilder };
});
