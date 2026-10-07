'use strict';
// The game: the frame loop, scenario loading, settings and imports.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { lerp, v3, fmtK } = Common;
const {
    INSTANCE_FLOATS, FORCE, LOD_MODES, ATLAS_VIEWS, nextFrame, quat, Oct, ModelLibrary, GltfLoader, ObjLoader,
    ImposterBaker, Renderer, Lighting, World, FlyCamera, InputSystem, Hud, ControlPanel,
} = feature;

class Game {
    constructor(fx) {
        const scenario = fx.native;
        this.fx = fx;
        this.ui = fx.ui;
        this.canvas = fx.canvas;
        this.scenario = scenario;
        this.baseScenario = scenario;       // last scenario loaded from data (drops of models derive from it)
        this.renderer = new Renderer(fx);
        this.lib = new ModelLibrary();
        this.camera = new FlyCamera();
        this.lighting = new Lighting();
        this.bakes = 0;                     // atlas bakes since start
        this.bakesAfterRelight = 0;         // ... since the lighting first changed (only manual rebakes / new models)
        this.input = new InputSystem(this);
        this.hud = new Hud(this);
        this.world = null;
        this.loading = false;
        this.baking = false;
        this.cpuMs = 0;
        this.time = 0;
        this.last = 0;
        this.focusInfo = null;
        this.settings = {
            lodMode: 'auto', lodDistance: 40, fade: 0.25, far: 2400, blend: true, parallax: true, depthOffset: true, tint: false, atlasView: 'off', focus: '',
            shadows: true, shadowDistance: 1200, shadowLambda: 0.85, cascadeTint: false,
        };
    }

    // the world loads (and bakes) while frames already run
    async start() {
        await this.renderer.init();
        this.baker = new ImposterBaker(this.renderer);
        this.panel = new ControlPanel(this);
        this.input.attach();
        this.attachFiles();
        this.loadScenario(this.scenario);
    }

    toast(msg, ms) { this.hud.toast(msg, ms); }

    applyScenarioSettings(sc) {
        const lod = sc.lod || {}, imp = sc.imposter || {}, st = this.settings;
        Object.assign(st, {
            lodMode: LOD_MODES.includes(lod.mode) ? lod.mode : 'auto', lodDistance: lod.distance ?? 40, fade: lod.fade ?? 0.25, far: lod.far ?? 2400,
            blend: imp.blend ?? true, parallax: imp.parallax ?? true, depthOffset: imp.depthOffset ?? true,
        });
        const sh = sc.shadows || {};
        Object.assign(st, { shadows: sh.enabled ?? true, shadowDistance: sh.distance ?? 1200, shadowLambda: sh.lambda ?? 0.85 });
        this.renderer.ensureShadowMap(sh.resolution ?? 2048);
    }

    // build a world from scenario data and make it current; `fromData` = a scenario (not a model drop)
    async loadScenario(sc, { resetCamera = true, fromData = true } = {}) {
        if (this.loading) { this.toast('Still loading…'); return; }
        this.loading = true;
        try {
            const world = new World(this, sc);
            await world.build();
            const old = this.world;
            this.world = world;
            this.scenario = sc;
            if (fromData) { this.baseScenario = sc; this.applyScenarioSettings(sc); this.lighting.load(sc); }
            old?.destroy();
            this.lib.flushRetired();
            if (resetCamera) this.camera.reset(sc.camera, world);
            const imp = world.list.filter(a => a.asset.settings.enabled);
            if (!imp.some(a => a.name === this.settings.focus)) this.settings.focus = (imp.find(a => a.asset.kind === 'import') || imp.find(a => a.name === 'oak') || imp[0] || {}).name || '';
            this.panel.sync();
            const inst = world.list.reduce((n, a) => n + a.count, 0);
            if (world.warnings.length) { console.warn('Scenario warnings:\n' + world.warnings.join('\n')); this.toast(`${world.warnings.length} scenario warning(s), see console`, 4000); }
            else this.toast(`Loaded "${sc.name || 'scenario'}": ${fmtK(inst)} instances of ${world.list.length} models`);
        } catch (err) {
            console.error(err);
            this.toast('Scenario error: ' + err.message, 6000);
        } finally {
            this.loading = false;
        }
    }

    // bake (or rebake) one model's atlas; the old atlas stays in use until the new one is ready
    async bake(asset) {
        const s = asset.settings;
        this.toast(`Baking ${asset.name}: ${s.grid}x${s.grid} frames @ ${s.res}px (${s.mode})…`, 0);
        await nextFrame();
        await nextFrame();
        const old = asset.atlas;
        asset.atlas = await this.baker.bake(asset);
        asset.version++;
        this.bakes++;
        this.fx.emit('baked', { name: asset.name, ms: asset.atlas.bakeMs });
        if (this.lighting.changes) this.bakesAfterRelight++;
        old?.destroy();
        this.toast(`Baked ${asset.name} in ${asset.atlas.bakeMs.toFixed(0)} ms`, 1500);
    }

    async rebake() {
        const a = this.world && this.world.archetypes.get(this.settings.focus);
        if (!a || this.baking || this.loading) return;
        this.baking = true;
        try {
            Object.assign(a.asset.settings, this.panel.bakeSettings());
            await this.bake(a.asset);
        } catch (err) {
            console.error(err);
            this.toast('Bake failed: ' + err.message, 5000);
        } finally {
            this.baking = false;
            this.panel.sync();
        }
    }

    relight(k, v) {
        const L = this.lighting;
        if (k === 'preset') { L.set(v); this.toast(`Lighting: ${v} (no rebake)`, 1200); this.fx.emit('relight', { name: v }); }
        else L.tweak(k, v);
        this.panel.sync();
    }

    set(k, v) {
        const st = this.settings;
        st[k] = v;
        if (k === 'lodMode') this.toast(`LOD: ${v}`, 900);
        this.panel.sync();
    }

    action(a) {
        if (a === 'rebake') this.rebake();
        else if (a === 'load') this.ui.$('file').click();
        else if (a === 'export') {
            // as a scenario of entities (the engine's format, js/engine/scenario-format.js)
            const sc = { name: this.baseScenario.name, group: 'Entity Imposter', entities: ScenarioFormat.fromNative('imposter', this.baseScenario) };
            const url = URL.createObjectURL(new Blob([JSON.stringify(sc, null, 2)], { type: 'application/json' }));
            const link = Object.assign(document.createElement('a'), { href: url, download: 'scenario.json' });
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    onKey(code) {
        const st = this.settings, toggle = (k, label) => { this.set(k, !st[k]); this.toast(`${label} ${st[k] ? 'ON' : 'OFF'}`, 900); this.fx.emit('toggle', { on: st[k] }); };
        switch (code) {
            case 'Digit1': this.set('lodMode', 'auto'); break;
            case 'Digit2': this.set('lodMode', 'mesh'); break;
            case 'Digit3': this.set('lodMode', 'imposter'); break;
            case 'KeyB': toggle('blend', 'Frame blending'); break;
            case 'KeyP': toggle('parallax', 'Depth parallax'); break;
            case 'KeyO': toggle('depthOffset', 'Pixel depth offset'); break;
            case 'KeyT': toggle('tint', 'LOD tint'); break;
            case 'KeyG': toggle('shadows', 'Shadows'); break;
            case 'KeyV': this.set('atlasView', ATLAS_VIEWS[(ATLAS_VIEWS.indexOf(st.atlasView) + 1) % ATLAS_VIEWS.length]); break;
            case 'KeyN': {
                const names = this.world ? this.world.list.filter(a => a.asset.settings.enabled).map(a => a.name) : [];
                if (names.length) { this.set('focus', names[(names.indexOf(st.focus) + 1) % names.length]); this.toast(`Focus: ${st.focus}`, 900); }
                break;
            }
            case 'BracketLeft': this.set('lodDistance', Math.max(2, Math.round(st.lodDistance / 1.25))); break;
            case 'BracketRight': this.set('lodDistance', Math.min(300, Math.round(st.lodDistance * 1.25))); break;
            case 'KeyR': this.camera.reset(this.scenario.camera, this.world); break;
            case 'KeyL': this.ui.$('file').click(); break;
            case 'KeyK': this.lighting.cycle(); this.toast(`Lighting: ${this.lighting.name} (no rebake)`, 1200); this.panel.sync(); this.fx.emit('relight', { name: this.lighting.name }); break;
        }
    }

    attachFiles() {
        const input = this.ui.$('file');
        input.addEventListener('change', () => { if (input.files.length) this.loadFiles([...input.files]); input.value = ''; });
    }

    // a scenario .json, or a model (+ its companion files) that replaces the scenario's `drop` targets
    async loadFiles(list) {
        const files = new Map(list.map(f => [f.name.toLowerCase(), f]));
        const main = list.find(f => /\.(glb|gltf|obj)$/i.test(f.name)) || list.find(f => /\.json$/i.test(f.name));
        if (!main) { this.toast('Drop a .glb, .gltf, .obj or a scenario .json'); return; }
        if (this.loading || this.baking) { this.toast('Busy, try again in a moment'); return; }
        try {
            if (/\.json$/i.test(main.name)) { await this.loadScenario(JSON.parse(await main.text())); return; }
            this.toast(`Loading ${main.name}…`, 0);
            await nextFrame();
            const mesh = /\.obj$/i.test(main.name) ? await ObjLoader.load(main, files) : await GltfLoader.load(main, files);
            const base = this.baseScenario, drop = base.drop || {};
            mesh.fit(drop.fit ?? 6);
            const name = 'import:' + main.name.replace(/\.[^.]+$/, '');
            this.lib.addImport(name, mesh, drop.imposter);
            const sc = structuredClone(base);
            for (const e of sc.entities || []) if ((drop.replace || []).includes(e.id)) e.model = name;
            if (drop.field) sc.entities.push({ ...drop.field, model: name });
            this.settings.focus = name;
            await this.loadScenario(sc, { resetCamera: false, fromData: false });
        } catch (err) {
            console.error(err);
            this.toast(`Could not load ${main.name}: ${err.message}`, 6000);
        }
    }

    // the focused model's nearest instance: which atlas frames it uses right now (atlas overlay, HUD)
    updateFocus() {
        const w = this.world, a = w && w.archetypes.get(this.settings.focus), at = a && a.asset.atlas;
        if (!at || !a.data) { this.focusInfo = null; return; }
        let best = -1, bd = Infinity;
        for (let i = 0; i < a.count; i++) {
            const o = i * INSTANCE_FLOATS, dd = (a.data[o] - this.camera.pos[0]) ** 2 + (a.data[o + 1] - this.camera.pos[1]) ** 2 + (a.data[o + 2] - this.camera.pos[2]) ** 2;
            if (a.data[o + 8] !== FORCE.mesh && dd < bd) { bd = dd; best = i; }
        }
        if (best < 0) { this.focusInfo = null; return; }
        const inst = a.instance(best), c = v3.add(inst.pos, quat.rotate(inst.rot, v3.mul(at.center, inst.scale)));
        const dir = quat.rotate(quat.conj(inst.rot), v3.norm(v3.sub(this.camera.pos, c)));
        this.focusInfo = {
            name: a.name, atlas: at, sel: Oct.select(dir, at.grid, at.full, this.settings.blend), view: this.settings.atlasView, rightInset: 0,
        };
    }

    // update: input, lighting, world; render: the frame. The host runs both, or (in a composition) the camera's world
    // updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        const t0 = performance.now(), w = this.world, cam = this.camera;
        if (update) {
            this.time += dt;
            this.input.update(dt);
            this.lighting.update(dt);
            if (w) {
                w.update(dt, this.time);
                if (!this.fx.cameraLocked) cam.pos[1] = Math.max(cam.pos[1], w.heightAt(cam.pos[0], cam.pos[2]) + 0.5);
            }
        }
        if (!render) return;
        this.updateFocus();
        const f = this.focusInfo;
        this.renderer.render(w, cam, this.settings, this.time, f && this.settings.atlasView !== 'off' ? f : null, this.lighting.env);
        this.cpuMs = lerp(this.cpuMs, performance.now() - t0, 0.1);
        this.hud.update(now);
        if (now - (this.lastSync || 0) > 500) { this.lastSync = now; if (!this.baking) this.panel.sync(); }
    }
}

return { Game };
});
