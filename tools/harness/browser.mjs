// The browser side of the test tools (tools/pixel-harness.mjs, tools/seq.mjs): the page's prelude and probes, the
// snapshot server, an isolated Brave over CDP and its tabs. Nothing here knows about modes or sequences.
//
// Determinism (the page never sees real time): a fake clock (performance.now, Date.now) that moves 1/60 s per stepped
// frame, a seeded Math.random, requestAnimationFrame stubbed and its callbacks called by the harness (entities.frame(t)),
// `timestamp-query` hidden (the atmosphere's dynamic resolution would follow GPU timings), the weather's `transition`
// made tiny (no mid-blend early frames), #engine-bar / #engine-side / toasts hidden, a 960 x 600 viewport at
// devicePixelRatio 1, the cache off in the page's own CDP session, network idle and no app loading or baking before the
// first frame (settle). The Brave is its own instance (--user-data-dir under the work dir), never the user's session.
//
// Counters (window.__harness in the page): constructions per host class (Common.Composite.of: World, Renderer, App),
// queue.submit and queue.writeBuffer calls per stepped frame, and Object.keys(Features.kits).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const W = 960, H = 600;
export const BRAVE = process.env.BRAVE || 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fileOf = key => String(key).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'view';
export const scenarioIds = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/index.json'), 'utf8')).map(s => s.id);

// ----------------------------------------------------------------------------------------------- the page's prelude
export const PRELUDE = `(() => {
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
export const TRACE = `(() => {
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
export const BINDINGS = `(() => {
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
export const LIMITS = { sampled: 16, samplers: 16, storage: 8, uniform: 12, storageTextures: 4 };

// perf: GPU time per pass, whatever the renderer: every render and compute pass gets timestamps in a query set of the
// harness's (over the pass's own: a renderer's profiler then reads nothing), resolved by a command buffer added to each
// submit and read back; __harness.gpu: per stepped frame { ms (the passes' sum: passes overlapping in one command buffer
// count twice), span (first pass begin to last pass end: the frame's GPU time), passes: { label: ms } }
export const PERF = `(() => {
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
// reaches the scenarios still to come (live: the checkout itself; rev: that commit's files)
export function snapshot(work, { rev = null, live = false, name = 'serve' } = {}) {
    if (live && !rev) return ROOT;
    const dir = path.join(work, name), parts = ['index.html', 'css', 'js', 'scenarios'];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (rev) {
        execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'snapshot.tar'), rev, ...parts], { cwd: ROOT });
        execFileSync('tar', ['-xf', 'snapshot.tar'], { cwd: dir });
    }
    else for (const p of parts) fs.cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
    return dir;
}

export function serve(root, port) {
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
const cdp = port => `http://127.0.0.1:${port}`;
export async function version(port) { try { return await (await fetch(`${cdp(port)}/json/version`)).json(); } catch { return null; } }

// an isolated Brave on `port` (or the one already answering there); perf: GPU timestamps unquantised
export async function brave({ work, port, path: exe = BRAVE, perf = false }) {
    let v = await version(port);
    if (v) return { v, proc: null, port, perf: null };
    const profile = path.join(work, 'profile');
    const proc = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion', '--window-size=1040,760',
        // Canvas 2D on the CPU: GPU-rasterised canvases (the imposter world's procedural textures) differ a little from
        // one browser session to the next
        '--disable-accelerated-2d-canvas',
        ...(perf ? ['--enable-webgpu-developer-features'] : []), 'about:blank'], { stdio: 'ignore', detached: false });
    for (let k = 0; k < 60 && !(v = await version(port)); k++) await sleep(500);
    if (!v) throw new Error(`Brave did not answer on ${cdp(port)}`);
    return { v, proc, port, perf };
}

// closes the Brave this run started (Browser.close), and waits until its port is free
export async function closeBrave(b) {
    if (!b?.proc) return;
    try {
        const ws = new WebSocket(b.v.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch { b.proc.kill(); }
    for (let k = 0; k < 40 && await version(b.port); k++) await sleep(250);
}

export async function tab(port) {
    const t = await (await fetch(`${cdp(port)}/json/new?about:blank`, { method: 'PUT' })).json();
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
    const close = async () => { ws.close(); await fetch(`${cdp(port)}/json/close/${t.id}`).catch(() => {}); };
    return { send, evaluate, events, inflight, errors, warnings, close };
}

// a tab on `url` (index.html?scenario=...) with the prelude and the probes asked for ({ perf, trace, bindings }), waited
// on until the engine is up: { s, failed } (failed: the fallback's message, its first `stack` lines; or 'timed out')
export async function open(port, url, { perf = false, trace = false, bindings = false, stack = +(process.env.STACK || 3) } = {}) {
    const s = await tab(port);
    await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('Network.setCacheDisabled', { cacheDisabled: true }); await s.send('Page.enable');
    await s.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    if (perf) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__perf = true;' });
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
    if (perf) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PERF });
    if (trace) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACE });
    if (bindings) await s.send('Page.addScriptToEvaluateOnNewDocument', { source: BINDINGS });
    await s.send('Page.navigate', { url });
    let state = null;
    for (let k = 0; k < 240 && !state; k++) {
        await sleep(500);
        state = await s.evaluate(`document.getElementById('fallback')?.classList.contains('show') ? 'failed' : window.entities && entities.last !== undefined ? 'ready' : null`).catch(() => null);
    }
    if (state === 'ready') return { s, failed: null };
    const msg = state ? await s.evaluate(`document.getElementById('error-message').textContent`).catch(() => 'failed') : 'timed out';
    return { s, failed: String(msg).split('\n').slice(0, stack).join(' | ') };
}

// before the first stepped frame: no request in flight, and no app still loading or baking what it loads after the host
// is ready (the imposter world bakes its atlases then: on whichever frame they land, the pictures would differ)
export const BUSY = `[...(window.entities?.sites || []).map(s => s.ctx?.app), window.entities?.app].some(a => a && (a.loading || a.baking))`;
export async function settle(s, tries = 240) {
    for (let k = 0; k < tries; k++) {
        if (!s.inflight.size && !(await s.evaluate(BUSY).catch(() => false))) return true;
        await sleep(250);
    }
    return false;
}

// the binding budget of the layouts BINDINGS saw: { layouts, auto, over: [...], top: { '<stage> <kind>': { n, at } } }
export function bindingBudget(B) {
    const over = B.layouts.flatMap(l => Object.entries(l.stages).flatMap(([st, c]) => Object.entries(c).filter(([k, n]) => n > LIMITS[k])
        .map(([k, n]) => `${l.label || '(no label)'} ${l.at} ${st}: ${n} ${k} > ${LIMITS[k]}`)));
    const groups = B.layouts.filter(l => l.groups > 4).map(l => `${l.label || '(no label)'} ${l.at}: ${l.groups} bind groups > 4`);
    // the most of each kind per stage, and where
    const top = {};
    for (const l of B.layouts) for (const [st, c] of Object.entries(l.stages)) for (const [k, n] of Object.entries(c)) {
        const key = `${st} ${k}`;
        if (!top[key] || n > top[key].n) top[key] = { n, at: `${l.label || '(no label)'} ${l.at}` };
    }
    return { layouts: B.layouts.length, auto: B.auto, over: [...over, ...groups], top };
}

// the GPU time PERF measured from stepped frame `from` on, once read back: { median (span: the frame's GPU time, ms),
// sum (the passes' sum), passes: { label: median ms } }
export async function gpuTime(s, from) {
    for (let k = 0; k < 40 && await s.evaluate(`__harness.gpu.slice(${from}).some(f => f.pending)`); k++) await sleep(50);
    const frames = await s.evaluate(`__harness.gpu.slice(${from}).map(f => ({ ms: f.ms, span: f.span || 0, passes: f.passes }))`);
    const med = xs => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
    const labels = [...new Set(frames.flatMap(f => Object.keys(f.passes)))];
    return { median: med(frames.map(f => f.span)), sum: med(frames.map(f => f.ms)), passes: Object.fromEntries(labels.map(l => [l, med(frames.map(f => f.passes[l] || 0))])) };
}

// one scenario's page URL: index.html?scenario=<id>&<query...>
export const pageUrl = (base, sid, query = []) => `${base}/index.html?${['scenario=' + encodeURIComponent(sid), ...query].join('&')}`;
