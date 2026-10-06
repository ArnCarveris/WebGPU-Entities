'use strict';
// Host: boots a scenario and runs every world in it.
//
//   1. catalog + scenario (scenarios/*.json over HTTP, or the embedded copies when opened from disk; a dropped file)
//   2. one GPU device for everything (GpuChoice adapter), one canvas
//   3. a world per feature root entity, each built by its feature script (Features) from its entities
//      (ScenarioFormat.toNative), with its own HUD root (in-world labels, toasts) and input scope; its options and
//      readouts go on the handheld (world.handheld(), see handheld.js)
//   4. the frame: the camera's world first, the camera passed to the others, each world renders (into the canvas when
//      it is alone, else into its layer); the Compositor merges the layers (or hands them to the atmosphere world);
//      then links and sound read the frame's stats, and the handheld draws over the finished frame
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

    // which feature a native scenario was made for: the schema that takes all its keys and shares the most with it
    static importNative(native, name) {
        let best = null;
        for (const f of Object.keys(ScenarioFormat.SCHEMAS)) {
            try {
                const entities = ScenarioFormat.fromNative(f, native);
                const s = ScenarioFormat.SCHEMAS[f], keys = [...s.config, ...Object.keys(s.lists), ...Object.keys(s.maps).map(p => p.split('.')[0])];
                const score = Object.keys(native).filter(k => keys.includes(k)).length;
                if (!best || score > best.score) best = { score, f, entities };
            } catch { /* not this feature */ }
        }
        if (!best || !best.score) throw new Error('not a scenario of entities, nor one made for any of the features');
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
        await this.initGpu();
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
        const features = ['timestamp-query', 'float32-filterable'].filter(f => adapter.features.has(f));
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
        if (!roots.length) throw new Error(`Scenario "${scenario.name}" has no feature world (an entity of type ${Object.keys(ScenarioFormat.SCHEMAS).join(' / ')})`);
        const engine = { Expr, GpuChoice, Common, CamMath, LayerFrame, host: this };
        this.composed = roots.length > 1;
        for (const root of roots) {
            const module = await Features.load(root.feature, engine);
            const inst = this.createInstance(root, scenario, module);
            this.instances.push(inst);
        }
        // atmosphere worlds render last, over the merged others
        for (const inst of this.instances) await inst.world.init();
    }

    createInstance(root, scenario, module) {
        const def = root.def, layer = def.layer || {};
        const huds = document.getElementById('feature-huds');
        const ui = document.createElement('div');
        ui.className = 'fhud';
        ui.dataset.feature = root.feature;
        ui.dataset.id = root.id;
        huds.appendChild(ui);
        const inst = {
            id: root.id,
            feature: root.feature,
            label: def.label || def.name || root.id,
            def, layer,
            visible: layer.visible !== false,
            role: layer.role || 'scene',
            frameDef: layer.transform || {},
            ui: { root: ui, $: name => ui.querySelector(`[data-hud="${name}"]`) },
        };
        const native = ScenarioFormat.toNative(scenario, root);
        const ctx = inst.ctx = {
            id: root.id, feature: root.feature, def, native, layer,
            host: this,
            device: this.device, format: this.format, adapter: this.adapter,
            canvas: this.canvas,
            ui: inst.ui,
            io: this.router.scope(root.id),
            composed: this.composed,
            cameraLocked: false,           // set while another world (or the engine) drives the camera
            inject: null,                  // atmosphere worlds: the merged other worlds this frame
            size: () => [this.width, this.height],
            target: () => this.targetFor(inst),
            emit: (name, payload) => this.emit(root.id, name, payload),
            toast: (msg, ms) => this.hud.toast(msg, ms),
            sound: { toggle: () => this.audio.toggle() },
            fail: err => showFallback(err),
        };
        inst.world = module.create(ctx);
        ui.innerHTML = inst.world.hudHtml || '';
        return inst;
    }

    configure(scenario) {
        const ents = scenario.entities || [];
        // camera
        const cam = this.cameraDef = ents.find(e => e.type === 'camera') || {};
        this.owners = [];
        if (cam.controller === 'fly') {
            this.fly = new FlyCamera(cam, this.router.scope('engine'));
            this.router.always.add('engine');
        } else if (cam.from) {
            this.owners = [].concat(cam.from).map(id => this.instances.find(i => i.id === id)).filter(Boolean);
        }
        if (!this.fly && !this.owners.length) this.owners = [this.instances.find(i => i.role !== 'atmosphere') || this.instances[0]];
        // each camera world's own view, for taking the camera back where it left it (carry false)
        for (const o of this.owners) o.savedView = o.world.view;
        this.setCameraOwner(this.owners[0] || null);
        const focus = this.instances.find(i => i.layer.focus) || this.cameraOwner || this.instances[0];
        this.focusInstance(focus);
        this.router.onFocus = () => this.refreshHuds();
        // the composition's engine keys
        window.addEventListener('keydown', e => {
            if (e.target instanceof Element && e.target.closest('.engine-ui')) return;
            this.audio.start();
            if (e.code === 'Backquote' && this.instances.length > 1) this.cycleFocus();
        });
        window.addEventListener('pointerdown', () => this.audio.start());
        // links between worlds
        for (const e of ents.filter(e => e.type === 'link')) {
            const [id, ...param] = String(e.to).split('.');
            const inst = this.instances.find(i => i.id === id);
            if (!inst) { console.warn(`link: no world "${id}"`); continue; }
            this.links.push({ inst, param: param.join('.'), value: Expr.compile(e.value), last: undefined });
        }
        this.hud.configure(ents);
        this.handheld.rebuild();
        this.audio.configure(ents);
        if (this.composed) this.compositor = new Compositor(this.device, this.format);
        this.refreshHuds();
    }

    // ------------------------------------------------------------------------------------------- worlds
    setCameraOwner(inst) {
        this.cameraOwner = inst;
        for (const i of this.instances) i.ctx.cameraLocked = !!this.fly || (inst ? i !== inst : false);
    }

    focusInstance(inst) {
        this.router.setFocus(inst.id);
        if (this.owners.includes(inst) && inst !== this.cameraOwner) {
            // the new owner takes over from the current view (or, with camera.carry false, goes on from its own)
            const v = this.worldView(), prev = this.cameraOwner;
            if (prev) prev.savedView = prev.world.view;
            this.setCameraOwner(inst);
            if (this.cameraDef.carry === false) { if (inst.savedView) inst.world.setView(inst.savedView); }
            else if (v) this.setView(inst, v);
        }
        this.refreshHuds();
    }

    cycleFocus() {
        const list = this.instances.filter(i => i.visible);
        if (!list.length) return;
        const k = list.findIndex(i => i.id === this.router.focus);
        const next = list[(k + 1) % list.length];
        this.focusInstance(next);
        this.hud.toast(`Keys → ${next.label}${this.cameraOwner === next ? ' (camera)' : ''}`, 1500);
    }

    setVisible(inst, on) {
        inst.visible = on;
        if (!on && this.router.focus === inst.id) {
            const other = this.instances.find(i => i.visible);
            if (other) this.focusInstance(other);
        }
        this.refreshHuds();
    }

    solo(inst) {
        for (const i of this.instances) i.visible = i === inst;
        this.focusInstance(inst);
        this.refreshHuds();
    }

    refreshHuds() {
        for (const i of this.instances) {
            const focused = this.router.focus === i.id;
            i.ui.root.classList.toggle('hidden', !i.visible);
            i.ui.root.classList.toggle('unfocused', this.composed && !focused);
        }
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
        if (!this.composed || inst.role === 'atmosphere' || this.directOut === inst) return this.swapView();
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
        try {
            this.frameWorlds(now, dt);
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
            return;
        }
        // links, sound and the handheld read what the worlds did
        const scope = this.scope = this.buildScope();
        for (const l of this.links) {
            let v;
            try { v = l.value(scope); } catch { continue; }
            if (!Host.same(v, l.last)) { l.last = Array.isArray(v) ? [...v] : v; l.inst.world.set?.(l.param, v); }
        }
        this.audio.update(scope);
        try {
            this.handheld.frame(now, dt);
        } catch (err) {
            if (!this.failed) { this.failed = true; showFallback(err); }
        }
    }

    frameWorlds(now, dt) {
        const visible = this.instances.filter(i => i.visible);
        if (!this.composed) {
            const inst = this.instances[0];
            inst.world.frame(now, dt);
            return;
        }
        // the camera: the engine's, or its world's after that world's own update
        const atmos = visible.filter(i => i.role === 'atmosphere');
        const scene = visible.filter(i => i.role !== 'atmosphere');
        const owner = this.cameraOwner;
        if (this.fly) this.fly.update(dt);
        this.compositor.resize(this.width, this.height, this.instances);
        // a world shown alone (no atmosphere over it) renders straight into the canvas
        this.directOut = scene.length === 1 && !atmos.length ? scene[0] : null;
        // the camera's world moves first (its update only), so every world renders this frame's view
        let view = this.fly ? this.fly.view : null;
        if (owner) {
            owner.world.frame(now, dt, { render: false });
            view = this.worldView();
        }
        const step = (inst, render) => {
            if (inst === owner) { if (render) inst.world.frame(now, dt, { update: false }); return; }
            if (view) this.setView(inst, view);
            inst.world.frame(now, dt, { render });
        };
        // hidden worlds don't run (bar the camera's)
        const rendered = [];
        for (const inst of scene) { step(inst, true); rendered.push(inst); }
        if (!atmos.length && this.directOut) return;
        const enc = this.device.createCommandEncoder({ label: 'composite' });
        for (const inst of rendered) this.compositor.linearize(enc, inst);
        const skyIdx = Math.max(0, rendered.findIndex(i => i.layer.sky));
        if (atmos.length) {
            const inj = rendered.length ? this.compositor.merge(enc, rendered, null, skyIdx) : null;
            this.device.queue.submit([enc.finish()]);
            for (const a of atmos) {
                a.ctx.inject = inj;
                step(a, true);
            }
        } else {
            this.compositor.merge(enc, rendered, this.swapView(), skyIdx);
            this.device.queue.submit([enc.finish()]);
        }
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
