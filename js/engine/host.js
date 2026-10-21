'use strict';
// Host: boots a scenario and runs every world in it.
//
//   1. catalog + scenario (scenarios/*.json over HTTP, or the embedded copies when opened from disk; a dropped file)
//   2. one GPU device for everything (GpuChoice adapter), one canvas
//   3. a world per root entity (one a kit offers; entities no world of the scenario takes bring in their own:
//      ScenarioFormat.complete), each built by its kit's world parts (Features) from its entities
//      (ScenarioFormat.toNative), the kits of its entities' types and the features its data asks for loaded first
//      (ScenarioFormat.kitsOf / featuresOf, the world gets them as fx.features), with its own HUD root (in-world
//      labels, toasts) and input scope; its options and readouts go on the handheld (world.handheld(), see handheld.js)
//   4. the frame: the camera's world first, the camera passed to the others, each world renders (into the canvas when
//      it is alone, else into its layer); the Compositor merges the layers (or hands them to the atmosphere world);
//      then links and sound read the frame's stats, and the handheld draws over the finished frame. All of it goes into
//      one command encoder, submitted once at the end of the frame (gpuFrame, the gpu kit's GpuFrame: every Renderer
//      draws into it, fx.frame)
//
// Every world of a composition is always there and always runs: what keeps them out of each other's way is the
// composition's own rules, not hiding one. The camera inside one world's interior is inside for all of them (inside():
// the others see the outdoors only through its portals, fx.outdoors, and the atmosphere's rain stays off); a world takes
// its sun from the world it stands in (lights(): layer.sun); an atmosphere knows where its air ends (its own data: the
// cloud world's render.airTop), and what of the others it hides beyond it (veilOf(): in daylight its sky hides what is
// in space, and their in-world labels there fade out with it).
//
// Engine entities: camera, view, link, hud.toast, handheld, handheld.page, sound.* (see camera.js, audio.js, hud.js,
// handheld.js). A link sets a world's parameter
// from an expression every frame: { type: "link", to: "<world id>.<param>", value: expr }.
//
// Switching scenario reloads the page (?scenario=<id>): every world starts from a clean page and GPU device.

class Host {
    static DROPPED = 'dropped';

    // link values: numbers and vectors change when they move by more than a hair
    static same(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Host.same(x, b[i]));
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a));
        return a === b;
    }

    constructor() {
        this.canvas = document.getElementById('view');
        this.router = new InputRouter(this.canvas);
        this.audio = new AudioEngine();
        this.hud = new EngineHud(this);
        this.handheld = new Handheld(this);
        this.instances = [];
        this.links = [];
        this.width = this.height = 0;
        this.fps = 60;
        this.time = 0;
        this.frameNo = 0;
        this.cameraOwner = null;
        this.fly = null;
        this.canvasView = null;
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
            if (!ScenarioFormat.roots(data).length) data = Host.importNative(data, file.name);
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
        this.hud.buildBar();
        window.addEventListener('dragover', e => e.preventDefault());
        window.addEventListener('drop', e => {
            e.preventDefault();
            const files = [...e.dataTransfer.files];
            // models and such go to the focused world (the imposter baker takes .glb / .gltf / .obj), scenarios to the engine
            const world = this.instances.find(i => i.id === this.router.focus)?.world;
            if (files.some(f => !/\.json$/i.test(f.name)) && world?.drop) world.drop(files);
            else if (files[0]) this.dropFile(files[0]);
        });
        const scenario = this.scenario = await this.loadScenario(id);
        document.title = `${scenario.name} · WebGPU Entities`;
        await ScenarioData.load(scenario);         // the data its entities name (a real place's heights, roads, buildings)
        await this.initGpu();
        this.engine = { Expr, GpuChoice, Common, CamMath, LayerFrame, host: this, kits: Features.kits };
        for (const k of Features.ENGINE_KITS) await Features.loadKit(k, this.engine);
        this.gpuFrame = new Features.kits.gpu.GpuFrame(this.device);
        await this.handheld.init(scenario);
        await this.createWorlds(scenario);
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

    async createWorlds(scenario) {
        const roots = ScenarioFormat.roots(scenario);
        if (!roots.length) throw new Error(`Scenario "${scenario.name}" has no world (an entity of type ${Object.keys(ScenarioFormat.SCHEMAS).join(' / ')}, or one a world takes)`);
        const engine = this.engine;
        this.composed = roots.length > 1;
        for (const root of roots) {
            // the kits its entities are of (only those the scenario has), then the world's own parts
            for (const k of ScenarioFormat.kitsOf(scenario, root)) await Features.loadKit(k, engine);
            // the features of its kit its data asks for (what it is made of beyond its core: Kits.featuresOf)
            const features = {};
            for (const name of ScenarioFormat.featuresOf(scenario, root)) features[name] = await Features.loadFeature(root.type, name, engine);
            const module = await Features.load(root.type, engine);
            const inst = this.createInstance(root, scenario, module, features);
            this.instances.push(inst);
        }
        // the worlds, then the atmospheres (they render last, over the merged others), each making room in its terrain
        // for the ground the others cover (fx.footprints)
        const scene = this.instances.filter(i => i.role !== 'atmosphere');
        for (const inst of scene) { await inst.world.init(); inst.ready = true; }
        for (const inst of this.instances.filter(i => i.role === 'atmosphere')) {
            inst.ctx.footprints = this.footprintsIn(inst, scene);
            await inst.world.init();
            inst.ready = true;
        }
    }

    // the ground each world of `worlds` covers (FeatureWorld.footprint), in world a's frame: [{ id, pos: [x, z] (its
    // centre), size: [w, d], yaw (deg, as a terrain stamp turns), floor (its lowest ground's height), ground }]
    footprintsIn(a, worlds) {
        const Fa = this.frameOf(a), out = [];
        for (const i of worlds) {
            let fp = null;
            try { fp = i.world.footprint?.(); } catch (err) { console.warn(`${i.id}: footprint()`, err); }
            if (!fp) continue;
            const Fi = this.frameOf(i), p = Fa.local(Fi.point([(fp.lo[0] + fp.hi[0]) / 2, fp.floor, (fp.lo[1] + fp.hi[1]) / 2]));
            const x = Fa.localDir(Fi.dir([1, 0, 0]));
            out.push({ id: i.id, pos: [p[0], p[2]], size: [fp.hi[0] - fp.lo[0], fp.hi[1] - fp.lo[1]], yaw: Math.atan2(x[2], x[0]) * 180 / Math.PI,
                floor: p[1], ground: !!fp.ground });
        }
        return out;
    }

    createInstance(root, scenario, module, features = {}) {
        const def = root.def, layer = def.layer || {};
        const huds = document.getElementById('world-huds');
        const ui = document.createElement('div');
        ui.className = 'fhud';
        ui.dataset.world = root.type;
        ui.dataset.id = root.id;
        huds.appendChild(ui);
        const inst = {
            id: root.id,
            type: root.type,
            label: def.label || def.name || root.id,
            def, layer,
            role: layer.role || 'scene',
            frameDef: layer.transform || {},
            // (region(): what of the screen its in-world labels may show, fx.outdoors; veil(): how much the other worlds
            // hide of a point on it, veilOf)
            ui: { root: ui, $: name => ui.querySelector(`[data-hud="${name}"]`), region: () => inst.ctx.outdoors,
                veil: (x, y, W, H, d) => this.veilOf(inst, x, y, W, H, d) },
        };
        const native = ScenarioFormat.toNative(scenario, root);
        const ctx = inst.ctx = {
            id: root.id, type: root.type, def, native, layer,
            features,                      // its kit's features its data asks for: { <name>: their exports }
            host: this,
            device: this.device, format: this.format, adapter: this.adapter,
            frame: this.gpuFrame,          // the frame's one encoder and submit (GpuFrame)
            canvas: this.canvas,
            ui: inst.ui,
            io: this.router.scope(root.id),
            composed: this.composed,
            cameraLocked: false,           // set while another world (or the engine) drives the camera
            inject: null,                  // atmosphere worlds: the merged other worlds this frame
            outdoors: null,                // while the camera is inside another world's interior, what of the outdoors it
                                           // sees from there: { seen, rect ([x0, y0, x1, y1] px; null: all), W, H }
            size: () => [this.width, this.height],
            target: () => this.targetFor(inst),
            emit: (name, payload) => this.emit(root.id, name, payload),
            toast: (msg, ms) => this.hud.toast(msg, ms),
            sound: { toggle: () => this.audio.toggle() },
            fail: err => showFallback(err),
            floor: (x, y, z) => this.floorIn(inst, x, y, z),
        };
        inst.world = module.create(ctx);
        ui.innerHTML = inst.world.hudHtml || '';
        return inst;
    }

    configure(scenario) {
        const ents = scenario.entities || [];
        // camera
        const cam = this.cameraDef = ents.find(e => e.type === 'camera' && ScenarioFormat.isEngine(e)) || {};
        this.owners = [];
        if (cam.controller === 'fly') {
            this.fly = new FlyCamera(cam, this.router.scope('engine'), (x, y, z) => this.floorAt(x, y, z));
            this.router.always.add('engine');
        } else if (cam.from) {
            this.owners = [].concat(cam.from).map(id => this.instances.find(i => i.id === id)).filter(Boolean);
        }
        if (!this.fly && !this.owners.length) this.owners = [this.instances.find(i => i.role !== 'atmosphere') || this.instances[0]];
        // each camera world's own view, for taking the camera back where it left it (carry false)
        for (const o of this.owners) o.savedView = o.world.view;
        this.setCameraOwner(this.owners[0] || null);
        if (cam.mode) this.setMove(cam.mode, false);
        this.router.onFocus = () => this.refreshHuds();
        this.focusCamera();
        // (no keys of the engine's own: walk / fly is the handheld's; a key only starts the sound)
        window.addEventListener('keydown', () => this.audio.start());
        window.addEventListener('pointerdown', () => this.audio.start());
        // walking, a click on the world takes the mouse to look (pointer lock); Esc gives it back. Not a press the
        // handheld took (it stops it) or a world's GUI did (its screens: preventDefault)
        window.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target !== this.canvas || e.defaultPrevented || this.move !== 'walk' || this.handheld.shown) return;
            if (!document.pointerLockElement) this.canvas.requestPointerLock?.()?.catch?.(() => {});
        });
        // links between worlds
        for (const e of ents.filter(e => e.type === 'link')) {
            const [id, ...param] = String(e.to).split('.');
            const inst = this.instances.find(i => i.id === id);
            if (!inst) { console.warn(`link: no world "${id}"`); continue; }
            this.links.push({ inst, param: param.join('.'), value: Expr.compile(e.value), last: undefined });
        }
        this.configureSuns();
        this.hud.configure(ents);
        this.hud.toast(() => this.keyHelp(), 7000, this.hud.toastsEnd(ents));
        this.handheld.rebuild();
        this.audio.configure(ents);
        if (this.composed) this.compositor = new Compositor(this.device, this.format);
        this.refreshHuds();
    }

    // ------------------------------------------------------------------------------------------- suns
    // Whose sun lights each world of a composition: its layer.sun (a world's id, or false: its own), by default the
    // atmosphere's for the worlds under it and the sky world's (layer.sky: its own) for the atmosphere, or for every
    // world when there is no atmosphere; none where a link drives its sunDir. Passed on in that order every frame (lights())
    configureSuns() {
        const all = this.instances, byId = id => all.find(i => i.id === id);
        const atmos = all.find(i => i.role === 'atmosphere'), sky = all.find(i => i.layer.sky);
        for (const i of all) {
            const s = i.layer.sun;
            i.sunFrom = s === false || !this.composed ? null : s ? byId(s) : i === sky ? null : i.role === 'atmosphere' ? sky : atmos || sky;
            if (i.sunFrom === i || this.links.some(l => l.inst === i && l.param === 'sunDir')) i.sunFrom = null;
        }
        const depth = (i, seen = new Set()) => (!i.sunFrom || seen.has(i) ? 0 : (seen.add(i), 1 + depth(i.sunFrom, seen)));
        this.lit = all.filter(i => i.sunFrom).sort((a, b) => depth(a) - depth(b));
    }

    // each lit world's sun: the direction to its sun's world's sun (FeatureWorld.sunDir) at the world's origin, through
    // the two frames into its own (set('sunDir')), when it moves
    lights() {
        for (const i of this.lit) {
            const s = i.sunFrom, Fs = this.frameOf(s), Fi = this.frameOf(i);
            let d;
            try { d = s.world.sunDir?.(Fs.local(Fi.pos)); } catch { continue; }
            if (!d) continue;
            const local = Fi.localDir(Fs.dir(d));
            if (Host.same(local, i.sunLast)) continue;
            i.sunLast = local;
            i.world.set?.('sunDir', local);
        }
    }

    // ------------------------------------------------------------------------------------------- worlds
    setCameraOwner(inst) {
        const mode = this.cameraOwner && this.move;
        this.cameraOwner = inst;
        for (const i of this.instances) i.ctx.cameraLocked = !!this.fly || (inst ? i !== inst : false);
        // the new camera world goes on walking (or flying) if it can
        const w = inst?.world;
        if (mode && !this.fly && (w.moves || ['fly']).includes(mode) && w.move !== mode) w.setMove(mode);
    }

    // ------------------------------------------------------------------------------------------- walk / fly
    // The camera's mode, the engine's to switch (the handheld's Walk, camera.mode): the engine's camera walks on every
    // world's ground; a world with the camera walks its own way (FeatureWorld.moves / move / setMove), on fx.floor.
    // Walking always starts where the camera is: when the camera's world cannot walk, the world that can walk there
    // (walkerAt: the one whose interior holds the camera, else the one with the highest ground under it) borrows the
    // camera, from the current view, and flying gives it back to the world it came from, from where the walk ended. Only
    // with no such world does a mode go to another camera world (camera.from: a floating-origin flight, far from any
    // ground, walks as the facility's player). Walking looks with the mouse taken (pointer lock), flying by dragging
    get moves() {
        if (this.fly) return ['fly', 'walk'];
        const can = (this.owners || []).concat(this.instances.filter(i => i.ready)).flatMap(o => o.world.moves || ['fly']);
        return ['fly', 'walk'].filter(m => can.includes(m));
    }
    get move() { return this.fly ? this.fly.eye.mode : this.cameraOwner?.world.move || 'fly'; }

    // the world that walks the camera where it is: the one holding it (inside()), else the one with the highest ground
    // under it within its footprint (FeatureWorld.footprint; the worlds before the atmospheres on a tie), or null
    walkerAt() {
        const v = this.worldView(), walks = i => i.ready && (i.world.moves || ['fly']).includes('walk');
        if (!v) return null;
        this.inside();
        if (this.holder && walks(this.holder)) return this.holder;
        let best = null, top = -Infinity;
        for (const i of this.byRole) {
            if (!walks(i) || !i.world.ground) continue;
            const F = this.frameOf(i), lp = F.local(v.pos), fp = i.world.footprint?.();
            if (fp && (lp[0] < fp.lo[0] || lp[0] > fp.hi[0] || lp[2] < fp.lo[1] || lp[2] > fp.hi[1])) continue;
            const g = i.world.ground(lp);
            if (g == null || g === -Infinity) continue;
            const h = F.point([lp[0], g, lp[2]])[1];
            if (h > top) { top = h; best = i; }
        }
        return best;
    }

    setMove(mode, say = true) {
        if (mode === this.move) return;     // already (a fly-only world's camera has no setMode)
        if (!this.moves.includes(mode)) { if (say) this.hud.toast(`${this.cameraOwner?.label || 'This camera'} cannot ${mode}`, 1500); return; }
        if (!this.fly) {
            const can = i => (i.world.moves || ['fly']).includes(mode), cur = this.cameraOwner;
            if (mode === 'walk' && !can(cur)) {
                const here = this.walkerAt();
                if (here) { this.lender = cur; this.handTo(here, true); }
                else this.handTo(this.owners.find(can));
            } else if (mode === 'fly' && this.lender && !this.owners.includes(cur)) {
                // a borrowed walker gives the camera back, from where the walk ended
                const to = this.lender;
                this.lender = null;
                this.handTo(to, true);
            } else if (!can(cur)) this.handTo(this.owners.find(can));
        }
        if (mode !== this.move) {
            if (this.fly) this.fly.eye.setMode(mode);
            else this.cameraOwner.world.setMove(mode);
        }
        if (mode !== 'walk' && document.pointerLockElement === this.canvas) document.exitPointerLock();
        if (say) this.hud.toast(`${mode === 'walk' ? 'Walking' : 'Flying'}: ${this.keyHelp()}`, 4000);
    }

    // the keys there are, as a line for a toast: the camera world's (FeatureWorld.keys: [keys, what it does]) or the
    // engine fly camera's, and the handheld's, which holds everything else
    keyHelp() {
        const { FeatureWorld } = Features.kits.world;
        const keys = this.fly ? (this.fly.eye.mode === 'walk' ? FeatureWorld.WALK_KEYS : FeatureWorld.FLY_KEYS) : this.cameraOwner?.world.keys || [];
        return [...keys, ['Tab', 'handheld (every option)']].map(([k, what]) => `${k} ${what}`).join(' · ');
    }

    // the floor at composition-space point (x, y, z): the highest thing to stand on at or below y over every world
    // (each world's ground(), in its own frame), or -Infinity
    floorAt(x, y, z) {
        let best = -Infinity;
        for (const i of this.instances) {
            if (!i.world.ground) continue;
            const F = this.frameOf(i), lp = F.local([x, y, z]), g = i.world.ground(lp);
            if (g == null || g === -Infinity) continue;
            const h = F.point([lp[0], g, lp[2]])[1];
            if (h > best) best = h;
        }
        return best;
    }

    // The camera inside an interior of a world (FeatureWorld.sheltered: a building, a vehicle's cabin, a portal area) is
    // inside for every world: that world holds it, the others see the outdoors only as it does (FeatureWorld.outdoors:
    // through its portals, or not at all, as their fx.outdoors: an atmosphere draws its sky, clouds and weather only
    // there, and every world's in-world labels show only there), and an atmosphere that doesn't hold it keeps its rain
    // and snow off it (set('indoors'), unless a scenario link drives that itself). One point query per world, O(1) in
    // what the worlds hold
    inside() {
        if (!this.composed) return;
        const v = this.fly ? this.fly.view : this.worldView();
        let holder = null, region = null;
        if (v) for (const i of this.byRole) {
            const p = this.frameOf(i).local(v.pos);
            if (!i.world.sheltered?.(p)) continue;
            holder = i;
            const od = i.world.outdoors?.(p);
            region = od ? { seen: od.seen, rect: od.rect || null, W: this.width, H: this.height } : null;
            break;
        }
        this.holder = holder;
        this.region = region;
        this.focusCamera();
        for (const i of this.instances) {
            i.ctx.outdoors = holder && i !== holder ? region : null;
            if (i.role !== 'atmosphere' || this.links.some(l => l.inst === i && l.param === 'indoors')) continue;
            const indoors = !!holder && holder !== i;
            if (i.sheltered !== indoors) { i.sheltered = indoors; i.world.set?.('indoors', indoors); }
        }
    }

    // How much the composition's other worlds hide (FeatureWorld.veil: an atmosphere's air, its daytime sky what is in
    // space) a point d m from the eye seen at pixel [x, y] of inst's W x H screen: 0 .. 1, the most any of them does. The
    // ray through that pixel of this frame's view, in each one's frame: no world has to say where its points are
    veilOf(inst, x, y, W, H, d) {
        const v = this.composed && this.eye;
        if (!v) return 0;
        let most = 0, dir = null;
        for (const i of this.instances) {
            if (i === inst || !i.ready) continue;
            if (!dir) {
                const M = CamMath, t = Math.tan((v.fov || Math.PI / 3) / 2), u = (2 * x / W - 1) * t * W / H, w = (1 - 2 * y / H) * t;
                dir = M.norm(M.add(v.fwd, M.add(M.mul(M.cross(v.fwd, v.up), u), M.mul(v.up, w))));
            }
            const F = this.frameOf(i);
            let a = 0;
            try { a = i.world.veil?.(F.local(v.pos), F.localDir(dir), d) || 0; } catch { a = 0; }
            if (a > most) most = a;
        }
        return Math.min(most, 1);
    }

    // where no world of `scene` draws (Compositor.merge): the sky world's sky (layer.sky, else the first's) within what of
    // the outdoors the camera sees, the background of the world holding it elsewhere
    skyOf(scene) {
        const index = Math.max(0, scene.findIndex(i => i.layer.sky)), h = this.holder, own = scene.indexOf(h);
        if (own < 0) return { index };
        const od = this.region;
        return { index, own, rect: !od || (od.seen && !od.rect) ? null : od.seen ? od.rect : [0, 0, 0, 0] };
    }

    // the worlds, the atmospheres last (an interior of a world standing in the air holds the camera first)
    get byRole() { return this.instances.filter(i => i.role !== 'atmosphere').concat(this.instances.filter(i => i.role === 'atmosphere')); }

    // ... at a point of inst's frame, in its frame (fx.floor)
    floorIn(inst, x, y, z) {
        const F = this.frameOf(inst), w = F.point([x, y, z]), g = this.floorAt(w[0], w[1], w[2]);
        return g === -Infinity ? g : F.local([w[0], g, w[2]])[1];
    }

    // the camera to another of its worlds (camera.from), or lent to a world walking it (setMove): it takes over from the
    // current view (or, with camera.carry false and not `carry`, goes on from its own)
    handTo(inst, carry = this.cameraDef.carry !== false) {
        if (!inst || inst === this.cameraOwner) return;
        const v = this.worldView(), prev = this.cameraOwner;
        if (prev) prev.savedView = prev.world.view;
        if (this.owners.includes(inst)) this.lender = null;
        this.setCameraOwner(inst);
        if (!carry) { if (inst.savedView) inst.world.setView(inst.savedView); }
        else if (v) this.setView(inst, v);
        this.focusCamera();
    }

    // The keys go with the camera, the same ones whatever the world: to the world driving it, or, while the engine flies
    // it, to the world holding it (inside()), else the one with layer.focus (or the first). Nobody picks who has them
    focusCamera() {
        const inst = this.cameraOwner || this.holder || this.instances.find(i => i.layer.focus) || this.instances[0];
        if (inst && inst.id !== this.router.focus) this.router.setFocus(inst.id);
    }

    refreshHuds() {
        for (const i of this.instances) i.ui.root.classList.toggle('unfocused', this.composed && this.router.focus !== i.id);
    }

    // the frame of a world in composition space (anchors resolved against the world they ride on)
    frameOf(inst) {
        const t = inst.frameDef, local = LayerFrame.fromDef(t);
        if (!t.anchor) return local;
        const [wid, eid] = String(t.anchor).split(':');
        const base = this.instances.find(i => i.id === wid);
        const f = base?.world.anchor?.(eid);
        return f ? local.within(new LayerFrame(f.pos, f.q)) : local;
    }

    // the camera in composition space
    worldView() {
        if (this.fly) return this.fly.view;
        const o = this.cameraOwner, v = o?.world.view;
        return v ? this.frameOf(o).toWorld(v) : null;
    }

    // Every view of the scenario, for the handheld's View: its `view` entities (composition space), then each world's own
    // (FeatureWorld.views: static ones, and one per member of a followed entity), each { key, name, sub, group, go }
    get viewList() {
        const out = (this.scenario?.entities || []).filter(e => e.type === 'view' && ScenarioFormat.isEngine(e))
            .map((v, i) => ({ key: `engine/${i}`, name: v.name || `view ${i + 1}`, group: this.scenario.name, go: () => this.jumpView(v) }));
        for (const inst of this.instances.filter(i => i.ready)) {
            let list = [];
            try { list = inst.world.views?.() || []; } catch (err) { console.warn(`${inst.id}: views()`, err); }
            list.forEach((v, i) => out.push({ ...v, key: `${inst.id}/${v.key ?? i}`, group: inst.label, inst }));
        }
        return out;
    }

    // go to a view of viewList: a world's view moves its camera (it takes the camera when it can); a world that can't
    // hand the camera on (an atmosphere) has its view copied to the camera
    goView(v) {
        const inst = v.inst;
        if (inst && this.owners.includes(inst) && inst !== this.cameraOwner) this.handTo(inst);
        v.go();
        this.viewKey = v.key;
        if (inst && inst !== this.cameraOwner && inst.world.view) {
            const view = this.frameOf(inst).toWorld(inst.world.view);
            if (this.fly) this.fly.view = view;
            else if (this.cameraOwner) this.setView(this.cameraOwner, view);
        }
    }

    // a view entity: the camera there, looking at `look`
    jumpView(v) {
        const pos = v.pos || [0, 100, 0], fwd = CamMath.norm(CamMath.sub(v.look || [pos[0], pos[1], pos[2] - 1], pos));
        const right = CamMath.norm(CamMath.cross(fwd, [0, 1, 0])), view = { pos: [...pos], fwd, up: CamMath.cross(right, fwd), fov: (v.fov || 60) * Math.PI / 180 };
        if (this.fly) this.fly.view = view;
        else if (this.cameraOwner) this.setView(this.cameraOwner, view);
        this.hud.toast(v.name || 'view', 1500);
    }

    setView(inst, worldView) {
        if (!inst.world.setView) return;
        inst.world.setView(this.frameOf(inst).toLocal(worldView));
    }

    // ------------------------------------------------------------------------------------------- frame
    resize() {
        const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
        if (w === this.width && h === this.height) return;
        this.width = c.width = w;
        this.height = c.height = h;
    }

    targetFor(inst) {
        if (!this.composed || inst.role === 'atmosphere') return this.swapView();
        return this.compositor.target(inst);
    }

    swapView() {
        if (this.canvasViewFrame !== this.frameNo) {
            this.canvasView = this.context.getCurrentTexture().createView();
            this.canvasViewFrame = this.frameNo;
        }
        return this.canvasView;
    }

    emit(worldId, name, payload) {
        this.audio.emit(`${worldId}.${name}`, payload, this.scope);
    }

    // the scope every expression of the frame reads
    buildScope() {
        const s = { time: this.time, fps: this.fps, focus: this.router.focus, scenario: this.scenario.name, frame: this.frameNo, gpuError: this.lastError || '' };
        for (const i of this.instances) {
            try { s[i.id] = i.world.stats ? i.world.stats() : {}; } catch (err) { s[i.id] = { error: err.message }; }
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
        try {
            this.frameWorlds(now, dt);
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
            return;
        }
        // the suns passed on; then links, sound and the handheld read what the worlds did
        if (this.composed) this.lights();
        const scope = this.scope = this.buildScope();
        for (const l of this.links) {
            let v;
            try { v = l.value(scope); } catch { continue; }
            if (Host.same(v, l.last)) continue;
            l.last = Array.isArray(v) ? [...v] : v;
            l.inst.world.set?.(l.param, v);
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

    // the worlds' readouts kept on the screen (EngineHud side panels), a few times a second: the portal traversal tree of
    // the world the camera is inside (else of the one with the keys), while its inspector's `tree` option is on
    sidePanels(now) {
        if (now - (this.sideAt || 0) < 200) return;
        this.sideAt = now;
        const at = this.holder || this.instances.find(i => i.id === this.router.focus);
        for (const inst of this.instances) {
            const I = inst === at ? inst.world.inspector : null;
            this.hud?.side(inst.id, I && I.opts.tree ? I.tree() : null);
        }
    }

    frameWorlds(now, dt) {
        if (!this.composed) {
            const inst = this.instances[0];
            inst.world.frame(now, dt);
            return;
        }
        // the camera: the engine's, or its world's after that world's own update
        const atmos = this.instances.filter(i => i.role === 'atmosphere');
        const scene = this.instances.filter(i => i.role !== 'atmosphere');
        const owner = this.cameraOwner;
        if (this.fly) this.fly.update(dt);
        this.compositor.resize(this.width, this.height, this.instances);
        // the camera's world moves first (its update only), so every world renders this frame's view
        let view = this.fly ? this.fly.view : null;
        if (owner) {
            owner.world.frame(now, dt, { render: false });
            view = this.worldView();
        }
        this.eye = view;
        const step = (inst, render) => {
            if (inst === owner) { if (render) inst.world.frame(now, dt, { update: false }); return; }
            if (view) this.setView(inst, view);
            inst.world.frame(now, dt, { render });
        };
        for (const inst of scene) step(inst, true);
        // where the camera is (inside a world's interior, or out), before the atmospheres draw the outdoors
        this.inside();
        const enc = this.gpuFrame.enc;
        for (const inst of scene) this.compositor.linearize(enc, inst);
        const sky = this.skyOf(scene);
        if (atmos.length) {
            const inj = scene.length ? this.compositor.merge(enc, scene, null, sky) : null;
            for (const a of atmos) {
                a.ctx.inject = inj;
                step(a, true);
            }
        } else this.compositor.merge(enc, scene, this.swapView(), sky);
    }
}

function showFallback(e) {
    console.error(e);
    window.entities?.hud.buildFallbackBar();
    document.getElementById('error-message').textContent = String(e && (e.stack || e.message) || e);
    document.getElementById('fallback').classList.add('show');
}

window.addEventListener('DOMContentLoaded', () => {
    const host = window.entities = new Host();     // devtools: entities.instances[i].world
    host.boot().catch(showFallback);
});
