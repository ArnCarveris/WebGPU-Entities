// The single-world guard (docs/single-world-plan.md §4 Phase 7, §6.2 G8): nothing comes back of the machinery that ran
// a scenario as several worlds.
//
//   node tools/check-single-world.mjs       exit 1 on a finding, each as file:line and what it is
//
// It fails on:
//   - more than one `new World(`, `new Renderer(` or `new App(` in js/ (the host's, js/engine/host.js);
//   - the identifiers of the cross-world machinery: frameOf, composed, Compositor, inject, behindTex, byRole,
//     cameraOwner, sunFrom, holder, layer.role, and `instances` in js/engine (the host's list of worlds; in the kits'
//     renderers `instances` is GPU instance data);
//   - a `worlds:` key in js/kits/manifest.js;
//   - a field `layer` on any entity of scenarios/*.json (an include's `site` too).
// Code is read without its comments, strings and template literals (WGSL: the atmosphere's froxel `inject` pass), so
// the words stay free in prose. The test sequence `single-world` (tests/sequences) runs the same checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['frameOf', 'composed', 'Compositor', 'inject', 'behindTex', 'byRole', 'cameraOwner', 'sunFrom', 'holder'];
const ENGINE_NAMES = ['instances'];
const ONE = ['World', 'Renderer', 'App'];

// the source with comments, strings and template literals blanked (newlines kept, so lines still count); a template's
// ${...} stays code. `end`: the '}' that closes the ${ this call reads (depth counted), or none at the top
export function codeOf(src, from = 0, end = false) {
    let out = '', i = from, depth = 0;
    const blank = s => s.replace(/[^\n]/g, ' ');
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (end && c === '}' && !depth) return { out, i };
        if (c === '{') depth++; else if (c === '}') depth--;
        let j = i;
        if (c === '/' && d === '/') { j = src.indexOf('\n', i); if (j < 0) j = src.length; }
        else if (c === '/' && d === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; }
        else if (c === '`') {
            out += c; i++;
            while (i < src.length && src[i] !== '`') {
                if (src[i] === '$' && src[i + 1] === '{') { const r = codeOf(src, i + 2, true); out += '${' + r.out + '}'; i = r.i + 1; }
                else { const n = src[i] === '\\' ? 2 : 1; out += blank(src.slice(i, i + n)); i += n; }
            }
            out += '`'; i++; continue;
        } else if (c === '"' || c === "'") {
            j = i + 1;
            while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            j++;
        } else { out += c; i++; continue; }
        out += c === '/' ? blank(src.slice(i, j)) : c + blank(src.slice(i + 1, j - 1)) + c;
        i = j;
    }
    return end ? { out, i } : out;
}

const jsFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? jsFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
const lineAt = (s, k) => s.slice(0, k).split('\n').length;

// the code rules over js/: [{ at: 'file:line', what }]
export function checkCode(root = ROOT) {
    const out = [], news = Object.fromEntries(ONE.map(n => [n, []]));
    for (const file of jsFiles(path.join(root, 'js'))) {
        const rel = path.relative(root, file).replace(/\\/g, '/'), code = codeOf(fs.readFileSync(file, 'utf8'));
        const hit = (re, what) => { for (const m of code.matchAll(re)) out.push({ at: `${rel}:${lineAt(code, m.index)}`, what: what(m) }); };
        for (const m of code.matchAll(/\bnew\s+(World|Renderer|App)\s*\(/g)) news[m[1]].push(`${rel}:${lineAt(code, m.index)}`);
        const names = rel.startsWith('js/engine/') ? [...NAMES, ...ENGINE_NAMES] : NAMES;
        hit(new RegExp(`\\b(${names.join('|')})\\b`, 'g'), m => `"${m[1]}": the cross-world machinery's`);
        hit(/\blayer\s*\.\s*role\b/g, () => '"layer.role": layer roles are gone');
        if (rel === 'js/kits/manifest.js') hit(/\bworlds\s*:/g, () => 'a manifest `worlds:` key (a kit offers a `site`)');
    }
    for (const [n, at] of Object.entries(news)) if (at.length > 1) out.push({ at: at.join(', '), what: `${at.length} \`new ${n}(\`: the host makes the one ${n}` });
    return out;
}

// the scenario rules over one scenarios/<id>.json: [{ at, what }]
export function checkScenario(id, root = ROOT) {
    const rel = `scenarios/${id}.json`, s = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')), out = [];
    (s.entities || []).forEach((e, k) => {
        for (const [where, o] of [['', e], ['.site', e.site]])
            if (o && typeof o === 'object' && 'layer' in o) out.push({ at: `${rel} entities[${k}]${where}`, what: `a field \`layer\` (${e.type}${e.id ? ` "${e.id}"` : ''}): a site has \`at\`, the frame is shared` });
    });
    return out;
}

export const scenarioIds = (root = ROOT) => fs.readdirSync(path.join(root, 'scenarios')).filter(f => f.endsWith('.json') && f !== 'index.json').map(f => f.slice(0, -5));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const found = [...checkCode(), ...scenarioIds().flatMap(id => checkScenario(id))];
    for (const f of found) console.log(`${f.at}: ${f.what}`);
    console.log(found.length ? `${found.length} finding(s)` : 'single world: clean');
    process.exit(found.length ? 1 : 0);
}
