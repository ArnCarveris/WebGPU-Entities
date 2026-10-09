'use strict';
// PortalVis: what the camera sees of a world of areas joined by portals, by traversal from the camera's area.

Features.kit('interior', (engine, kit) => {
const { v3, frustumPlanes } = engine.Common;
const { aabbVisible, aabbContained, clipPoly3, planesFromHull, screenRect, rectIntersect, rectUnion } = kit;

// PortalVis: FarCry CVisArea::PreRender / SECTR_CullingCamera traversal.
// Starts in the camera's area only; other areas (and the outdoors, area 0) are reached exclusively through open portals,
// each through the frustum its portal's clipped hull leaves (and that hull's screen rectangle). Each visited
// (area, frustum) pair is an "entry" in a tree.
//
// The world is read through a graph:
//   root(eye)          the area holding the eye (0: outdoors)
//   portals(entry)     the portals of entry.area worth testing: { index (unique), verts (convex, world), center,
//                      normal (from its front area toward its back), d (plane: normal . p + d), min, max, front, back,
//                      closed, passThrough, doubleSide, skyOnly, containsProjected(p) }
//   occluders(area)    (optional) occluders accumulated in it: { min, max, center, verts(eye) -> { n, verts } }
//   count, portalCount (optional) the areas and portals there are: results indexed by them (else Maps)
//   all()              (optional) every area, for traversal disabled
// options: maxDepth (portals deep), outdoorDepth (from outdoors, portals deep: a city's windows lead into rooms
// that lead on into more; 0 = maxDepth), outdoorNear (m: from outdoors, only a room entered through a portal this
// near the eye is looked on through; 0 = any), maxEntries, nearPass (m: the camera this near a portal's plane, inside its
// aperture, sees through it with the frustum it has), reversed (reversed-Z view-projection)
class PortalVis {
    constructor(graph, { maxDepth = 12, outdoorDepth = 0, outdoorNear = 0, maxEntries = 127, nearPass = 0.35, reversed = false } = {}) {
        this.graph = graph;
        Object.assign(this, { maxDepth, outdoorDepth, outdoorNear, maxEntries, nearPass, reversed });
    }

    compute(eye, viewProj, W, H, enabled = true) {
        const g = this.graph, full = [0, 0, W, H], NEAR_PASS = this.nearPass;
        const rootPlanes = frustumPlanes(viewProj, this.reversed ? { reversed: true } : undefined), near = rootPlanes[4], far = rootPlanes[5];
        const indexed = g.count !== undefined;
        const res = {
            eye: eye.slice(), viewProj, W, H, root: g.root(eye), nodes: indexed ? new Array(g.count).fill(null) : new Map(), entries: [],
            sky: false, skyRect: null, occluders: [], portalState: g.portalCount !== undefined ? new Uint8Array(g.portalCount) : new Map(),
            tested: 0, passed: 0, closed: 0, occludedPortals: 0, enabled, truncated: false,
        };
        const state = (pi, v) => {
            if (indexed) { if (v === 2 || !res.portalState[pi]) res.portalState[pi] = v; }
            else if (v === 2 || !res.portalState.get(pi)) res.portalState.set(pi, v);
        };
        const push = e => {
            e.children = [];
            res.entries.push(e);
            if (indexed) (res.nodes[e.area] ||= []).push(e);
            else { let l = res.nodes.get(e.area); if (!l) res.nodes.set(e.area, l = []); l.push(e); }
            if (e.parent) e.parent.children.push(e);
            if (e.area === 0) { res.sky = true; res.skyRect = rectUnion(res.skyRect, e.rect); }
        };
        if (!enabled) {
            for (const i of g.all ? g.all() : []) push({ area: i, planes: rootPlanes, rect: full, depth: 0, via: null, parent: null, skyOnly: false });
            return res;
        }
        const activeOcc = new Set(), maxDepth = res.root === 0 && this.outdoorDepth ? this.outdoorDepth : this.maxDepth;
        const stack = [{ area: res.root, planes: rootPlanes, rect: full, path: [], depth: 0, via: null, parent: null, skyOnly: false, clipped: null }];
        while (stack.length) {
            if (res.entries.length >= this.maxEntries) { res.truncated = true; break; }
            const e = stack.pop();
            push(e);
            if (e.skyOnly) continue;                                      // FarCry SkyOnly: nothing but sky beyond
            // SECTR: accumulate the occluders of every sector we pass through
            for (const O of g.occluders ? g.occluders(e.area) : []) {
                if (activeOcc.has(O)) continue;
                if (!aabbVisible(O.min, O.max, e.planes)) continue;
                const { n, verts } = O.verts(eye);
                const planes = planesFromHull(eye, verts);
                let pn = n, pd = -v3.dot(n, O.center);
                if (v3.dot(pn, eye) + pd > 0) { pn = v3.mul(pn, -1); pd = -pd; }  // positive side = behind the occluder
                planes.push([pn[0], pn[1], pn[2], pd]);
                activeOcc.add(O);
                res.occluders.push({ occ: O, verts, planes });
            }
            if (e.depth >= maxDepth) continue;
            if (res.root === 0 && this.outdoorNear && e.via && Math.hypot(...[0, 1, 2].map(k => Math.max(e.via.min[k] - eye[k], 0, eye[k] - e.via.max[k]))) > this.outdoorNear) continue;
            for (const P of g.portals(e)) {
                const pi = P.index;
                if (e.path.includes(pi)) continue;
                res.tested++;
                if (P.closed) { res.closed++; continue; }
                const fromFront = P.front === e.area, other = fromFront ? P.back : P.front;
                const s = v3.dot(P.normal, eye) + P.d;
                let planes, rect, clipped, share = false;
                if (Math.abs(s) < NEAR_PASS && P.containsProjected(eye)) {
                    planes = e.planes; rect = e.rect; clipped = P.verts; share = true;   // camera is inside the aperture
                } else {
                    // wrong side of the portal plane (SECTR IsPointInFrontOfPlane)
                    if (!P.doubleSide && (fromFront ? s > 0 : s < 0)) { state(pi, 1); continue; }
                    // SECTR: the next portal must lie in front of the portal we came through
                    if (e.via) {
                        const entryN = e.fromFront ? e.via.normal : v3.mul(e.via.normal, -1);
                        if (v3.dot(v3.sub(P.center, e.via.center), entryN) < -0.01) { state(pi, 1); continue; }
                    }
                    // SECTR: skip portals completely hidden by an accumulated occluder
                    if (res.occluders.some(o => aabbContained(P.min, P.max, o.planes))) { res.occludedPortals++; state(pi, 1); continue; }
                    clipped = clipPoly3(P.verts, e.planes);
                    if (clipped.length < 3) { state(pi, 1); continue; }
                    rect = rectIntersect(e.rect, screenRect(clipped, viewProj, W, H));
                    if (!rect) { state(pi, 1); continue; }
                    if (P.passThrough) { planes = e.planes; share = true; }
                    else {
                        planes = planesFromHull(eye, clipped);
                        const pn = fromFront ? P.normal : v3.mul(P.normal, -1), pd = fromFront ? P.d : -P.d;
                        planes.push([pn[0], pn[1], pn[2], pd], near, far);      // portal plane becomes the near plane
                    }
                }
                state(pi, 2);
                res.passed++;
                stack.push({ area: other, planes, rect, path: e.path.concat(pi), depth: e.depth + 1, via: P, fromFront, clipped, share, parent: e, skyOnly: P.skyOnly && other === 0 });
            }
        }
        return res;
    }
}

// A rectangle portal of a graph (PortalVis): world corners (convex, in order), from area front to area back (its
// normal toward back); bounds and plane worked out
function portalQuad(index, verts, front, back, normal, flags = {}) {
    const center = [0, 1, 2].map(k => (verts[0][k] + verts[1][k] + verts[2][k] + verts[3][k]) / 4);
    const right = v3.norm(v3.sub(verts[1], verts[0])), up = v3.norm(v3.sub(verts[3], verts[0]));
    const w = v3.len(v3.sub(verts[1], verts[0])), h = v3.len(v3.sub(verts[3], verts[0]));
    return {
        index, verts, front, back, normal, center, d: -v3.dot(normal, center), closed: false, passThrough: false, doubleSide: false, skyOnly: false, ...flags,
        min: [0, 1, 2].map(k => Math.min(verts[0][k], verts[1][k], verts[2][k], verts[3][k])),
        max: [0, 1, 2].map(k => Math.max(verts[0][k], verts[1][k], verts[2][k], verts[3][k])),
        containsProjected(p) {
            const r = v3.sub(p, center);
            return Math.abs(v3.dot(r, right)) <= w / 2 + 0.1 && Math.abs(v3.dot(r, up)) <= h / 2 + 0.1;
        },
    };
}

return { PortalVis, portalQuad };
});
