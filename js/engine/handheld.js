'use strict';
// Handheld: the engine's phone, in every scenario, and the only place options and readouts live (the screen keeps
// nothing but the worlds, their in-world labels and toasts). A PhoneGUI (the gui kit, js/kits/gui/) whose pages are data,
// held in front of the camera and drawn over the finished frame (its own pass, depth and fixed field of view, so it
// never clips into a world). TAB (or the corner chip) takes it out, Esc puts it away; while the cursor is on it, the
// worlds don't get the mouse.
//
// Its root page: a section per world (the pages that world offers, see below, and the scenario's pages tied to it), the
// scenario's own pages, then the engine's options (scenario, worlds, view, move, sound, GPU).
//
//   handheld       { startShown, title, fovDeg, showSeconds, pose, screen, virtual, zOffset, model, materials, sounds }
//                  merged over HANDHELD_DEFAULTS, later entities winning (a composition overrides what it includes)
//   handheld.page  { id, of, title, nav: { section, sub, icon }, sections: [{ header, cells: [...], footer }] }
//                  a list page; `of` ties it to a world (its id becomes "<of>:<id>" and its nav cell names the world in a
//                  composition), `nav` adds a cell for it to that section of the root page. Cells as in PhoneGUI:
//                  nav, label, text, switch, slider, picker, action; `label` / `text` take `expr`, a template read
//                  against the frame scope ("{sky.rain|pct}", see js/engine/expr.js).
//
// Every world offers its options and readouts through world.handheld() -> [{ id, title, sub, icon, sections }], rebuilt
// a few times a second while the handheld is out. Their cells are plain data with closures:
//   { label, value } { text } { toggle, on, set(v) } { choice, options: [label | { label, sub }], index, pick(i) }
//   { action, run() } { slider, value, min, max, fmt(v), set(v) } { image: <canvas>, aspect, click(u, v) }
// A world built of areas and portals also has world.inspector (kits.interior VisInspector): its floor map and portal
// traversal pages come from it, so every such world shows the same ones.
//
// A world can lend it more (the gui feature's facility does): provide({ id, pages, bindings, apps(phone), renderer,
// fullscreen(), hidden(), motion(), lighting(t) }): its pages (their root sections go first), named bindings for their
// cells, PhoneApps, the GUI materials of its renderer (render targets), and, while its player is the camera, the stride
// that sways the phone and the lights that light it.

const HANDHELD_DEFAULTS = {
    startShown: false,
    title: 'Debug Sheet',
    fovDeg: 60,
    showSeconds: 0.38,
    screen: [0.068, 0.1435],
    virtual: [270, 570],
    zOffset: 0.0047,
    pose: { hidden: { offset: [0.08, -0.2], yaw: -0.45, tilt: 0.95 }, shown: { offset: [0.062, -0.012, -0.2], yaw: -0.14, tilt: 0.04 }, landscape: { offset: [0, 0, -0.16] } },
    model: [
        { box: [-0.0385, -0.079, -0.0045, 0.0385, 0.079, 0.0045], mat: 'phoneBody' },
        { box: [0.0385, 0.018, -0.002, 0.0395, 0.042, 0.002], mat: 'lightMetal' },
        { box: [-0.0395, 0.03, -0.002, -0.0385, 0.04, 0.002], mat: 'lightMetal' },
        { box: [-0.0395, 0.015, -0.002, -0.0385, 0.025, 0.002], mat: 'lightMetal' },
        { box: [0.006, 0.048, -0.0068, 0.032, 0.074, -0.0045], mat: 'darkMetal' },
    ],
    materials: {
        phoneBody: { albedo: [0.035, 0.037, 0.042], spec: 0.9, shin: 70, emissive: { color: [0.012, 0.013, 0.015] } },
        lightMetal: { albedo: [0.18, 0.2, 0.16], spec: 0.7, shin: 40 },
        darkMetal: { pattern: 'plates', albedo: [0.1, 0.11, 0.12], spec: 0.45, shin: 30 },
        glass: { albedo: [0.004, 0.012, 0.014], spec: 1.2, shin: 110 },
    },
    // in eye space: a soft key light above the shoulder and a cool fill from below
    lighting: { ambient: 0.1, lights: [[0.35, 0.45, 0.25, 0.9, 1, 0.97, 0.92, 0], [-0.4, -0.35, 0.1, 0.25, 0.6, 0.7, 0.9, 0]] },
    sounds: [
        { type: 'sound.cue', on: 'handheld.shown', parts: [{ tone: ['on ? 700 : 520', 0.07, 'sine', 0.03, 'on ? 1100 : 300'] }] },
        { type: 'sound.cue', on: 'handheld.tap', parts: [{ tone: [1500, 0.02, 'sine', 0.03] }] },
    ],
};

class Handheld {
    // A world's readout panel (lines of text with a little markup, as the demos printed them) as handheld sections:
    // a <span class="t">TITLE</span> line starts a section, every other line is a "title   value" row (split at its
    // first run of spaces), a blank line ends a section.
    static panel(lines) {
        const strip = h => String(h ?? '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const sections = [];
        let sec = null;
        const open = header => { sections.push(sec = { header, cells: [] }); return sec; };
        for (const raw of lines || []) {
            const head = /^\s*<span class="t">([^<]*)<\/span>(.*)$/.exec(raw);
            if (head) {
                const title = strip(head[1]).trim();
                open(title.includes('//') ? 'STATUS' : title.toUpperCase());
                const rest = strip(head[2]).replace(/^[\s·]+/, '').trim();
                if (rest) sec.cells.push({ label: '', value: rest.replace(/\s{2,}/g, '  ') });
                continue;
            }
            const text = strip(raw).trim();
            if (!text) { sec = null; continue; }
            const m = /^(.{1,18}?)\s{2,}(.*)$/.exec(text) || /^(\S{1,18})\s+(.*)$/.exec(text);
            (sec || open(undefined)).cells.push(m ? { label: m[1], value: m[2].replace(/\s{2,}/g, '  ') } : { label: '', value: text });
        }
        return sections.filter(s => s.cells.length);
    }

    constructor(host) {
        this.host = host;
        this.cfg = HANDHELD_DEFAULTS;
        this.pages = {};                // the PhoneGUI's pages, rebuilt in place
        this.providers = [];
        this.anim = 0;                  // 0 hidden .. 1 in hand
        this.kick = 0;                  // shutter recoil
        this.land = 0;                  // 0 portrait .. 1 landscape (a world's full-screen video)
        this.pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        this.mouse = { x: 0, y: 0, inside: false };
        this.hasCursor = false;
        this.capture = false;
        this.ready = false;
        this.dyn = { specs: {}, actions: {} };     // bindings of the cells the worlds offer, rebuilt with their pages
        this.images = new Map();                    // image cells: key -> { canvas, texture, w, h, material, page }
        this.imageKeys = new Set();
        this.dirty = true;
        this.lastBuild = 0;
        const self = this;
        // what the PhoneGUI calls `game.audio`
        this.audio = {
            emit: (name, payload = {}) => host.emit('handheld', name, payload),
            later: (ms, fn) => setTimeout(fn, ms),
        };
        this.bindings = {
            spec(key) {
                for (const b of self.allBindings()) if (b.specs[key]) return b.specs[key];
                throw new Error(`No binding "${key}"`);
            },
            text(key) { const s = this.spec(key); return s.text ? s.text() : String(s.get()); },
            action(name) {
                for (const b of self.allBindings()) if (b.actions?.[name]) return b.actions[name]();
                throw new Error(`No action "${name}"`);
            },
        };
    }

    get target() { return this.shown; }
    get visible() { return this.anim > 0.001; }
    get interactive() { return this.shown && this.anim > 0.9; }
    get fullscreen() { return this.providers.some(p => p.fullscreen?.()); }
    get scope() { return this.host.scope || {}; }

    // ------------------------------------------------------------------------------------------- setup
    // before the worlds: its config and pages from the scenario, then its renderer on the host's device
    async init(scenario) {
        const ents = scenario.entities || [];
        const cfg = { ...HANDHELD_DEFAULTS };
        for (const e of ents.filter(e => e.type === 'handheld')) {
            const { type, $comment, ...rest } = e;
            Object.assign(cfg, rest);
        }
        this.cfg = cfg;
        this.shown = !!cfg.startShown;
        this.fovy = cfg.fovDeg * Math.PI / 180;
        this.scenarioPages = ents.filter(e => e.type === 'handheld.page');
        this.host.audio.configure(cfg.sounds || []);
        GpuChoice.probe?.();

        const { Renderer, MaterialTable, MeshBuilder, GuiAtlas, DeviceContext, PhoneGUI } = Features.kits.gui;
        const host = this.host;
        const r = this.renderer = new Renderer({
            device: host.device, format: host.format,
            size: () => [host.width, host.height],
            target: () => host.swapView(),
        });
        await r.init();
        await GuiAtlas.loadFonts();
        r.reserveSurfaces(1);           // the phone's screen
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(cfg.materials));
        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);
        this.mesh = r.createMesh(new MeshBuilder(r.worldMaterials).parts(cfg.model));
        this.instance = r.allocInstances(1);
        this.gui = new PhoneGUI(cfg, this.pages);
        this.gui.attach(this);
        r.finalizeInstances();
        this.view = r.createView();
        this.rebuild();
        this.listen();
        this.ready = true;
    }

    // a world lends the handheld its pages, bindings, apps and GUI materials
    provide(p) {
        this.providers.push(p);
        if (p.renderer) p.renderer.mirrorTo(this.renderer);
        if (p.apps) Object.assign(this.gui.apps, p.apps(this.gui));
        this.rebuild();
    }

    allBindings() {
        return [this.dyn, ...this.providers.map(p => p.bindings).filter(Boolean)];
    }

    // the root page: the lent root sections, a section per world, the scenario's pages, the engine's options
    rebuild() {
        const pages = this.pages, host = this.host;
        for (const k of Object.keys(pages)) delete pages[k];
        this.dyn = { specs: {}, actions: {} };
        this.imageKeys = new Set();
        const root = { title: this.cfg.title, sections: [] };
        const section = header => {
            let sec = root.sections.find(s => s.header === header);
            if (!sec) root.sections.push(sec = { header, cells: [] });
            return sec;
        };
        for (const p of this.providers) {
            for (const [id, page] of Object.entries(p.pages || {})) {
                if (id === 'root') root.sections.push(...(page.sections || []).map(s => ({ ...s, cells: [...(s.cells || [])] })));
                else pages[id] = page;
            }
        }
        // a world's section: its name in a composition, its scenario's name alone ("Water · Riverlands" -> RIVERLANDS)
        const worldSection = inst => {
            const [kind, name] = inst.label.split(' · ');
            return section((host.instances.length > 1 || !name ? kind : name).toUpperCase());
        };
        // what each world offers
        for (const inst of host.instances) {
            let offered = [];
            try { offered = inst.world.handheld?.() || []; } catch (err) { console.warn(`${inst.id}: handheld()`, err); }
            // a world built of areas and portals: its visibility (the interior kit's VisInspector), the same pages in every
            // world and scenario: the floor map, the portal traversal and its options
            try { offered = [...offered, ...(inst.world.inspector?.pages() || [])]; } catch (err) { console.warn(`${inst.id}: inspector`, err); }
            for (const sp of offered) {
                const id = `${inst.id}:${sp.id}`;
                pages[id] = this.toPage(id, sp);
                worldSection(inst).cells.push({ type: 'nav', page: id, title: sp.title, ...(sp.sub ? { sub: sp.sub } : {}), ...(sp.icon ? { icon: sp.icon } : {}) });
            }
        }
        // the scenario's pages (handheld.page entities), by their world
        for (const e of this.scenarioPages) {
            const id = e.of ? `${e.of}:${e.id}` : e.id;
            const { type, $comment, nav, of, ...page } = e;
            pages[id] = page;
            if (!nav) continue;
            const inst = of && host.instances.find(i => i.id === of);
            const { section: header, ...cell } = nav;
            (header ? section(header) : inst ? worldSection(inst) : section('SCENARIO')).cells.push({ type: 'nav', page: id, title: page.title, ...cell });
        }
        for (const sec of this.engineOptions()) root.sections.push(this.toSection('engine', sec));
        pages.root = root;
        this.dirty = false;
        this.lastBuild = performance.now();
        for (const [k, img] of this.images) if (!this.imageKeys.has(k)) img.page = null;
    }

    // the engine's own options, as offered cells
    engineOptions() {
        const host = this.host, cat = host.catalog || [], inst = host.instances;
        const short = i => i.label.split(' · ')[0];
        const cells = [{ choice: 'Scenario', options: cat.map(s => ({ label: s.name, sub: s.group })), index: cat.findIndex(s => s.id === host.currentId),
            value: host.scenario?.name, pick: i => host.pickScenario(cat[i].id) }];
        if (inst.length > 1) {
            const focus = inst.findIndex(i => i.id === host.router.focus);
            this.pages['engine:worlds'] = this.toPage('engine:worlds', { title: 'Worlds', sections: [
                { header: 'SHOWN', cells: inst.map(i => ({ toggle: i.label, on: i.visible, set: v => host.setVisible(i, v) })),
                    footer: 'Hide a world to see the others without it.' },
                { header: 'KEYS', cells: [
                    { choice: 'Keys', options: inst.map(i => i.label), index: focus, pick: k => host.focusInstance(inst[k]) },
                    { action: 'Show only that one', run: () => host.solo(inst[Math.max(0, inst.findIndex(i => i.id === host.router.focus))]) },
                    { action: 'Show all', run: () => inst.forEach(i => host.setVisible(i, true)) }],
                    footer: '` gives the keys to the next world.' },
            ] });
            cells.push({ nav: 'Worlds', page: 'engine:worlds', sub: `${inst.filter(i => i.visible).length} of ${inst.length} shown · keys: ${focus >= 0 ? short(inst[focus]) : '-'}` });
        }
        const views = inst.length ? host.viewList : [];
        if (views.length) {
            const multi = inst.length > 1 || views.some(v => !v.inst);
            cells.push({ choice: 'View', options: views.map(v => ({ label: v.name, sub: [multi && v.group, v.sub].filter(Boolean).join(' · ') || undefined })),
                index: views.findIndex(v => v.key === host.viewKey), value: '-', pick: i => host.goView(views[i]) });
        }
        const moves = host.moves;
        if (inst.length) cells.push({ choice: 'Move', options: moves.map(m => ({ label: m, sub: moves.length > 1 ? 'H' : undefined })),
            index: moves.indexOf(host.move), value: host.move, pick: i => host.setMove(moves[i]) });
        cells.push({ toggle: 'Sound', on: host.audio.on, set: () => host.audio.toggle() });
        const names = GpuChoice.names || {};
        cells.push({ choice: 'GPU', options: GpuChoice.CHOICES.map(c => ({ label: c.label, sub: names[c.id] === null ? 'none here' : names[c.id] || '' })),
            index: GpuChoice.CHOICES.findIndex(c => c.id === GpuChoice.id),
            pick: i => {
                const c = GpuChoice.CHOICES[i];
                if (names[c.id] === null) host.hud.toast(`${c.label}: no such GPU here`);
                else if (c.id !== GpuChoice.id) GpuChoice.pick(c.id);
            } });
        cells.push({ label: 'Frame rate', value: `${Math.round(host.fps)} fps` });
        return [{ header: 'ENGINE', cells, footer: 'TAB takes the handheld out, Esc puts it away. Drop a scenario .json on the page to load it.' }];
    }

    // ------------------------------------------------------------------------------------------- offered cells -> pages
    toPage(id, sp) {
        return { title: sp.title, sections: (sp.sections || []).map(s => this.toSection(id, s)) };
    }

    toSection(pid, s) {
        return { header: s.header, footer: s.footer, cells: (s.cells || []).filter(Boolean).map(c => this.toCell(pid, c)) };
    }

    // an offered cell -> a PhoneGUI cell, its closures as bindings (keys without ':', PhoneGUI splits hit ids on it)
    toCell(pid, c) {
        const name = c.key ?? c.toggle ?? c.choice ?? c.action ?? c.slider ?? c.nav ?? c.label ?? 'image';
        const key = `${pid}/${name}`.replace(/:/g, '_');
        const touched = () => { this.dirty = true; };
        if ('toggle' in c) {
            this.dyn.specs[key] = { get: () => !!c.on, set: v => { c.on = v; c.set(v); touched(); } };
            return { type: 'switch', bind: key, title: c.toggle };
        }
        if ('choice' in c) {
            const opts = (c.options || []).map(o => (typeof o === 'object' ? { title: String(o.label ?? o.title), sub: o.sub || undefined } : { title: String(o) }));
            this.dyn.specs[key] = { get: () => c.index, set: i => { c.index = i; c.pick(i); touched(); },
                label: i => opts[i]?.title ?? String(c.value ?? '-'), options: () => opts };
            this.pages[`pick:${key}`] = { title: c.choice, sections: [{ optionsBind: key }] };
            return { type: 'picker', bind: key, page: `pick:${key}`, title: c.choice };
        }
        if ('action' in c) {
            this.dyn.actions[key] = () => { c.run(); touched(); };
            return { type: 'action', action: key, title: c.action };
        }
        if ('slider' in c) {
            this.dyn.specs[key] = { get: () => c.value, set: v => { c.value = v; c.set(v); touched(); }, min: c.min, max: c.max,
                fmt: c.fmt || (v => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0))) };
            return { type: 'slider', bind: key, title: c.slider };
        }
        if ('nav' in c) return { type: 'nav', page: c.page, title: c.nav, ...(c.sub ? { sub: c.sub } : {}), ...(c.icon ? { icon: c.icon } : {}) };
        if ('image' in c) {
            const cv = c.image, img = this.image(key, cv);
            img.page = pid;
            this.imageKeys.add(key);
            this.dyn.specs[key] = { material: img.material, click: c.click || null };
            return { type: 'image', bind: key, aspect: c.aspect || cv.width / cv.height || 1, click: !!c.click };
        }
        if ('text' in c) return { type: 'text', text: String(c.text) };
        return { type: 'label', title: String(c.label ?? ''), value: c.value == null ? '' : String(c.value) };
    }

    // a canvas shown on the handheld: a GUI material of its own, copied in while its page is on screen
    image(key, canvas) {
        let img = this.images.get(key);
        const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
        if (img && img.canvas === canvas && img.w === w && img.h === h) return img;
        const U = GPUTextureUsage;
        const texture = this.renderer.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
        if (img) { img.texture.destroy(); this.renderer.setMaterialTexture(img.material, texture.createView()); }
        else { img = { material: `img/${this.images.size}` }; this.renderer.registerMaterial(img.material, 'gui', texture.createView()); this.images.set(key, img); }
        Object.assign(img, { canvas, texture, w, h });
        return img;
    }

    copyImages() {
        const shown = this.gui.pagesVisible();
        for (const img of this.images.values()) {
            if (!img.page || !shown.includes(img.page) || img.canvas.width !== img.w || img.canvas.height !== img.h) continue;
            this.renderer.device.queue.copyExternalImageToTexture({ source: img.canvas }, { texture: img.texture }, [img.w, img.h]);
        }
    }

    // ------------------------------------------------------------------------------------------- input
    // Window capture listeners run before every world's (InputRouter listens on the canvas / window, bubbling): presses
    // and the wheel on the phone stop there.
    listen() {
        const canvas = this.host.canvas;
        const track = e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = e.target === canvas; };
        const onPhone = e => e.target === canvas && this.interactive && !!this.trace(e.clientX, e.clientY);
        window.addEventListener('pointermove', track, true);
        window.addEventListener('pointerdown', e => {
            track(e);
            if (!onPhone(e)) return;
            e.stopPropagation();
            e.preventDefault();
            this.hover();
            if (this.gui.pointerDown()) this.capture = true;
        }, true);
        const release = () => { if (this.capture) this.gui.pointerUp(); this.capture = false; };
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
        for (const type of ['mousedown', 'click', 'dblclick', 'contextmenu']) {
            window.addEventListener(type, e => { if (onPhone(e)) { e.stopPropagation(); e.preventDefault(); } }, true);
        }
        window.addEventListener('wheel', e => {
            if (!onPhone(e)) return;
            e.stopPropagation();
            e.preventDefault();
            this.hover();
            this.gui.wheel(e.deltaY);
        }, { capture: true, passive: false });
        window.addEventListener('keydown', e => {
            if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
            if (e.code === 'Tab') {
                e.preventDefault();
                if (!e.repeat) this.setShown(!this.shown);
            } else if (e.code === 'Escape' && this.shown) this.setShown(false);
        }, true);
    }

    setShown(on) {
        on = !!on;
        if (this.shown === on) return;
        this.shown = on;
        this.gui.drag = null;
        if (on) document.exitPointerLock?.();
        else for (const p of this.providers) p.hidden?.();
        document.body.classList.toggle('handheld-up', on);
        if (on) this.dirty = true;
        this.audio.emit('shown', { on });
        this.host.hud.paintHandheld?.();
    }

    // the phone under a screen point: its GUI cursor, or null (eye space: the eye at the origin looking down -Z)
    trace(x, y) {
        const rect = this.host.canvas.getBoundingClientRect();
        const nx = ((x - rect.left) / rect.width) * 2 - 1, ny = 1 - ((y - rect.top) / rect.height) * 2;
        const th = Math.tan(this.fovy / 2), aspect = rect.width / rect.height;
        return this.gui.trace([0, 0, 0], [nx * th * aspect, ny * th, -1]);
    }

    hover() {
        const g = this.gui;
        const pt = this.interactive && this.mouse.inside ? this.trace(this.mouse.x, this.mouse.y) : null;
        g.active = !!pt || this.capture;
        if (pt) { g.cursor.x = pt.x; g.cursor.y = pt.y; }
        this.hasCursor = !!pt || this.capture;
    }

    // ------------------------------------------------------------------------------------------- frame
    // Pose relative to the eye: swings up from below with an overshoot when shown, sways with the walking player of
    // the world holding the camera, turns to landscape for a full-screen video
    poseAt(t) {
        const { M4, lerp, clamp, smooth01, easeOutBack } = Features.kits.gui;
        const P = this.cfg.pose, a = this.anim;
        const e = this.shown ? easeOutBack(a) : smooth01(a);
        const motion = this.providers.map(p => p.motion?.()).find(Boolean);
        const bob = motion?.moving ? 1 : 0, phase = motion?.stepPhase || 0;
        const bx = Math.sin(phase) * 0.0025 * bob;
        const by = Math.abs(Math.cos(phase)) * 0.003 * bob + Math.sin(t * 1.3) * 0.0008;
        const L = smooth01(clamp(this.land, 0, 1));
        const off = [
            lerp(lerp(P.hidden.offset[0], P.shown.offset[0], e), P.landscape.offset[0], L) + bx,
            lerp(P.hidden.offset[1], P.shown.offset[1], e) + by * (1 - L),
            lerp(P.shown.offset[2], P.landscape.offset[2], L) + this.kick * 0.006,
        ];
        return M4.chain(
            M4.translation(...off),
            M4.rotationY(lerp(lerp(P.hidden.yaw, P.shown.yaw, e), 0, L)),
            M4.rotationX(lerp(P.hidden.tilt, P.shown.tilt, e) + this.kick * 0.04),
            M4.rotationZ((L * Math.PI) / 2),
        );
    }

    frame(now, dt) {
        if (!this.ready) return;
        const { M4, clamp } = Features.kits.gui;
        const t = now / 1000, r = this.renderer, g = this.gui;
        this.anim = clamp(this.anim + ((this.shown ? 1 : -1) * dt) / this.cfg.showSeconds, 0, 1);
        this.kick *= Math.exp(-dt * 14);
        this.land = clamp(this.land + ((this.fullscreen ? 1 : -1) * dt) / 0.35, 0, 1);
        this.pose = this.poseAt(t);
        g.setTransform(this.pose);
        this.hover();
        if (this.capture) g.pointerDrag();
        const canvas = this.host.canvas;
        if (this.hasCursor) { canvas.style.cursor = 'none'; this.cursorHidden = true; }
        else if (this.cursorHidden) { canvas.style.cursor = ''; this.cursorHidden = false; }
        g.update(dt, now);
        if (!this.visible) return;
        if (this.dirty || now - this.lastBuild > 200) this.rebuild();
        this.copyImages();

        r.resize();
        g.build(this.dc, now);
        const lit = this.providers.map(p => p.lighting?.(t)).find(Boolean);
        const L = this.cfg.lighting, lights = [...(lit?.lights || L.lights)];
        while (lights.length < 6) lights.push([0, 0, 0, 0, 0, 0, 0, 0]);
        const frame = { time: t, lightsOn: true, alarmPulse: lit?.alarmPulse || 0, lights, fog: 0, ambient: lit ? lit.ambient : L.ambient };
        this.view.update(M4.perspective(this.fovy, r.aspect, 0.02, 100), [0, 0, 0], frame);
        r.setInstance(this.instance, this.pose);
        g.writeInstances(r);
        r.beginFrame();
        const pass = r.beginScenePass(r.swapView, r.depthView, this.view, { load: true, forceStencil: true });
        pass.mesh(this.mesh, this.instance);
        g.render(pass);
        pass.end();
        r.endFrame();
    }
}
