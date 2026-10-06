'use strict';
// ScenarioFormat: everything is an entity.
//
// A scenario is one flat list of entities: { name, group, description, entities: [ { type, id?, ...fields } ] }.
// Engine entities have plain types (camera, layer settings live on feature roots, hud.toast, handheld, handheld.page,
// sound.*, link). A feature
// world is a root entity whose type is the feature's name ({ type: "water", id: "river" }); everything that world
// is made of is an entity of type "<feature>.<kind>": terrain stamps, lakes, storm cells, materials, models,
// views, lighting presets, config blocks. Children belong to the only world of their feature, or to the one named
// by `of` when a scenario has several.
//
// Each feature engine still reads its own native layout (materials as a map, views as a list, ...). SCHEMAS says
// how a feature's entities map onto it, so toNative / fromNative convert both ways without per-feature code:
//
//   config   singleton blocks: native key -> one "<f>.<key>" entity holding its fields (non-objects as `value`)
//   maps     native map (dotted path for nested ones) -> one "<f>.<type>" entity per key, the key as `id`
//            (non-object values as `value`, or as the field named by `value`); `except` keys stay in the config block
//   lists    native list -> one "<f>.<type>" entity per item, in order
//            (a map value's or list item's own `type` field is kept in the field named after its slot type:
//            a water tool { type: "pour" } is { type: "water.tool", tool: "pour" })
//   (rest)   native `entities` list: "<f>.<native type>"
//
// include { scenario, as, skip, only, root }: the entities of another scenario, spliced in its place (resolveIncludes).
// `as` renames its world (the root's id, `of` fields, and the world's name in the engine entities' expressions),
// `skip` / `only` filter by type ("cloud.view", "sound.*"), `root` merges fields into its root entity (layer settings).
// A composition is a few includes plus what joins them.

const ScenarioFormat = (() => {
    const SCHEMAS = {
        cloud: {
            title: 'Entity Cloud',
            config: ['terrain', 'render', 'weather', 'lighting', 'hurricane', 'streetLights'],
            maps: { 'weather.states': { type: 'weatherState' }, 'lighting.presets': { type: 'light' }, buildings: { type: 'building' } },
            lists: { clouds: 'cloudLayer', views: 'view' },
        },
        water: {
            title: 'Entity Water',
            config: ['terrain', 'sim', 'waves', 'water', 'lighting'],
            maps: { lighting: { type: 'light', except: ['start'] } },
            lists: { tools: 'tool', views: 'view' },
        },
        origin: {
            title: 'Entity Origin',
            config: ['start', 'camera', 'origin', 'lighting'],
            maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
            lists: { bookmarks: 'bookmark' },
        },
        imposter: {
            title: 'Entity Imposter',
            config: ['camera', 'environment', 'lod', 'shadows', 'imposter', 'drop'],
            maps: { lighting: { type: 'light' }, materials: { type: 'material' }, models: { type: 'model' } },
            lists: {},
        },
        portal: {
            title: 'Entity Portal',
            config: ['camera', 'player', 'minimap', 'outdoor'],
            maps: { materials: { type: 'material' }, models: { type: 'model' } },
            lists: { areas: 'area', portals: 'portal', occluders: 'occluder', vehicles: 'vehicle' },
        },
        gui: {
            title: 'Entity GUI',
            config: ['player', 'facility', 'cctv', 'media', 'iptv', 'waves', 'radar', 'places', 'phone'],
            maps: { materials: { type: 'material' }, models: { type: 'model', value: 'parts' } },
            lists: {},
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

    // type names a feature's entities may take besides its native entity types
    function slotTypes(schema) {
        const m = new Map();
        for (const k of schema.config) m.set(k, { kind: 'config', key: k });
        for (const [path, spec] of Object.entries(schema.maps)) m.set(spec.type, { kind: 'map', path, spec });
        for (const [path, type] of Object.entries(schema.lists)) m.set(type, { kind: 'list', path });
        return m;
    }

    // the feature roots of a scenario: [{ feature, id, def }]
    function roots(scenario) {
        return (scenario.entities || []).filter(e => SCHEMAS[e.type]).map(def => ({ feature: def.type, id: def.id || def.type, def }));
    }

    // the entities of one feature world, in scenario order
    function childrenOf(scenario, root) {
        const all = roots(scenario), same = all.filter(r => r.feature === root.feature);
        const prefix = root.feature + '.';
        return (scenario.entities || []).filter(e => typeof e.type === 'string' && e.type.startsWith(prefix) &&
            (e.of ? e.of === root.id : same.length === 1 || same[0].id === root.id));
    }

    // feature entities -> the native scenario object that feature's engine reads
    function toNative(scenario, root) {
        const schema = SCHEMAS[root.feature];
        if (!schema) throw new Error(`unknown feature "${root.feature}"`);
        const slots = slotTypes(schema), prefix = root.feature + '.';
        const native = { name: root.def.name || scenario.name || root.id };
        const entities = [];
        for (const e of childrenOf(scenario, root)) {
            const kind = e.type.slice(prefix.length), slot = slots.get(kind);
            if (!slot) { entities.push({ type: kind, ...strip(e) }); continue; }
            if (slot.kind === 'config') {
                const body = 'value' in e && Object.keys(strip(e)).length === 1 ? e.value : untag(strip(e), kind);
                const prev = native[kind];
                native[kind] = isObj(prev) && isObj(body) ? { ...prev, ...body } : body;
            } else if (slot.kind === 'map') {
                const key = e.id;
                if (key === undefined) throw new Error(`${e.type} needs an id (its key in "${slot.path}")`);
                const vk = slot.spec.value || 'value', body = untag(strip(e, ['id']), kind);
                const value = vk in body && Object.keys(body).length === 1 ? body[vk] : body;
                let map = getPath(native, slot.path);
                if (!isObj(map)) { map = {}; setPath(native, slot.path, map); }
                map[key] = value;
            } else {
                let list = getPath(native, slot.path);
                if (!Array.isArray(list)) { list = []; setPath(native, slot.path, list); }
                list.push(untag(strip(e), kind));
            }
        }
        native.entities = entities;
        return native;
    }

    // a feature's native scenario -> entities (the root first); used to import scenarios made for the single demos
    function fromNative(feature, native, id = feature) {
        const schema = SCHEMAS[feature];
        if (!schema) throw new Error(`unknown feature "${feature}"`);
        const slots = slotTypes(schema), prefix = feature + '.';
        const root = { type: feature };
        if (id !== feature) root.id = id;
        if (native.name) root.name = native.name;
        const out = [root];
        const of = id !== feature ? { of: id } : {};
        const known = new Set(['name', 'entities', ...schema.config, ...Object.keys(schema.lists), ...Object.keys(schema.maps).map(p => p.split('.')[0])]);
        for (const k of Object.keys(native)) if (!known.has(k)) throw new Error(`${feature}: native key "${k}" is not in its schema`);
        // config blocks, without the parts that are maps of their own
        for (const k of schema.config) {
            if (!(k in native)) continue;
            let v = native[k];
            if (isObj(v)) {
                v = { ...v };
                for (const [path, spec] of Object.entries(schema.maps)) {
                    if (path === k) for (const key of Object.keys(v)) { if (!(spec.except || []).includes(key)) delete v[key]; }
                    else if (path.startsWith(k + '.')) delete v[path.slice(k.length + 1)];
                }
                if (!Object.keys(v).length) continue;
                out.push({ type: prefix + k, ...of, ...tag(v, k) });
            } else out.push({ type: prefix + k, ...of, value: v });
        }
        for (const [path, spec] of Object.entries(schema.maps)) {
            const map = getPath(native, path);
            if (!isObj(map)) continue;
            for (const [key, v] of Object.entries(map)) {
                if ((spec.except || []).includes(key)) continue;
                out.push(isObj(v) ? { type: prefix + spec.type, id: key, ...of, ...tag(v, spec.type) } : { type: prefix + spec.type, id: key, ...of, [spec.value || 'value']: v });
            }
        }
        for (const [path, type] of Object.entries(schema.lists)) {
            for (const item of getPath(native, path) || []) out.push({ type: prefix + type, ...of, ...tag(item, type) });
        }
        for (const e of native.entities || []) {
            if (slots.has(e.type)) throw new Error(`${feature}: native entity type "${e.type}" clashes with a schema slot`);
            const { type, ...rest } = e;
            out.push({ type: prefix + type, ...of, ...rest });
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------- includes
    const ENGINE_TYPES = /^(hud\.|sound\.|handheld(\.|$)|link$|camera$)/;
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
                    if (ENGINE_TYPES.test(x.type || '')) x = rename(x, from, to);
                }
                if (e.root && SCHEMAS[x.type] && x.id === to) x = { ...x, ...e.root, layer: { ...(x.layer || {}), ...(e.root.layer || {}) } };
                // a world's children name it once there may be several of its feature
                if (typeof x.type === 'string' && !SCHEMAS[x.type] && x.type.includes('.') && !ENGINE_TYPES.test(x.type) && !x.of && to) x = { ...x, of: to };
                out.push(x);
            }
        }
        return { ...scenario, entities: out };
    }

    return { SCHEMAS, roots, childrenOf, toNative, fromNative, resolveIncludes, isObj };
})();

if (typeof module !== 'undefined') module.exports = ScenarioFormat;
