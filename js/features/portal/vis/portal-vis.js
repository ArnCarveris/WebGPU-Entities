'use strict';
// Portal visibility: traversal from the camera's area through its portals.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3, frustumPlanes } = Common;
const {
    MAX_DEPTH, MAX_ENTRIES, NEAR_PASS, aabbVisible, aabbContained, clipPoly3, planesFromHull, screenRect,
    rectIntersect, rectUnion,
} = feature;

// PortalVis: FarCry CVisArea::PreRender / SECTR_CullingCamera traversal.
// Starts in the camera's area only; other areas (and the outdoors) are reached exclusively
// through open portals. Each visited (area, frustum) pair is an "entry" in a tree.

class PortalVis {
    constructor(world) { this.world = world; }

    compute(eye, viewProj, W, H, enabled) {
        const w = this.world, full = [0, 0, W, H];
        const rootPlanes = frustumPlanes(viewProj), near = rootPlanes[4], far = rootPlanes[5];
        const res = {
            eye: eye.slice(), viewProj, W, H, root: w.areaAt(eye), nodes: w.areas.map(() => null), entries: [],
            sky: false, skyRect: null, occluders: [], portalState: new Uint8Array(w.portals.length),
            tested: 0, passed: 0, closed: 0, occludedPortals: 0, enabled,
        };
        const push = e => {
            e.children = [];
            res.entries.push(e);
            (res.nodes[e.area] ||= []).push(e);
            if (e.parent) e.parent.children.push(e);
            if (e.area === 0) { res.sky = true; res.skyRect = rectUnion(res.skyRect, e.rect); }
        };
        if (!enabled) {
            w.areas.forEach((a, i) => push({ area: i, planes: rootPlanes, rect: full, depth: 0, via: null, parent: null, skyOnly: false }));
            return res;
        }
        const activeOcc = new Set();
        const stack = [{ area: res.root, planes: rootPlanes, rect: full, path: [], depth: 0, via: null, parent: null, skyOnly: false, clipped: null }];
        while (stack.length && res.entries.length < MAX_ENTRIES) {
            const e = stack.pop();
            push(e);
            if (e.skyOnly) continue;                                      // FarCry SkyOnly: nothing but sky beyond
            // SECTR: accumulate the occluders of every sector we pass through
            for (const oi of w.areas[e.area].occluders) {
                if (activeOcc.has(oi)) continue;
                const O = w.occluders[oi];
                if (!aabbVisible(O.min, O.max, e.planes)) continue;
                const { n, verts } = O.verts(eye);
                const planes = planesFromHull(eye, verts);
                let pn = n, pd = -v3.dot(n, O.center);
                if (v3.dot(pn, eye) + pd > 0) { pn = v3.mul(pn, -1); pd = -pd; }  // positive side = behind the occluder
                planes.push([pn[0], pn[1], pn[2], pd]);
                activeOcc.add(oi);
                res.occluders.push({ occ: O, verts, planes });
            }
            if (e.depth >= MAX_DEPTH) continue;
            for (const pi of this.candidates(e)) {
                if (e.path.includes(pi)) continue;
                const P = w.portals[pi];
                res.tested++;
                if (P.closed) { res.closed++; continue; }
                const fromFront = P.front === e.area, other = fromFront ? P.back : P.front;
                const s = v3.dot(P.normal, eye) + P.d;
                let planes, rect, clipped, share = false;
                if (Math.abs(s) < NEAR_PASS && P.containsProjected(eye)) {
                    planes = e.planes; rect = e.rect; clipped = P.verts; share = true;   // camera is inside the aperture
                } else {
                    // wrong side of the portal plane (SECTR IsPointInFrontOfPlane)
                    if (!P.doubleSide && (fromFront ? s > 0 : s < 0)) { res.portalState[pi] ||= 1; continue; }
                    // SECTR: the next portal must lie in front of the portal we came through
                    if (e.via) {
                        const entryN = e.fromFront ? e.via.normal : v3.mul(e.via.normal, -1);
                        if (v3.dot(v3.sub(P.center, e.via.center), entryN) < -0.01) { res.portalState[pi] ||= 1; continue; }
                    }
                    // SECTR: skip portals completely hidden by an accumulated occluder
                    if (res.occluders.some(o => aabbContained(P.min, P.max, o.planes))) { res.occludedPortals++; res.portalState[pi] ||= 1; continue; }
                    clipped = clipPoly3(P.verts, e.planes);
                    if (clipped.length < 3) { res.portalState[pi] ||= 1; continue; }
                    rect = rectIntersect(e.rect, screenRect(clipped, viewProj, W, H));
                    if (!rect) { res.portalState[pi] ||= 1; continue; }
                    if (P.passThrough) { planes = e.planes; share = true; }
                    else {
                        planes = planesFromHull(eye, clipped);
                        const pn = fromFront ? P.normal : v3.mul(P.normal, -1), pd = fromFront ? P.d : -P.d;
                        planes.push([pn[0], pn[1], pn[2], pd], near, far);      // portal plane becomes the near plane
                    }
                }
                res.portalState[pi] = 2;
                res.passed++;
                stack.push({ area: other, planes, rect, path: e.path.concat(pi), depth: e.depth + 1, via: P, fromFront, clipped, share, parent: e, skyOnly: P.skyOnly && other === 0 });
            }
        }
        return res;
    }

    // the portals of entry e's area worth testing. Outdoors holds every exit portal of every building, so there the
    // world's outdoor-portal quadtree gives only those whose bounds meet e's frustum (its planes pushed out by
    // NEAR_PASS + 1 m: a broad phase that never drops one the tests below would pass, the camera standing in an aperture
    // included), in index order as the full list would visit them. Cost: the tree nodes in view, not the world's portals
    candidates(e) {
        const w = this.world;
        if (e.area !== 0 || !w.outdoorPortals) return w.areas[e.area].portals;
        const pad = NEAR_PASS + 1, planes = e.planes.map(q => [q[0], q[1], q[2], q[3] + pad]), out = [];
        // a vehicle's (the ship's): only while its bounding sphere is in view
        for (const { veh, portals } of w.movingOutdoorPortals) if (veh.inPlanes(planes)) out.push(...portals);
        w.outdoorPortals.query(planes, P => out.push(P.index), this.st ??= { nodes: 0, objs: 0 });
        return out.sort((a, b) => a - b);
    }
}

return { PortalVis };
});
