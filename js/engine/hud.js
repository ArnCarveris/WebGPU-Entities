'use strict';
// EngineHud: the engine's own UI and the HUD as entities.
//
// The bar (top right): scenario picker (every scenario, grouped by the demo it comes from, compositions first), the
// worlds of a composition (show / hide each one to see it alone or composed; the focused one gets the keys), sound,
// GPU picker. Everything else comes from the scenario:
//
//   hud.panel  { id, anchor: top-left | top | top-right | left | right | bottom-left | bottom | bottom-right,
//                lines: [template, ...], title, of (only while that world has focus), when: expr, every: ms, class }
//              Templates are text with {expr|format} slots (see Expr), read against the frame scope: { time, fps, focus,
//              scenario, <world id>: its stats() }. Markup is limited to <b> <i> <br> <span class="...">.
//   hud.help   { of, lines }: the help text of a world, shown in its own help panel (H toggles it)
//   hud.toast  { text, ms }: shown once the scenario starts
//   view       { name, pos, look, fov }: a viewpoint in composition space, picked from the bar

const HudMarkup = {
    // escapes everything but a few formatting tags
    clean(html) {
        const esc = String(html).replace(/&(?!(?:[a-z]+|#\d+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return esc
            .replace(/&lt;(\/?)(b|i|br)&gt;/g, '<$1$2>')
            .replace(/&lt;span class="([\w -]*)"&gt;/g, '<span class="$1">')
            .replace(/&lt;\/span&gt;/g, '</span>');
    },
};

class EngineHud {
    constructor(host) {
        this.host = host;
        this.root = document.getElementById('engine-hud');
        this.anchors = {};
        for (const a of ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right']) {
            const el = document.createElement('div');
            el.className = `anchor anchor-${a}`;
            this.root.appendChild(el);
            this.anchors[a] = el;
        }
        this.panels = [];
        this.toastEl = document.getElementById('engine-toast');
    }

    // ------------------------------------------------------------------------------------------- the bar
    buildBar(catalog, currentId, instances) {
        const bar = document.getElementById('engine-bar');
        bar.innerHTML = '';
        const title = document.createElement('span');
        title.className = 'brand';
        title.textContent = 'ENTITIES';
        title.title = 'WebGPU Entities: every scenario of every WebGPU-Entity demo, and compositions of them';
        bar.appendChild(title);

        // scenarios, grouped
        const sel = document.createElement('select');
        sel.className = 'scenario-pick';
        sel.title = 'Scenario (picking one reloads the page)';
        const groups = new Map();
        for (const s of catalog) {
            if (!groups.has(s.group)) groups.set(s.group, []);
            groups.get(s.group).push(s);
        }
        for (const [g, list] of groups) {
            const og = document.createElement('optgroup');
            og.label = g;
            for (const s of list) {
                const o = document.createElement('option');
                o.value = s.id;
                o.textContent = s.name;
                o.title = s.description || '';
                og.appendChild(o);
            }
            sel.appendChild(og);
        }
        if (currentId && !catalog.some(s => s.id === currentId)) {
            const o = document.createElement('option');
            o.value = currentId;
            o.textContent = this.host.scenario?.name || currentId;
            sel.prepend(o);
        }
        sel.value = currentId;
        sel.addEventListener('change', () => this.host.pickScenario(sel.value));
        sel.addEventListener('keydown', e => e.stopPropagation());
        bar.appendChild(sel);

        // the worlds of a composition
        if (instances.length > 1) {
            const box = document.createElement('span');
            box.className = 'layers';
            this.layerEls = new Map();
            for (const inst of instances) {
                const chip = document.createElement('span');
                chip.className = 'layer';
                chip.innerHTML = `<input type="checkbox" checked><span class="name"></span>`;
                chip.querySelector('.name').textContent = inst.label.split(' · ')[0];
                chip.title = `${inst.label} (${inst.feature}): checkbox shows / hides it, the name gives it the keys (\` cycles), Alt+click shows it alone`;
                const cb = chip.querySelector('input');
                cb.addEventListener('change', () => this.host.setVisible(inst, cb.checked));
                chip.querySelector('.name').addEventListener('click', e => {
                    if (e.altKey) this.host.solo(inst);
                    else this.host.focusInstance(inst);
                });
                box.appendChild(chip);
                this.layerEls.set(inst, { chip, cb });
            }
            bar.appendChild(box);
        }

        // the scenario's viewpoints (view entities)
        const views = (this.host.scenario?.entities || []).filter(e => e.type === 'view');
        if (views.length && instances.length) {
            const vs = document.createElement('select');
            vs.className = 'view-pick';
            vs.title = 'Jump the camera to a viewpoint';
            vs.innerHTML = `<option value="">view…</option>` + views.map((v, i) => `<option value="${i}"></option>`).join('');
            views.forEach((v, i) => { vs.options[i + 1].textContent = v.name || `view ${i + 1}`; });
            vs.addEventListener('change', () => { if (vs.value !== '') this.host.jumpView(views[+vs.value]); vs.value = ''; vs.blur(); });
            vs.addEventListener('keydown', e => e.stopPropagation());
            bar.appendChild(vs);
        }

        const snd = document.createElement('button');
        snd.className = 'sound';
        snd.title = 'Sound on / off';
        const paint = this.paintSound = () => { snd.textContent = this.host.audio.on ? '♪ on' : '♪ off'; };
        paint();
        snd.addEventListener('click', () => { this.host.audio.toggle(); paint(); });
        bar.appendChild(snd);

        const gpu = GpuChoice.panel();
        if (instances.length > 1) { gpu.querySelector('span').textContent = ''; gpu.classList.add('compact'); }
        bar.appendChild(gpu);
    }

    refreshLayers() {
        if (!this.layerEls) return;
        for (const [inst, { chip, cb }] of this.layerEls) {
            cb.checked = inst.visible;
            chip.classList.toggle('focus', this.host.router.focus === inst.id);
            chip.classList.toggle('camera', this.host.cameraOwner === inst);
        }
    }

    // ------------------------------------------------------------------------------------------- hud.* entities
    configure(entities) {
        for (const e of entities) {
            if (e.type === 'hud.panel') {
                const el = document.createElement('div');
                el.className = `panel engine-panel ${e.class || ''}`;
                if (e.id) el.dataset.id = e.id;
                (this.anchors[e.anchor || 'top'] || this.anchors.top).appendChild(el);
                const lines = (e.title ? [`<span class="t">${e.title}</span>`] : []).concat(e.lines || []);
                this.panels.push({ def: e, el, lines: lines.map(l => Expr.template(l)), when: e.when != null ? Expr.compile(e.when) : null, last: -1e9 });
            } else if (e.type === 'hud.help') {
                const inst = this.host.instances.find(i => i.id === e.of) || this.host.instances[0];
                const el = inst?.ui.$('help');
                if (el) el.innerHTML = HudMarkup.clean((e.lines || []).join('\n'));
            } else if (e.type === 'hud.toast') {
                setTimeout(() => this.toast(e.text, e.ms || 3000), e.delay || 600);
            }
        }
    }

    update(scope, now) {
        for (const p of this.panels) {
            if (now - p.last < (p.def.every ?? 200)) continue;
            p.last = now;
            const shown = (!p.def.of || scope.focus === p.def.of) && (!p.when || p.when(scope));
            p.el.style.display = shown ? '' : 'none';
            if (!shown) continue;
            try {
                p.el.innerHTML = HudMarkup.clean(p.lines.map(l => l(scope)).join('\n'));
            } catch (err) {
                p.el.textContent = `hud.panel ${p.def.id || ''}: ${err.message}`;
            }
        }
    }

    toast(msg, ms = 2400) {
        this.toastEl.textContent = msg;
        this.toastEl.style.display = 'block';
        clearTimeout(this.tid);
        this.tid = setTimeout(() => { this.toastEl.style.display = 'none'; }, ms);
    }
}
