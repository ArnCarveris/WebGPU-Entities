// Writes the scenario catalog and the embedded copy of every scenario:
//
//   scenarios/index.json    [{ id, name, group, description, features }], what the scenario picker lists
//   scenarios/embedded.js   all of scenarios/*.json plus the catalog, for index.html opened from disk (browsers block
//                           fetch() on file:// pages, but run <script> files)
//
// The folders under scenarios/ hold parts of scenarios (scenarios/gui/: each scenario's GUIs), included by
// id ("gui/water-riverlands"): embedded too, but not listed.
//
// The .json files stay the source of truth: run this after adding or editing one.
//
//   node tools/embed-scenarios.mjs
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'scenarios');
const ScenarioFormat = createRequire(import.meta.url)(join(root, 'js/engine/scenario-format.js'));

// groups in this order, then any other; within a group by `order`, then name
const GROUPS = ['Compositions', 'Entity Cloud', 'Entity Water', 'Entity Origin', 'Entity Imposter', 'Entity Portal', 'Entity GUI'];

const embedded = {}, index = [];
const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
const parts = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => readdirSync(join(dir, d.name)).filter(f => f.endsWith('.json')).map(f => `${d.name}/${f}`));
const raw = Object.fromEntries([...files, ...parts].map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]));   // fail loudly on invalid JSON
for (const f of parts) embedded[`scenarios/${f}`] = raw[f.replace(/\.json$/, '')];
for (const file of files) {
    const id = file.replace(/\.json$/, ''), s = raw[id];
    const full = await ScenarioFormat.resolveIncludes(s, async inc => {
        if (!raw[inc]) throw new Error(`${file}: include of unknown scenario "${inc}"`);
        return structuredClone(raw[inc]);
    });
    const roots = ScenarioFormat.roots(full);
    if (!roots.length) throw new Error(`${file}: no feature world entity`);
    for (const r of roots) ScenarioFormat.toNative(full, r);   // and on entities that don't fit their feature
    embedded[`scenarios/${file}`] = s;
    index.push({ id, name: s.name, group: s.group || 'Other', description: s.description || '',
        features: [...new Set(roots.map(r => r.feature))], order: s.order ?? 100 });
}
const g = x => { const k = GROUPS.indexOf(x); return k < 0 ? GROUPS.length : k; };
index.sort((a, b) => g(a.group) - g(b.group) || a.order - b.order || a.name.localeCompare(b.name));
for (const e of index) delete e.order;
embedded.index = index;

writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
writeFileSync(join(dir, 'embedded.js'),
    `'use strict';\n// Generated from scenarios/*.json by tools/embed-scenarios.mjs - edit the .json files, then re-run the tool.\n` +
    `window.EMBEDDED_SCENARIOS = ${JSON.stringify(embedded)};\n`);
console.log(`scenarios/index.json: ${index.length} scenarios`);
for (const e of index) console.log(`  ${e.group.padEnd(16)} ${e.id.padEnd(32)} ${e.name}`);
