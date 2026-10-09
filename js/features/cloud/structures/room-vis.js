'use strict';
// The planned buildings' interior draws: what the portal feature's PortalVis (the interior kit's) reaches from the camera
// over the world's areas and portals (Structures.areas, an AreaSet: rooms, stairwells, lift shafts, façades), as
// instanced draws of their storeys.

Features.part('cloud', (engine, feature) => {
const { PortalVis } = engine.kits.interior;
const { Lifts } = engine.kits.transit;
const { INTERIOR_DRAW } = feature;
const MAX_ENTRIES = 3000;            // traversal entries a frame; past it, the buildings in range draw their storeys near
const VERT_NEAR = 6;                 // a stairwell's or lift shaft's storeys drawn above and below the eye

class RoomVis {
    constructor(S) {
        this.S = S;
        this.nearPass = 0.25;
        // from outdoors, the façade portals within INTERIOR_DRAW of the eye (as fsWindow sees through); the eye in no
        // area but inside a building (a wall's thickness, a sealed void of its core): from the area nearest it
        const graph = S.areas.visGraph({ maxRange: INTERIOR_DRAW, nearPass: () => this.nearPass, root: eye => {
            const a = S.areas.areaAt(eye);
            return a || (S.interiors.at(eye, 'building')?.owner.plan ? S.areas.nearestArea(eye, 3) : 0);
        } });
        this.vis = new PortalVis(graph, { maxDepth: 12, maxEntries: MAX_ENTRIES, nearPass: this.nearPass, reversed: true });
    }

    // the traversal from the eye (PortalVis's result), and its rooms' draws (Buildings.draws' format) into out: each kind
    // of storey's room in runs of storeys (instanced); a stairwell or shaft, its storeys near the eye; if it ran out of
    // entries, the storeys near of every planned building in range instead (never a hole). near: the camera's near plane
    // (m): a portal nearer than it is clipped away by it, so within it the camera looks through (PortalVis nearPass)
    compute(eye, viewProj, W, H, out, near = 0.05) {
        const S = this.S;
        this.nearPass = this.vis.nearPass = Math.max(0.25, near * 1.5 + 0.05);
        // the landing doors: open while a car of their shaft stands there with its doors open (Lifts)
        for (const l of S.landings) l.P.closed = !Lifts.openAt(l.cars, l.y);
        const res = this.vis.compute(eye, viewProj, W, H);
        if (res.truncated) {
            const R = INTERIOR_DRAW;
            S.interiors.grid.each(eye[0] - R, eye[2] - R, eye[0] + R, eye[2] + R, it => { if (it.kind === 'building' && it.owner.plan) S.buildings.near(it.owner, eye, out); });
            return res;
        }
        const by = new Map();            // template -> room -> storeys
        const add = (b, s, k) => {
            const tp = b.plan.tpl.get(b.plan.keys[s]);
            tp.owner = b;
            if (!by.has(tp)) by.set(tp, new Map());
            const rooms = by.get(tp);
            if (!rooms.has(k)) rooms.set(k, new Set());
            rooms.get(k).add(s);
        };
        const areas = S.areas.areas;
        res.nodes.forEach((entries, i) => {
            const r = entries && i && areas[i].room;
            if (!r) return;
            if (r.vert === undefined) { add(r.b, r.s, r.k); return; }
            const b = r.b, s0 = Math.floor((eye[1] - b.floor) / b.H);
            for (let s = Math.max(0, s0 - VERT_NEAR); s <= Math.min(b.n - 1, s0 + VERT_NEAR); s++) {
                const P = b.plan.planOf(s), k = r.vert === 'stair' ? P.coreIdx.stair : P.coreIdx.shafts[r.vert];
                if (k !== undefined && k >= 0) add(b, s, k);
            }
        });
        for (const [tp, rooms] of by) for (const [k, set] of rooms) {
            const [first, count] = tp.rooms[k];
            if (!count) continue;
            if (!tp.stacked) { out.push([first, count, 1, 0, tp.owner]); continue; }
            const list = [...set].sort((p, q) => p - q);
            for (let i = 0; i < list.length;) {
                let j = i;
                while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
                out.push([first, count, j - i + 1, list[i] - tp.s0, tp.owner]);
                i = j + 1;
            }
        }
        return res;
    }
}

return { RoomVis };
});
