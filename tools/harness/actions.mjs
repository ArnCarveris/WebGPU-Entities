// The steps of a test sequence (tests/README.md): one Action subclass per reusable step, its parameters from the
// sequence's JSON ({ "action": "<name>", ...params }). A test that needs something new gets a new subclass here, never
// code in the sequence.
//
// Every action runs on a case: one scenario of a sequence (ctx below). Common step fields, handled by the runner:
//   "if": "<expr>"        run the step only when the page expression is truthy (the walk switch: scenarios with walk)
//   "only" / "skip": [ids] run the step only for / not for these scenarios
//   "note": "..."         a comment, never read
//
// ctx: { sid, seq, opts, mode ('run' | 'record'), page (the tab, after open), base (the served URL), work (this case's
// output dir), sidecar (the sequence's sidecar dir), baselines, manifest (baselines/manifest.json), vars, captures,
// value(v), path(...), fail(msg), note(msg), runner }
import fs from 'node:fs';
import path from 'node:path';
import * as PNG from '../png.mjs';
import { W, H, ROOT, fileOf, open, settle, pageUrl, bindingBudget, gpuTime, sleep } from './browser.mjs';

// a step can't go on (no page, the page failed): the case stops here
export class Abort extends Error {}

export class Action {
    // the step's name in JSON ({ "action": key }); the class's own name, first letter lower case, by default
    static get key() { return this.name[0].toLowerCase() + this.name.slice(1); }
    // what the step needs and accepts: { name: 'default' | required (undefined) }
    static params = {};
    constructor(p) {
        this.p = { ...this.constructor.params, ...p };
        for (const [k, v] of Object.entries(this.constructor.params)) if (v === undefined && this.p[k] === undefined) throw new Error(`${this.constructor.key}: '${k}' is required`);
    }
    // true: the step runs without a page (format goldens, perf: its own tabs)
    static pageless = false;
    async run(ctx) { throw new Error(`${this.constructor.key}: no run`); }
    // one line for the log
    describe() { const { action, note, if: _, only, skip, ...rest } = this.p; return `${this.constructor.key} ${JSON.stringify(rest)}`; }
}

const page = ctx => { if (!ctx.page) throw new Abort('no page: an "open" step first'); return ctx.page; };
const step = (ctx, n) => n > 0 ? page(ctx).evaluate(`__step(${n | 0})`) : null;
const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyE: 69, KeyF: 70, KeyQ: 81, KeyR: 82, KeyC: 67, KeyG: 71, KeyH: 72, KeyM: 77, KeyV: 86,
    Tab: 9, Escape: 27, Enter: 13, Space: 32, ShiftLeft: 16, ControlLeft: 17, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53 };
const keyOf = code => code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code;

// ----------------------------------------------------------------------------------------------- page life
// a tab on the case's scenario (or `scenario`), with the prelude; `query`: ["k=v", ...] added to the URL (with the
// sequence's options.query and the CLI's --query); probes: perf, trace, bindings; settle (default): wait until nothing
// loads or bakes
export class Open extends Action {
    static params = { scenario: null, query: [], perf: false, trace: false, bindings: false, settle: true };
    async run(ctx) {
        if (ctx.page) await ctx.page.close();
        ctx.page = null;
        const sid = ctx.value(this.p.scenario) || ctx.sid, query = [...(ctx.opts.query || []), ...this.p.query];
        const { s, failed } = await open(ctx.runner.port, pageUrl(ctx.base, sid, query), { perf: this.p.perf, trace: this.p.trace, bindings: this.p.bindings });
        ctx.page = s;
        if (failed) { ctx.fail(`${sid} failed to start: ${failed}`); for (const e of [...new Set(s.errors())].slice(0, 6)) ctx.fail(e); throw new Abort(failed); }
        if (this.p.settle && !await settle(s)) ctx.note('still loading after 60 s');
        await s.send('Page.bringToFront');
    }
}

// wait until no request is in flight and no app loads or bakes (the imposter's atlases)
export class Settle extends Action {
    async run(ctx) { if (!await settle(page(ctx))) ctx.fail('still loading or baking after 60 s'); }
}

// `frames` frames on the fake clock (1/60 s each)
export class Step extends Action {
    static params = { frames: undefined };
    async run(ctx) { await step(ctx, ctx.value(this.p.frames)); }
}

// step until the expression is truthy, at most `frames` frames (fails then, unless soft)
export class Wait extends Action {
    static params = { expr: undefined, frames: 600, soft: false };
    async run(ctx) {
        for (let k = 0; k <= this.p.frames; k++) {
            if (await page(ctx).evaluate(`!!(${this.p.expr})`).catch(() => false)) return;
            await step(ctx, 1);
        }
        if (!this.p.soft) ctx.fail(`waited ${this.p.frames} frames for ${this.p.expr}`);
    }
}

// close the tab (the next open makes a new one)
export class Close extends Action {
    async run(ctx) { if (ctx.page) await ctx.page.close(); ctx.page = null; }
}

// ----------------------------------------------------------------------------------------------- the camera and views
// jump to one view of the handheld's View list (entities.viewList) by key, then `frames` frames
export class View extends Action {
    static params = { key: undefined, frames: null };
    async run(ctx) {
        const ok = await page(ctx).evaluate(`(() => { const v = entities.viewList.find(v => v.key === ${JSON.stringify(String(ctx.value(this.p.key)))}); if (!v) return false; entities.goView(v); return true; })()`);
        if (!ok) return ctx.fail(`no view ${this.p.key}`);
        await step(ctx, this.p.frames ?? ctx.opts.viewFrames);
    }
}

// every view of the View list in turn: jump, `frames` frames, capture as view-<key>; compare: "baseline" (each with
// baselines/<scenario>/<file>, and every baseline view must exist) or null
export class Views extends Action {
    static params = { frames: null, compare: null, report: false };
    async run(ctx) {
        const s = page(ctx), list = await s.evaluate(`entities.viewList.map(v => ({ key: v.key, name: v.name }))`), shot = [];
        for (const v of list) {
            const ok = await s.evaluate(`(() => { const v = entities.viewList.find(v => v.key === ${JSON.stringify(v.key)}); if (!v) return false; entities.goView(v); return true; })()`);
            if (!ok) { ctx.fail(`view ${v.key} went missing`); continue; }
            await step(ctx, this.p.frames ?? ctx.opts.viewFrames);
            const name = 'view-' + v.key;
            await capture(ctx, name);
            shot.push({ ...v, name, file: fileOf(name) + '.png' });
        }
        ctx.views = [{ key: 'start', name: 'start', file: 'start.png' }, ...shot];
        if (this.p.compare !== 'baseline') return;
        const B = ctx.manifest.scenarios[ctx.sid];
        if (ctx.mode === 'record') {
            for (const v of shot) await compareWith(ctx, v.name, { against: 'baseline' });
            if (B) B.views = ctx.views.filter(v => ctx.captures[v.name] || v.key === 'start');
            ctx.manifestDirty = true;
            return;
        }
        if (!B) return ctx.fail('no baseline in baselines/manifest.json');
        for (const bv of B.views.filter(v => v.file && v.key !== 'start')) {
            const v = shot.find(x => x.key === bv.key);
            if (!v) ctx.fail(`view ${bv.key} missing`);
            else await compareWith(ctx, v.name, { against: 'baseline', file: bv.file, report: this.p.report });
        }
        for (const v of shot.filter(x => !B.views.some(b => b.key === x.key))) ctx.note(`new view ${v.key}`);
    }
}

// where the camera is (the engine's, in the world): stored as `as`
export const EYE = `(() => { const v = entities.camera?.view || (entities.worldView ? entities.worldView() : null); return v ? v.pos.map(x => +(+x).toFixed(3)) : null; })()`;
export class Eye extends Action {
    static params = { as: 'eye' };
    async run(ctx) { ctx.vars[this.p.as] = await page(ctx).evaluate(EYE); ctx.note(`${this.p.as} = ${JSON.stringify(ctx.vars[this.p.as])}`); }
}

// the camera mode (entities.setMove: fly, walk, ...), then `frames` frames; fails if the mode isn't taken
export class Move extends Action {
    static params = { mode: undefined, frames: 10 };
    async run(ctx) {
        const s = page(ctx);
        await s.evaluate(`entities.setMove(${JSON.stringify(this.p.mode)})`);
        await step(ctx, this.p.frames);
        const now = await s.evaluate('entities.move');
        if (now !== this.p.mode) ctx.fail(`move is ${now}, not ${this.p.mode}`);
    }
}

// the camera mode (as move), then a look and a move in it, on the page's own input: a drag by `turn` from `at` (pixels:
// flying drags, walking takes the mouse with the press) must turn the camera, `code` held `hold` frames must move the
// eye; each fails on its own. `turn` null: no look. The look goes first: a move may bring a GUI screen in reach, which
// takes the press
const VIEW = `(() => { const v = entities.camera?.view || (entities.worldView ? entities.worldView() : null); return v ? { pos: [...v.pos].map(Number), fwd: [...v.fwd].map(Number) } : null; })()`;
const apart = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
export class Travel extends Action {
    static params = { mode: undefined, code: 'KeyW', hold: 30, turn: [160, 0], at: [W * 0.2, H * 0.8], frames: 20 };
    async run(ctx) {
        const s = page(ctx), m = this.p.mode;
        await s.evaluate(`entities.setMove(${JSON.stringify(m)})`);
        await step(ctx, this.p.frames);
        const now = await s.evaluate('entities.move');
        if (now !== m) return ctx.fail(`move is ${now}, not ${m}`);
        let v = await s.evaluate(VIEW);
        if (!v) throw new Abort('no camera view');
        if (this.p.turn) {
            const c = this.p.at;
            await new Drag({ from: c, to: [c[0] + this.p.turn[0], c[1] + this.p.turn[1]], moves: 8, after: 2 }).run(ctx);
            const was = v, t = apart(was.fwd, (v = await s.evaluate(VIEW)).fwd);
            if (t < 1e-3) ctx.fail(`${m}: a drag by ${JSON.stringify(this.p.turn)} did not turn the camera (mouse ${await s.evaluate("document.pointerLockElement ? 'taken' : 'not taken'")})`);
            else ctx.note(`${m}: the drag turned the camera by ${t.toFixed(3)}`);
        }
        await new Key({ code: this.p.code, hold: this.p.hold, after: 2 }).run(ctx);
        const d = apart(v.pos, (await s.evaluate(VIEW)).pos);
        if (d < 1e-3) ctx.fail(`${m}: ${this.p.code} held ${this.p.hold} frames, the eye did not move`);
        else ctx.note(`${m}: ${this.p.code} moved the eye ${d.toFixed(3)}`);
    }
}

// ----------------------------------------------------------------------------------------------- input
// the page takes the harness's input from here on (window.__input; real input over the test window stays dropped
// otherwise); every key / pointer step turns it on
export class Input extends Action {
    static params = { enabled: true };
    async run(ctx) { await page(ctx).evaluate(`window.__input = ${!!this.p.enabled}`); }
}
const inputOn = ctx => page(ctx).evaluate('window.__input = true');
const keyEvent = (ctx, type, code, key) => page(ctx).send('Input.dispatchKeyEvent', { type, code, key: key ?? keyOf(code), windowsVirtualKeyCode: VK[code] ?? 0 });

// press a key: down, `hold` frames, up, `after` frames
export class Key extends Action {
    static params = { code: undefined, key: null, hold: 1, after: 1 };
    async run(ctx) {
        await inputOn(ctx);
        await keyEvent(ctx, 'rawKeyDown', this.p.code, this.p.key ?? undefined);
        await step(ctx, this.p.hold);
        await keyEvent(ctx, 'keyUp', this.p.code, this.p.key ?? undefined);
        await step(ctx, this.p.after);
    }
}
export class KeyDown extends Action {
    static params = { code: undefined, key: null, frames: 0 };
    async run(ctx) { await inputOn(ctx); await keyEvent(ctx, 'rawKeyDown', this.p.code, this.p.key ?? undefined); await step(ctx, this.p.frames); }
}
export class KeyUp extends Action {
    static params = { code: undefined, key: null, frames: 0 };
    async run(ctx) { await inputOn(ctx); await keyEvent(ctx, 'keyUp', this.p.code, this.p.key ?? undefined); await step(ctx, this.p.frames); }
}

// a click at `at` ([x, y] in the 960 x 600 page, the centre by default), then `after` frames
export class Click extends Action {
    static params = { at: null, button: 'left', after: 1 };
    async run(ctx) {
        await inputOn(ctx);
        const [x, y] = this.p.at || [W / 2, H / 2], s = page(ctx), b = this.p.button;
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: b, clickCount: 1 });
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: b, clickCount: 1 });
        await step(ctx, this.p.after);
    }
}

// a drag from `from` to `to` in `moves` moves, a frame stepped after each, then `after` frames
export class Drag extends Action {
    static params = { from: null, to: undefined, button: 'left', moves: 1, after: 1 };
    async run(ctx) {
        await inputOn(ctx);
        const s = page(ctx), [x0, y0] = this.p.from || [W / 2, H / 2], [x1, y1] = this.p.to, b = this.p.button;
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: b, clickCount: 1 });
        for (let i = 1; i <= this.p.moves; i++) {
            const t = i / this.p.moves;
            await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, button: b });
            if (i < this.p.moves) await step(ctx, 1);
        }
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: b, clickCount: 1 });
        await step(ctx, this.p.after);
    }
}

// the handheld shown or put away with Tab (pressed only if it isn't so already), `frames` frames after; fails if it
// doesn't follow
export class Handheld extends Action {
    static params = { shown: true, frames: 30 };
    async run(ctx) {
        const shown = () => page(ctx).evaluate('!!entities.handheld?.shown');
        if (await shown() !== this.p.shown) await new Key({ code: 'Tab', key: 'Tab', hold: this.p.frames, after: this.p.frames }).run(ctx);
        if (await shown() !== this.p.shown) ctx.fail(`the handheld is ${this.p.shown ? 'not shown' : 'still shown'} after Tab`);
    }
}

// ----------------------------------------------------------------------------------------------- reading the page
// an expression's value (awaited; frames step while it waits, the page's own waits for frames work), stored as `as`;
// `frames`: frames stepped after
export class Eval extends Action {
    static params = { expr: undefined, as: null, frames: 0, print: true };
    async run(ctx) {
        const v = await evalStepping(ctx, this.p.expr);
        if (this.p.as) ctx.vars[this.p.as] = v;
        if (this.p.print) ctx.note(`${this.p.as || this.p.expr.slice(0, 60)} = ${JSON.stringify(v)?.slice(0, 300)}`);
        await step(ctx, this.p.frames);
    }
}
// (deterministic: a value that is there once the page's microtasks ran steps no frame; one that waits steps a frame
// at a time until it's there, at most 600)
async function evalStepping(ctx, expr) {
    const s = page(ctx);
    await s.evaluate(`(() => { const r = window.__evr = { done: false }; (async () => { try { r.v = JSON.stringify(await (${expr})); } catch (e) { r.e = String(e?.stack || e); } r.done = true; })(); })()`);
    let r;
    for (let k = 0; !(r = await s.evaluate('__evr')).done && k < 600; k++) await s.evaluate('__step(1)');
    if (!r.done) throw new Abort(`${expr.slice(0, 80)}: no value after 600 frames`);
    if (r.e) throw new Abort(`${expr.slice(0, 80)} threw ${r.e.split('\n')[0]}`);
    return r.v === undefined ? undefined : JSON.parse(r.v);
}

// an expectation on a value: the page expression `expr`, or the variable `var` (eval / eye / counts store them), or
// `file` (a JSON in the sidecar); with any of
//   equals, notEquals (deep; { "$": "name" } reads a variable), near: [value, tolerance] (numbers, deep), gte, lte,
//   includes (an array or string has it), excludes, matches (a regex on the string), truthy: true | false,
//   golden: "<file>.json" (equal, `tolerance` for numbers, to that sidecar file; record mode writes it)
export class Expect extends Action {
    static params = { expr: null, var: null, label: null, tolerance: 0 };
    async run(ctx) {
        const v = this.p.var ? ctx.vars[this.p.var] : await evalStepping(ctx, this.p.expr);
        const what = this.p.label || this.p.var || this.p.expr;
        for (const msg of check(ctx, v, this.p)) ctx.fail(`${what}: ${msg}`);
    }
}
export function check(ctx, v, p) {
    const out = [], show = x => JSON.stringify(x)?.slice(0, 160);
    const val = x => ctx.value(x);
    if ('equals' in p && !deepNear(v, val(p.equals), p.tolerance)) out.push(`${show(v)}, expected ${show(val(p.equals))}`);
    if ('notEquals' in p && deepNear(v, val(p.notEquals), p.tolerance)) out.push(`${show(v)}, expected anything else`);
    if ('near' in p && !deepNear(v, val(p.near[0]), p.near[1])) out.push(`${show(v)}, expected ${show(val(p.near[0]))} ± ${p.near[1]}`);
    if ('gte' in p && !(v >= val(p.gte))) out.push(`${show(v)} < ${val(p.gte)}`);
    if ('lte' in p && !(v <= val(p.lte))) out.push(`${show(v)} > ${val(p.lte)}`);
    if ('includes' in p) for (const x of [].concat(val(p.includes))) if (!v?.includes?.(x)) out.push(`${show(v)} lacks ${show(x)}`);
    if ('excludes' in p) for (const x of [].concat(val(p.excludes))) if (v?.includes?.(x)) out.push(`${show(v)} has ${show(x)}`);
    if ('matches' in p && !new RegExp(p.matches).test(String(v))) out.push(`${show(v)} doesn't match /${p.matches}/`);
    if ('truthy' in p && !!v !== !!p.truthy) out.push(`${show(v)} is ${v ? 'truthy' : 'falsy'}`);
    if ('golden' in p) {
        const file = ctx.path('sidecar', ctx.value(p.golden));
        if (ctx.mode === 'record') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 1) + '\n'); ctx.note(`wrote ${path.relative(ROOT, file)}`); }
        else if (!fs.existsSync(file)) out.push(`no golden ${path.relative(ROOT, file)} (record it: node tools/seq.mjs record ${ctx.seq.name})`);
        else for (const d of differences(JSON.parse(fs.readFileSync(file, 'utf8')), v, p.tolerance)) out.push(d);
    }
    return out;
}
function deepNear(a, b, tol = 0) {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
        return Array.isArray(a) === Array.isArray(b) && [...ks].every(k => deepNear(a[k], b[k], tol));
    }
    return a === b;
}
// where two JSON values differ: up to `max` paths (numbers within `tol`)
export function differences(a, b, tol = 0, at = '', out = [], max = 8) {
    if (out.length >= max || deepNear(a, b, tol)) return out;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], tol, `${at}.${k}`, out, max);
        return out;
    }
    out.push(`${at || '(root)'}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
}

// print an expression's value (or a variable's)
export class Log extends Action {
    static params = { expr: null, var: null };
    async run(ctx) { ctx.note(`${this.p.var || this.p.expr} = ${JSON.stringify(this.p.var ? ctx.vars[this.p.var] : await evalStepping(ctx, this.p.expr))?.slice(0, 400)}`); }
}

// write an expression's value (or a variable's) as JSON into the case's work dir: <work>/<seq>/<scenario>/<file>
export class Save extends Action {
    static params = { expr: null, var: null, file: undefined };
    async run(ctx) {
        const v = this.p.var ? ctx.vars[this.p.var] : await evalStepping(ctx, this.p.expr), f = ctx.path('work', ctx.value(this.p.file));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(v, null, 1));
    }
}

// ----------------------------------------------------------------------------------------------- counters
// constructions per host class (Common.Composite.of): expect { World: 1, Renderer: 1, App: 1 } (classes not named
// aren't checked), or "baseline" (the manifest's); stored as `counts`
export class Counts extends Action {
    static params = { expect: 'baseline' };
    async run(ctx) {
        const c = ctx.vars.counts = await page(ctx).evaluate('__harness.counts');
        const B = ctx.manifest.scenarios[ctx.sid];
        if (this.p.expect === 'baseline' && ctx.mode === 'record') { if (B) { B.counts = c; ctx.manifestDirty = true; } return; }
        const want = this.p.expect === 'baseline' ? B?.counts : this.p.expect;
        if (!want) return ctx.fail('no baseline counts');
        for (const [k, n] of Object.entries(want)) if ((c[k] || 0) !== n) ctx.fail(`${k} constructed ${c[k] || 0} times, expected ${n}`);
        ctx.note(`counts ${JSON.stringify(c)}`);
    }
}

// queue.submit (and writeBuffer) calls per frame over the last `frames` stepped frames: expect n, [min, max] or
// "baseline"; writes: the same for queue.writeBuffer (optional)
export class Submits extends Action {
    static params = { expect: 1, frames: null, writes: null };
    async run(ctx) {
        const n = this.p.frames ?? ctx.opts.viewFrames, fr = await page(ctx).evaluate(`__harness.frames.slice(-${n})`);
        const range = k => { const xs = fr.map(f => f[k]); return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0]; };
        const sub = ctx.vars.submits = range('submits'), wr = ctx.vars.writes = range('writes');
        const B = ctx.manifest.scenarios[ctx.sid];
        if (this.p.expect === 'baseline' && ctx.mode === 'record') { if (B) { B.submitsPerFrame = sub; B.writesPerFrame = wr; ctx.manifestDirty = true; } return; }
        const want = this.p.expect === 'baseline' ? B?.submitsPerFrame : [].concat(this.p.expect);
        const [lo, hi] = want.length > 1 ? want : [want[0], want[0]];
        if (sub[0] < lo || sub[1] > hi) ctx.fail(`submits per frame ${sub.join('..')}, expected ${lo === hi ? lo : lo + '..' + hi}`);
        if (this.p.writes != null) { const [a, b] = [].concat(this.p.writes); if (wr[0] < a || wr[1] > (b ?? a)) ctx.fail(`writeBuffer per frame ${wr.join('..')}, expected ${a}..${b ?? a}`); }
        ctx.note(`submits/frame ${sub.join('..')}, writes/frame ${wr.join('..')}`);
    }
}

// Object.keys(Features.kits): expect "baseline" (the manifest's, exactly) or a list (exactly); includes / excludes
export class Kits extends Action {
    static params = { expect: 'baseline' };
    async run(ctx) {
        const k = ctx.vars.kits = (await page(ctx).evaluate('Object.keys(Features.kits)')).sort();
        const B = ctx.manifest.scenarios[ctx.sid];
        if (this.p.expect === 'baseline' && ctx.mode === 'record') { if (B) { B.kits = k; ctx.manifestDirty = true; } return; }
        const want = this.p.expect === 'baseline' ? B?.kits : this.p.expect;
        if (want) {
            const add = k.filter(x => !want.includes(x)), gone = want.filter(x => !k.includes(x));
            if (add.length || gone.length) ctx.fail(`kits ${add.map(x => '+' + x).join(' ')} ${gone.map(x => '-' + x).join(' ')}`.trim());
        }
        for (const msg of check(ctx, k, this.p)) ctx.fail(`kits: ${msg}`);
    }
}

// console errors and uncaught exceptions so far: at most `max` (0), those matching an `allow` regex not counted;
// warnings: the same for console warnings (null: not checked)
export class Errors extends Action {
    static params = { max: 0, allow: [], warnings: null };
    async run(ctx) {
        const s = page(ctx), ok = e => this.p.allow.some(a => new RegExp(a).test(e));
        const errs = [...new Set(s.errors())].filter(e => !ok(e));
        if (errs.length > this.p.max) for (const e of errs.slice(0, 6)) ctx.fail(e);
        if (this.p.warnings != null) {
            const w = [...new Set(s.warnings())].filter(e => !ok(e));
            if (w.length > this.p.warnings) for (const e of w.slice(0, 6)) ctx.fail('warning: ' + e);
        }
        const failed = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show')`);
        if (failed) ctx.fail('the page shows its failure fallback');
    }
}

// the binding budget of every pipeline layout made (the page opened with "bindings": true): over WebGPU's default
// limits fails; <work>/<seq>/<scenario>/bindings.json
export class Bindings extends Action {
    async run(ctx) {
        const B = await page(ctx).evaluate('__harness.bindings');
        if (!B) throw new Abort('no binding probe: open with "bindings": true');
        fs.writeFileSync(ctx.path('work', 'bindings.json'), JSON.stringify(B, null, 1));
        const r = bindingBudget(B);
        for (const o of r.over) ctx.fail(`binding budget: ${o}`);
        const t = r.top, show = k => t[k] ? `${t[k].n} (${t[k].at})` : '-';
        ctx.note(`bindings: ${r.layouts} layouts (+${r.auto} auto); most sampled: fragment ${show('fragment sampled')}, compute ${show('compute sampled')}; most storage: fragment ${show('fragment storage')}, compute ${show('compute storage')}`);
    }
}

// what each host answers through its extensions (the page opened with "trace": true): <work>/<seq>/<scenario>/trace.json
export class Trace extends Action {
    async run(ctx) {
        const T = await page(ctx).evaluate('__harness.trace || {}');
        fs.writeFileSync(ctx.path('work', 'trace.json'), JSON.stringify(T, null, 1));
        ctx.note(`trace: ${Object.keys(T).length} host <- extension pairs`);
    }
}

// ----------------------------------------------------------------------------------------------- pictures
// a screenshot as `name` (<work>/<seq>/<scenario>/<name>.png); region: [x, y, w, h] for a part of the page
export class Capture extends Action {
    static params = { name: undefined, region: null };
    async run(ctx) { await capture(ctx, ctx.value(this.p.name), this.p.region); }
}

// how much of a capture's `region` ([x, y, w, h], its pixels; null: all) is sky: blue at least as much as red and green
// (blue sky, grey and white cloud, haze), not ground (green grass, olive and brown terrain). Stored as `as`; fails under
// `min`, or under `atLeast` (a number or { "$": var }: another capture's) less `slack`. A level view's band above the
// horizon catches the ground drawn over the eye (2026-10-27: the plains' terrain as a slanted wall)
export class Sky extends Action {
    static params = { name: undefined, region: null, as: 'sky', min: null, atLeast: null, slack: 0.1 };
    async run(ctx) {
        const name = ctx.value(this.p.name), file = ctx.captures[name];
        if (!file) return ctx.fail(`no capture ${name}`);
        const img = PNG.decode(fs.readFileSync(file)), [x0, y0, w, h] = this.p.region || [0, 0, img.width, img.height];
        let sky = 0, n = 0;
        for (let y = y0; y < Math.min(y0 + h, img.height); y++) for (let x = x0; x < Math.min(x0 + w, img.width); x++) {
            const i = (y * img.width + x) * 4, [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
            n++;
            if (b + 6 >= r && b + 6 >= g) sky++;
        }
        const f = ctx.vars[this.p.as] = n ? sky / n : 0, least = this.p.atLeast == null ? null : ctx.value(this.p.atLeast) - this.p.slack;
        ctx.note(`${name}: ${(100 * f).toFixed(1)} % sky`);
        if (this.p.min != null && f < this.p.min) ctx.fail(`${name}: ${(100 * f).toFixed(1)} % sky, under ${100 * this.p.min} %`);
        if (least != null && f < least) ctx.fail(`${name}: ${(100 * f).toFixed(1)} % sky, under ${(100 * least).toFixed(1)} % (ground over the eye?)`);
    }
}

// how much of a capture's `region` ([x, y, w, h]; null: all) is pixels where `where` holds (an expression of r, g, b,
// 0..255): stored as `as`; fails over `max` or under `min`. A view of walls catches light that should not be on them
// (2026-10-27: a bus's cabin salmon with the sunset through its walls, the in-world labels' yellow drawn over them)
export class Pixels extends Action {
    static params = { name: undefined, region: null, where: undefined, as: 'pixels', min: null, max: null };
    async run(ctx) {
        const name = ctx.value(this.p.name), file = ctx.captures[name];
        if (!file) return ctx.fail(`no capture ${name}`);
        const img = PNG.decode(fs.readFileSync(file)), [x0, y0, w, h] = this.p.region || [0, 0, img.width, img.height];
        const test = new Function('r', 'g', 'b', `return ${this.p.where};`);
        let hit = 0, n = 0;
        for (let y = y0; y < Math.min(y0 + h, img.height); y++) for (let x = x0; x < Math.min(x0 + w, img.width); x++) {
            const i = (y * img.width + x) * 4;
            n++;
            if (test(img.data[i], img.data[i + 1], img.data[i + 2])) hit++;
        }
        const f = ctx.vars[this.p.as] = n ? hit / n : 0, pc = v => (100 * v).toFixed(2);
        ctx.note(`${name}: ${pc(f)} % ${this.p.as}`);
        if (this.p.max != null && f > this.p.max) ctx.fail(`${name}: ${pc(f)} % ${this.p.as} (${this.p.where}), over ${pc(this.p.max)} %`);
        if (this.p.min != null && f < this.p.min) ctx.fail(`${name}: ${pc(f)} % ${this.p.as} (${this.p.where}), under ${pc(this.p.min)} %`);
    }
}

// a contact sheet: captures (`names`, default every capture of the case so far) scaled to `width` px, `cols` a row, to
// <work>/<sequence>/<scenario>/<file>.png: one picture to look at per case
export class Sheet extends Action {
    static params = { names: null, cols: 4, width: 240, file: 'sheet' };
    async run(ctx) {
        const names = (this.p.names || Object.keys(ctx.captures)).filter(n => ctx.captures[n]);
        if (!names.length) return ctx.note('sheet: no captures');
        const imgs = names.map(n => PNG.decode(fs.readFileSync(ctx.captures[n]))), W2 = this.p.width;
        const cell = imgs.map(i => Math.round(i.height * W2 / i.width)), rowH = Math.max(...cell), cols = Math.min(this.p.cols, imgs.length);
        const out = { width: W2 * cols, height: rowH * Math.ceil(imgs.length / cols), data: null };
        out.data = new Uint8Array(out.width * out.height * 4);
        imgs.forEach((img, k) => {
            const ox = (k % cols) * W2, oy = Math.floor(k / cols) * rowH, s = img.width / W2;
            for (let y = 0; y < cell[k]; y++) for (let x = 0; x < W2; x++) {
                const i = (Math.min(img.height - 1, Math.floor(y * s)) * img.width + Math.min(img.width - 1, Math.floor(x * s))) * 4, o = ((oy + y) * out.width + ox + x) * 4;
                out.data.set(img.data.subarray(i, i + 4), o);
            }
        });
        const file = ctx.path('work', fileOf(this.p.file) + '.png');
        fs.writeFileSync(file, PNG.encode(out));
        ctx.note(`sheet ${file}: ${names.join(', ')}`);
    }
}
async function capture(ctx, name, region = null) {
    const s = page(ctx);
    await s.send('Page.bringToFront');
    const clip = region ? { x: region[0], y: region[1], width: region[2], height: region[3], scale: 1 } : undefined;
    const r = await s.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    if (!r.result?.data) throw new Abort(`no screenshot: ${JSON.stringify(r.error || r).slice(0, 120)}`);
    const file = ctx.path('work', fileOf(name) + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    ctx.captures[name] = file;
    return file;
}

// a capture compared with: "baseline" (baselines/<scenario>/<file>, within the scenario's recorded noise: up to twice the
// share of pixels two Brave sessions differed in, by up to max(16, twice their largest difference)), "sidecar" (the
// sequence's sidecar/<file>, noise as given) or "capture" (another capture of this case, `other`); noise: "baseline" |
// { frac, max } | 0 (exact); report: differences are printed, not failures; expectDiffer: the pictures must differ by
// more than the noise (the view moved). A heat map of every difference: <work>/<seq>/<scenario>/diff/<name>.png.
// Record mode writes the capture to the baseline or sidecar file.
export class Compare extends Action {
    static params = { name: undefined, against: 'baseline', file: null, other: null, noise: null, report: false, expectDiffer: false };
    async run(ctx) { await compareWith(ctx, ctx.value(this.p.name), this.p); }
}
async function compareWith(ctx, name, p) {
    const cur = ctx.captures[name];
    if (!cur) throw new Abort(`no capture ${name}`);
    const file = p.file || fileOf(name) + '.png';
    const ref = p.against === 'baseline' ? path.join(ctx.baselines, ctx.sid, file) : p.against === 'sidecar' ? ctx.path('sidecar', file) : ctx.captures[p.other];
    if (ctx.mode === 'record' && p.against !== 'capture') {
        fs.mkdirSync(path.dirname(ref), { recursive: true });
        fs.copyFileSync(cur, ref);
        return ctx.note(`recorded ${path.relative(ROOT, ref)}`);
    }
    if (!ref || !fs.existsSync(ref)) return ctx.fail(`no ${p.against} picture ${ref ? path.relative(ROOT, ref) : p.other}`);
    const B = ctx.manifest.scenarios[ctx.sid] || {};
    const noise = p.noise ?? (p.against === 'baseline' ? 'baseline' : 0);
    const [allow, allowMax] = noise === 'baseline' ? [2 * (B.noise || 0), B.noise ? Math.max(16, 2 * (B.noiseMax ?? 255)) : 0] : noise ? [noise.frac ?? 0, noise.max ?? 0] : [0, 0];
    const d = PNG.diff(PNG.decode(fs.readFileSync(ref)), PNG.decode(fs.readFileSync(cur)), { heat: true });
    ctx.worst = Math.max(ctx.worst || 0, d.frac);
    if (d.heat) { const h = ctx.path('work', 'diff', fileOf(name) + '.png'); fs.mkdirSync(path.dirname(h), { recursive: true }); fs.writeFileSync(h, d.heat); }
    const within = d.frac <= allow && d.max <= allowMax;
    const msg = `${name} differs ${(100 * d.frac).toFixed(4)}% max ${d.max} mean ${d.mean?.toFixed(2)} box ${d.box}`;
    if (p.expectDiffer) { if (!d.n || within) ctx.fail(`${name}: the same as ${p.other || file}${d.n ? ' (within noise)' : ''}`); return; }
    if (!d.n) return;
    if (within) ctx.note(msg + ' (noise)');
    else if (p.report || ctx.opts.report) ctx.note(msg + ' (reported)');
    else ctx.fail(msg);
}

// ----------------------------------------------------------------------------------------------- without a page
// GPU time per frame and per pass (every pass timestamped), A/B between revisions (`revs`, the CLI's --revs over it),
// alternated, `rounds` times, on the case's scenario: `frames` stepped, then `measure` frames measured; a Brave with
// the WebGPU developer features (unquantised timestamps) for the step. Compare runs within one sequence only: the
// laptop GPU's clocks drift between runs. expect: { maxRatio } (each later revision's best against the first's).
// <work>/<seq>/<scenario>/perf.json
export class Perf extends Action {
    static pageless = true;
    static params = { revs: ['HEAD~1', 'HEAD'], rounds: 2, frames: 40, measure: 20, expect: null };
    async run(ctx) {
        const revs = ctx.runner.revs || this.p.revs, runs = Object.fromEntries(revs.map(r => [r, []]));
        await ctx.runner.braveFor({ perf: true });
        const bases = [];
        for (const rev of revs) bases.push({ rev, base: await ctx.runner.serveRev(rev) });
        for (let k = 0; k < this.p.rounds; k++) for (const b of (k % 2 ? [...bases].reverse() : bases)) {
            const { s, failed } = await open(ctx.runner.port, pageUrl(b.base, ctx.sid, ctx.opts.query), { perf: true });
            try {
                if (failed) { ctx.fail(`${ctx.sid} @ ${b.rev}: ${failed}`); continue; }
                await settle(s);
                await s.send('Page.bringToFront');
                await s.evaluate(`__step(${this.p.frames})`);
                const from = await s.evaluate('__harness.gpu.length');
                await s.evaluate(`__step(${this.p.measure})`);
                runs[b.rev].push(await gpuTime(s, from));
            } finally { await s.close(); }
        }
        await ctx.runner.braveFor({ perf: false });
        const best = rs => rs.length ? Math.min(...rs.map(r => r.median)) : NaN;
        fs.writeFileSync(ctx.path('work', 'perf.json'), JSON.stringify(Object.fromEntries(revs.map(r => [r, runs[r]])), null, 1));
        ctx.note(`GPU span ${revs.map(r => `${r} ${runs[r].map(x => x.median.toFixed(2)).join(' / ')}`).join('   ')} ms (best ${revs.map(r => best(runs[r]).toFixed(2)).join(' vs ')})`);
        ctx.vars.perf = Object.fromEntries(revs.map(r => [r, best(runs[r])]));
        if (revs.some(r => !runs[r].length || !(best(runs[r]) > 0))) ctx.fail('no GPU timings (timestamp-query unavailable?)');
        else if (this.p.expect?.maxRatio) for (const r of revs.slice(1)) {
            const q = best(runs[r]) / best(runs[revs[0]]);
            if (q > this.p.expect.maxRatio) ctx.fail(`${r} takes ${q.toFixed(2)}x the GPU time of ${revs[0]} (at most ${this.p.expect.maxRatio}x)`);
        }
    }
}

// format goldens (§6.2 G3): what the case's scenario becomes for the engine (per site: type, kits, features, native),
// equal key for key to `dir`/<scenario>.json (baselines/format); record mode writes it
export class FormatGolden extends Action {
    static pageless = true;
    static params = { dir: 'baselines/format' };
    async run(ctx) {
        const { createRequire } = await import('node:module');
        const SF = createRequire(import.meta.url)(path.join(ctx.runner.served, 'js/engine/scenario-format.js'));
        const load = async id => JSON.parse(fs.readFileSync(path.join(ctx.runner.served, 'scenarios', `${id}.json`), 'utf8'));
        const scenario = await SF.resolveIncludes(await load(ctx.sid), load), golden = {};
        for (const root of SF.sites(scenario))
            golden[root.id] = { type: root.type, kits: SF.kitsOf(scenario, root), features: SF.featuresOf(scenario, root), native: SF.toNative(scenario, root) };
        const file = path.join(ROOT, this.p.dir, `${ctx.sid}.json`);
        if (ctx.mode === 'record') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(golden, null, 1) + '\n'); return ctx.note(`wrote ${path.relative(ROOT, file)}`); }
        if (!fs.existsSync(file)) return ctx.fail(`no golden ${path.relative(ROOT, file)}`);
        for (const d of differences(JSON.parse(fs.readFileSync(file, 'utf8')), golden)) ctx.fail(`format: ${d}`);
        ctx.note(`format: ${Object.keys(golden).join(', ')}`);
    }
}

// the single-world guard (§6.2 G8, tools/check-single-world.mjs) on the served files: the code once a run (on its first
// case), the case's scenario every case
export class SingleWorld extends Action {
    static pageless = true;
    async run(ctx) {
        const { checkCode, checkScenario } = await import('../check-single-world.mjs'), root = ctx.runner.served;
        const found = [...(ctx.runner.singleWorldCode ? [] : (ctx.runner.singleWorldCode = true, checkCode(root))), ...checkScenario(ctx.sid, root)];
        for (const f of found) ctx.fail(`${f.at}: ${f.what}`);
        if (!found.length) ctx.note('single world: clean');
    }
}

// ----------------------------------------------------------------------------------------------- the registry
export const ACTIONS = Object.fromEntries([Open, Settle, Step, Wait, Close, View, Views, Eye, Move, Travel, Input, Key, KeyDown, KeyUp, Click, Drag, Handheld,
    Eval, Expect, Log, Save, Counts, Submits, Kits, Errors, Bindings, Trace, Capture, Sky, Pixels, Sheet, Compare, Perf, FormatGolden, SingleWorld].map(A => [A.key, A]));
