// Format goldens: what every scenario's data becomes for the engine, as JSON, so a change to the scenario format can be
// checked key for key (docs/single-world-plan.md §6.2 G3).
//
//   node tools/format-golden.mjs            write baselines/format/<scenario>.json
//   node tools/format-golden.mjs --check    compare with them instead; exit 1 on a difference (the first few paths shown)
//
// For each scenario in scenarios/index.json (includes resolved, ScenarioFormat.resolveIncludes): per root, its
// ScenarioFormat.toNative, kitsOf and featuresOf.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ScenarioFormat = createRequire(import.meta.url)(path.join(ROOT, 'js/engine/scenario-format.js'));
const check = process.argv.includes('--check');
const dir = path.join(ROOT, 'baselines/format');
const load = async id => JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', `${id}.json`), 'utf8'));

// where two JSON values differ: up to `max` paths
function differences(a, b, at = '', out = [], max = 8) {
    if (out.length >= max) return out;
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${at}.${k}`, out, max);
        return out;
    }
    out.push(`${at || '(root)'}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
}

const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/index.json'), 'utf8')).map(s => s.id);
fs.mkdirSync(dir, { recursive: true });
let bad = 0;
for (const id of ids) {
    const scenario = await ScenarioFormat.resolveIncludes(await load(id), load);
    const golden = {};
    for (const root of ScenarioFormat.roots(scenario)) {
        golden[root.id] = { type: root.type, kits: ScenarioFormat.kitsOf(scenario, root), features: ScenarioFormat.featuresOf(scenario, root),
            native: ScenarioFormat.toNative(scenario, root) };
    }
    const file = path.join(dir, `${id}.json`), text = JSON.stringify(golden, null, 1) + '\n';
    if (!check) { fs.writeFileSync(file, text); console.log(`${id}: ${Object.keys(golden).join(', ')}`); continue; }
    const was = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const d = was ? differences(was, golden) : ['no golden'];
    if (d.length) { bad++; console.log(`${id}: DIFFERS`); for (const l of d) console.log('    ' + l); }
    else console.log(`${id}: same`);
}
if (check) console.log(bad ? `${bad} differ` : 'all same');
process.exit(bad ? 1 : 0);
