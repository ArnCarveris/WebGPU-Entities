// The deterministic pixel harness: every scenario, every view, captured in an isolated Brave over CDP, compared with the
// baselines (docs/single-world-plan.md §6).
//
//   node tools/pixel-harness.mjs record [ids...]   capture into baselines/ (PNGs + manifest.json; --runs N, 2 by default,
//                                                  measures the noise: what differs between runs of the same scenario,
//                                                  each in a Brave session of its own)
//   node tools/pixel-harness.mjs check [ids...]    capture into <work>/check and compare with baselines/: pixels (within
//                                                  each scenario's recorded noise), kits loaded, World / Renderer / App
//                                                  constructions and queue.submit calls per frame; exit 1 on a failure
//   node tools/pixel-harness.mjs smoke [ids...]    the key smoke run: WASD, E, F, Tab, the Walk switch, click, Esc; no
//                                                  errors, and the view moves
//   node tools/pixel-harness.mjs eval --expr 'js' [ids...]   after opt.frames: the expression's value (awaited), then
//                                                  opt.view-frames more frames; the counters before and after, errors
//   node tools/pixel-harness.mjs perf [ids...]     GPU time per frame and per pass (timestamps on every pass), A/B
//                                                  between two revisions (--revs a,b, HEAD~1,HEAD), alternated
//                                                  scenario by scenario, --rounds times; <work>/perf-report.json
//
// Options: --frames N (stepped before the start view, 40), --view-frames N (after each view jump, 20), --runs N, --out
// dir (record: baselines), --baseline dir (check: baselines), --work dir (the Brave profile, captures, diff heat maps;
// default <os tmp>/webgpu-entities-harness; the page is served from a copy made there when the run starts, --live serves
// the checkout itself, --rev <commit> that commit's files; always on --serve-port N, 9381: one origin for every run),
// --port N (Brave's debugging port, 9371), --keep (leave Brave open), --only
// start (the start view only), --query k=v (added to the page URL, repeatable), --brave path, --trace (also writes
// <work>/trace/<scenario>.json: what each host answers through its base extension, see TRACE), --bindings (check: the
// binding budget of every pipeline layout, failing over WebGPU's default limits; <work>/bindings/<scenario>.json),
// --report (check: pixel differences are reported, not failures: a variant forced with --query, render.depth=reversed)
//
// The page's prelude (fake clock, seeded random, stepped frames, counters), its probes and the isolated Brave over CDP:
// tools/harness/browser.mjs, shared with the test sequences (tools/seq.mjs, tests/README.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PNG from './png.mjs';
import { W, H, ROOT, fileOf, snapshot as snapshotOf, serve, brave as launch, closeBrave, open, settle, pageUrl, bindingBudget, gpuTime, scenarioIds } from './harness/browser.mjs';

const argv = process.argv.slice(2);
const mode = ['record', 'check', 'smoke', 'perf', 'eval'].includes(argv[0]) ? argv.shift() : 'check';
const opt = { frames: 40, viewFrames: 20, runs: mode === 'record' ? 2 : 1, port: 9371, out: 'baselines', baseline: 'baselines',
    work: path.join(os.tmpdir(), 'webgpu-entities-harness'), keep: false, trace: false, bindings: false, report: false, expr: '', live: false, rev: null, revs: 'HEAD~1,HEAD', rounds: 2, servePort: 9381, only: null, query: [],
    brave: process.env.BRAVE || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' };
const ids = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { ids.push(a); continue; }
    const k = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (typeof opt[k] === 'boolean') opt[k] = true;
    else if (k === 'query') opt.query.push(argv[++i]);
    else opt[k] = typeof opt[k] === 'number' ? +argv[++i] : argv[++i];
}
const abs = p => path.isAbsolute(p) ? p : path.join(ROOT, p);
fs.mkdirSync(opt.work, { recursive: true });
const CDP = `http://127.0.0.1:${opt.port}`;
const snapshot = (rev = opt.rev, name = 'serve') => snapshotOf(opt.work, { rev, live: opt.live, name });
const brave = () => launch({ work: opt.work, port: opt.port, path: opt.brave, perf: mode === 'perf' });


// one scenario: the start view after opt.frames, then every view of the handheld's View list (entities.viewList)
async function capture(base, sid, dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const { s, failed } = await open(opt.port, pageUrl(base, sid, opt.query), { trace: opt.trace, bindings: opt.bindings });
    const t0 = Date.now();
    try {
        if (failed) return { sid, failed, errors: s.errors() };
        await settle(s);
        await s.send('Page.bringToFront');
        const views = [];
        const shot = async key => {
            const r = await s.send('Page.captureScreenshot', { format: 'png' });
            const file = fileOf(key) + '.png';
            fs.writeFileSync(path.join(dir, file), Buffer.from(r.result.data, 'base64'));
            return file;
        };
        await s.evaluate(`__step(${opt.frames})`);
        views.push({ key: 'start', name: 'start', file: await shot('start') });
        const list = opt.only === 'start' ? [] : await s.evaluate(`entities.viewList.map(v => ({ key: v.key, name: v.name }))`);
        for (const v of list) {
            const ok = await s.evaluate(`(() => { const v = entities.viewList.find(v => v.key === ${JSON.stringify(v.key)}); if (!v) return false; entities.goView(v); return true; })()`);
            if (!ok) { views.push({ ...v, missing: true }); continue; }
            await s.evaluate(`__step(${opt.viewFrames})`);
            views.push({ ...v, file: await shot('view-' + v.key) });
        }
        const h = await s.evaluate(`({ counts: __harness.counts, frames: __harness.frames, kits: Object.keys(Features.kits) })`);
        let bindings = null;
        if (opt.bindings) {
            const B = await s.evaluate('__harness.bindings');
            bindings = bindingBudget(B);
            fs.mkdirSync(path.join(opt.work, 'bindings'), { recursive: true });
            fs.writeFileSync(path.join(opt.work, 'bindings', `${sid}.json`), JSON.stringify(B, null, 1));
        }
        if (opt.trace) {
            fs.mkdirSync(path.join(opt.work, 'trace'), { recursive: true });
            fs.writeFileSync(path.join(opt.work, 'trace', `${sid}.json`), JSON.stringify(await s.evaluate('__harness.trace || {}'), null, 1));
        }
        const steady = h.frames.slice(-opt.viewFrames);
        const range = k => { const xs = steady.map(f => f[k]); return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0]; };
        return { sid, views, bindings, counts: h.counts, submitsPerFrame: range('submits'), writesPerFrame: range('writes'), kits: h.kits.sort(),
            errors: s.errors(), warnings: [...new Set(s.warnings())].slice(0, 10), seconds: (Date.now() - t0) / 1000 };
    } finally { await s.close(); }
}

// GPU time (§6.2 G7) of one scenario's start view: opt.frames stepped, then opt.viewFrames measured (the same frames for
// every revision: the stepping is deterministic); { sid, median (ms per frame), passes: { label: median ms } }
async function perf(base, sid) {
    const { s, failed } = await open(opt.port, pageUrl(base, sid), { perf: true });
    try {
        if (failed) return { sid, failed };
        await settle(s);
        await s.send('Page.bringToFront');
        await s.evaluate(`__step(${opt.frames})`);
        const from = await s.evaluate('__harness.gpu.length');
        await s.evaluate(`__step(${opt.viewFrames})`);
        return { sid, ...await gpuTime(s, from), errors: s.errors() };
    } finally { await s.close(); }
}

// one scenario, an expression run in it after opt.frames (eval mode): { sid, before, value, after, frames, errors }
async function evalIn(base, sid) {
    const { s, failed } = await open(opt.port, pageUrl(base, sid));
    try {
        if (failed) return { sid, failed, errors: s.errors() };
        await settle(s);
        await s.evaluate(`__step(${opt.frames})`);
        const counts = () => s.evaluate('JSON.stringify(__harness.counts)');
        const before = await counts();
        // (the expression may wait for frames: they step meanwhile)
        let done = false, value;
        const run = s.evaluate(`(async () => JSON.stringify(await (${opt.expr})))()`).then(v => { value = v; done = true; }, e => { value = 'threw ' + e.message; done = true; });
        for (let k = 0; k < 600 && !done; k++) await s.evaluate('__step(1)');
        await run;
        await settle(s);
        const f0 = await s.evaluate('entities.frameNo');
        await s.evaluate(`__step(${opt.viewFrames})`);
        const f1 = await s.evaluate('entities.frameNo');
        const fell = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show')`);
        return { sid, before, value, after: await counts(), frames: [f0, f1], failed: fell, errors: s.errors() };
    } finally { await s.close(); }
}

// the key smoke run (§6.2 G6) on one scenario
async function smoke(base, sid) {
    const { s, failed } = await open(opt.port, pageUrl(base, sid));
    try {
        if (failed) return { sid, failed, errors: s.errors() };
        await settle(s);
        await s.evaluate('window.__input = true');
        await s.send('Page.bringToFront');
        await s.evaluate(`__step(10)`);
        // where the camera is: the engine's, in the world (entities.worldView)
        const eye = `JSON.stringify((() => { const v = entities.camera?.view || (entities.worldView ? entities.worldView() : null); return v ? v.pos.map(x => +(+x).toFixed(3)) : null; })())`;
        const key = async (code, key, frames = 1, hold = 0) => {
            const vk = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyE: 69, KeyF: 70, Tab: 9, Escape: 27 }[code];
            await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, windowsVirtualKeyCode: vk });
            await s.evaluate(`__step(${hold || frames})`);
            await s.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
            await s.evaluate(`__step(${frames})`);
        };
        const steps = [];
        const p0 = await s.evaluate(eye);
        await key('KeyW', 'w', 2, 30);
        await key('KeyA', 'a', 2, 10);
        await key('KeyS', 's', 2, 10);
        await key('KeyD', 'd', 2, 10);
        const p1 = await s.evaluate(eye);
        steps.push(`WASD ${p0} -> ${p1}${p0 === p1 ? ' (did not move)' : ''}`);
        await key('KeyE', 'e', 5);
        await key('KeyF', 'f', 5);
        await key('Tab', 'Tab', 30);
        steps.push(`Tab: handheld ${await s.evaluate('entities.handheld.shown')}`);
        await key('Tab', 'Tab', 30);
        const moves = await s.evaluate('entities.moves');
        if (moves.includes('walk')) {
            await s.evaluate(`entities.setMove('walk'); __step(10)`);
            const w0 = await s.evaluate(eye);
            await key('KeyW', 'w', 2, 30);
            steps.push(`walk: ${await s.evaluate('entities.move')} ${w0} -> ${await s.evaluate(eye)}`);
            await s.evaluate(`entities.setMove('fly'); __step(5)`);
        }
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: W / 2, y: H / 2, button: 'left', clickCount: 1 });
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W / 2 + 60, y: H / 2 + 20, button: 'left' });
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: W / 2 + 60, y: H / 2 + 20, button: 'left', clickCount: 1 });
        await s.evaluate(`__step(5)`);
        await key('Escape', 'Escape', 5);
        return { sid, moved: p0 !== p1, steps, errors: s.errors() };
    } finally { await s.close(); }
}

// ----------------------------------------------------------------------------------------------- main
const served = snapshot(), server = await serve(served, opt.servePort);
const base = `http://127.0.0.1:${server.address().port}`;
let browser = await brave();
const { v } = browser;
console.log(`${v.Browser} on ${CDP}, serving ${served} at ${base}, mode ${mode}`);
const all = scenarioIds();
const list = ids.length ? ids : all;
let failures = 0;
const fail = msg => { failures++; console.log('  FAIL ' + msg); };

try {
    if (mode === 'eval') {
        for (const sid of list) {
            const r = await evalIn(base, sid);
            console.log(`${sid}: ${r.failed ? 'FAILED ' + r.failed : `${r.value} · counts ${r.before} -> ${r.after} · frames ${r.frames.join(' -> ')}`}`);
            if (r.failed) fail(String(r.failed));
            for (const e of [...new Set(r.errors)].slice(0, 6)) fail(e);
        }
    } else if (mode === 'perf') {
        // A/B: each revision (--revs a,b) served from its own snapshot and port, alternated scenario by scenario, rounds
        // times (the laptop GPU's clocks drift between runs: compare neighbours, not runs)
        const revs = opt.revs.split(','), bases = [];
        for (const [i, rev] of revs.entries()) {
            const srv = await serve(snapshot(rev, `serve-${i}`), opt.servePort + 2 + i);
            bases.push({ rev, base: `http://127.0.0.1:${srv.address().port}`, srv });
        }
        const out = {};
        for (const sid of list) {
            const runs = Object.fromEntries(revs.map(r => [r, []]));
            for (let k = 0; k < opt.rounds; k++) for (const b of (k % 2 ? [...bases].reverse() : bases)) {
                const r = await perf(b.base, sid);
                if (r.failed) { fail(`${sid} @ ${b.rev}: ${r.failed}`); continue; }
                runs[b.rev].push(r);
            }
            const best = rs => rs.length ? Math.min(...rs.map(r => r.median)) : NaN;
            out[sid] = Object.fromEntries(revs.map(r => [r, { span: runs[r].map(x => +x.median.toFixed(3)), sum: runs[r].map(x => +x.sum.toFixed(3)), passes: runs[r][0]?.passes }]));
            console.log(`${sid}: GPU span ${revs.map(r => `${r} ${runs[r].map(x => x.median.toFixed(2)).join(' / ')}`).join('   ')} ms (best ${revs.map(r => best(runs[r]).toFixed(2)).join(' vs ')}); passes' sum ${revs.map(r => runs[r].map(x => x.sum.toFixed(2)).join(' / ')).join(' vs ')}`);
        }
        fs.writeFileSync(path.join(opt.work, 'perf-report.json'), JSON.stringify(out, null, 1));
        for (const b of bases) b.srv.close();
    } else if (mode === 'smoke') {
        for (const sid of list) {
            const r = await smoke(base, sid);
            console.log(`${sid}: ${r.failed ? 'FAILED ' + r.failed : r.steps.join(' · ')}`);
            if (r.failed) fail(r.failed);
            else if (!r.moved) fail('the view did not move');
            for (const e of [...new Set(r.errors)].slice(0, 6)) fail(e);
        }
    } else if (mode === 'record') {
        const out = abs(opt.out);
        const manifestFile = path.join(out, 'manifest.json');
        const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { scenarios: {} };
        Object.assign(manifest, { browser: v.Browser, size: [W, H], frames: opt.frames, viewFrames: opt.viewFrames, runs: opt.runs, query: opt.query });
        for (const sid of list) {
            const r = await capture(base, sid, path.join(out, sid));
            if (r.failed) { fail(`${sid}: ${r.failed}`); continue; }
            // the noise: the most any view differs between runs of the same scenario, each in a browser session of its own
            // (some pictures are the same from run to run in one session, not from one session to the next: the imposter
            // world's foliage), as the share of pixels and the largest channel difference
            const noise = {};
            for (let k = 1; k < opt.runs; k++) {
                await closeBrave(browser);
                browser = await brave();
                const again = await capture(base, sid, path.join(opt.work, 'noise', sid));
                for (const view of r.views.filter(x => x.file)) {
                    const b = again.views?.find(x => x.key === view.key), was = noise[view.file] || { frac: 0, max: 0 };
                    if (!b?.file) { noise[view.file] = { frac: 1, max: 255 }; continue; }
                    const d = PNG.diff(PNG.decode(fs.readFileSync(path.join(out, sid, view.file))), PNG.decode(fs.readFileSync(path.join(opt.work, 'noise', sid, b.file))));
                    noise[view.file] = { frac: Math.max(was.frac, d.frac), max: Math.max(was.max, d.max) };
                }
            }
            const most = Math.max(0, ...Object.values(noise).map(x => x.frac)), mostMax = Math.max(0, ...Object.values(noise).map(x => x.max));
            manifest.scenarios[sid] = { views: r.views, counts: r.counts, submitsPerFrame: r.submitsPerFrame, writesPerFrame: r.writesPerFrame,
                kits: r.kits, noise: most, noiseMax: mostMax, noiseByView: Object.fromEntries(Object.entries(noise).filter(([, x]) => x.frac > 0)),
                errors: r.errors, warnings: r.warnings };
            console.log(`${sid}: ${r.views.length} views, ${JSON.stringify(r.counts)}, submits/frame ${r.submitsPerFrame.join('..')}, ${r.kits.length} kits, noise ${(100 * most).toFixed(4)}% max ${mostMax}, ${r.seconds.toFixed(0)} s${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
            for (const e of [...new Set(r.errors)].slice(0, 6)) console.log('    ' + e);
            fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
        }
    } else {
        const bdir = abs(opt.baseline), manifest = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'));
        const cdir = path.join(opt.work, 'check'), ddir = path.join(opt.work, 'diff');
        const report = {};
        for (const sid of list) {
            const B = manifest.scenarios[sid];
            const r = await capture(base, sid, path.join(cdir, sid));
            if (r.failed) { console.log(`${sid}: FAILED`); fail(`${sid}: ${r.failed}`); for (const e of [...new Set(r.errors || [])].slice(0, 6)) fail(`${sid}: ${e}`); continue; }
            const lines = [];
            if (!B) { console.log(`${sid}: no baseline`); fail(`${sid}: no baseline`); continue; }
            // pixels: exact, or within the scenario's recorded noise: up to twice the share of pixels two sessions differed
            // in, by up to twice their largest difference (at least 16: a few sessions don't show the largest)
            const allow = 2 * (B.noise || 0), allowMax = B.noise ? Math.max(16, 2 * (B.noiseMax ?? 255)) : 0;
            let worst = 0;
            fs.rmSync(path.join(ddir, sid), { recursive: true, force: true });
            for (const bv of B.views.filter(x => x.file)) {
                const cv = r.views.find(x => x.key === bv.key);
                if (!cv?.file) { lines.push(`view ${bv.key} missing`); fail(`${sid}: view ${bv.key} missing`); continue; }
                const d = PNG.diff(PNG.decode(fs.readFileSync(path.join(bdir, sid, bv.file))), PNG.decode(fs.readFileSync(path.join(cdir, sid, cv.file))), { heat: true });
                worst = Math.max(worst, d.frac);
                if (!d.n) continue;
                if (d.heat) { fs.mkdirSync(path.join(ddir, sid), { recursive: true }); fs.writeFileSync(path.join(ddir, sid, bv.file), d.heat); }
                const msg = `${bv.file} differs ${(100 * d.frac).toFixed(4)}% max ${d.max} mean ${d.mean.toFixed(2)} box ${d.box}`;
                if (d.frac <= allow && d.max <= allowMax) lines.push(msg + ' (noise)');
                else if (opt.report) lines.push(msg + ' (reported)');
                else { lines.push(msg); fail(`${sid}: ${msg}`); }
            }
            for (const cv of r.views.filter(x => !B.views.some(b => b.key === x.key))) lines.push(`new view ${cv.key}`);
            const kitsSame = JSON.stringify(r.kits) === JSON.stringify(B.kits);
            if (!kitsSame) { const add = r.kits.filter(k => !B.kits.includes(k)), gone = B.kits.filter(k => !r.kits.includes(k)); fail(`${sid}: kits ${add.length ? '+' + add.join(' +') : ''} ${gone.length ? '-' + gone.join(' -') : ''}`); }
            for (const e of [...new Set(r.errors)].slice(0, 6)) fail(`${sid}: ${e}`);
            if (r.bindings) {
                for (const o of r.bindings.over) fail(`${sid}: binding budget: ${o}`);
                const t = r.bindings.top, show = k => t[k] ? `${t[k].n} (${t[k].at})` : '-';
                lines.push(`bindings: ${r.bindings.layouts} layouts (+${r.bindings.auto} auto); most sampled: fragment ${show('fragment sampled')}, compute ${show('compute sampled')}; most storage: fragment ${show('fragment storage')}, compute ${show('compute storage')}, vertex ${show('vertex storage')}`);
            }
            report[sid] = { counts: r.counts, submitsPerFrame: r.submitsPerFrame, writesPerFrame: r.writesPerFrame, kits: r.kits.length, worst, views: r.views.length };
            const was = `${JSON.stringify(B.counts)} submits ${B.submitsPerFrame.join('..')}`;
            const now = `${JSON.stringify(r.counts)} submits ${r.submitsPerFrame.join('..')}`;
            console.log(`${sid}: ${r.views.length} views, worst ${(100 * worst).toFixed(4)}% (noise ${(100 * (B.noise || 0)).toFixed(4)}% max ${B.noiseMax ?? '-'}), ${now}${now !== was ? ` (was ${was})` : ''}, kits ${kitsSame ? 'same' : 'DIFFER'}, ${r.seconds.toFixed(0)} s`);
            for (const l of lines) console.log('    ' + l);
        }
        fs.writeFileSync(path.join(opt.work, 'check-report.json'), JSON.stringify(report, null, 1));
        console.log(`diff heat maps: ${ddir}`);
    }
} finally {
    server.close();
    if (!opt.keep) await closeBrave(browser);
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
