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
// Determinism (the page never sees real time): a fake clock (performance.now, Date.now) that moves 1/60 s per stepped
// frame, a seeded Math.random, requestAnimationFrame stubbed and its callbacks called by the harness (entities.frame(t)),
// `timestamp-query` hidden (the atmosphere's dynamic resolution would follow GPU timings), the weather's `transition`
// made tiny (no mid-blend early frames), #engine-bar / #engine-side / toasts hidden, a 960 x 600 viewport at
// devicePixelRatio 1, the cache off in the page's own CDP session, network idle and no app loading or baking before the
// first frame (settle). The Brave is its own instance (--user-data-dir under <work>), never the user's session.
//
// Counters (window.__harness in the page): constructions per host class (Common.Composite.of: World, Renderer, App),
// queue.submit and queue.writeBuffer calls per stepped frame, and Object.keys(Features.kits).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as PNG from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const W = 960, H = 600;
const abs = p => path.isAbsolute(p) ? p : path.join(ROOT, p);
fs.mkdirSync(opt.work, { recursive: true });

// ----------------------------------------------------------------------------------------------- the page's prelude
const PRELUDE = `(() => {
  let clock = 1000, seed = 12345;
  const H = window.__harness = { counts: {}, submits: 0, writes: 0, frames: [] };
  if (self.GPUSupportedFeatures && !window.__perf) { const has = GPUSupportedFeatures.prototype.has; GPUSupportedFeatures.prototype.has = function (f) { return f !== 'timestamp-query' && has.call(this, f); }; }
  if (self.GPUQueue) {
    const submit = GPUQueue.prototype.submit, write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.submit = function (...a) { H.submits++; return submit.apply(this, a); };
    GPUQueue.prototype.writeBuffer = function (...a) { H.writes++; return write.apply(this, a); };
  }
  // no input but the harness's own (smoke: window.__input): the test window is on the user's screen, and a mouse passing
  // over it would move the water's tool ring or light a GUI button
  for (const t of ['pointermove', 'pointerdown', 'pointerup', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mousemove', 'mousedown',
    'mouseup', 'mouseover', 'mouseout', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'touchend'])
    window.addEventListener(t, e => { if (!window.__input) e.stopImmediatePropagation(); }, { capture: true });
  window.__raf = [];
  window.requestAnimationFrame = cb => { window.__raf.push(cb); return window.__raf.length; };
  window.cancelAnimationFrame = () => {};
  performance.now = () => clock;
  // (new Date() too: the GUIs' clocks)
  const RealDate = Date;
  window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1.7e12 + clock])); } static now() { return 1.7e12 + clock; } };
  Math.random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  // one frame: the clock 1/60 s on, the rAF callbacks (Host.frame), the GPU's work done
  window.__step = async n => {
    for (let i = 0; i < n; i++) {
      clock += 1000 / 60;
      const q = window.__raf; window.__raf = [];
      const s = H.submits, w = H.writes;
      H.gpuFrame?.();
      for (const cb of q) cb(clock);
      H.frames.push({ submits: H.submits - s, writes: H.writes - w });
      const d = window.entities?.device;
      if (d) await d.queue.onSubmittedWorkDone();
      await new Promise(r => setTimeout(r, 0));
    }
    return window.entities?.frameNo;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = '#engine-toast, [data-hud=toast], #engine-bar, #engine-side { display: none !important; }';
    document.head.appendChild(st);
    // every World / Renderer / App made (Common.Composite.of wraps each)
    const C = Common.Composite, of = C.of;
    C.of = host => { const n = host.constructor.name; H.counts[n] = (H.counts[n] || 0) + 1; return window.__trace ? __trace(host, of(host)) : of(host); };
    // the weather blends in no time
    const loadKit = Features.loadKit;
    Features.loadKit = function (name, engine) {
      const p = loadKit.call(this, name, engine);
      if (name === 'weather') p.then(k => {
        const P = k.WeatherSystem?.prototype;
        if (P && !Object.getOwnPropertyDescriptor(P, 'transition')) Object.defineProperty(P, 'transition', { configurable: true,
          set() { Object.defineProperty(this, 'transition', { value: 1e-3, writable: true, enumerable: true }); }, get() { return 1e-3; } });
      });
      return p;
    };
  });
})();`;

// --trace: every member a host (World / Renderer / App) answers through its base extension (Common.Composite's
// forwarding), by base and kind (get / set / has), with where it was asked from and whether the base was still being
// built: __harness.trace { '<host> <- <base class> <file>': { '<get|set|has> <name>': { ctor, from: [file:line...] } } }
const TRACE = `(() => {
  const srcOf = new WeakMap(), seen = new Map();
  const frames = () => new Error().stack.split('\\n').slice(1).map(l => l.trim());
  const at = l => (l.match(/\\/(js\\/[^)]*?):(\\d+):\\d+\\)?$/) || []).slice(1, 3).join(':');
  document.addEventListener('DOMContentLoaded', () => {
    const C = Common.Composite, mount = C.mount;
    C.mount = (host, base) => { srcOf.set(base, at(frames().find(l => l.startsWith('at new ')) || '')); return mount(host, base); };
  });
  window.__trace = (raw, inner) => {
    const T = window.__harness.trace ??= {};
    const note = (kind, k) => {
      const b = raw.base, label = raw.constructor.name + ' <- ' + b.constructor.name + ' ' + (srcOf.get(b) || '?').split(':')[0];
      const t = T[label] ??= {}, key = kind + ' ' + k, e = t[key] ??= { n: 0, ctor: false, from: [] };
      if (e.n++ > 30) return;
      const fs = frames().slice(2), from = at(fs.find(l => at(l) && !l.includes('common.js')) || '');
      if (from && !e.from.includes(from) && e.from.length < 6) e.from.push(from);
      if (fs.some(l => l.startsWith('at new ' + b.constructor.name + ' '))) e.ctor = true;
    };
    return new Proxy(inner, {
      get(t, k, r) { if (typeof k === 'string' && raw.base && !(k in raw) && k in raw.base) note('get', k); return Reflect.get(t, k, r); },
      set(t, k, v, r) { if (typeof k === 'string' && raw.base && !(k in raw)) note(k in raw.base ? 'set' : 'add', k); return Reflect.set(t, k, v, r); },
      has(t, k) { if (typeof k === 'string' && raw.base && !(k in raw) && k in raw.base) note('has', k); return Reflect.has(t, k); },
    });
  };
})();`;

// --bindings: every pipeline layout made, with its bind group layouts' sampled textures, samplers, storage and uniform
// buffers and storage textures per shader stage (WebGPU's default limits: 16 sampled textures, 8 storage buffers, 4
// storage textures, 12 uniform buffers, 16 samplers per stage; 4 bind groups): __harness.bindings [{ label, groups,
// stages: { vertex | fragment | compute: counts } }], plus the pipelines made with layout 'auto' (not counted)
const BINDINGS = `(() => {
  const B = window.__harness.bindings = { layouts: [], auto: 0 }, info = new WeakMap();
  const STAGES = [[1, 'vertex'], [2, 'fragment'], [4, 'compute']];
  const kind = e => e.texture ? 'sampled' : e.sampler ? 'samplers' : e.storageTexture ? 'storageTextures' : e.externalTexture ? 'sampled'
    : e.buffer?.type === 'storage' || e.buffer?.type === 'read-only-storage' ? 'storage' : 'uniform';
  const bgl = GPUDevice.prototype.createBindGroupLayout;
  GPUDevice.prototype.createBindGroupLayout = function (d) { const l = bgl.call(this, d); info.set(l, { label: d.label || '', entries: d.entries || [] }); return l; };
  const pl = GPUDevice.prototype.createPipelineLayout;
  GPUDevice.prototype.createPipelineLayout = function (d) {
    const l = pl.call(this, d), groups = (d.bindGroupLayouts || []).map(g => info.get(g)), stages = {};
    for (const [bit, name] of STAGES) {
      const c = { sampled: 0, samplers: 0, storage: 0, uniform: 0, storageTextures: 0 };
      for (const g of groups) for (const e of g?.entries || []) if (e.visibility & bit) c[kind(e)]++;
      if (Object.values(c).some(Boolean)) stages[name] = c;
    }
    B.layouts.push({ label: d.label || groups.map(g => g?.label).filter(Boolean).join('+') || '', groups: groups.length, stages,
      at: (new Error().stack.split('\\n').slice(2).find(s => /\\/js\\//.test(s)) || '').replace(/^.*\\/(js\\/[^)]*?):(\\d+):\\d+\\)?$/, '$1:$2') });
    return l;
  };
  for (const m of ['createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const f = GPUDevice.prototype[m];
    GPUDevice.prototype[m] = function (d) { if (d && d.layout === 'auto') B.auto++; return f.call(this, d); };
  }
})();`;
const LIMITS = { sampled: 16, samplers: 16, storage: 8, uniform: 12, storageTextures: 4 };

// perf: GPU time per pass, whatever the renderer: every render and compute pass gets timestamps in a query set of the
// harness's (over the pass's own: a renderer's profiler then reads nothing), resolved by a command buffer added to each
// submit and read back; __harness.gpu: per stepped frame { ms (the passes' sum: passes overlapping in one command buffer
// count twice), span (first pass begin to last pass end: the frame's GPU time), passes: { label: ms } }
const PERF = `(() => {
  const H = window.__harness, MAX = 1024;
  let dev = null, qs = null, res = null, used = 0, labels = [], frame = null;
  const free = [];
  H.gpu = [];
  H.gpuFrame = () => { frame = { ms: 0, passes: {}, pending: 0, t0: null, t1: null }; H.gpu.push(frame); };
  const ad = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (d) {
    const device = await ad.call(this, d);
    if (device.features.has('timestamp-query')) {
      dev = device;
      qs = device.createQuerySet({ type: 'timestamp', count: MAX * 2 });
      res = device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    }
    return device;
  };
  const stamp = (d, kind) => {
    if (!qs || used >= MAX) return d;
    const i = used++;
    labels.push((d && d.label) || kind);
    return { ...(d || {}), timestampWrites: { querySet: qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } };
  };
  const rp = GPUCommandEncoder.prototype.beginRenderPass, cp = GPUCommandEncoder.prototype.beginComputePass;
  GPUCommandEncoder.prototype.beginRenderPass = function (d) { return rp.call(this, stamp(d, 'render')); };
  GPUCommandEncoder.prototype.beginComputePass = function (d) { return cp.call(this, stamp(d, 'compute')); };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (cbs) {
    if (!qs || !used) return submit.call(this, cbs);
    const n = used, names = labels, f = frame;
    used = 0; labels = [];
    const buf = free.pop() || dev.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.resolveQuerySet(qs, 0, n * 2, res, 0);
    enc.copyBufferToBuffer(res, 0, buf, 0, n * 16);
    const r = submit.call(this, [...cbs, enc.finish()]);
    if (f) f.pending++;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(buf.getMappedRange(0, n * 16));
      for (let i = 0; i < n; i++) {
        const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (!f || !(ms >= 0 && ms < 1000)) continue;
        f.ms += ms;
        f.passes[names[i]] = (f.passes[names[i]] || 0) + ms;
        if (f.t0 === null || t[i * 2] < f.t0) f.t0 = t[i * 2];
        if (f.t1 === null || t[i * 2 + 1] > f.t1) f.t1 = t[i * 2 + 1];
      }
      if (f && f.t0 !== null) f.span = Number(f.t1 - f.t0) / 1e6;
      buf.unmap();
      free.push(buf);
      if (f) f.pending--;
    });
    return r;
  };
})();`;

// ----------------------------------------------------------------------------------------------- static server
// what the page is served from: a copy of the page's files made when the run starts, so an edit during a run never
// reaches the scenarios still to come (--live: the checkout itself)
function snapshot(rev = opt.rev, name = 'serve') {
    if (opt.live && !rev) return ROOT;
    const dir = path.join(opt.work, name), parts = ['index.html', 'css', 'js', 'scenarios'];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (rev) {
        execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'snapshot.tar'), rev, ...parts], { cwd: ROOT });
        execFileSync('tar', ['-xf', 'snapshot.tar'], { cwd: dir });
    }
    else for (const p of parts) fs.cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
    return dir;
}

function serve(root, port = opt.servePort) {
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
        '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' };
    const server = http.createServer((req, res) => {
        const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
        fs.stat(p, (err, st) => {
            const f = !err && st.isDirectory() ? path.join(p, 'index.html') : p;
            fs.readFile(f, (e, data) => {
                if (e) { res.writeHead(404); return res.end('not found'); }
                res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
                res.end(data);
            });
        });
    });
    return new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', () => r(server)); });
}

// ----------------------------------------------------------------------------------------------- Brave + CDP
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP = `http://127.0.0.1:${opt.port}`;
async function version() { try { return await (await fetch(`${CDP}/json/version`)).json(); } catch { return null; } }

async function brave() {
    let v = await version();
    if (v) return { v, proc: null };
    const profile = path.join(opt.work, 'profile');
    const proc = spawn(opt.brave, [`--user-data-dir=${profile}`, `--remote-debugging-port=${opt.port}`, '--no-first-run', '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion', '--window-size=1040,760',
        // Canvas 2D on the CPU: GPU-rasterised canvases (the imposter world's procedural textures) differ a little from
        // one browser session to the next
        '--disable-accelerated-2d-canvas',
        // (perf: GPU timestamps unquantised)
        ...(mode === 'perf' ? ['--enable-webgpu-developer-features'] : []), 'about:blank'], { stdio: 'ignore', detached: false });
    for (let k = 0; k < 60 && !(v = await version()); k++) await sleep(500);
    if (!v) throw new Error(`Brave did not answer on ${CDP}`);
    return { v, proc };
}

// closes the Brave this run started (Browser.close), and waits until its port is free
async function closeBrave(b) {
    if (!b.proc) return;
    try {
        const ws = new WebSocket(b.v.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch { b.proc.kill(); }
    for (let k = 0; k < 40 && await version(); k++) await sleep(250);
}

async function tab() {
    const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const wait = new Map(), events = [], inflight = new Set();
    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
        if (d.method === 'Network.requestWillBeSent') inflight.add(d.params.requestId);
        else if (d.method === 'Network.loadingFinished' || d.method === 'Network.loadingFailed') inflight.delete(d.params.requestId);
        else events.push(d);
    };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
        return r.result?.result?.value;
    };
    const errors = () => events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
        .map(e => e.method === 'Runtime.exceptionThrown' ? 'exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split('\n')[0]
            : 'error: ' + e.params.args.map(a => a.value ?? a.description).join(' ').split('\n')[0]);
    const warnings = () => events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning')
        .map(e => e.params.args.map(a => a.value ?? a.description).join(' ').split('\n')[0]);
    const close = async () => { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
    return { send, evaluate, events, inflight, errors, warnings, close };
}

// before the first stepped frame: no request in flight, and no app still loading or baking what it loads after the host
// is ready (the imposter world bakes its atlases then: on whichever frame they land, the pictures would differ)
const BUSY = `[...(window.entities?.instances || []).map(i => i.world?.app), window.entities?.app].some(a => a && (a.loading || a.baking))`;
async function settle(s) {
    for (let k = 0; k < 240; k++) {
        if (!s.inflight.size && !(await s.evaluate(BUSY).catch(() => false))) return;
        await sleep(250);
    }
}

const fileOf = key => String(key).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'view';

// one scenario: the start view after opt.frames, then every view of the handheld's View list (entities.viewList)
async function capture(base, sid, dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const s = await tab();
    const t0 = Date.now();
    try {
        await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('Network.setCacheDisabled', { cacheDisabled: true }); await s.send('Page.enable');
        await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
        if (opt.trace) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACE });
        if (opt.bindings) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: BINDINGS });
        const q =['scenario=' + encodeURIComponent(sid), ...opt.query].join('&');
        await s.send('Page.navigate', { url: `${base}/index.html?${q}` });
        let state = null;
        for (let k = 0; k < 240 && !state; k++) {
            await sleep(500);
            state = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show') ? 'failed' : window.entities && entities.last !== undefined ? 'ready' : null`).catch(() => null);
        }
        if (state !== 'ready') {
            const msg = state ? await s.evaluate(`document.getElementById('error-message').textContent`) : 'timed out';
            return { sid, failed: String(msg).split('\n').slice(0, +(process.env.STACK || 3)).join(' | '), errors: s.errors() };
        }
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
            const over = B.layouts.flatMap(l => Object.entries(l.stages).flatMap(([st, c]) => Object.entries(c).filter(([k, n]) => n > LIMITS[k])
                .map(([k, n]) => `${l.label || '(no label)'} ${l.at} ${st}: ${n} ${k} > ${LIMITS[k]}`)));
            const groups = B.layouts.filter(l => l.groups > 4).map(l => `${l.label || '(no label)'} ${l.at}: ${l.groups} bind groups > 4`);
            // the most of each kind per stage, and where
            const top = {};
            for (const l of B.layouts) for (const [st, c] of Object.entries(l.stages)) for (const [k, n] of Object.entries(c)) {
                const key = `${st} ${k}`;
                if (!top[key] || n > top[key].n) top[key] = { n, at: `${l.label || '(no label)'} ${l.at}` };
            }
            bindings = { layouts: B.layouts.length, auto: B.auto, over: [...over, ...groups], top };
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
    const s = await tab();
    try {
        await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('Network.setCacheDisabled', { cacheDisabled: true }); await s.send('Page.enable');
        await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__perf = true;' });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PERF });
        await s.send('Page.navigate', { url: `${base}/index.html?scenario=${encodeURIComponent(sid)}` });
        let state = null;
        for (let k = 0; k < 240 && !state; k++) {
            await sleep(500);
            state = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show') ? 'failed' : window.entities && entities.last !== undefined ? 'ready' : null`).catch(() => null);
        }
        if (state !== 'ready') return { sid, failed: state || 'timed out' };
        await settle(s);
        await s.send('Page.bringToFront');
        await s.evaluate(`__step(${opt.frames})`);
        const from = await s.evaluate('__harness.gpu.length');
        await s.evaluate(`__step(${opt.viewFrames})`);
        for (let k = 0; k < 40 && await s.evaluate(`__harness.gpu.slice(${from}).some(f => f.pending)`); k++) await sleep(50);
        const frames = await s.evaluate(`__harness.gpu.slice(${from}).map(f => ({ ms: f.ms, span: f.span || 0, passes: f.passes }))`);
        const med = xs => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
        const labels = [...new Set(frames.flatMap(f => Object.keys(f.passes)))];
        return { sid, median: med(frames.map(f => f.span)), sum: med(frames.map(f => f.ms)), passes: Object.fromEntries(labels.map(l => [l, med(frames.map(f => f.passes[l] || 0))])), errors: s.errors() };
    } finally { await s.close(); }
}

// one scenario, an expression run in it after opt.frames (eval mode): { sid, before, value, after, frames, errors }
async function evalIn(base, sid) {
    const s = await tab();
    try {
        await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('Network.setCacheDisabled', { cacheDisabled: true }); await s.send('Page.enable');
        await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
        await s.send('Page.navigate', { url: `${base}/index.html?scenario=${encodeURIComponent(sid)}` });
        let state = null;
        for (let k = 0; k < 240 && !state; k++) {
            await sleep(500);
            state = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show') ? 'failed' : window.entities && entities.last !== undefined ? 'ready' : null`).catch(() => null);
        }
        if (state !== 'ready') return { sid, failed: state || 'timed out', errors: s.errors() };
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
        const failed = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show')`);
        return { sid, before, value, after: await counts(), frames: [f0, f1], failed, errors: s.errors() };
    } finally { await s.close(); }
}

// the key smoke run (§6.2 G6) on one scenario
async function smoke(base, sid) {
    const s = await tab();
    try {
        await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('Network.setCacheDisabled', { cacheDisabled: true }); await s.send('Page.enable');
        await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
        await s.send('Page.navigate', { url: `${base}/index.html?scenario=${encodeURIComponent(sid)}` });
        let state = null;
        for (let k = 0; k < 240 && !state; k++) {
            await sleep(500);
            state = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show') ? 'failed' : window.entities && entities.last !== undefined ? 'ready' : null`).catch(() => null);
        }
        if (state !== 'ready') return { sid, failed: state || 'timed out', errors: s.errors() };
        await settle(s);
        await s.evaluate('window.__input = true');
        await s.send('Page.bringToFront');
        await s.evaluate(`__step(10)`);
        // where the camera is: the engine's (entities.camera after Phase 5), else the camera world's in composition space
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
const served = snapshot(), server = await serve(served);
const base = `http://127.0.0.1:${server.address().port}`;
let browser = await brave();
const { v } = browser;
console.log(`${v.Browser} on ${CDP}, serving ${served} at ${base}, mode ${mode}`);
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/index.json'), 'utf8')).map(s => s.id);
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
