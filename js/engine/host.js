'use strict';
// Host: boots a scenario and runs it on the one World, the one Renderer and the one App.
//
//   1. catalog + scenario (scenarios/*.json over HTTP, or the embedded copies when opened from disk; a dropped file)
//   2. one GPU device, one canvas; the World, the Renderer and the App, made empty here and extended by the kits the
//      scenario uses (Common.Composite: each kit's World, Renderer and App extensions; the handheld's GUI renderer beside
//      the Renderer, renderer.ext.handheld)
//   3. its site (a scenario of plain entities implies one: ScenarioFormat), built by its kit's parts (Features) from its
//      entities (ScenarioFormat.toNative), the kits of its entities' types and the features its data asks for loaded
//      first (ScenarioFormat.kitsOf / featuresOf: fx.features); what the host asks of it (its camera, views, ground,
//      stats, options, parameters...) is its kit's world type's spec, kept beside the App (Site, app.ext.site), with the
//      HUD root (in-world labels, toasts) and input scope; its options and readouts go on the handheld (handheld.js)
//   4. the frame: the site's update and render, then links and sound read the frame's stats, and the handheld draws over
//      the finished frame; all of it into one command encoder, submitted once at the end of the frame (gpuFrame, the gpu
//      kit's GpuFrame: renderer.frameEncoder())
//
// A scenario of several sites (a composition) still runs one world per site: js/engine/legacy-host.js (LegacyHost),
// which this one hands it to, until its sites share the one World too (docs/single-world-plan.md Phase 6).
//
// Engine entities: camera, view, link, site, features, hud.toast, handheld, handheld.page, sound.* (see camera.js,
// audio.js, hud.js, handheld.js). A link sets a parameter of the site from an expression every frame: { type: "link",
// to: "<site id>.<param>", value: expr }.
//
// Switching scenario reloads the page (?scenario=<id>): every scenario starts from a clean page and GPU device.

class Host {
    static DROPPED = 'dropped';

    // link values: numbers and vectors change when they move by more than a hair
    static same(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Host.same(x, b[i]));
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a));
        return a === b;
    }

    constructor() {
        this.links = [];
        this.width = this.height = 0;
        this.fps = 60;
        this.time = 0;
        this.frameNo = 0;
        this.fly = null;
        this.canvasView = null;
        this.site = null;               // { id, type, label, def, ui, ctx, world (its Site), ready }
        this.sites = [];                // (the handheld lists what they offer)
    }

    // the page's parts (once it is this host's scenario)
    setup() {
        this.canvas = document.getElementById('view');
        this.router = new InputRouter(this.canvas);
        this.audio = new AudioEngine();
        this.hud = new EngineHud(this);
        this.handheld = new Handheld(this);
    }

    // ------------------------------------------------------------------------------------------- catalog
    // over HTTP the .json files themselves (edits show without re-running the embed tool); from disk, where browsers
    // block fetch(), the embedded copies
    get local() { return location.protocol === 'file:'; }

    async loadCatalog() {
        const embedded = window.EMBEDDED_SCENARIOS || {};
        try {
            if (this.local) throw new Error('file:');
            const res = await fetch('scenarios/index.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.catalog = await res.json();
        } catch {
            this.catalog = embedded.index || [];
        }
        if (!this.catalog.length) throw new Error('No scenarios: scenarios/index.json could not be read (run node tools/embed-scenarios.mjs)');
    }

    // a scenario with its includes spliced in (ScenarioFormat.resolveIncludes)
    async loadScenario(id) {
        return ScenarioFormat.resolveIncludes(await this.fetchScenario(id), inc => this.fetchScenario(inc));
    }

    async fetchScenario(id) {
        if (id === Host.DROPPED) {
            const text = sessionStorage.getItem('entities.dropped');
            if (!text) throw new Error('The dropped scenario is gone from this tab; drop it again');
            return JSON.parse(text);
        }
        const file = `scenarios/${id}.json`;
        try {
            if (this.local) throw new Error('opened from disk, embedded copy only');
            const res = await fetch(file, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            const copy = (window.EMBEDDED_SCENARIOS || {})[file];
            if (copy) return copy;
            throw new Error(`Could not load ${file} (${err.message})`);
        }
    }

    get scenarioId() {
        const p = new URLSearchParams(location.search).get('scenario');
        if (p) return p;
        try { const last = localStorage.getItem('webgpu-entities.scenario'); if (last && this.catalog.some(s => s.id === last)) return last; } catch { /* storage blocked */ }
        return this.catalog[0].id;
    }

    pickScenario(id) {
        try { localStorage.setItem('webgpu-entities.scenario', id); } catch { /* storage blocked */ }
        const url = new URL(location.href);
        url.searchParams.set('scenario', id);
        location.assign(url);
    }

    // a dropped .json: a scenario of entities, or a native one made for one of the single demos
    async dropFile(file) {
        try {
            let data = JSON.parse(await file.text());
            if (!Array.isArray(data.entities)) data = Host.importNative(data, file.name);
            sessionStorage.setItem('entities.dropped', JSON.stringify(data));
            this.pickScenario(Host.DROPPED);
        } catch (err) {
            this.hud.toast(`Could not load ${file.name}: ${err.message}`, 6000);
        }
    }

    // which world a native scenario was made for: the schema that takes all its keys and shares the most with it
    static importNative(native, name) {
        let best = null;
        for (const f of Object.keys(ScenarioFormat.SCHEMAS)) {
            try {
                const entities = ScenarioFormat.fromNative(f, native);
                const s = ScenarioFormat.SCHEMAS[f], keys = [...s.config, ...Object.keys(s.lists), ...Object.keys(s.maps).map(p => p.split('.')[0])];
                const score = Object.keys(native).filter(k => keys.includes(k)).length;
                if (!best || score > best.score) best = { score, f, entities };
            } catch { /* not this world */ }
        }
        if (!best || !best.score) throw new Error('not a scenario of entities, nor one made for any of the worlds');
        return { name: native.name || name, group: 'Dropped', entities: best.entities };
    }

    // ------------------------------------------------------------------------------------------- boot
    async boot() {
        await this.loadCatalog();
        const id = this.currentId = this.scenarioId;
        const scenario = await this.loadScenario(id);
        // several sites: one world each, for now
        if (ScenarioFormat.roots(scenario).length > 1) {
            const legacy = window.entities = new LegacyHost();
            return legacy.boot(this.catalog, scenario);
        }
        this.setup();
        this.scenario = scenario;
        this.hud.buildBar();
        window.addEventListener('dragover', e => e.preventDefault());
        window.addEventListener('drop', e => {
            e.preventDefault();
            const files = [...e.dataTransfer.files];
            // models and such go to the site (the imposter baker takes .glb / .gltf / .obj), scenarios to the engine
            if (files.some(f => !/\.json$/i.test(f.name)) && this.site?.world.drop) this.site.world.drop(files);
            else if (files[0]) this.dropFile(files[0]);
        });
        document.title = `${scenario.name} · WebGPU Entities`;
        await ScenarioData.load(scenario);         // the data its entities name (a real place's heights, roads, buildings)
        await this.initGpu();
        this.engine = { Expr, GpuChoice, Common, CamMath, LayerFrame, host: this, kits: Features.kits };
        for (const k of Features.ENGINE_KITS) await Features.loadKit(k, this.engine);
        const { World, App } = Features.kits.world, { Renderer, GpuFrame } = Features.kits.gpu;
        this.gpuFrame = new GpuFrame(this.device);
        // the one World, Renderer and App: empty until the site's kit extends them
        this.world = new World();
        this.renderer = new Renderer();
        this.app = new App();
        this.app.attach('handheld', HandheldApp, this.handheld);
        await this.handheld.init(scenario);
        await this.createSite(scenario);
        this.configure(scenario);
        this.last = performance.now();
        requestAnimationFrame(t => this.frame(t));
    }

    async initGpu() {
        if (!navigator.gpu) throw new Error('navigator.gpu is undefined');
        const adapter = await GpuChoice.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter available');
        this.adapter = adapter;
        const features = ['timestamp-query', 'float32-filterable', 'depth32float-stencil8'].filter(f => adapter.features.has(f));
        this.device = await adapter.requestDevice({ requiredFeatures: features });
        this.device.lost.then(info => { if (info.reason !== 'destroyed') showFallback(new Error(`GPU device lost: ${info.message}`)); });
        this.device.addEventListener('uncapturederror', e => { console.error(e.error.message); this.lastError = e.error.message; });
        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
        this.resize();
    }

    // the scenario's site: the kits of its entities, its kit's features its data asks for, its world type's parts, then
    // its context (fx) and its Site beside the App
    async createSite(scenario) {
        const [root] = ScenarioFormat.roots(scenario);
        if (!root) throw new Error(`Scenario "${scenario.name}" has nothing in it (no site, and no entity any kit takes)`);
        if (!root.site) console.info(`${scenario.name}: the root entity { type: "${root.type}" } is read as a site of the ${root.kit} kit`);
        const engine = this.engine;
        for (const k of ScenarioFormat.kitsOf(scenario, root)) await Features.loadKit(k, engine);
        const features = {};
        for (const name of ScenarioFormat.featuresOf(scenario, root)) features[name] = await Features.loadFeature(root.type, name, engine);
        const module = await Features.load(root.type, engine);
        const def = root.def, layer = def.layer || {};
        const ui = document.createElement('div');
        ui.className = 'fhud';
        ui.dataset.world = root.type;
        ui.dataset.id = root.id;
        document.getElementById('world-huds').appendChild(ui);
        const site = this.site = {
            id: root.id, type: root.type, label: def.label || def.name || root.id, def, layer,
            // (what of the screen its in-world labels may show: all of it; nothing else hides any of it)
            ui: { root: ui, $: name => ui.querySelector(`[data-hud="${name}"]`), region: () => null, veil: () => 0 },
        };
        this.sites = [site];
        const ctx = site.ctx = {
            id: root.id, type: root.type, def, native: ScenarioFormat.toNative(scenario, root), layer,
            features,                      // its kit's features its data asks for: { <name>: their exports }
            host: this,
            device: this.device, format: this.format, adapter: this.adapter,
            frame: this.gpuFrame,          // the frame's one encoder and submit (GpuFrame)
            canvas: this.canvas,
            world: this.world, renderer: this.renderer, app: this.app,     // the one World, Renderer and App
            ui: site.ui,
            io: this.router.scope(root.id),
            composed: false,
            cameraLocked: false,           // set while the engine drives the camera (camera.controller: fly)
            inject: null,
            outdoors: null,
            size: () => [this.width, this.height],
            target: () => this.swapView(),
            emit: (name, payload) => this.emit(root.id, name, payload),
            toast: (msg, ms) => this.hud.toast(msg, ms),
            sound: { toggle: () => this.audio.toggle() },
            fail: err => showFallback(err),
            floor: (x, y, z) => this.floorAt(x, y, z),
        };
        site.world = this.app.attach('site', Features.kits.world.Site, ctx, module.spec);
        ui.innerHTML = site.world.hudHtml || '';
        await site.world.init();
        site.ready = true;
    }

    configure(scenario) {
        const ents = scenario.entities || [];
        const site = this.site;
        // camera: the site's, or the engine's free camera
        const cam = this.cameraDef = ents.find(e => e.type === 'camera' && ScenarioFormat.isEngine(e)) || {};
        if (cam.controller === 'fly') {
            this.fly = new FlyCamera(cam, this.router.scope('engine'), (x, y, z) => this.floorAt(x, y, z));
            this.router.always.add('engine');
            site.ctx.cameraLocked = true;
        }
        if (cam.mode) this.setMove(cam.mode, false);
        this.router.setFocus(site.id);
        // (no keys of the engine's own: walk / fly is the handheld's; a key only starts the sound)
        window.addEventListener('keydown', () => this.audio.start());
        window.addEventListener('pointerdown', () => this.audio.start());
        // walking, a click on the world takes the mouse to look (pointer lock); Esc gives it back. Not a press the
        // handheld took (it stops it) or a world's GUI did (its screens: preventDefault)
        window.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target !== this.canvas || e.defaultPrevented || this.move !== 'walk' || this.handheld.shown) return;
            if (!document.pointerLockElement) this.canvas.requestPointerLock?.()?.catch?.(() => {});
        });
        // links: the site's parameters
        for (const e of ents.filter(e => e.type === 'link')) {
            const [id, ...param] = String(e.to).split('.');
            if (id !== site.id) { console.warn(`link: no site "${id}"`); continue; }
            this.links.push({ param: param.join('.'), value: Expr.compile(e.value), last: undefined });
        }
        this.hud.configure(ents);
        this.hud.toast(() => this.keyHelp(), 7000, this.hud.toastsEnd(ents));
        this.handheld.rebuild();
        this.audio.configure(ents);
    }

    // ------------------------------------------------------------------------------------------- walk / fly
    // The camera's mode, the engine's to switch (the handheld's Walk, camera.mode): the site's camera walks its own way
    // (Site.moves / move / setMove), on fx.floor; the engine's free camera walks on the site's ground. Walking looks with
    // the mouse taken (pointer lock), flying by dragging
    get moves() { return this.fly ? ['fly', 'walk'] : ['fly', 'walk'].filter(m => (this.site?.world.moves || ['fly']).includes(m)); }
    get move() { return this.fly ? this.fly.eye.mode : this.site?.world.move || 'fly'; }

    setMove(mode, say = true) {
        if (mode === this.move) return;
        if (!this.moves.includes(mode)) { if (say) this.hud.toast(`${this.site?.label || 'This camera'} cannot ${mode}`, 1500); return; }
        if (this.fly) this.fly.eye.setMode(mode);
        else this.site.world.setMove(mode);
        if (mode !== 'walk' && document.pointerLockElement === this.canvas) document.exitPointerLock();
        if (say) this.hud.toast(`${mode === 'walk' ? 'Walking' : 'Flying'}: ${this.keyHelp()}`, 4000);
    }

    // the keys there are, as a line for a toast: the site's camera's (Site.keys: [keys, what it does]) or the engine fly
    // camera's, and the handheld's, which holds everything else
    keyHelp() {
        const { Site } = Features.kits.world;
        const keys = this.fly ? (this.fly.eye.mode === 'walk' ? Site.WALK_KEYS : Site.FLY_KEYS) : this.site?.world.keys || [];
        return [...keys, ['Tab', 'handheld (every option)']].map(([k, what]) => `${k} ${what}`).join(' · ');
    }

    // the floor at point (x, y, z): the site's ground (the highest thing to stand on at or below y), or -Infinity
    floorAt(x, y, z) {
        const w = this.site?.world;
        if (!w?.ground) return -Infinity;
        const g = w.ground([x, y, z]);
        return g == null ? -Infinity : g;
    }

    // the camera
    worldView() { return this.fly ? this.fly.view : this.site?.world.view || null; }

    // Every view of the scenario, for the handheld's View: its `view` entities, then the site's own (Site.views: static
    // ones, and one per member of a followed entity), each { key, name, sub, group, go }
    get viewList() {
        const out = (this.scenario?.entities || []).filter(e => e.type === 'view' && ScenarioFormat.isEngine(e))
            .map((v, i) => ({ key: `engine/${i}`, name: v.name || `view ${i + 1}`, group: this.scenario.name, go: () => this.jumpView(v) }));
        const site = this.site;
        if (site?.ready) {
            let list = [];
            try { list = site.world.views?.() || []; } catch (err) { console.warn(`${site.id}: views()`, err); }
            list.forEach((v, i) => out.push({ ...v, key: `${site.id}/${v.key ?? i}`, group: site.label, inst: site }));
        }
        return out;
    }

    goView(v) {
        v.go();
        this.viewKey = v.key;
        if (this.fly && v.inst) this.fly.view = this.site.world.view;
    }

    // a view entity: the camera there, looking at `look`
    jumpView(v) {
        const pos = v.pos || [0, 100, 0], fwd = CamMath.norm(CamMath.sub(v.look || [pos[0], pos[1], pos[2] - 1], pos));
        const right = CamMath.norm(CamMath.cross(fwd, [0, 1, 0])), view = { pos: [...pos], fwd, up: CamMath.cross(right, fwd), fov: (v.fov || 60) * Math.PI / 180 };
        if (this.fly) this.fly.view = view;
        else this.site?.world.setView?.(view);
        this.hud.toast(v.name || 'view', 1500);
    }

    // ------------------------------------------------------------------------------------------- frame
    resize() {
        const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
        if (w === this.width && h === this.height) return;
        this.width = c.width = w;
        this.height = c.height = h;
    }

    swapView() {
        if (this.canvasViewFrame !== this.frameNo) {
            this.canvasView = this.context.getCurrentTexture().createView();
            this.canvasViewFrame = this.frameNo;
        }
        return this.canvasView;
    }

    emit(siteId, name, payload) {
        this.audio.emit(`${siteId}.${name}`, payload, this.scope);
    }

    // the scope every expression of the frame reads
    buildScope() {
        const s = { time: this.time, fps: this.fps, focus: this.router.focus, scenario: this.scenario.name, frame: this.frameNo, gpuError: this.lastError || '' };
        const site = this.site;
        try { s[site.id] = site.world.stats ? site.world.stats() : {}; } catch (err) { s[site.id] = { error: err.message }; }
        return s;
    }

    frame(now) {
        requestAnimationFrame(t => this.frame(t));
        const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
        this.last = now;
        if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
        this.time += dt;
        this.frameNo++;
        this.resize();
        // (what a failed frame left unsubmitted goes)
        this.gpuFrame.encoder = null;
        this.gpuFrame.after = [];
        try {
            if (this.fly) { this.fly.update(dt); this.site.world.setView?.(this.fly.view); }
            this.site.world.frame(now, dt);
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
            return;
        }
        // links, sound and the handheld read what the site did
        const scope = this.scope = this.buildScope();
        for (const l of this.links) {
            let v;
            try { v = l.value(scope); } catch { continue; }
            if (Host.same(v, l.last)) continue;
            l.last = Array.isArray(v) ? [...v] : v;
            this.site.world.set?.(l.param, v);
        }
        this.audio.update(scope);
        this.sidePanels(now);
        try {
            this.handheld.frame(now, dt);
            this.gpuFrame.submit();
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
        }
    }

    // the site's readouts kept on the screen (EngineHud side panels), a few times a second: its portal traversal tree,
    // while its inspector's `tree` option is on
    sidePanels(now) {
        if (now - (this.sideAt || 0) < 200) return;
        this.sideAt = now;
        const I = this.site.world.inspector;
        this.hud?.side(this.site.id, I && I.opts.tree ? I.tree() : null);
    }
}

function showFallback(e) {
    console.error(e);
    window.entities?.hud?.buildFallbackBar();
    document.getElementById('error-message').textContent = String(e && (e.stack || e.message) || e);
    document.getElementById('fallback').classList.add('show');
}

window.addEventListener('DOMContentLoaded', () => {
    const host = window.entities = new Host();     // devtools: entities.site.world, entities.app, entities.renderer
    host.boot().catch(showFallback);
});
