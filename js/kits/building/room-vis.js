'use strict';
// RoomVis: what of a world's planned buildings the camera sees, as draws. The interior kit's PortalVis over the world's
// AreaSet (rooms of the storeys near, made as needed; stairwells, lift shafts and lift cars aboard; façades out to the
// outdoors), turned into instanced draws of the storeys' rooms and of the shafts' pieces, and the lift cars reached.

Features.kit('building', (engine, kit) => {
const { PortalVis, VisInspector, prismRange } = engine.kits.interior;

// draws are [first vertex, count, instances, first instance, building]: a storey (or a shaft piece) many storeys share
// is built once at its first storey s0 and drawn one storey higher per instance, so storey s is instance s - s0

// the runs of consecutive storeys in each item's set (item: { first, count, stacked, s0, owner }) as draws into out
function runDraws(items, out) {
    for (const [it, set] of items) {
        if (!it.count) continue;
        if (!it.stacked) { out.push([it.first, it.count, 1, 0, it.owner]); continue; }
        const list = [...set].sort((p, q) => p - q);
        for (let i = 0; i < list.length;) {
            let j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            out.push([it.first, it.count, j - i + 1, list[i] - it.s0, it.owner]);
            i = j + 1;
        }
    }
}

// collects (item, storey) pairs for runDraws
class DrawSet {
    constructor() { this.items = new Map(); }
    add(it, owner, s) {
        it.owner = owner;
        let set = this.items.get(it);
        if (!set) this.items.set(it, set = new Set());
        set.add(s);
    }
    // room k of section b's storey s
    room(b, s, k) {
        const tp = b.plan.tpl.get(b.plan.keys[s]), r = tp.rooms[k];
        if (!r || !r[1]) return;
        const it = (tp.roomItems ||= tp.rooms.map(([first, count]) => ({ first, count, stacked: tp.stacked, s0: tp.s0 })))[k];
        this.add(it, b, s);
    }
    // shaft j's piece on section b's storey s
    shaft(b, s, j) { const pc = b.plan.shafts?.[j]?.of[s]; if (pc) this.add(pc, b, s); }
    // every room and shaft piece of storeys lo..hi of section b
    storeys(b, lo, hi) {
        lo = Math.max(0, lo); hi = Math.min(b.n - 1, hi);
        for (let s = lo; s <= hi; s++) {
            const tp = b.plan.tpl.get(b.plan.keys[s]);
            for (let k = 0; k < tp.rooms.length; k++) this.room(b, s, k);
            for (let j = 0; j < (b.plan.shafts?.length || 0); j++) this.shaft(b, s, j);
        }
    }
    into(out) { runDraws(this.items, out); return out; }
}

// world: { areas (AreaSet), lifts (kits.transit Lifts), interiors (InteriorIndex: the buildings' interiors, kind
// 'building', owner the section building with its `plan`) }. o: range (m: interiors drawn within it of the eye; from
// outdoors, façade portals within it), maxEntries (traversal entries a frame; past it, every storey in range draws),
// maxDepth, outdoorDepth (from outdoors: through a window into a room, its doorway, the room beyond), outdoorNear (m:
// ... only through windows this near), stairNear (storeys of a stairwell drawn above and below the eye: its flights hide
// the rest), inspect (the VisInspector's options: map { spans, level, teleport }, keys; it is this.inspector: the floor
// map, the traversal, culling and freeze, the frames, on the engine's handheld)
class RoomVis {
    constructor(world, { range = 160, maxEntries = 3000, maxDepth = 12, outdoorDepth = 3, outdoorNear = 30, stairNear = 6, inspect = {} } = {}) {
        const A = world.areas;
        Object.assign(this, { world, range, stairNear });
        this.inspector = new VisInspector({ set: A, ...inspect, map: { level: 2.5, spans: { near: 80, far: 320 }, ...(inspect.map || {}) }, name: a => RoomVis.areaName(a) });
        this.nearPass = 0.25;
        this.cars = new Set();
        // from outdoors, the façade portals within range; the eye in no area but inside a building (a wall's thickness, a
        // sealed void of its core): from the area nearest it
        const graph = A.visGraph({ maxRange: range, nearPass: () => this.nearPass, root: eye => {
            const a = A.areaAt(eye);
            return a || (world.interiors.at(eye, 'building')?.owner.plan ? A.nearestArea(eye, 3) : 0);
        } });
        this.vis = new PortalVis(graph, { maxDepth, outdoorDepth, outdoorNear, maxEntries, nearPass: this.nearPass, reversed: true });
    }

    // The traversal from the eye (PortalVis's result; `frozen`: that one again, as it was), its draws into out: each room
    // reached, in runs of the storeys it is reached on; a stairwell's storeys near the eye; a shaft's pieces wherever
    // the frustums it is seen through take in its height (it is dark but for its lamps, which are seen from end to end);
    // the cars reached (this.cars). Culling off (enabled false), or the traversal out of entries: every storey of the
    // planned buildings in range instead (never a hole). near: the camera's near plane (m): a portal nearer than it is
    // clipped away by it, so within it the camera looks through (PortalVis nearPass)
    // view: { basis { fwd, right, up }, aspect, fov } (the inspector's: the culling and freeze options, the map, the frames)
    compute(eye, viewProj, W, H, out, near = 0.05, view = null) {
        const { world, range } = this, A = world.areas, L = world.lifts, I = this.inspector, enabled = I.opts.culling, t0 = performance.now();
        A.frame++;
        this.nearPass = this.vis.nearPass = Math.max(0.25, near * 1.5 + 0.05);
        // the landing doors: open while a car of their shaft stands there with its doors open, or forced; a car's door
        // as far as it is open
        for (const P of A.landings) P.closed = !L.landingOpen(P.landing.key, P.landing.y);
        for (const c of L.cars) if (c.doorPortal) c.doorPortal.closed = c.el.door < 0.03;
        const res = I.frozen || this.vis.compute(eye, viewProj, W, H, enabled);
        if (view) I.update(res, { eye, ...view }, performance.now() - t0);
        const D = new DrawSet();
        this.cars = new Set();
        this.ranges = new Map();         // car -> the stretch [y0, y1] of its shaft in view (Lifts.instances: its landing doors there)
        if (!I.frozen && (!enabled || res.truncated)) {
            world.interiors.grid.each(eye[0] - range, eye[2] - range, eye[0] + range, eye[2] + range, it => {
                const b = it.owner;
                if (it.kind !== 'building' || !b.plan) return;
                const q = it.origin.toLocal(eye), dh = Math.hypot(Math.max(Math.abs(q[0]) - b.hx, 0), Math.max(Math.abs(q[2]) - b.hz, 0));
                if (dh >= range) return;
                const dy = Math.sqrt(range * range - dh * dh);
                D.storeys(b, Math.floor((q[1] - dy) / b.H), Math.floor((q[1] + dy) / b.H));
            });
            for (const c of L.near(eye, 40)) this.cars.add(c);
            D.into(out);
            return res;
        }
        const areas = A.areas;
        res.nodes.forEach((entries, i) => {
            const a = entries && i && areas[i], r = a?.room;
            if (!r) return;
            if (r.car) { this.cars.add(r.car); return; }
            if (r.vert === undefined) { D.room(r.b, r.s, r.k); return; }
            // a stairwell or a shaft: the stretch of its height the frustums it is seen through take in
            let lo = Infinity, hi = -Infinity;
            for (const e of entries) {
                const yr = prismRange(a.shape, a.y, a.top, e.planes);
                if (yr) { lo = Math.min(lo, yr[0]); hi = Math.max(hi, yr[1]); }
            }
            if (r.vert === 'stair') { lo = Math.max(lo, eye[1] - this.stairNear * r.b.H); hi = Math.min(hi, eye[1] + this.stairNear * r.b.H); }
            if (hi < lo) return;
            for (const { b } of r.pb.sections) {
                const s0 = Math.max(0, Math.floor((lo - b.floor) / b.H)), s1 = Math.min(b.n - 1, Math.floor((hi - b.floor) / b.H));
                for (let s = s0; s <= s1; s++) {
                    if (r.vert === 'stair') { const k = b.plan.planOf(s).coreIdx.stair; if (k !== undefined && k >= 0) D.room(b, s, k); }
                    else D.shaft(b, s, r.vert);
                }
            }
            // a shaft's cars in that stretch, and its landing doors there (seen from end to end, as its lamps are)
            if (r.vert !== 'stair') for (const c of r.pb.cars || []) {
                if (c.shaftArea !== i) continue;
                this.ranges.set(c, [lo, hi]);
                if (c.el.y + c.h >= lo && c.el.y <= hi) this.cars.add(c);
            }
        });
        D.into(out);
        return res;
    }
}

// what the readout calls an area of a planned building
RoomVis.areaName = a => {
    const r = a?.room;
    if (!r) return a?.name ?? '?';
    if (r.car) return `lift car ${r.car.name ?? ''}`.trim();
    const b = r.b, who = b.name || 'building';
    if (r.vert !== undefined) return `${who} - ${r.vert === 'stair' ? 'stairwell' : `shaft ${r.vert}`}`;
    const g = (b.plan.g0 ?? 0) + r.s, kind = b.plan.planOf(r.s)?.rooms[r.k]?.kind ?? 'room';
    return `${who} - storey ${g} - ${kind}`;
};

return { RoomVis, DrawSet, runDraws };
});
