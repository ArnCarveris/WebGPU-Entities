'use strict';
// PlanLibrary: a world's floor plans (data: scenarios/plans/, included by the scenarios that build from them) and its
// building archetypes, and a buildingPlan resolved into what a world builds: its sections, their storeys, its core, its
// lifts and their stops.

Features.kit('building', (engine, kit) => {
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b || {})) o[k] = isObj(o[k]) && isObj(v) ? merge(o[k], v) : v;
    return o;
};

// an archetype's keys when it leaves them out (a plain house, one storey of it to a room)
const ARCHETYPE = {
    storeyHeight: 3, plinth: 0.3, wall: 0.25, slab: 0.25, partition: 0.12, window: { width: 1.2, height: 1.4, sill: 0.9, pitch: 3.4 },
    door: { width: 1.0, height: 2.1, color: 'door' }, stairs: { width: 1.0 }, lamps: 0.5, porch: 0, shelter: true,
    inner: [0.82, 0.8, 0.76], floorColor: [0.4, 0.4, 0.4], ceiling: [0.9, 0.9, 0.88],
};
// a lift kind's motion when its plan leaves it out (m/s, m/s^2, s)
const LIFT_KIND = { local: { speed: 4, accel: 1.2, door: 1.6, dwell: 4 }, express: { speed: 20, accel: 2.0, door: 2.0, dwell: 6 } };

// "{building} zone {zone}" with vars
const fill = (s, vars) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// The plans a world has (its native `plans`: { buildings, storeys, cores, rooms, furniture, furnishings }, each by id)
// and its archetypes (native `buildings`, by id)
class PlanLibrary {
    constructor(plans = {}, archetypes = {}) {
        this.plans = { buildings: {}, storeys: {}, cores: {}, rooms: {}, furniture: {}, furnishings: {}, ...plans };
        this.archetypes = archetypes;
    }

    // archetype id with spec's keys over it (nested objects key by key)
    archetype(id, spec = {}) {
        const a = this.archetypes[id] || this.archetypes.house || {};
        return merge(merge(ARCHETYPE, a), spec);
    }

    storey(id) {
        const s = this.plans.storeys[id];
        if (!s) throw new Error(`no storeyPlan "${id}" (scenarios/plans/)`);
        return { id, ...s };
    }

    core(id) {
        const c = this.plans.cores[id];
        if (!c) throw new Error(`no corePlan "${id}" (scenarios/plans/)`);
        return { id, ...c };
    }

    room(kind) { return this.plans.rooms[kind] || null; }
    item(name) { return this.plans.furniture[name] || null; }
    furnishing(id) { return this.plans.furnishings[id]?.storeys || []; }
    has(id) { return !!this.plans.buildings[id]; }

    // buildingPlan `id` for a building placed with `spec` ({ name, w, d (m), storeys (what a "*" repeat fills to),
    // type (archetype), and any archetype key }). Returns:
    //   { id, name, archetype (merged), core (its corePlan), sections: [{ index, w, d, H, n, g0, spec (the section's
    //   own archetype keys: window, doors, roof...) }], storeys: [{ g, sec, s (in its section), plan (storeyPlan), tags
    //   (Set), zone, label, stairsUp }], G, zones, lifts: [{ kind, group, name, bank, shaft (index in its bank),
    //   stops (storey numbers), motion { speed, accel, door, dwell } }], crown, ground (label of storey 0) }
    resolve(id, spec = {}) {
        const P = this.plans.buildings[id];
        if (!P) throw new Error(`no buildingPlan "${id}" (scenarios/plans/)`);
        const name = spec.name || P.name || id, A = this.archetype(spec.type || P.archetype, spec);
        const total = spec.storeys ?? null;
        // the storey entries, repeats expanded: { plan, tags, label, zone }
        const expand = (entries, fixed) => {
            const out = [];
            for (const e of entries || []) {
                if (e.of) { for (let i = 0; i < (e.repeat ?? 1); i++) out.push(...expand(e.of, fixed)); continue; }
                const n = e.repeat === '*' ? Math.max(0, (total ?? 1) - fixed) : e.repeat ?? 1;
                for (let i = 0; i < n; i++) out.push({ plan: e.plan, tags: e.tags || [], label: e.label, zone: !!e.zone && i === 0 });
            }
            return out;
        };
        const count = entries => (entries || []).reduce((n, e) => n + (e.of ? (e.repeat ?? 1) * count(e.of) : e.repeat === '*' ? 0 : e.repeat ?? 1), 0);
        const allFixed = (P.sections || []).reduce((n, s) => n + count(s.storeys), 0);
        const sections = [], storeys = [];
        let zone = 1;
        for (const [k, sec] of (P.sections || []).entries()) {
            const list = expand(sec.storeys, allFixed), g0 = storeys.length;
            const S = { index: k, id: sec.id || `section ${k + 1}`, w: sec.width ?? spec.w, d: sec.depth ?? sec.width ?? spec.d, H: sec.storeyHeight ?? A.storeyHeight,
                n: list.length, g0, spec: Object.fromEntries(Object.entries(sec).filter(([key]) => !['id', 'width', 'depth', 'storeyHeight', 'storeys'].includes(key))) };
            if (!S.n) continue;
            sections.push(S);
            list.forEach((e, s) => {
                const g = g0 + s;
                if (e.zone && g > 0) zone++;
                const plan = this.storey(e.plan);
                storeys.push({ g, sec: sections.length - 1, s, plan, key: e.plan, tags: new Set(e.tags), zone,
                    label: e.label ? fill(e.label, { zone, sky: zone - 1, g }) : g === 0 ? (P.ground ?? 'G') : String(g) });
            });
        }
        const G = storeys.length;
        for (const st of storeys) st.stairsUp = st.plan.stairs !== false && st.g < G - 1;
        // the lifts: each shaft of a bank one car per group (a zoned group: one per zone, in the same shaft, one zone above
        // the next), stopping at the storeys with any of its tags (of its zone); a group needs two stops
        const core = this.core(P.core);
        const lifts = [];
        const letter = i => 'ABCDEFGH'[i] || String(i + 1);
        for (const L of P.lifts || []) {
            const bank = core.banks?.[L.bank];
            if (!bank?.shafts) continue;
            const motion = { ...LIFT_KIND[L.kind] || LIFT_KIND.local, ...Object.fromEntries(['speed', 'accel', 'door', 'dwell'].filter(k => L[k] !== undefined).map(k => [k, L[k]])) };
            const has = st => (L.stops || ['stop']).some(t => st.tags.has(t));
            const groups = L.zoned ? [...new Set(storeys.map(s => s.zone))].map(z => ({ zone: z, stops: storeys.filter(s => s.zone === z && has(s)).map(s => s.g) }))
                : [{ zone: 0, stops: storeys.filter(has).map(s => s.g) }];
            for (const gr of groups) {
                if (gr.stops.length < 2) continue;
                for (let i = 0; i < bank.shafts; i++) {
                    const vars = { building: name, zone: gr.zone, sky: gr.zone - 1, n: i + 1, letter: letter(i) };
                    lifts.push({ kind: L.kind || 'local', group: fill(L.group || '{building}', vars), name: fill(L.name || '{building} lift {n}', vars),
                        bank: L.bank, shaft: i, zone: gr.zone, stops: gr.stops, motion });
                }
            }
        }
        return { id, name, archetype: A, core, sections, storeys, G, zones: zone, lifts, crown: P.crown || null, ground: P.ground ?? 'G', plan: P };
    }
}

return { PlanLibrary, ARCHETYPE, mergeDeep: merge, fillTemplate: fill };
});
