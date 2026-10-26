// Data-driven browser tests: the sequences in tests/sequences/*.json, each an ordered list of steps run on one or more
// scenarios in an isolated Brave over CDP (tests/README.md; the steps: tools/harness/actions.mjs).
//
//   node tools/seq.mjs list [names...]           the sequences, their scenarios and steps
//   node tools/seq.mjs run [names|globs...]      run them (all by default); exit 1 on a failure
//   node tools/seq.mjs record [names|globs...]   write what they compare with: baseline / sidecar pictures, sidecar
//                                                goldens, format goldens, the manifest's counts / kits / views
//
// Options: --scenario id (only these scenarios, repeatable), --baselines dir (the baseline pictures and their manifest.json:
// baselines/, or $BASELINES; the PNGs are gitignored, so a worktree points at a checkout that has them), --work dir (the Brave profile and every output:
// <work>/<sequence>/<scenario>/...; <os tmp>/webgpu-entities-seq), --rev commit (serve that commit's files; else a copy
// of the checkout made when the run starts, --live: the checkout itself), --revs a,b (perf: the revisions),
// --query k=v (added to every page URL, repeatable), --report (pixel differences are printed, not failures),
// --frames N / --view-frames N (the defaults of the sequences' options), --port N (Brave's debugging port, 9371),
// --serve-port N (9381), --brave path, --keep (leave Brave open), --bail (stop at the first failing case)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, BRAVE, scenarioIds, snapshot, serve, brave, closeBrave } from './harness/browser.mjs';
import { ACTIONS, Abort } from './harness/actions.mjs';

const SEQ = path.join(ROOT, 'tests/sequences');
const argv = process.argv.slice(2);
const cmd = ['list', 'run', 'record'].includes(argv[0]) ? argv.shift() : 'run';
const opt = { work: path.join(os.tmpdir(), 'webgpu-entities-seq'), rev: null, revs: null, live: false, report: false, keep: false, bail: false,
    baselines: process.env.BASELINES || 'baselines', port: 9371, servePort: 9381, brave: BRAVE, frames: 40, viewFrames: 20, query: [], scenario: [] };
const names = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { names.push(a); continue; }
    const k = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (!(k in opt)) { console.error(`unknown option ${a}`); process.exit(2); }
    if (typeof opt[k] === 'boolean') opt[k] = true;
    else if (Array.isArray(opt[k])) opt[k].push(argv[++i]);
    else opt[k] = typeof opt[k] === 'number' ? +argv[++i] : argv[++i];
}
const work = path.resolve(opt.work);

// ----------------------------------------------------------------------------------------------- the sequences
const all = () => {
    const out = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.json')) out.push(path.join(d, e.name)); };
    walk(SEQ);
    return out.map(f => path.basename(f, '.json')).sort();
};
const glob = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
function pick(args) {
    const have = all();
    if (!args.length) return have;
    const out = [];
    for (const a of args) {
        const n = path.basename(a).replace(/\.json$/, ''), hit = have.filter(h => glob(n).test(h));
        if (!hit.length) { console.error(`no sequence ${a} (tests/sequences: ${have.join(', ')})`); process.exit(2); }
        for (const h of hit) if (!out.includes(h)) out.push(h);
    }
    return out;
}
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/index.json'), 'utf8'));
function load(name) {
    const file = path.join(SEQ, name + '.json'), seq = JSON.parse(fs.readFileSync(file, 'utf8'));
    seq.name = name;
    // scenarios: "*" (all of scenarios/index.json), "<id>", [ids], or { "group": "Tours" } / { "exclude": [...] }
    const sc = seq.scenarios ?? seq.scenario ?? '*';
    let ids = sc === '*' ? scenarioIds() : typeof sc === 'string' ? [sc] : Array.isArray(sc) ? sc
        : SCENARIOS.filter(s => !sc.group || s.group === sc.group).map(s => s.id);
    if (sc.exclude) ids = ids.filter(id => !sc.exclude.includes(id));
    if (opt.scenario.length) ids = ids.filter(id => opt.scenario.includes(id));
    for (const id of ids) if (!SCENARIOS.some(s => s.id === id)) throw new Error(`${name}: no scenario ${id}`);
    seq.ids = ids;
    seq.steps = (seq.steps || []).map((p, i) => {
        const A = ACTIONS[p.action];
        if (!A) throw new Error(`${name} step ${i + 1}: no action '${p.action}' (${Object.keys(ACTIONS).join(', ')})`);
        const { action, if: cond, only, skip, note, ...params } = p;
        return { A, action: new A(params), cond, only, skip, i };
    });
    seq.pageless = seq.steps.every(s => s.A.pageless);
    return seq;
}

if (cmd === 'list') {
    for (const n of pick(names)) {
        const s = load(n);
        console.log(`${n}: ${s.description || ''}\n    ${s.ids.length} scenario(s): ${s.ids.join(', ')}\n    ${s.steps.length} steps: ${s.steps.map(x => x.A.key).join(' ')}`);
    }
    process.exit(0);
}

// ----------------------------------------------------------------------------------------------- running
const seqs = pick(names).map(load);
fs.mkdirSync(work, { recursive: true });
const served = snapshot(work, { rev: opt.rev, live: opt.live });
const servers = [await serve(served, opt.servePort)];
const base = `http://127.0.0.1:${opt.servePort}`;
const revBases = new Map();
const baselines = path.resolve(ROOT, opt.baselines), manifestFile = path.join(baselines, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { scenarios: {} };
let browser = null;
const runner = {
    port: opt.port, served, revs: opt.revs ? opt.revs.split(',') : null,
    // a Brave with (perf) or without the WebGPU developer features, restarted when it's the other kind
    async braveFor({ perf = false } = {}) {
        if (browser && browser.perf !== perf && browser.proc) { await closeBrave(browser); browser = null; }
        if (!browser) browser = await brave({ work, port: opt.port, path: opt.brave, perf });
        return browser;
    },
    // the base URL serving a revision's files (its own snapshot and port)
    async serveRev(rev) {
        if (!revBases.has(rev)) {
            const port = opt.servePort + 2 + revBases.size;
            servers.push(await serve(snapshot(work, { rev, name: `serve-${revBases.size}` }), port));
            revBases.set(rev, `http://127.0.0.1:${port}`);
        }
        return revBases.get(rev);
    },
};

const report = { started: new Date().toISOString(), mode: cmd, rev: opt.rev, sequences: {} };
let failures = 0, cases = 0, stop = false;
try {
    for (const seq of seqs) {
        if (stop) break;
        console.log(`\n== ${seq.name} (${seq.ids.length} scenario(s), ${seq.steps.length} steps)`);
        const sidecar = path.join(SEQ, seq.name);
        const opts = { frames: opt.frames, viewFrames: opt.viewFrames, ...seq.options, query: [...(seq.options?.query || []), ...opt.query], report: opt.report || !!seq.options?.report };
        const R = report.sequences[seq.name] = {};
        for (const sid of seq.ids) {
            if (stop) break;
            cases++;
            const dir = path.join(work, seq.name, sid), t0 = Date.now();
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            const fails = [], notes = [];
            const ctx = {
                sid, seq, opts, mode: cmd, runner, base, page: null, vars: { scenario: sid }, captures: {}, manifest,
                baselines, work: dir, sidecar,
                fail: m => { fails.push(m); console.log(`    FAIL ${m}`); },
                note: m => { notes.push(m); console.log(`    ${m}`); },
                path: (where, ...p) => path.join(where === 'sidecar' ? sidecar : dir, ...p),
                // a JSON value with { "$": "var" } read from the variables and "${var}" in strings filled in
                value: v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$' in v ? ctx.vars[v.$]
                    : typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => ctx.vars[k] ?? '') : v,
            };
            console.log(`  ${sid}`);
            if (!seq.pageless) await runner.braveFor({ perf: false });
            try {
                for (const st of seq.steps) {
                    if (st.only && !st.only.includes(sid)) continue;
                    if (st.skip && st.skip.includes(sid)) continue;
                    if (st.cond && !(ctx.page && await ctx.page.evaluate(`!!(${st.cond})`).catch(() => false))) continue;
                    try { await st.action.run(ctx); }
                    catch (e) {
                        if (e instanceof Abort) { ctx.fail(`step ${st.i + 1} ${st.A.key}: ${e.message}`); break; }
                        ctx.fail(`step ${st.i + 1} ${st.action.describe()}: ${e.stack?.split('\n').slice(0, 2).join(' ') || e}`); break;
                    }
                }
            } finally { if (ctx.page) await ctx.page.close().catch(() => {}); }
            const seconds = (Date.now() - t0) / 1000;
            R[sid] = { ok: !fails.length, fails, notes, worst: ctx.worst ?? null, seconds };
            console.log(`  ${sid}: ${fails.length ? `FAILED (${fails.length})` : 'ok'}, ${seconds.toFixed(0)} s`);
            if (ctx.manifestDirty) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
            if (fails.length) { failures++; if (opt.bail) stop = true; }
        }
    }
} finally {
    for (const s of servers) s.close();
    if (!opt.keep && browser) await closeBrave(browser);
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 1));
}
console.log(`\n${cases - failures}/${cases} case(s) passed${failures ? `, ${failures} failed` : ''}; outputs and report.json in ${work}`);
process.exit(failures ? 1 : 0);
