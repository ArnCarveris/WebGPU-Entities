'use strict';
// PlannedBuilding: a buildingPlan (PlanLibrary.resolve) built in a world of structure meshes: its sections stacked
// (each a building shell of the world's, its storeys of a kind built once and drawn instanced), the core's stairwell
// and shafts as areas through all of them, each section's storeys as a stack of areas made near the eye (AreaSet
// addStack), the lift cars (the transit kit's Lifts: areas of their own, aboard), the emergency ladders, the crown.

Features.kit('building', (engine, kit) => {
const { kits } = engine;
const { FloorPlan, sharedEdge } = kits.interior;
const { coreLayout, FloorBuilder, PARTITION } = kit;
const { Lifts } = kits.transit;
const EPS = 1e-4;

// world: { S (its structures: buildings.add(f, spec) builds a shell and calls spec.interior(B) for its rooms, solids
// (stack), areas (an AreaSet), lifts (kits.transit Lifts), ladders (Ladders), box / prism, boxes (shader boxes),
// ground(x, z)), lib (PlanLibrary) }. R: the resolved plan; f: its ground frame; spec: the placement's (name, color,
// floor, base, seed, doors, w, d, storeys...)
class PlannedBuilding {
    constructor(world, R, f, spec = {}) {
        Object.assign(this, { world, R, f, spec, S: world.S, lib: world.lib });
        this.name = spec.name || R.name;
        const Hmax = Math.max(...R.sections.map(s => s.H));
        this.core = coreLayout(R.core, Hmax);
        // each storey's floor over storey 0's (m), from the sections' heights
        this.yRel = [];
        let y = 0;
        for (const sec of R.sections) for (let s = 0; s < sec.n; s++) { this.yRel.push(y); y += sec.H; }
        this.height = y;
        // each shaft's cars: their storeys' range (from the plan's lifts)
        this.columns = this.core.shafts.map(sh => R.lifts.filter(l => l.bank === sh.bank && l.shaft === sh.index)
            .map(l => ({ lift: l, lo: Math.min(...l.stops), hi: Math.max(...l.stops), stops: new Set(l.stops) })));
    }

    // The building: its sections, the areas, the lifts, the ladders, the crown. Returns { sections [{ b, g0 }], lobby
    // (the first section's building), top (m), storeys, stop(g) ({ y, building, name, g }), find(tag) (the first storey
    // with that tag), label(g) }
    build() {
        const { S, R, f, spec } = this;
        let floor = spec.floor, base = spec.base, prev = null;
        this.sections = [];
        R.sections.forEach((sec, k) => {
            const next = R.sections[k + 1], last = !next;
            const roof = last ? { kind: 'flat', overhang: 0.4, thick: 0.6, ...(spec.roof || {}), ...(sec.spec.roof || {}) }
                : { kind: 'terrace', inner: [next.w / 2, next.d / 2], drip: false };
            const b = S.buildings.add(f, {
                ...spec, ...sec.spec, type: spec.type || R.plan.archetype,
                name: this.name, w: sec.w, d: sec.d, storeys: sec.n, storeyHeight: sec.H, floor, base,
                doors: k === 0 ? sec.spec.doors || spec.doors : [], roof, lifts: false,
                interior: B => this.interior(B, sec),
            });
            this.sections.push({ b, g0: sec.g0, sec });
            if (prev) { prev.above = b; b.below = prev; }
            prev = b;
            floor = base = b.top;
        });
        this.floor0 = this.sections[0].b.floor;
        this.top = prev.top;
        this.areas();
        this.lifts();
        this.ladders();
        this.crown();
        const self = this;
        return {
            sections: this.sections.map(({ b, g0 }) => ({ b, g0 })), lobby: this.sections[0].b, top: this.crownTop ?? this.top, storeys: R.G, plan: R,
            stop: g => self.stop(g), find: tag => R.storeys.find(st => st.tags.has(tag))?.g ?? -1, label: g => R.storeys[g]?.label ?? String(g),
            building: this,
        };
    }

    // storey g: its floor's height, its section's building, its label
    stop(g) {
        const st = this.R.storeys[g], { b } = this.sections[st.sec];
        return { y: this.floor0 + this.yRel[g], building: b, name: st.label, g };
    }

    // Shaft j's slice of storey g (heights over the storey's floor; see FloorBuilder.shaft): a landing door where a car
    // stops; the run of its cars (rails) and its ladder from the pit's floor to the overrun's ceiling; the pit's floor,
    // the overrun's ceiling and the machine room over it in the storeys that hold them (below the lowest storey or
    // above the highest: the nearest storey's); a service opening into the machine room from a storey whose floor is
    // level with it and has no landing there
    slices(g) {
        const { core, R } = this, H = R.sections[R.storeys[g].sec].H, y0 = this.yRel[g], G = R.G;
        // (what lies below the building belongs to its first storey, what lies above it to its last)
        const lo0 = g === 0 ? -Infinity : y0 - EPS, hi0 = g === G - 1 ? Infinity : y0 + H - EPS;
        const holds = yy => yy >= lo0 && yy < hi0;
        return core.shafts.map((sh, j) => {
            const out = {};
            for (const c of this.columns[j]) {
                const lo = this.yRel[c.lo] - core.pit, top = this.yRel[c.hi] + sh.car.h + core.overrun, m0 = top + 0.25, m1 = m0 + core.machine;
                if (c.stops.has(g)) out.door = true;
                const a = Math.max(lo, lo0), b = Math.min(top, hi0);
                if (b > a) {
                    const r = [a - y0, b - y0];
                    out.run = out.run ? [Math.min(out.run[0], r[0]), Math.max(out.run[1], r[1])] : r;
                    out.ladder = out.run;
                }
                if (holds(lo)) out.pit = lo - y0;
                if (holds(top)) out.top = top - y0;
                if (holds(m0)) {
                    out.machine = [m0 - y0, m1 - y0];
                    if (!c.stops.has(g) && m0 - y0 >= -EPS && m0 - y0 < 0.45) out.service = core.machine;
                }
            }
            return out;
        });
    }

    // the interior of section `sec` (Buildings.add calls it with the world's B once its shell is up): a plan per kind of
    // storey, each kind of storey (its storeyPlan, which shafts have a landing door or a service opening on it, stairs up
    // or not, the ground's doors) built once at its first storey and, when storeys share it, stacked (drawn instanced, its
    // solids made near a walker: Solids.stack). Each shaft apart, in pieces: a piece per kind of slice of it (its pit, a
    // plain stretch, one with a landing door, the overrun, the machine room... FloorBuilder.shaftPiece), built once and
    // stacked up the shaft the same way.
    // Returns b.plan: { core, keys (per storey), tpl (key -> { s0, storeys, rooms (vertex ranges), first, count, stacked,
    // plan, info }), shafts (per shaft: { pieces (key -> { s0, storeys, first, count, stacked }), of (per storey: its
    // piece) }), planOf(s), info (per storey), depth ([x, z]: how deep the façade rooms reach), codes (per storey: 2 for
    // a hall, plus the share of such storeys lit), lights (the shafts' lamp columns, lightColumns) }
    interior(B, sec) {
        const { S, R, core } = this, { n, H, floor, hx, hz, t } = B, plans = {};
        B.lib = this.lib;
        const planOf = st => plans[st.key] ??= new FloorPlan({ hx, hz, t, core, storey: st.plan, partition: PARTITION, seed: B.id * 31 + st.key.length * 7 + 3 });
        const storeys = R.storeys.slice(sec.g0, sec.g0 + n);
        const sliceKey = o => `${o.door ? 'd' : '-'}${o.run ? 'r' + o.run.map(v => v.toFixed(2)).join(':') : ''}${o.pit !== undefined ? 'p' + o.pit.toFixed(2) : ''}${o.top !== undefined ? 't' + o.top.toFixed(2) : ''}${o.service ? 's' : ''}${o.machine ? 'm' + o.machine[0].toFixed(2) : ''}`;
        const info = storeys.map(st => {
            const slices = this.slices(st.g), sig = slices.map(o => `${o.door ? 'd' : '-'}${o.service ? 's' : ''}`).join(',');
            return { key: `${st.key}|${sig}|${st.stairsUp ? 'u' : ''}${st.g === 0 ? 'g' : ''}`, st, slices, stairsUp: st.stairsUp, ground: st.g === 0, plan: planOf(st) };
        });
        const fb = new FloorBuilder(B), tpl = new Map();
        info.forEach((o, s) => { if (!tpl.has(o.key)) tpl.set(o.key, { s0: s, storeys: [], info: o }); tpl.get(o.key).storeys.push(s); });
        for (const [key, tp] of tpl) {
            const P = tp.info.plan, y = floor + tp.s0 * H, stacked = tp.storeys.length > 1, first = B.count();
            const opts = { stacked, stairsUp: tp.info.stairsUp, ground: tp.info.ground, shafts: tp.info.slices, seed: B.id * 977 + tp.s0 };
            const build = () => { tp.rooms = fb.storey(P, y, opts); };
            if (stacked) S.solids.stack(y, H, si => info[tp.s0 + si]?.key === key, build);
            else build();
            Object.assign(tp, { first, count: B.count() - first, stacked, plan: P });
        }
        // the shafts' pieces (a shaft lies where it does on every storey's plan: the core is the building's)
        const P0 = info[0].plan;
        const shafts = core.shafts.map((sh, j) => {
            const pieces = new Map(), of = info.map((o, s) => {
                const key = sliceKey(o.slices[j] || {});
                if (!pieces.has(key)) pieces.set(key, { key, s0: s, storeys: [], sl: o.slices[j] || {} });
                const pc = pieces.get(key);
                pc.storeys.push(s);
                return pc;
            });
            for (const pc of pieces.values()) {
                const y = floor + pc.s0 * H, stacked = pc.storeys.length > 1;
                const build = () => { [pc.first, pc.count] = fb.shaftPiece(P0, j, y, pc.sl, { stacked, light: core.light }); };
                if (stacked) S.solids.stack(y, H, si => of[pc.s0 + si] === pc, build);
                else build();
                pc.stacked = stacked;
            }
            return { pieces, of };
        });
        // how deep the façade rooms reach (the sun's limit in WGSL), each storey's kind and lit share
        const depth = [0, 0];
        for (const P of Object.values(plans)) { const d = P.facadeDepth(); depth[0] = Math.max(depth[0], d[0]); depth[1] = Math.max(depth[1], d[1]); }
        const lamps = B.T.lamps ?? 0.5;
        const codes = info.map(o => (o.plan.halls?.length && o.plan.rooms[o.plan.halls[0]].hall ? 2 : 0) + Math.min(1, Math.max(0, o.st.plan.lit ?? lamps)));
        return { core, keys: info.map(o => o.key), tpl, shafts, info, depth, codes, lights: this.lightColumns(floor, H), planOf: s => info[s].plan, g0: sec.g0 };
    }

    // The shafts' lamps of a section whose storey 0 is at `floor` (m, world) and H m high, as the shaders light a shaft
    // by: per shaft with cars, { rect [x0, x1, z0, z1] (its inside, building frame), lamp [x, z], y0 (a lamp's height,
    // world), step (m between lamps), lo, hi (the lamps' heights from its lowest pit to its highest overrun: the whole
    // shaft's, through every section), color, intensity, range }
    lightColumns(floor, H) {
        const { core, R } = this, L = core.light, out = [];
        if (!L) return out;
        const half = PARTITION / 2, floor0 = this.sections?.[0]?.b.floor ?? floor;
        core.shafts.forEach((sh, j) => {
            if (!this.columns[j].length) return;
            let lo = Infinity, hi = -Infinity;
            for (const c of this.columns[j]) {
                lo = Math.min(lo, floor0 + this.yRel[c.lo] - core.pit);
                hi = Math.max(hi, floor0 + this.yRel[c.hi] + sh.car.h + core.overrun);
            }
            const [x0, x1, z0, z1] = sh.rect;
            out.push({ rect: [x0 + half, x1 - half, z0 + half, z1 - half], lamp: [sh.lamp.x, sh.lamp.z], y0: floor + L.y, step: H / L.perStorey, lo, hi,
                color: L.color, intensity: L.intensity, range: L.range });
        });
        return out;
    }

    // The areas (the world's AreaSet): the stairwell and each shaft one tall area through every section (a shaft's from
    // its pit to its machine room), each section's storeys a stack (AreaSet.addStack: made near the eye): each room's
    // rectangles an area, the doorways, the openings between a room's rectangles, the faÃ§ade's window band (the ground
    // floor's doors too) out to the outdoors, the landing doors into the shafts (closed unless a car stands open there),
    // the service openings into the machine rooms, the stair doors into the stairwell
    areas() {
        const { S, f, core, R } = this, A = S.areas, shelter = this.sections[0].b.shelter !== false;
        const shape = r => [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]].map(([x, z]) => f.xz(x, z));
        const b0 = this.sections[0].b;
        const tall = (r, y0, y1, room, reach) => Object.assign(A.addArea({ id: A.areas.length, shape: shape(r), y: y0, height: y1 - y0, shelter }), { room, reach });
        this.stairArea = core.stair ? tall(core.stair.rect, this.floor0, this.top, { b: b0, vert: 'stair', pb: this }, 3 * R.sections[0].H).index : -1;
        this.shaftAreas = core.shafts.map((sh, j) => {
            if (!this.columns[j].length) return -1;
            const y0 = this.floor0 - core.pit - 0.4, y1 = Math.max(this.top, this.floor0 + this.yRel[R.G - 1] + sh.car.h + core.overrun + core.machine + 0.5);
            return tall(sh.rect, y0, y1, { b: b0, vert: j, pb: this }, 6 * R.sections[0].H).index;
        });
        const talls = [this.stairArea, ...this.shaftAreas].filter(i => i >= 0);
        for (const { b } of this.sections) {
            const P = b.plan, templates = new Map();
            const corners = [[-b.hx, -b.hz], [b.hx, -b.hz], [b.hx, b.hz], [-b.hx, b.hz]].map(([x, z]) => f.xz(x, z));
            const rect = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
            b.stack = A.addStack({
                origin: b.interior.origin, base: b.floor, H: b.H, n: b.n, rect, tall: talls,
                key: s => P.keys[s],
                template: key => {
                    if (!templates.has(key)) templates.set(key, this.template(b, P.tpl.get(key)));
                    return templates.get(key);
                },
            });
        }
    }

    // the areas and portals of a kind of storey of section building b (tp: its template)
    template(b, tp) {
        const P = tp.plan, o = tp.info, H = b.H, T = b.T, W = T.window, out = { areas: [], portals: [] };
        const [X0, X1, Z0, Z1] = P.inner, slab = T.slab;
        const byRoom = P.rooms.map(() => []);
        P.rooms.forEach((room, k) => {
            if (room.kind === 'stair' || room.kind === 'shaft') return;
            for (const r of room.rects) { byRoom[k].push(out.areas.length); out.areas.push({ rect: r, y: 0, height: H, room: { b, k }, shelter: b.shelter !== false }); }
        });
        // the template area of room k holding the point (x, z) on an edge, nudged toward the room by n
        const areaOf = (k, x, z, n) => {
            const q = [x - n[0] * 0.05, z - n[1] * 0.05];
            const i = byRoom[k].find(i => { const r = out.areas[i].rect; return q[0] >= r[0] - EPS && q[0] <= r[1] + EPS && q[1] >= r[2] - EPS && q[1] <= r[3] + EPS; });
            return i ?? byRoom[k][0];
        };
        const portal = (x, z, yc, w, h, nl, a, b2, extra = {}) => out.portals.push({ center: [x, yc, z], size: [w, h], normal: [nl[0], 0, nl[1]], a, b: b2, ...extra });
        const door = Math.max(0, ...(T.doors || []).map(d => d.height ?? T.door.height));
        P.rooms.forEach((room, k) => {
            if (room.kind === 'stair' || room.kind === 'shaft') return;
            // the openings between its own rectangles
            for (let i = 0; i < room.rects.length; i++) for (let j = i + 1; j < room.rects.length; j++) {
                const e = sharedEdge(room.rects[i], room.rects[j]);
                if (!e) continue;
                const c = (e.a0 + e.a1) / 2, [x, z] = e.axis === 'x' ? [c, e.at] : [e.at, c];
                const nl = e.axis === 'x' ? [0, e.side] : [e.side, 0];
                portal(x, z, (H - slab) / 2, e.a1 - e.a0, H - slab, nl, byRoom[k][i], byRoom[k][j], { passThrough: true });
            }
            // its faÃ§ade's stretches: the storey's window band (the ground floor's doors too)
            const [b0, b1] = o.ground ? [0, Math.max(W.sill + W.height, door)] : [W.sill, Math.min(W.sill + W.height, H - slab)];
            room.rects.forEach((r, i) => {
                for (const [axis, at, a0, a1, nl] of [['x', r[2], r[0], r[1], [0, -1]], ['x', r[3], r[0], r[1], [0, 1]], ['z', r[0], r[2], r[3], [-1, 0]], ['z', r[1], r[2], r[3], [1, 0]]]) {
                    if (axis === 'x' ? Math.abs(at - (nl[1] < 0 ? Z0 : Z1)) > 1e-4 : Math.abs(at - (nl[0] < 0 ? X0 : X1)) > 1e-4) continue;
                    const c = (a0 + a1) / 2, [x, z] = axis === 'x' ? [c, at] : [at, c];
                    portal(x, z, (b0 + b1) / 2, a1 - a0, b1 - b0, nl, byRoom[k][i], { outdoors: true });
                }
            });
        });
        // the doorways, the stair door, the landing doors and service openings (into the tall areas)
        for (const p of P.portals) {
            const ka = P.rooms[p.a].kind, kb = P.rooms[p.b].kind;
            const h = p.h || H - slab, [x, z] = p.axis === 'x' ? [p.c, p.at] : [p.at, p.c];
            // the normal from a to b: a's rectangle lies on the - side of the edge
            const aMinus = P.rooms[p.a].rects.some(r => p.axis === 'x' ? Math.abs(r[3] - p.at) < EPS && r[0] <= p.c + EPS && p.c <= r[1] + EPS
                : Math.abs(r[1] - p.at) < EPS && r[2] <= p.c + EPS && p.c <= r[3] + EPS);
            const nl = p.axis === 'x' ? [0, aMinus ? 1 : -1] : [aMinus ? 1 : -1, 0];
            const side = (k, kind, sgn) => {
                if (kind === 'stair') return { tall: this.stairArea };
                if (kind === 'shaft') return { tall: this.shaftAreas[P.coreIdx.shafts.indexOf(k)] };
                return areaOf(k, x, z, [nl[0] * sgn, nl[1] * sgn]);
            };
            const a = side(p.a, ka, 1), bb = side(p.b, kb, -1);
            if (kb === 'shaft' || ka === 'shaft') {
                const sk = kb === 'shaft' ? p.b : p.a, j = P.coreIdx.shafts.indexOf(sk), sl = o.slices[j] || {}, sh = P.rooms[sk].shaft;
                if (this.shaftAreas[j] < 0) continue;
                if (sl.door) portal(x, z, h / 2, p.w, h, nl, a, bb, { landing: { key: Lifts.shaftKey(this.f, sh.rect), shaft: sh.key, pb: this }, closed: true, kind: 'door' });
                else if (sl.service) portal(x, z, sl.service / 2, p.w, sl.service, nl, a, bb, { kind: 'opening' });
                continue;
            }
            portal(x, z, h / 2, p.w, h, nl, a, bb, { kind: p.kind === 'opening' ? 'opening' : 'door', passThrough: p.kind === 'opening' && p.w > 2.5 });
        }
        return out;
    }

    // the lifts: a car per lift of the plan in its shaft (the core's), its stops each storey's floor; each car an area
    // aboard it (its own light and air: the world draws it when the traversal reaches it), its door a portal onto the
    // shaft (open as its doors are)
    lifts() {
        const { S, R, core, f } = this;
        this.cars = [];
        for (const l of R.lifts) {
            const sh = core.shafts.find(s => s.bank === l.bank && s.index === l.shaft);
            const car = S.lifts.add({ f, shaft: sh, kind: l.kind, group: l.group, name: l.name, motion: l.motion, stops: l.stops.map(g => this.stop(g)), owner: this });
            const j = core.shafts.indexOf(sh);
            car.shaftArea = this.shaftAreas[j];
            if (S.areas && car.shaftArea >= 0) S.lifts.carArea(car, S.areas);
            this.cars.push(car);
        }
    }

    // an emergency ladder up the technical space of each shaft, from each car's pit to its overrun's ceiling
    ladders() {
        const { S, core, f } = this;
        if (!core.ladder || !S.ladders) return;
        core.shafts.forEach((sh, j) => {
            for (const c of this.columns[j]) {
                const y0 = this.floor0 + this.yRel[c.lo] - core.pit, y1 = this.floor0 + this.yRel[c.hi] + sh.car.h + core.overrun;
                S.ladders.add({ f, x: sh.ladder.x, z: sh.ladder.z, n: sh.ladder.n, w: sh.ladder.w, y0, y1, along: [sh.sx, 0], building: this,
                    landings: [...c.stops].map(g => ({ y: this.floor0 + this.yRel[g], g, x: sh.wall, z: sh.door.c, w: sh.door.w, shaft: sh.key })) });
            }
        });
    }

    // the crown on the roof (a spire: a plant box, a mast stepping in, a beacon on its tip)
    crown() {
        const { S, f, R } = this, c = R.crown;
        if (!c || c.kind !== 'spire') return;
        const C = { metal: [0.40, 0.42, 0.44] }, roof = this.top + (this.sections[this.sections.length - 1].b.roofThick ?? 1.2);
        const hw = (c.width ?? 14) / 2, h = c.height ?? 6, sp = c.spire ?? 100;
        S.box(f, 0, 0, hw, hw, roof, roof + h, C.metal, 4);
        for (let i = 0; i < 6; i++) {
            const a = 3.2 * (1 - i / 6) + 0.25, y0 = roof + h + i * sp / 6;
            S.prism(f, 0, 0, a, a, y0, y0 + sp / 6, C.metal, 4);
        }
        S.prism(f, 0, 0, 0.35, 0.35, roof + h + sp, roof + h + sp + 0.7, [1.0, 0.18, 0.12], 7);
        S.boxes.add(f, 0, 0, hw, hw, roof, roof + h, 0.2, 0, roof);
        this.crownTop = roof + h + sp;
    }
}

return { PlannedBuilding };
});
