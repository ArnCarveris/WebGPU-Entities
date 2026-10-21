'use strict';
// Host: boots a scenario and runs it on the one World, the one Renderer and the one App.
//
//   1. catalog + scenario (scenarios/*.json over HTTP, or the embedded copies when opened from disk; a dropped file)
//   2. one GPU device, one canvas; the World, the Renderer and the App, made empty here and extended by the kits the
//      scenario uses (Common.Composite: each kit's World, Renderer and App extensions; the handheld's GUI renderer beside
//      the Renderer, renderer.ext.handheld)
//   3. its sites (a scenario of plain entities implies one: ScenarioFormat), each built by its kit's parts (Features) from
//      its entities (ScenarioFormat.toNative), the kits of its entities' types and the features its data asks for loaded
//      first (ScenarioFormat.kitsOf / featuresOf: fx.features); what the host asks of a site (its camera, views, ground,
//      stats, options, parameters...) is its kit's spec, kept beside the App (Site); one HUD root (in-world labels,
//      toasts) and one input scope; their options and readouts go on the handheld (handheld.js)
//   4. the frame: the camera, the sites' update and render, then links and sound read the frame's stats, and the
//      handheld draws over the finished frame; all of it into one command encoder, submitted once at the end of the frame
//      (gpuFrame, the gpu kit's GpuFrame: renderer.frameEncoder())
//
// Several sites (docs/single-world-plan.md Phase 6): each kit extends the one World, Renderer and App through a scope of
// its own (Common.Composite.scope: its own extensions and the names they expose, everything else shared), its site placed
// in the world by its `at` (a position and a yaw, on an entity another site answers anchor() for: frameOf), and they draw
// one frame (Renderer.share: one scene, one depth, one sky, the post of the kit that maps radiance to the canvas). There is
// one camera, the engine's: it flies or walks over every site's ground (floorAt), and each site's own camera follows it in
// the site's frame. The sky's site lights the others (world.sunlight). A scenario with a site of a kit that cannot share
// a frame yet (Host.SHARED) still runs one world per site: js/engine/legacy-host.js (LegacyHost), until Phase 6 is done.
//
// Engine entities: camera, view, link, site, features, hud.toast, handheld, handheld.page, sound.* (see camera.js,
// audio.js, hud.js, handheld.js). A link sets a parameter of a site from an expression every frame: { type: "link",
// to: "<site id>.<param>", value: expr }.
//
// Switching scenario reloads the page (?scenario=<id>): every scenario starts from a clean page and GPU device.

class Host {
    static DROPPED = 'dropped';
    // the kits whose sites share the one World, Renderer and App with other kits' sites (docs/single-world-plan.md Phase 6:
    // one kit more each step)
    static SHARED = ['atmosphere', 'hydrology'];

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
        this.site = null;               // the one site of a scenario of one: { id, type, kit, label, def, ui, ctx, world (its Site), ready }
        this.sites = [];                // every site (the handheld lists what they offer)
        this.shared = false;            // several sites, one frame
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
        // several sites, a kit among them that cannot share a frame yet: one world each, for now
        const roots = ScenarioFormat.roots(scenario);
        if (roots.length > 1 && !roots.every(r => Host.SHARED.includes(r.kit))) {
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
            // models and such go to a site that takes them (the imposter baker takes .glb / .gltf / .obj), scenarios to the
            // engine
            const site = this.sites.find(s => s.world?.drop);
            if (files.some(f => !/\.json$/i.test(f.name)) && site) site.world.drop(files);
            else if (files[0]) this.dropFile(files[0]);
        });
        document.title = `${scenario.name} · WebGPU Entities`;
        await ScenarioData.load(scenario);         // the data its entities name (a real place's heights, roads, buildings)
        await this.initGpu();
        this.engine = { Expr, GpuChoice, Common, CamMath, LayerFrame, host: this, kits: Features.kits };
        for (const k of Features.ENGINE_KITS) await Features.loadKit(k, this.engine);
        const { World, App } = Features.kits.world, { Renderer, GpuFrame } = Features.kits.gpu;
        this.gpuFrame = new GpuFrame(this.device);
        // the one World, Renderer and App: empty until the sites' kits extend them
        this.world = new World();
        this.renderer = new Renderer();
        this.app = new App();
        this.app.attach('handheld', HandheldApp, this.handheld);
        await this.handheld.init(scenario);
        await this.createSites(scenario);
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

    // the scenario's sites: the kits of each one's entities, its kit's features its data asks for, its kit's site parts;
    // then each one's context (fx) and its Site beside the App, the HUD root and the input scope they share
    async createSites(scenario) {
        const roots = ScenarioFormat.roots(scenario);
        if (!roots.length) throw new Error(`Scenario "${scenario.name}" has nothing in it (no site, and no entity any kit takes)`);
        for (const r of roots) if (!r.site) console.info(`${scenario.name}: the root entity { type: "${r.type}" } is read as a site of the ${r.kit} kit`);
        const engine = this.engine, shared = this.shared = roots.length > 1;
        const ui = this.createHud(roots.map(r => r.type));
        const made = [];
        for (const root of roots) {
            for (const k of ScenarioFormat.kitsOf(scenario, root)) await Features.loadKit(k, engine);
            const features = {};
            for (const name of ScenarioFormat.featuresOf(scenario, root)) features[name] = await Features.loadFeature(root.type, name, engine);
            const module = await Features.load(root.type, engine);
            made.push({ root, features, module, native: ScenarioFormat.toNative(scenario, root) });
        }
        // one frame for every site: its conventions from their kits' Renderer extensions (Renderer.share)
        if (shared) {
            this.renderer.share(this.device, made.map(({ root, module, native }) => {
                const E = module[Kits.KITS[root.kit].site.extends.renderer];
                return { key: E.key, E, fx: { native } };
            }));
            this.world.sunlight = null;
        }
        for (const { root, features, module, native } of made) this.sites.push(this.createSite(root, module, features, native, ui));
        if (!shared) this.site = this.sites[0];
        // the sites that make room in their ground for the others' (fx.footprints) after those
        const later = this.sites.filter(s => s.spec.makesRoom && shared);
        for (const site of this.sites.filter(s => !later.includes(s))) { await site.world.init(); site.ready = true; }
        for (const site of later) {
            site.ctx.footprints = this.footprintsIn(site, this.sites.filter(s => s !== site));
            await site.world.init();
            site.ready = true;
        }
        // the frame's order: the sky's site first (its sun lights the others), then as the scenario has them
        const sky = this.renderer.shared?.sky;
        this.order = shared ? [...this.sites].sort((a, b) => (b.renderKey === sky) - (a.renderKey === sky)) : this.sites;
        this.skySite = shared ? this.order.find(s => s.renderKey === sky && s.world.sunlight) || null : null;
    }

    // the HUD root: the elements the sites ask for (their specs' hud: Site.HUD), once each
    createHud(types) {
        const root = document.createElement('div');
        root.className = 'fhud';
        root.dataset.world = types.length > 1 ? '' : types[0];
        document.getElementById('world-huds').appendChild(root);
        return {
            root, $: name => root.querySelector(`[data-hud="${name}"]`),
            // (what of the screen the in-world labels may show: all of it; how much a point of the screen d m away is hidden:
            // by what an atmosphere's sky hides, veilOf; a frame number: every kit's labels on the one canvas, cleared once)
            region: () => null, veil: (x, y, W, H, d) => this.veilOf(x, y, W, H, d), frame: () => this.frameNo,
        };
    }

    createSite(root, module, features, native, ui) {
        const def = root.def, layer = def.layer || {}, shared = this.shared;
        const site = {
            id: root.id, type: root.type, kit: root.kit, label: def.label || def.name || root.id, def, layer, spec: module.spec || {},
            // (a site's at: { pos, yaw, on }, on: an entity of another site it rides on; a root's layer.transform)
            frameDef: def.at ? { offset: def.at.pos, yaw: def.at.yaw, on: def.at.on } : layer.transform || {},
            ui: shared ? ui : { ...ui, veil: () => 0, frame: undefined },
        };
        const { Composite } = Common;
        const ctx = site.ctx = {
            id: root.id, type: root.type, def, native, layer,
            features,                      // its kit's features its data asks for: { <name>: their exports }
            host: this,
            device: this.device, format: this.format, adapter: this.adapter,
            frame: this.gpuFrame,          // the frame's one encoder and submit (GpuFrame)
            canvas: this.canvas,
            // the one World, Renderer and App (several sites: as its kit sees them, Composite.scope)
            world: shared ? Composite.scope(this.world, root.id) : this.world,
            renderer: shared ? Composite.scope(this.renderer, root.id) : this.renderer,
            app: shared ? Composite.scope(this.app, root.id) : this.app,
            ui: site.ui,
            io: this.router.scope('app'),
            composed: false,
            cameraLocked: shared,          // set while the engine drives the camera (several sites, camera.controller: fly)
            inject: null,
            outdoors: null,
            // where it is in the world (several sites): { id, frame (its LayerFrame this frame) }
            site: shared ? { id: root.id, frame: () => this.frameOf(site) } : null,
            size: () => [this.width, this.height],
            target: () => this.swapView(),
            emit: (name, payload) => this.emit(root.id, name, payload),
            toast: (msg, ms) => this.hud.toast(msg, ms),
            sound: { toggle: () => this.audio.toggle() },
            fail: err => showFallback(err),
            floor: (x, y, z) => this.floorIn(site, x, y, z),
        };
        site.renderKey = module[Kits.KITS[root.kit].site.extends.renderer]?.key;
        site.world = shared ? new Features.kits.world.Site(ctx.app, ctx, module.spec) : this.app.attach('site', Features.kits.world.Site, ctx, module.spec);
        // its HUD elements, those the root has not yet
        const tmp = document.createElement('div');
        tmp.innerHTML = site.world.hudHtml || '';
        for (const el of [...tmp.children]) if (!ui.$(el.dataset.hud)) ui.root.appendChild(el);
        return site;
    }

    // the ground each of `sites` covers (Site.footprint), in site a's frame: [{ id, pos: [x, z] (its centre), size: [w, d],
    // yaw (deg, as a terrain stamp turns), floor (its lowest ground's height), ground }]
    footprintsIn(a, sites) {
        const Fa = this.frameOf(a), out = [];
        for (const s of sites) {
            let fp = null;
            try { fp = s.world.footprint?.(); } catch (err) { console.warn(`${s.id}: footprint()`, err); }
            if (!fp) continue;
            const Fs = this.frameOf(s), p = Fa.local(Fs.point([(fp.lo[0] + fp.hi[0]) / 2, fp.floor, (fp.lo[1] + fp.hi[1]) / 2]));
            const x = Fa.localDir(Fs.dir([1, 0, 0]));
            out.push({ id: s.id, pos: [p[0], p[2]], size: [fp.hi[0] - fp.lo[0], fp.hi[1] - fp.lo[1]], yaw: Math.atan2(x[2], x[0]) * 180 / Math.PI,
                floor: p[1], ground: !!fp.ground });
        }
        return out;
    }

    configure(scenario) {
        const ents = scenario.entities || [];
        // camera: a site's, or the engine's (several sites: always the engine's, starting at a site's start view)
        const cam = this.cameraDef = ents.find(e => e.type === 'camera' && ScenarioFormat.isEngine(e)) || {};
        if (cam.controller === 'fly' || this.shared) {
            this.fly = new FlyCamera(cam, this.router.scope('engine'), (x, y, z) => this.floorAt(x, y, z));
            this.router.always.add('engine');
            for (const s of this.sites) s.ctx.cameraLocked = true;
            const start = this.sites.find(s => s.id === (cam.start ?? [].concat(cam.from ?? [])[0]));
            if (this.shared && start?.world.view) this.fly.view = this.frameOf(start).toWorld(start.world.view);
        }
        if (cam.mode) this.setMove(cam.mode, false);
        this.router.setFocus('app');
        // (no keys of the engine's own: walk / fly is the handheld's; a key only starts the sound)
        window.addEventListener('keydown', () => this.audio.start());
        window.addEventListener('pointerdown', () => this.audio.start());
        // walking, a click on the world takes the mouse to look (pointer lock); Esc gives it back. Not a press the
        // handheld took (it stops it) or a world's GUI did (its screens: preventDefault)
        window.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target !== this.canvas || e.defaultPrevented || this.move !== 'walk' || this.handheld.shown) return;
            if (!document.pointerLockElement) this.canvas.requestPointerLock?.()?.catch?.(() => {});
        });
        // links: the sites' parameters
        for (const e of ents.filter(e => e.type === 'link')) {
            const [id, ...param] = String(e.to).split('.');
            const site = this.sites.find(s => s.id === id);
            if (!site) { console.warn(`link: no site "${id}"`); continue; }
            this.links.push({ site, param: param.join('.'), value: Expr.compile(e.value), last: undefined });
        }
        this.hud.configure(ents);
        this.hud.toast(() => this.keyHelp(), 7000, this.hud.toastsEnd(ents));
        this.handheld.rebuild();
        this.audio.configure(ents);
    }

    // ------------------------------------------------------------------------------------------- sites
    // where a site is in the world: its frame (a site's `at`, riding on the entity another site answers anchor() for)
    frameOf(site) {
        const t = site.frameDef, local = LayerFrame.fromDef(t);
        if (t.on) {
            const owner = site.anchorOwner ? [site.anchorOwner] : this.sites.filter(s => s !== site);
            for (const s of owner) {
                const f = s.world.anchor?.(t.on);
                if (f) { site.anchorOwner = s; return local.within(new LayerFrame(f.pos, f.q)); }
            }
        }
        return local;
    }

    // How much the sites hide (Site.veil: an atmosphere's air, its daytime sky what is in space) a point d m from the
    // eye seen at pixel [x, y] of a W x H screen: 0 .. 1, the most any of them does. The ray through that pixel of this
    // frame's view, in each one's frame
    veilOf(x, y, W, H, d) {
        const v = this.shared && this.eye;
        if (!v) return 0;
        const M = CamMath, t = Math.tan((v.fov || Math.PI / 3) / 2), u = (2 * x / W - 1) * t * W / H, w = (1 - 2 * y / H) * t;
        const dir = M.norm(M.add(v.fwd, M.add(M.mul(M.cross(v.fwd, v.up), u), M.mul(v.up, w))));
        let most = 0;
        for (const s of this.sites) {
            if (!s.ready || !s.world.veil) continue;
            const F = this.frameOf(s);
            let a = 0;
            try { a = s.world.veil(F.local(v.pos), F.localDir(dir), d) || 0; } catch { a = 0; }
            if (a > most) most = a;
        }
        return Math.min(most, 1);
    }

    // ------------------------------------------------------------------------------------------- walk / fly
    // The camera's mode, the engine's to switch (the handheld's Walk, camera.mode): the site's camera walks its own way
    // (Site.moves / move / setMove), on fx.floor; the engine's camera walks on every site's ground. Walking looks with the
    // mouse taken (pointer lock), flying by dragging
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

    // the keys there are, as a line for a toast: the site's camera's (Site.keys: [keys, what it does]) or the engine
    // camera's, and the handheld's, which holds everything else
    keyHelp() {
        const { Site } = Features.kits.world;
        const keys = this.fly ? (this.fly.eye.mode === 'walk' ? Site.WALK_KEYS : Site.FLY_KEYS) : this.site?.world.keys || [];
        return [...keys, ['Tab', 'handheld (every option)']].map(([k, what]) => `${k} ${what}`).join(' · ');
    }

    // the floor at world point (x, y, z): the highest thing to stand on at or below y over every site (each site's
    // ground(), in its own frame), or -Infinity
    floorAt(x, y, z) {
        let best = -Infinity;
        for (const s of this.sites) {
            const w = s.world;
            if (!w?.ground) continue;
            if (!this.shared) { const g = w.ground([x, y, z]); return g == null ? -Infinity : g; }
            const F = this.frameOf(s), lp = F.local([x, y, z]), g = w.ground(lp);
            if (g == null || g === -Infinity) continue;
            const h = F.point([lp[0], g, lp[2]])[1];
            if (h > best) best = h;
        }
        return best;
    }

    // ... at a point of site's frame, in its frame (fx.floor)
    floorIn(site, x, y, z) {
        if (!this.shared) return this.floorAt(x, y, z);
        const F = this.frameOf(site), w = F.point([x, y, z]), g = this.floorAt(w[0], w[1], w[2]);
        return g === -Infinity ? g : F.local([w[0], g, w[2]])[1];
    }

    // the camera
    worldView() { return this.fly ? this.fly.view : this.site?.world.view || null; }

    // Every view of the scenario, for the handheld's View: its `view` entities, then each site's own (Site.views: static
    // ones, and one per member of a followed entity), each { key, name, sub, group, go }
    get viewList() {
        const out = (this.scenario?.entities || []).filter(e => e.type === 'view' && ScenarioFormat.isEngine(e))
            .map((v, i) => ({ key: `engine/${i}`, name: v.name || `view ${i + 1}`, group: this.scenario.name, go: () => this.jumpView(v) }));
        for (const site of this.sites.filter(s => s.ready)) {
            let list = [];
            try { list = site.world.views?.() || []; } catch (err) { console.warn(`${site.id}: views()`, err); }
            list.forEach((v, i) => out.push({ ...v, key: `${site.id}/${v.key ?? i}`, group: site.label, inst: site }));
        }
        return out;
    }

    // go to a view of viewList: a site's view moves its camera, which the engine's takes over
    goView(v) {
        v.go();
        this.viewKey = v.key;
        if (this.fly && v.inst) this.fly.view = this.shared ? this.frameOf(v.inst).toWorld(v.inst.world.view) : v.inst.world.view;
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
        for (const site of this.sites) {
            try { s[site.id] = site.world.stats ? site.world.stats() : {}; } catch (err) { s[site.id] = { error: err.message }; }
        }
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
        this.renderer.pending = [];
        try {
            if (this.shared) this.frameSites(now, dt);
            else {
                if (this.fly) { this.fly.update(dt); this.site.world.setView?.(this.fly.view); }
                this.site.world.frame(now, dt);
            }
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
            return;
        }
        // links, sound and the handheld read what the sites did
        const scope = this.scope = this.buildScope();
        for (const l of this.links) {
            let v;
            try { v = l.value(scope); } catch { continue; }
            if (Host.same(v, l.last)) continue;
            l.last = Array.isArray(v) ? [...v] : v;
            l.site.world.set?.(l.param, v);
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

    // several sites: the camera moves, each site's camera follows it in its frame, each site updates and renders (the
    // sky's first: its sun, world.sunlight, lights the others), then the one frame is encoded (Renderer.encodeFrame)
    frameSites(now, dt) {
        this.fly.update(dt);
        const view = this.eye = this.fly.view;
        for (const site of this.order) {
            site.world.setView?.(this.frameOf(site).toLocal(view));
            site.world.frame(now, dt);
            if (site === this.skySite) {
                const s = site.world.sunlight();
                this.world.sunlight = s && { ...s, dir: this.frameOf(site).dir(s.dir) };
            }
        }
        this.renderer.encodeFrame();
    }

    // the sites' readouts kept on the screen (EngineHud side panels), a few times a second: the portal traversal tree of
    // a site's inspector, while its `tree` option is on
    sidePanels(now) {
        if (now - (this.sideAt || 0) < 200) return;
        this.sideAt = now;
        const at = this.sites.find(s => s.world.inspector);
        for (const site of this.sites) {
            const I = site === at ? site.world.inspector : null;
            this.hud?.side(site.id, I && I.opts.tree ? I.tree() : null);
        }
    }
}

function showFallback(e) {
    console.error(e);
    window.entities?.hud?.buildFallbackBar();
    document.getElementById('error-message').textContent = String(e && (e.stack || e.message) || e);
    document.getElementById('fallback').classList.add('show');
}

window.addEventListener('DOMContentLoaded', () => {
    const host = window.entities = new Host();     // devtools: entities.sites[i].world, entities.app, entities.renderer
    host.boot().catch(showFallback);
});
