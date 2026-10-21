// Rewrites scenarios/*.json from root entities to sites (docs/single-world-plan.md §1.6, §5), then re-embeds them:
//
//   - a scenario's root entity of a world type ({ "type": "water", "name": "Riverlands" }) goes: the scenario's plain
//     entities imply their one site (ScenarioFormat.complete). A root with more to say (an id of its own, a label,
//     features, a layer) becomes a { "type": "site", "kit": ... } with the same fields (its layer.transform as `at`);
//   - an include's `root` becomes its `site`: { label, at: { pos (offset), yaw, on (the entity of the anchor) }, layer
//     (what is left of it: role, sky, sun, focus, until the compositions run on one world) };
//   - the props the compositions anchor their sites on are renamed from *-site to *-pad (a site rides on a pad).
//
// The files keep their hand formatting: each change is a text edit, checked by parsing the result against the same
// change made on the parsed file.
//
//   node tools/migrate-single-world.mjs [--check]     (--check: say what would change, write nothing)
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { isDeepStrictEqual } from 'util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ScenarioFormat = createRequire(import.meta.url)(join(root, 'js/engine/scenario-format.js'));
const { SCHEMAS } = ScenarioFormat;
const Kits = createRequire(import.meta.url)(join(root, 'js/kits/manifest.js'));
const check = process.argv.includes('--check');
const PADS = /\b(plains|valley|sector07)-site\b/g;

// a root's layer.transform as a site's at
function atOf(t = {}) {
    const at = {};
    if (t.offset) at.pos = t.offset;
    if (t.yaw) at.yaw = t.yaw;
    if (t.anchor) at.on = String(t.anchor).split(':').pop();
    return at;
}
// an include's root merge as its site merge
function siteOf(r) {
    const { layer = {}, ...rest } = r, { transform, ...left } = layer, out = { ...rest };
    if (transform) out.at = atOf(transform);
    if (Object.keys(left).length) out.layer = left;
    return out;
}

// the end of the JSON value starting at s[i] ({ or [): its index past the closing bracket
function valueEnd(s, i) {
    let depth = 0, str = false;
    for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (str) { if (c === '\\') k++; else if (c === '"') str = false; continue; }
        if (c === '"') str = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { if (--depth === 0) return k + 1; }
    }
    throw new Error('unbalanced JSON');
}

// where two JSON values first differ
function firstDiff(x, y, at = '') {
    if (isDeepStrictEqual(x, y)) return null;
    if (x && y && typeof x === 'object' && typeof y === 'object') {
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[k], y[k], `${at}.${k}`); if (d) return d; }
    }
    return `${at || '(root)'}: ${JSON.stringify(x)?.slice(0, 80)} vs ${JSON.stringify(y)?.slice(0, 80)}`;
}

const changed = [];
for (const f of readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json') && f !== 'index.json')) {
    const file = join(root, 'scenarios', f);
    let text = readFileSync(file, 'utf8');
    const before = JSON.parse(text);
    const want = structuredClone(before);
    // the object-level change
    const roots = want.entities.filter(e => SCHEMAS[e.type]);
    for (const r of roots) {
        const { type, id, name, ...rest } = r, i = want.entities.indexOf(r);
        const plain = roots.length === 1 && (!id || id === type) && (!name || name === want.name) && !Object.keys(rest).length;
        if (plain) { want.entities.splice(i, 1); continue; }
        const { layer = {}, ...more } = rest, { transform, ...left } = layer;
        want.entities[i] = { type: 'site', id: id || type, kit: Kits.WORLDS[type].kit, ...(name ? { name } : {}), ...more,
            ...(transform ? { at: atOf(transform) } : {}), ...(Object.keys(left).length ? { layer: left } : {}) };
    }
    for (const e of want.entities) if (e.type === 'include' && e.root) { e.site = siteOf(e.root); delete e.root; }
    const wantText = JSON.stringify(want).replace(PADS, '$1-pad');
    const target = JSON.parse(wantText);
    // the same as text edits
    for (const r of before.entities.filter(e => SCHEMAS[e.type])) {
        const m = new RegExp(`\\{\\s*"type"\\s*:\\s*"${r.type}"`).exec(text);
        if (!m) throw new Error(`${f}: root { type: ${r.type} } not found as text`);
        const end = valueEnd(text, m.index), replacement = target.entities.find(e => e.type === 'site' && e.id === (r.id || r.type));
        if (replacement) text = text.slice(0, m.index) + JSON.stringify(replacement) + text.slice(end);
        else {
            // the entity, its comma and its line
            let a = m.index, b = end;
            while (/[ \t]/.test(text[a - 1])) a--;
            if (text[b] === ',') b++;
            while (/[ \t]/.test(text[b])) b++;
            if (text[b] === '\r') b++;
            if (text[b] === '\n') b++;
            text = text.slice(0, a) + text.slice(b);
        }
    }
    // (an include's own `root` only: a handheld page may be called root too)
    const includes = /\{\s*"type"\s*:\s*"include"/g;
    for (let m; (m = includes.exec(text));) {
        const end = valueEnd(text, m.index);
        let body = text.slice(m.index, end);
        const r = /"root"\s*:\s*\{/.exec(body);
        if (r && JSON.parse(body).root) {
            const start = body.indexOf('{', r.index), stop = valueEnd(body, start);
            body = body.slice(0, r.index) + `"site":${JSON.stringify(siteOf(JSON.parse(body.slice(start, stop))))}` + body.slice(stop);
            text = text.slice(0, m.index) + body + text.slice(end);
        }
        includes.lastIndex = m.index + body.length;
    }
    text = text.replace(PADS, '$1-pad');
    if (!isDeepStrictEqual(JSON.parse(text), target)) throw new Error(`${f}: the text edits do not give the migrated scenario (${firstDiff(JSON.parse(text), target)})`);
    if (isDeepStrictEqual(before, target)) continue;
    changed.push(f);
    if (!check) writeFileSync(file, text);
}
console.log(changed.length ? `${check ? 'would change' : 'changed'}: ${changed.join(', ')}` : 'nothing to migrate');
if (!check && changed.length) execFileSync(process.execPath, [join(root, 'tools/embed-scenarios.mjs')], { stdio: 'inherit' });
