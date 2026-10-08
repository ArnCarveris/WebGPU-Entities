'use strict';
// ScenarioFormat: everything is an entity.
//
// A scenario is one flat list of entities: { name, group, description, entities: [ { type, id?, of?, ...fields } ] }.
// Every type is one of js/kits/types.js (EntityTypes): types are the kits', not the features'. Engine entities
// (camera, view, link, include, hud.toast, handheld, handheld.page, sound.*) drive the host. A feature world is a root
// entity whose type is the feature's name ({ type: "water", id: "river" }); everything that world is made of is an
// entity of a plain type: terrain stamps, lakes, storm cells, materials, models, views, lighting presets, config
// blocks ({ type: "light" }, { type: "mountain" }). Such an entity belongs to the world named by `of`, or else to the
// only world of the scenario that takes its type (any world when there is only one). `camera` and `view` are the
// engine's unless they have `of` (then they are that world's camera block / one of its views).
//
// Each feature engine still reads its own native layout (materials as a map, views as a list, ...). SCHEMAS says
// how a feature's entities map onto it, so toNative / fromNative convert both ways without per-feature code:
//
//   config   singleton blocks: native key -> one entity of that type holding its fields (non-objects as `value`);
//            `rename` gives a block whose key is taken (a feature's name, an engine type) another type
//   maps     native map (dotted path for nested ones) -> one entity of `type` per key, the key as `id`
//            (non-object values as `value`, or as the field named by `value`); `except` keys stay in the config block
//   lists    native list -> one entity of that type per item, in order
//            (a map value's or list item's own `type` field is kept in the field named after its slot type:
//            a water tool { type: "pour" } is { type: "tool", tool: "pour" })
//   kinds    the feature's own entity classes (its native `entities` list)
//
// include { scenario, as, skip, only, root }: the entities of another scenario, spliced in its place (resolveIncludes).
// `as` renames its world (the root's id, `of` fields, and the world's name in the engine entities' expressions),
// `skip` / `only` filter by type ("view", "sound.*"), `root` merges fields into its root entity (layer settings).
// The included world's entities get its `of`. A composition is a few includes plus what joins them.

const ScenarioFormat = (() => {
    // js/kits/types.js: a script before this one in the page, a module in node
    const Types = typeof EntityTypes !== 'undefined' ? EntityTypes : require('../kits/types.js');

    const SCHEMAS = {
        cloud: {
            title: 'Entity Cloud',
            config: ['terrain', 'render', 'weather', 'lighting', 'hurricane', 'streetLights'],
            maps: { 'weather.states': { type: 'weatherState' }, 'lighting.presets': { type: 'light' }, buildings: { type: 'building' } },
            lists: { clouds: 'cloudLayer', views: 'view' },
            kinds: ['clearing', 'tilt', 'hills', 'mountain', 'range', 'river', 'lake', 'town', 'forest', 'village', 'busStation', 'bus',
                'storm', 'supercell', 'squall', 'spawner'],
        },
        water: {
            title: 'Entity Water',
            config: ['terrain', 'sim', 'waves', 'water', 'lighting'],
            rename: { water: 'waterShading' },
            maps: { lighting: { type: 'light', except: ['start'] } },
            lists: { tools: 'tool', views: 'view' },
            kinds: ['tilt', 'hills', 'mountain', 'valley', 'basin', 'coast', 'dam', 'sea', 'lake', 'spring', 'drain', 'rain', 'debris'],
        },
        origin: {
            title: 'Entity Origin',
            config: ['start', 'camera', 'origin', 'lighting'],
            rename: { origin: 'floatingOrigin' },
            maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
            lists: { bookmarks: 'bookmark' },
            kinds: ['body', 'prop', 'field', 'orbiter'],
        },
        imposter: {
            title: 'Entity Imposter',
            config: ['camera', 'environment', 'lod', 'shadows', 'imposter', 'drop'],
            rename: { imposter: 'imposterAtlas' },
            maps: { lighting: { type: 'light' }, materials: { type: 'material' }, models: { type: 'model' } },
            lists: {},
            kinds: ['terrain', 'prop', 'compare', 'scatter'],
        },
        portal: {
            title: 'Entity Portal',
            config: ['camera', 'player', 'minimap', 'outdoor', 'cctv', 'media', 'iptv'],
            maps: { materials: { type: 'material' }, models: { type: 'model' } },
            lists: { areas: 'area', portals: 'visPortal', occluders: 'occluder', vehicles: 'vehicle' },
            kinds: ['securityCamera', 'prop', 'light', 'stairs', 'hull', 'helm', 'door', 'drone'],
        },
        gui: {
            title: 'Entity GUI',
            config: ['player', 'facility', 'cctv', 'media', 'iptv', 'waves', 'radar', 'places', 'phone'],
            maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
            lists: {},
            kinds: ['static', 'door', 'lamp', 'alarmBeacon', 'light', 'drone', 'securityCamera', 'avatar', 'terminal', 'easel'],
        },
    };

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

    // the types a feature's entities may take: type -> { kind: config | map | list | entity, key / path }
    const slotCache = new Map();
    function slotTypes(feature) {
        if (slotCache.has(feature)) return slotCache.get(feature);
        const schema = SCHEMAS[feature], m = new Map();
        for (const k of schema.config) m.set(schema.rename?.[k] || k, { kind: 'config', key: k });
        for (const [path, spec] of Object.entries(schema.maps)) m.set(spec.type, { kind: 'map', path, spec });
        for (const [path, type] of Object.entries(schema.lists)) m.set(type, { kind: 'list', path });
        for (const k of schema.kinds || []) {
            if (m.has(k)) throw new Error(`${feature}: entity class "${k}" clashes with a schema slot`);
            m.set(k, { kind: 'entity' });
        }
        for (const t of m.keys()) {
            if (!Types.has(t)) throw new Error(`${feature}: type "${t}" is not in js/kits/types.js`);
            if (SCHEMAS[t]) throw new Error(`${feature}: type "${t}" is a feature's name`);
        }
        slotCache.set(feature, m);
        return m;
    }
    const takes = (feature, type) => slotTypes(feature).has(type);

    // an engine entity: hud.* / sound.* / an engine type of js/kits/types.js, but `camera` / `view` only without `of`
    const isEngine = e => typeof e.type === 'string' && (/^(hud|sound)\./.test(e.type) || Types.isEngine(e.type)) &&
        !(e.of && (e.type === 'camera' || e.type === 'view'));
    // an entity that belongs to a feature world
    const isChild = e => typeof e.type === 'string' && !SCHEMAS[e.type] && !isEngine(e);

    // the feature roots of a scenario: [{ feature, id, def }]
    function roots(scenario) {
        return (scenario.entities || []).filter(e => SCHEMAS[e.type]).map(def => ({ feature: def.type, id: def.id || def.type, def }));
    }

    // the world an entity belongs to: its `of`, the only world that takes its type, or the only world
    function worldOf(e, all) {
        const where = e.of ? ` (of "${e.of}")` : '';
        if (!Types.has(e.type)) {
            const dot = e.type.indexOf('.'), kind = e.type.slice(dot + 1);
            const hint = dot > 0 && SCHEMAS[e.type.slice(0, dot)] && Types.has(kind) ? `: write it as "${kind}"` : ' (js/kits/types.js)';
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

    // the entities of one feature world, in scenario order
    function childrenOf(scenario, root) {
        const all = roots(scenario);
        return (scenario.entities || []).filter(e => isChild(e) && worldOf(e, all).id === root.id);
    }

    // feature entities -> the native scenario object that feature's engine reads
    function toNative(scenario, root) {
        if (!SCHEMAS[root.feature]) throw new Error(`unknown feature "${root.feature}"`);
        const slots = slotTypes(root.feature);
        const native = { name: root.def.name || scenario.name || root.id };
        const entities = [];
        for (const e of childrenOf(scenario, root)) {
            const type = e.type, slot = slots.get(type);
            if (!slot) throw new Error(`${root.id}: ${root.feature} has no "${type}"`);
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
                map[key] = value;
            } else {
                let list = getPath(native, slot.path);
                if (!Array.isArray(list)) { list = []; setPath(native, slot.path, list); }
                list.push(untag(strip(e), type));
            }
        }
        native.entities = entities;
        return native;
    }

    // a feature's native scenario -> entities (the root first); used to import scenarios made for the single demos
    function fromNative(feature, native, id = feature) {
        const schema = SCHEMAS[feature];
        if (!schema) throw new Error(`unknown feature "${feature}"`);
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
            if (slots.get(type)?.kind !== 'entity') throw new Error(`${feature}: native entity type "${type}" is not one of its kinds`);
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
        return { ...scenario, entities: out };
    }

    return { SCHEMAS, roots, childrenOf, worldOf, isEngine, takes, toNative, fromNative, resolveIncludes, isObj };
})();

if (typeof module !== 'undefined') module.exports = ScenarioFormat;
