// Imports a scenario made for one of the single WebGPU-Entity* demos into the entity form (ScenarioFormat.fromNative),
// and checks that converting it back gives the same data.
//
//   node tools/import-native.mjs <feature> <source> <out.json> [--group <name>] [--description <text>]
//
// <source> is a native scenario: a .json file, an index.html with a <script id="scenario"> block, or a classic script
// defining `const SCENARIO` (WebGPU-EntityGUI's js/scenario.js).
//
//   node tools/import-native.mjs --originals [dir] [--force]
//       imports every original demo's scenario from the sibling repos (the first import of scenarios/*.json; those
//       files have been edited since, with HUD, sound and view entities, so existing ones are kept unless --force)
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import vm from 'vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ScenarioFormat = require(join(root, 'js/engine/scenario-format.js'));

function readNative(file) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) return JSON.parse(text);
    if (file.endsWith('.html')) {
        const at = text.indexOf('id="scenario"');
        if (at < 0) throw new Error(`${file}: no <script id="scenario">`);
        const s = text.indexOf('>', at) + 1;
        return JSON.parse(text.slice(s, text.indexOf('</script>', s)));
    }
    const ctx = { window: {} };
    vm.runInNewContext(`${text}\n;this.__scenario = SCENARIO;`, ctx);
    // through JSON: the script builds it with helpers, the scenario itself must be plain data
    const data = JSON.parse(JSON.stringify(ctx.__scenario));
    if (!deepEqual(data, ctx.__scenario)) throw new Error(`${file}: SCENARIO is not plain JSON data`);
    return data;
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
}

function firstDiff(a, b, path = '') {
    if (deepEqual(a, b)) return null;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = firstDiff(a[k], b[k], `${path}.${k}`);
        if (d) return d;
    }
    return `${path}: differs`;
}

// one entity per line (long ones wrap at their top-level fields): readable, diffable
function stringify(scenario) {
    const head = Object.entries(scenario).filter(([k]) => k !== 'entities').map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    const ents = scenario.entities.map(e => {
        const one = JSON.stringify(e);
        if (one.length <= 160) return `        ${one}`;
        // pack the fields into lines of up to ~150 characters
        const lines = [];
        let cur = '';
        for (const [k, v] of Object.entries(e)) {
            const f = `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
            if (cur && cur.length + f.length + 2 > 150) { lines.push(cur + ','); cur = ''; }
            cur += (cur ? ', ' : '') + f;
        }
        lines.push(cur);
        return `        {\n${lines.map(l => '            ' + l).join('\n')}\n        }`;
    });
    return `{\n${head.join(',\n')},\n    "entities": [\n${ents.join(',\n')}\n    ]\n}\n`;
}

export function importNative(feature, source, out, meta = {}) {
    const native = readNative(source);
    const entities = ScenarioFormat.fromNative(feature, native);
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    const scenario = { name: native.name || feature, group: ScenarioFormat.SCHEMAS[feature].title, ...meta, entities };
    // round trip: entities -> native must give back the source
    const back = ScenarioFormat.toNative(scenario, ScenarioFormat.roots(scenario)[0]);
    if (!native.name) delete back.name;
    if (!native.entities) delete back.entities;
    const diff = firstDiff(native, back);
    if (diff) throw new Error(`${feature}: round trip differs at ${diff}`);
    writeFileSync(out, stringify(scenario));
    console.log(`${out}: ${entities.length} entities (round trip ok)`);
    return scenario;
}

const ORIGINALS = [
    ['cloud', 'WebGPU-EntityCloud/index.html', 'cloud-high-plains.json'],
    ['water', 'WebGPU-EntityWater/index.html', 'water-riverlands.json'],
    ['origin', 'WebGPU-EntityOrigin/index.html', 'origin-sol-transit.json'],
    ['imposter', 'WebGPU-EntityImposter/index.html', 'imposter-valley.json'],
    ['portal', 'WebGPU-EntityPortal/scenarios/bunker-compound.json', 'portal-bunker-compound.json'],
    ['gui', 'WebGPU-EntityGUI/js/scenario.js', 'gui-sector-07.json'],
];

const args = process.argv.slice(2);
if (args[0] === '--originals') {
    const force = args.includes('--force'), dir = args[1] && args[1] !== '--force' ? args[1] : join(root, '..');
    for (const [feature, src, out] of ORIGINALS) {
        const file = join(root, 'scenarios', out);
        if (existsSync(file) && !force) { console.log(`${file}: exists, kept (--force overwrites)`); continue; }
        importNative(feature, join(dir, src), file, { name: feature === 'gui' ? 'Sector 07' : undefined });
    }
} else if (args.length >= 3) {
    const meta = {};
    for (let i = 3; i < args.length; i += 2) meta[args[i].replace(/^--/, '')] = args[i + 1];
    importNative(args[0], args[1], args[2], meta);
} else {
    console.log('usage: node tools/import-native.mjs <feature> <source> <out.json> [--group g] [--description d]\n       node tools/import-native.mjs --originals [dir]');
    process.exit(1);
}
