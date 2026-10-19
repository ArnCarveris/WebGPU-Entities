'use strict';
// ScenarioFormat: everything is an entity.
//
// A scenario is one flat list of entities: { name, group, description, entities: [ { type, id?, of?, ...fields } ] }.
// Every type is one of the kit manifest's (js/kits/manifest.js, Kits): an engine type, an entity type a kit implements,
// a data type a kit or world reads, or a world type. Engine entities (camera, view, link, include, hud.toast, handheld,
// handheld.page, sound.*) drive the host. A world is a root entity of a world type ({ type: "water", id: "river" });
// everything that world is made of is an entity of a plain type: terrain stamps, lakes, storm cells, materials,
// models, views, lighting presets, config blocks ({ type: "light" }, { type: "mountain" }). Such an entity belongs to
// the world named by `of`, or else to the only world of the scenario that takes its type (any world when there is
// only one). A world takes the entity types whose implementation's base it has and whose needs it provides, and the
// data types of its schema (Kits.implsIn). `camera` and `view` are the engine's unless they have `of` (then they
// are that world's camera block / one of its views).
//
// Any kit's entity works in any scenario: an entity no world of the scenario takes brings in a world that does (its
// implicit root: complete()), composed with the others; a scenario of plain entities needs no root at all.
//
// Each world still reads its own native layout (materials as a map, views as a list, ...). Its schema (the manifest's
// worlds.<type>.schema, SCHEMAS here) says how its entities map onto it, so toNative / fromNative convert both ways
// without per-world code:
//
//   config   singleton blocks: native key -> one entity of that type holding its fields (non-objects as `value`);
//            `rename` gives a block whose key is taken (a feature's name, an engine type) another type
//   maps     native map (dotted path for nested ones) -> one entity of `type` per key, the key as `id`
//            (non-object values as `value`, or as the field named by `value`); `except` keys stay in the config block
//   lists    native list -> one entity of that type per item, in order
//            (a map value's or list item's own `type` field is kept in the field named after its slot type:
//            a water tool { type: "pour" } is { type: "tool", tool: "pour" })
//   (entity types: the world's native `entities` list, each { type, ...fields })
//
// include { scenario, as, skip, only, root }: the entities of another scenario, spliced in its place (resolveIncludes).
// `as` renames its world (the root's id, `of` fields, and the world's name in the engine entities' expressions),
// `skip` / `only` filter by type ("view", "sound.*"), `root` merges fields into its root entity (layer settings).
// The included world's entities get its `of`. A composition is a few includes plus what joins them.

const ScenarioFormat = (() => {
    // js/kits/manifest.js: a script before this one in the page, a module in node
    const Types = typeof Kits !== 'undefined' ? Kits : require('../kits/manifest.js');

    // each world type's schema: { title, config, rename, maps, lists }
    const SCHEMAS = Object.fromEntries(Object.entries(Types.WORLDS).map(([type, w]) =>
        [type, { title: w.title || type, config: [], maps: {}, lists: {}, ...w.schema }]));

    // fields the engine adds to any entity; never passed to a feature engine
    const ENGINE_FIELDS = ['of', 'type', '$comment'];

    const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
    const setPath = (o, path, v) => {
        const ks = path.split('.'), last = ks.pop();
        let cur = o;
        for (const k of ks) cur = isObj(cur[k]) ? cur[k] : (cur[k] = {});
        cur[last] = v;
    };
    const deepMerge = (a, b) => {
        const o = { ...a };
        for (const [k, v] of Object.entries(b)) o[k] = isObj(o[k]) && isObj(v) ? deepMerge(o[k], v) : v;
        return o;
    };
    const strip = (e, more = []) => {
        const o = {};
        for (const [k, v] of Object.entries(e)) if (!ENGINE_FIELDS.includes(k) && !more.includes(k)) o[k] = v;
        return o;
    };

    // an item's native `type` lives in the field named after its slot (tag on import, untag on export)
    const tag = (item, slotType) => {
        if (!('type' in item)) return item;
        const { type, ...rest } = item;
        return { [slotType]: type, ...rest };
    };
    const untag = (body, slotType) => {
        if (!(slotType in body)) return body;
        const { [slotType]: type, ...rest } = body;
        return { type, ...rest };
    };

    // the types a world's entities may take: type -> { kind: config | map | list | entity, key / path }
    const slotCache = new Map();
    function slotTypes(feature) {
        if (slotCache.has(feature)) return slotCache.get(feature);
        const schema = SCHEMAS[feature], m = new Map();
        for (const k of schema.config) m.set(schema.rename?.[k] || k, { kind: 'config', key: k });
        for (const [path, spec] of Object.entries(schema.maps)) m.set(spec.type, { kind: 'map', path, spec });
        for (const [path, type] of Object.entries(schema.lists)) m.set(type, { kind: 'list', path });
        for (const k of Object.keys(Types.IMPLS)) {
            if (!Types.implsIn(feature, k).length) continue;
            if (m.has(k)) throw new Error(`${feature}: entity type "${k}" clashes with a schema slot`);
            m.set(k, { kind: 'entity' });
        }
        for (const t of m.keys()) {
            if (!Types.has(t)) throw new Error(`${feature}: type "${t}" is not in js/kits/manifest.js`);
            if (SCHEMAS[t]) throw new Error(`${feature}: type "${t}" is a world type`);
        }
        slotCache.set(feature, m);
        return m;
    }
    const takes = (feature, type) => slotTypes(feature).has(type);

    // an engine entity: hud.* / sound.* / an engine type of js/kits/manifest.js, but `camera` / `view` only without `of`
    const isEngine = e => typeof e.type === 'string' && (/^(hud|sound)\./.test(e.type) || Types.isEngine(e.type)) &&
        !(e.of && (e.type === 'camera' || e.type === 'view'));
    // an entity that belongs to a world
    const isChild = e => typeof e.type === 'string' && !SCHEMAS[e.type] && !isEngine(e);

    // the world roots of a scenario: [{ feature (its world type), id, def }]
    function roots(scenario) {
        return (scenario.entities || []).filter(e => SCHEMAS[e.type]).map(def => ({ feature: def.type, id: def.id || def.type, def }));
    }

    // the world an entity belongs to: its `of`, the only world that takes its type, or the only world
    function worldOf(e, all) {
        const where = e.of ? ` (of "${e.of}")` : '';
        if (!Types.has(e.type)) {
            const dot = e.type.indexOf('.'), kind = e.type.slice(dot + 1);
            const hint = dot > 0 && SCHEMAS[e.type.slice(0, dot)] && Types.has(kind) ? `: write it as "${kind}"` : ' (js/kits/manifest.js)';
            throw new Error(`unknown entity type "${e.type}"${where}${hint}`);
        }
        if (e.of) {
            const r = all.find(r => r.id === e.of);
            if (!r) throw new Error(`${e.type}: no world "${e.of}" (worlds: ${all.map(r => r.id).join(', ')})`);
            return r;
        }
        const fit = all.filter(r => takes(r.feature, e.type));
        if (fit.length === 1) return fit[0];
        if (fit.length > 1) throw new Error(`${e.type}: several worlds take it (${fit.map(r => r.id).join(', ')}), say which with "of"`);
        if (all.length === 1) return all[0];
        throw new Error(`${e.type}: no world of this scenario takes it`);
    }

    // the entities of one world, in scenario order
    function childrenOf(scenario, root) {
        const all = roots(scenario);
        return (scenario.entities || []).filter(e => isChild(e) && worldOf(e, all).id === root.id);
    }

    // a world's entities -> the native scenario object that world reads
    function toNative(scenario, root) {
        if (!SCHEMAS[root.feature]) throw new Error(`unknown world type "${root.feature}"`);
        const slots = slotTypes(root.feature);
        const native = { name: root.def.name || scenario.name || root.id };
        const entities = [];
        for (const e of childrenOf(scenario, root)) {
            const type = e.type, slot = slots.get(type);
            if (!slot) throw new Error(`${root.id}: a ${root.feature} world takes no "${type}"`);
            if (slot.kind === 'entity') { entities.push({ type, ...strip(e) }); continue; }
            if (slot.kind === 'config') {
                const body = 'value' in e && Object.keys(strip(e)).length === 1 ? e.value : untag(strip(e), type);
                const prev = native[slot.key];
                native[slot.key] = isObj(prev) && isObj(body) ? { ...prev, ...body } : body;
            } else if (slot.kind === 'map') {
                const key = e.id;
                if (key === undefined) throw new Error(`${type} needs an id (its key in "${slot.path}")`);
                const vk = slot.spec.value || 'value', body = untag(strip(e, ['id']), type);
                const value = vk in body && Object.keys(body).length === 1 ? body[vk] : body;
                let map = getPath(native, slot.path);
                if (!isObj(map)) { map = {}; setPath(native, slot.path, map); }
                // a later entity with the same id overrides the earlier one key by key (a scenario's archetype over the
                // plan library's it includes)
                map[key] = isObj(map[key]) && isObj(value) ? deepMerge(map[key], value) : value;
            } else {
                let list = getPath(native, slot.path);
                if (!Array.isArray(list)) { list = []; setPath(native, slot.path, list); }
                list.push(untag(strip(e), type));
            }
        }
        native.entities = entities;
        return native;
    }

    // the kits a world's entities need (each type's implementation's kit), beyond the world's own
    function kitsOf(scenario, root) {
        return [...new Set(childrenOf(scenario, root).flatMap(e => Types.kitsFor(root.feature, e.type)))];
    }

    // the features of its kit a world's data asks for (Kits.featuresOf: its entities' types, its native data, its root's
    // `features` overrides)
    function featuresOf(scenario, root) {
        const types = [...new Set(childrenOf(scenario, root).map(e => e.type))];
        return Types.featuresOf(root.feature, toNative(scenario, root), types, root.def.features || {});
    }

    // Implicit roots: the entities that no world of the scenario takes (and name none with `of`) bring in worlds that
    // take them: first the world type that takes the most of them (on a tie one that says how it joins a scenario, its
    // `implicit`, then the manifest's order), then for what is left, and so on. Each new root goes first, id = its type,
    // and the entities it was brought in for name it (`of`), as do its implicit entities (its defaults: a sky's ground)
    // of a type the scenario gives it none of. With other worlds a new one joins them as its `implicit.root` says
    // (fields merged into its root: a sky's layer role); alone it is the scenario's world as it is.
    function complete(scenario) {
        const ents = scenario.entities || [], have = roots(scenario);
        // a data type of no world here goes to the only world, which reads what it wants of it (worldOf), as before
        let left = ents.filter(e => isChild(e) && !e.of && Types.has(e.type) && !have.some(r => takes(r.feature, e.type)) &&
            !(have.length === 1 && !(e.type in Types.IMPLS)));
        const add = [], via = new Map();
        while (left.length) {
            const score = w => left.filter(e => takes(w, e.type)).length;
            const best = Object.keys(SCHEMAS).map((w, k) => ({ w, k, n: score(w), imp: !!Types.WORLDS[w].implicit }))
                .filter(c => c.n).sort((a, b) => b.n - a.n || b.imp - a.imp || a.k - b.k)[0];
            if (!best) break;           // taken by no world at all: worldOf says so
            const id = have.some(r => r.id === best.w) || add.some(r => r.id === best.w) ? `${best.w}${add.length + 1}` : best.w;
            add.push({ type: best.w, id });
            for (const e of left.filter(e => takes(best.w, e.type))) via.set(e, id);
            left = left.filter(e => !via.has(e));
        }
        if (!add.length) return scenario;
        const many = have.length + add.length > 1, out = [];
        for (const r of add) {
            const imp = Types.WORLDS[r.type].implicit || {};
            out.push(many ? { ...r, ...(imp.root || {}) } : r);
            const given = new Set(ents.filter(e => via.get(e) === r.id).map(e => e.type));
            for (const e of imp.entities || []) if (!given.has(e.type)) out.push({ ...e, of: r.id });
        }
        return { ...scenario, entities: [...out, ...ents.map(e => (via.has(e) ? { ...e, of: via.get(e) } : e))] };
    }

    // a world's native scenario -> entities (the root first); used to import scenarios made for the single demos
    function fromNative(feature, native, id = feature) {
        const schema = SCHEMAS[feature];
        if (!schema) throw new Error(`unknown world type "${feature}"`);
        const slots = slotTypes(feature);
        const root = { type: feature };
        if (id !== feature) root.id = id;
        if (native.name) root.name = native.name;
        const out = [root];
        // `of` when the world is renamed, and on camera / view (else they are the engine's)
        const ent = (type, body) => ({ type, ...(id !== feature || Types.isEngine(type) ? { of: id } : {}), ...body });
        const known = new Set(['name', 'entities', ...schema.config, ...Object.keys(schema.lists), ...Object.keys(schema.maps).map(p => p.split('.')[0])]);
        for (const k of Object.keys(native)) if (!known.has(k)) throw new Error(`${feature}: native key "${k}" is not in its schema`);
        // config blocks, without the parts that are maps of their own
        for (const k of schema.config) {
            if (!(k in native)) continue;
            const type = schema.rename?.[k] || k;
            let v = native[k];
            if (isObj(v)) {
                v = { ...v };
                for (const [path, spec] of Object.entries(schema.maps)) {
                    if (path === k) for (const key of Object.keys(v)) { if (!(spec.except || []).includes(key)) delete v[key]; }
                    else if (path.startsWith(k + '.')) delete v[path.slice(k.length + 1)];
                }
                if (!Object.keys(v).length) continue;
                out.push(ent(type, tag(v, type)));
            } else out.push(ent(type, { value: v }));
        }
        for (const [path, spec] of Object.entries(schema.maps)) {
            const map = getPath(native, path);
            if (!isObj(map)) continue;
            for (const [key, v] of Object.entries(map)) {
                if ((spec.except || []).includes(key)) continue;
                out.push(isObj(v) ? ent(spec.type, { id: key, ...tag(v, spec.type) }) : ent(spec.type, { id: key, [spec.value || 'value']: v }));
            }
        }
        for (const [path, type] of Object.entries(schema.lists)) {
            for (const item of getPath(native, path) || []) out.push(ent(type, tag(item, type)));
        }
        for (const e of native.entities || []) {
            const { type, ...rest } = e;
            if (slots.get(type)?.kind !== 'entity') throw new Error(`${feature}: native entity type "${type}" is not one it takes`);
            out.push(ent(type, rest));
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------- includes
    const glob = pat => new RegExp(`^${pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const rename = (v, from, to) => {
        if (typeof v === 'string') return v === from ? to : v.replace(new RegExp(`(^|[^\\w.$'"])${from}(?=\\s*[.\\[])`, 'g'), `$1${to}`);
        if (Array.isArray(v)) return v.map(x => rename(x, from, to));
        if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x, from, to)]));
        return v;
    };

    // splices every include entity's scenario in its place; load(id) -> scenario (a promise)
    async function resolveIncludes(scenario, load, depth = 0) {
        if (depth > 8) throw new Error('include: nested too deep');
        const out = [];
        for (const e of scenario.entities || []) {
            if (e.type !== 'include') { out.push(e); continue; }
            const inc = await resolveIncludes(await load(e.scenario), load, depth + 1);
            const skip = [].concat(e.skip || []).map(glob), only = e.only ? [].concat(e.only).map(glob) : null;
            const keep = x => typeof x.type !== 'string' ? !e.only : !skip.some(r => r.test(x.type)) && (!only || only.some(r => r.test(x.type)) || !!SCHEMAS[x.type]);
            const root = roots(inc)[0];
            const from = root ? root.id : null, to = e.as || from;
            for (let x of inc.entities) {
                if (!keep(x)) continue;
                if (from && to !== from) {
                    if (SCHEMAS[x.type] && (x.id || x.type) === from) x = { ...x, id: to };
                    else if (x.of === from) x = { ...x, of: to };
                    if (isEngine(x)) x = rename(x, from, to);
                }
                if (e.root && SCHEMAS[x.type] && x.id === to) x = { ...x, ...e.root, layer: { ...(x.layer || {}), ...(e.root.layer || {}) } };
                // a world's entities name it: the scenario it goes into may have other worlds that take their types
                if (to && isChild(x) && !x.of) x = { ...x, of: to };
                out.push(x);
            }
        }
        const done = { ...scenario, entities: out };
        return depth ? done : complete(done);
    }

    return { SCHEMAS, roots, childrenOf, worldOf, isEngine, takes, kitsOf, featuresOf, complete, toNative, fromNative, resolveIncludes, isObj };
})();

if (typeof module !== 'undefined') module.exports = ScenarioFormat;
