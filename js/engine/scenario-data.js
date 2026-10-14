'use strict';
// ScenarioData: binary data a scenario's entities read (a real place's heights, roads, buildings: tools/geo-import.mjs),
// as classic scripts under scenarios/data/ so a page opened from disk can load it too (it cannot fetch()). An entity
// names its data by id (`"data": "oahu/terrain"`); the host loads every id the scenario names before it builds the
// worlds (load), so building them stays synchronous (get).
//
// A data script calls ScenarioData.put(id, meta, base64): meta is plain JSON, the payload deflated (raw) and base64
// encoded; load() inflates it into bytes.

const ScenarioData = (() => {
    const store = {};            // id -> { meta, b64 } as put, then { meta, bytes } once loaded

    function put(id, meta, b64) { store[id] = { meta, b64 }; }

    // the data ids a scenario's entities name: `data` (an id or a list of them)
    function ids(scenario) {
        const out = new Set();
        for (const e of scenario.entities || []) for (const id of [].concat(e.data || [])) if (typeof id === 'string') out.add(id);
        return [...out];
    }

    const decode64 = s => {
        if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
        const bin = atob(s), out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    };
    const inflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());

    // every id the scenario names, loaded (scenarios/data/<id>.js) and inflated
    async function load(scenario) {
        await Promise.all(ids(scenario).map(async id => {
            if (!/^[\w./-]+$/.test(id) || id.includes('..')) throw new Error(`scenario data "${id}": not a data id`);
            if (!store[id]) await Features.script(`scenarios/data/${id}.js`);
            const d = store[id];
            if (!d) throw new Error(`scenarios/data/${id}.js did not put "${id}"`);
            if (!d.bytes) { d.bytes = await inflate(decode64(d.b64)); delete d.b64; }
        }));
    }

    // { meta, bytes } of a loaded id
    function get(id) {
        const d = store[id];
        if (!d?.bytes) throw new Error(`scenario data "${id}" is not loaded (an entity's \`data\` names what the host loads)`);
        return d;
    }

    return { put, ids, load, get };
})();
