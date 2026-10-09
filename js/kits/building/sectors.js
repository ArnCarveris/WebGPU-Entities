'use strict';
// Planned buildings in a sector world (areas whose walls, floors, ceilings and shell the world builds from their shapes;
// portals cut through them; props, lights, doors and stairs: the portal feature's World): a world's `structures`
// (placements of buildingPlans) expanded into its native areas, portals, models, materials and entities before it is
// built, from the same floor plans (PlanLibrary) a structure-mesh world (cloud) builds its buildings from. A sector world
// has no lift cars: a plan's shafts stay closed rooms, its stairs serve every storey.

Features.kit('building', (engine, kit) => {
const { FloorPlan, sharedEdge } = engine.kits.interior;
const { PlanLibrary, coreLayout, furnishRoom, PARTITION } = kit;
const { mulberry32 } = engine.kits.noise;
const { GroundFrame } = engine.Common;
const EPS = 1e-4;
const LAMP = [1.0, 0.92, 0.78];

// a colour as a material of the world's (its name, added to `materials` once)
function colourMaterial(materials, col, finish) {
    const name = `plan:${col.map(v => v.toFixed(2)).join(',')}${finish ? ':' + finish : ''}`;
    materials[name] ??= { albedo: col, pattern: 'flat', scale: 1, spec: finish === 'metal' ? 0.5 : 0.1 };
    return name;
}

// The native additions for structure `def` (index i): { plan (a buildingPlan of lib), id, pos [x, z], y (its ground
// floor's height), yaw (degrees), name, storeys, w, d (what the plan leaves to its placement), materials { floor, wall,
// ceiling, exterior, roof, stair, frame } (the world's material names), vehicle (the id of the vehicle it stands on),
// lamps { intensity, radius }, ambient }. Returns { areas, portals, models, materials, entities }
function sectorStructure(lib, def, i) {
    const R = lib.resolve(def.plan, { name: def.name, storeys: def.storeys, w: def.w, d: def.d, type: def.type });
    const id = def.id || `structure${i}`, f = new GroundFrame(def.pos || [0, 0], (def.yaw ?? 0) * Math.PI / 180), y0 = def.y ?? 0;
    const A = R.archetype, M = { floor: 'tiles', wall: 'plaster', ceiling: 'panel', exterior: 'concrete', roof: 'roof', stair: 'concrete', ...def.materials };
    const out = { areas: [], portals: [], models: {}, materials: {}, entities: [] };
    const rnd = mulberry32(def.seed ?? i * 7919 + 31);
    const extra = { ...(def.vehicle ? { vehicle: def.vehicle } : {}) };
    const at = (x, y, z) => f.at(x, y, z), nrm = ([x, z]) => { const p = f.at(x, 0, z), o = f.at(0, 0, 0); return [p[0] - o[0], 0, p[2] - o[2]]; };
    const core = coreLayout({ ...R.core, banks: [] }, Math.max(...R.sections.map(s => s.H)));
    const area = (aid, name, r, y, h, mats = {}) => out.areas.push({ id: aid, name, shape: [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]].map(([x, z]) => f.xz(x, z)),
        y, height: h, ambient: def.ambient || A.light?.ambient || [0.012, 0.012, 0.015], materials: { floor: M.floor, wall: M.wall, ceiling: M.ceiling, exterior: M.exterior, roof: M.roof, ...mats },
        ...(def.vehicle ? { terrain: false, shellFrom: y } : {}) });
    const portal = (pid, x, yc, z, w, h, n, kind, more = {}) => out.portals.push({ id: pid, kind, center: at(x, yc, z), size: [w, h], normal: nrm(n), ...more });
    const lamp = (r, yy, L) => out.entities.push({ type: 'light', pos: at((r[0] + r[1]) / 2, yy, (r[2] + r[3]) / 2), color: L.color || LAMP, intensity: L.intensity ?? 1.2,
        radius: L.radius ?? Math.hypot(r[1] - r[0], r[3] - r[2]) / 2 + 1, ...(L.model ? { model: L.model } : {}), ...extra });
    let y = y0;
    const plans = {};
    const stairRuns = [];
    R.storeys.forEach(st => {
        const sec = R.sections[st.sec], H = sec.H, hx = sec.w / 2, hz = sec.d / 2, t = 0.05, W = { ...A.window, ...(sec.spec.window || {}) };
        const P = plans[`${st.key}|${st.sec}`] ??= new FloorPlan({ hx, hz, t, core, storey: st.plan, partition: PARTITION, seed: i * 31 + st.key.length });
        const [X0, X1, Z0, Z1] = P.inner, label = st.label, g = st.g, aid = (k, j) => `${id}/${g}/${k}/${j}`;
        // the rooms' areas, the openings between a room's own rectangles
        P.rooms.forEach((room, k) => {
            if (room.kind === 'stair' || room.kind === 'shaft') return;
            const rt = lib.room(room.kind);
            room.rects.forEach((r, j) => area(aid(k, j), `${R.name} ${label} · ${rt?.label || room.kind}`, r, y, H));
            for (let a = 0; a < room.rects.length; a++) for (let b = a + 1; b < room.rects.length; b++) {
                const e = sharedEdge(room.rects[a], room.rects[b]);
                if (!e) continue;
                const c = (e.a0 + e.a1) / 2, [x, z] = e.axis === 'x' ? [c, e.at] : [e.at, c];
                portal(`${aid(k, a)}-${b}`, x, y + H / 2, z, e.a1 - e.a0, H, e.axis === 'x' ? [0, 1] : [1, 0], 'opening', { passThrough: true, frame: false });
            }
            // windows along its façade, spread as the archetype's pitch has them; a lamp under its ceiling
            for (const r of room.rects) for (const [axis, atv, a0, a1, n] of [['x', r[2], r[0], r[1], [0, -1]], ['x', r[3], r[0], r[1], [0, 1]], ['z', r[0], r[2], r[3], [-1, 0]], ['z', r[1], r[2], r[3], [1, 0]]]) {
                if (axis === 'x' ? Math.abs(atv - (n[1] < 0 ? Z0 : Z1)) > EPS : Math.abs(atv - (n[0] < 0 ? X0 : X1)) > EPS) continue;
                const L = a1 - a0, nw = L < W.width + 0.5 ? 0 : Math.max(1, Math.round(L / W.pitch));
                for (let q = 0; q < nw; q++) {
                    const c = a0 + (q + 0.5) * L / nw, [x, z] = axis === 'x' ? [c, atv] : [atv, c];
                    portal(`${id}/${g}/w${k}.${q}.${axis}${atv.toFixed(1)}`, x, y + W.sill + W.height / 2, z, Math.min(W.width, L / nw - 0.4), W.height, n, 'window', { glass: true });
                }
            }
            // its lamp (the archetype's `light`, the placement's over it: { color, intensity, radius (m; default the
            // room's half diagonal + 1), model }), lit as its roomType's share says
            // (a corridor: one in each of its pieces bigger than a few m², each piece being an area of its own)
            const lit = rt?.lit ?? 1, L = { ...A.light, ...def.light };
            const lamps = room.kind === 'corridor' ? room.rects.filter(r => (r[1] - r[0]) * (r[3] - r[2]) > 4) : room.rects.slice(0, 1);
            if (rnd() < lit) for (const r0 of lamps) lamp(r0, y + H - 0.25, L);
        });
        // the doorways: rooms, corridors, the stair door, each with a door leaf as the archetype's `interiorDoor` says
        // (a door entity's keys: { auto, slide, mat, locked }; false or none: open doorways); not the lift landings
        for (const p of P.portals) {
            if (p.kind === 'lift') continue;
            const h = p.h || H - 0.05, [x, z] = p.axis === 'x' ? [p.c, p.at] : [p.at, p.c], pid = `${id}/${g}/p${p.a}.${p.b}`;
            portal(pid, x, y + h / 2, z, p.w, h, p.axis === 'x' ? [0, 1] : [1, 0], p.kind === 'opening' ? 'opening' : 'door', { frame: p.kind !== 'opening' });
            if (p.kind !== 'opening' && A.interiorDoor) out.entities.push({ type: 'door', portal: pid, auto: true, ...A.interiorDoor });
        }
        // the ground storey's entrances: where its plan's passages meet the façade (entrances), else the section's or the
        // placement's doors (one in the middle of the front by default), each an automatic door
        const ways = P.entrances.length ? P.entrances.map(e => ({ face: e.face, at: e.c, width: Math.min(A.door.width, e.w - 0.2) }))
            : sec.spec.doors || def.doors || [{ face: '-z', at: 0 }];
        if (g === 0) for (const [k, d] of ways.entries()) {
            const n = { '-z': [0, -1], '+z': [0, 1], '-x': [-1, 0], '+x': [1, 0] }[d.face], dw = d.width ?? A.door.width, dh = Math.min(d.height ?? A.door.height, H - 0.2);
            const [x, z] = d.face.endsWith('z') ? [d.at ?? 0, n[1] < 0 ? Z0 : Z1] : [n[0] < 0 ? X0 : X1, d.at ?? 0];
            const pid = `${id}/entrance${k}`;
            portal(pid, x, y + dh / 2, z, dw, dh, n, 'door');
            out.entities.push({ type: 'door', portal: pid, auto: true });
        }
        // the furniture of every room, one model per kind of storey (in the building's frame, over its floor)
        const mk = `${id}:furniture:${st.key}:${st.sec}`;
        if (!out.models[mk]) {
            const parts = out.models[mk] = [], fr = mulberry32(i * 977 + st.key.length * 13);
            P.rooms.forEach((room, k) => {
                const rt = lib.room(room.kind);
                if (!rt?.furniture) return;
                const keep = P.portalsOf(k).map(p => p.axis === 'x' ? [p.c - p.w / 2 - 0.35, p.c + p.w / 2 + 0.35, p.at - 1.3, p.at + 1.3] : [p.at - 1.3, p.at + 1.3, p.c - p.w / 2 - 0.35, p.c + p.w / 2 + 0.35]);
                for (const r of room.rects) furnishRoom(r, rt.furniture, lib, fr, (x0, x1, z0, z1, ya, yb, col, fin) =>
                    parts.push({ box: [(x0 + x1) / 2, (ya + yb) / 2, (z0 + z1) / 2, x1 - x0, yb - ya, z1 - z0], mat: colourMaterial(out.materials, col, fin) }), keep);
            });
        }
        if (out.models[mk].length) out.entities.push({ type: 'prop', model: mk, pos: at(0, y, 0), rot: -(def.yaw ?? 0), ...extra });
        if (core.stair && st.stairsUp) stairRuns.push({ y, H });
        y += H;
    });
    // the stairwell: one area up through every storey, its flights (switchbacks: up the first lane to the half landing,
    // back up the second), the landings and the wall between the lanes
    if (core.stair && R.G > 1) {
        // (flights, landings and the wall between the lanes a few cm in from the well's walls: nothing coplanar with them)
        const s = core.stair, [x0, x1, z0, z1] = s.rect.map((v, k) => v + (k % 2 ? -0.04 : 0.04)), lane = s.lane - 0.04, land = s.landing - 0.04, top = y;
        area(`${id}/stair`, `${R.name} stairwell`, s.rect, y0, top - y0, { floor: M.stair });
        const parts = out.models[`${id}:stairwell`] = [];
        const slab = (a0, a1, b0, b1, yy, th = 0.2) => parts.push({ box: [(a0 + a1) / 2, yy - th / 2, (b0 + b1) / 2, a1 - a0, th, b1 - b0], mat: M.stair });
        for (const { y: ys, H } of stairRuns) {
            const r = ys - y0, steps = Math.ceil(H / 2 / 0.18);
            out.entities.push({ type: 'stairs', from: at(x0 + lane / 2, ys + H / 2, z1 - land), to: at(x0 + lane / 2, ys, z0 + land), width: lane - 0.05, steps, mat: M.stair, ...extra });
            out.entities.push({ type: 'stairs', from: at(x1 - lane / 2, ys + H, z0 + land), to: at(x1 - lane / 2, ys + H / 2, z1 - land), width: lane - 0.05, steps, mat: M.stair, ...extra });
            slab(x0, x1, z1 - land, z1, r + H / 2);
            slab(x0, x1, z0, z0 + land, r + H);
            parts.push({ box: [(x0 + x1) / 2, r + H / 2, (z0 + z1) / 2, x1 - x0 - 2 * lane, H, z1 - z0 - 2 * land], mat: M.wall });
            // a lamp over each half landing
            lamp([x0, x1, z1 - land, z1], ys + H - 0.3, { ...A.light, ...def.light, radius: (def.light?.radius ?? A.light?.radius) ?? H * 1.2 });
            // its door at each storey onto the ring
        }
        out.entities.push({ type: 'prop', model: `${id}:stairwell`, pos: at(0, y0, 0), rot: -(def.yaw ?? 0), ...extra });
    }
    return out;
}

// scn (a sector world's native scenario) with its `structures` built in: their areas, portals, models, materials and
// entities appended to its own (from its `plans` and archetypes, `buildings`)
function withStructures(scn) {
    if (!scn.structures?.length) return scn;
    const lib = new PlanLibrary(scn.plans || {}, scn.buildings || {}), o = { ...scn, areas: [...(scn.areas || [])], portals: [...(scn.portals || [])],
        models: { ...(scn.models || {}) }, materials: { ...(scn.materials || {}) }, entities: [...(scn.entities || [])] };
    scn.structures.forEach((def, i) => {
        const s = sectorStructure(lib, def, i);
        o.areas.push(...s.areas);
        o.portals.push(...s.portals);
        Object.assign(o.models, s.models);
        for (const [k, v] of Object.entries(s.materials)) o.materials[k] ??= v;
        o.entities.push(...s.entities);
    });
    return o;
}

return { sectorStructure, withStructures };
});
