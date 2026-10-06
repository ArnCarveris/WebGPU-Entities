'use strict';
// EngineHud: what the engine shows on the screen, which is next to nothing: a corner chip that takes the handheld out
// (every option, readout and page lives on the handheld, js/engine/handheld.js) and toasts.
//
//   hud.toast  { text, ms, delay }: shown once the scenario starts
//
// Only when the page could not start (no WebGPU, a bad scenario) does the bar grow the scenario and GPU pickers, so
// another one can still be chosen.

class EngineHud {
    constructor(host) {
        this.host = host;
        this.toastEl = document.getElementById('engine-toast');
    }

    // ------------------------------------------------------------------------------------------- the chip
    buildBar() {
        const bar = document.getElementById('engine-bar');
        bar.innerHTML = '';
        const chip = document.createElement('button');
        chip.className = 'handheld';
        chip.title = 'WebGPU Entities: the handheld holds every option of this scenario (TAB / Esc)';
        chip.innerHTML = '<span class="brand">ENTITIES</span> <span class="key">TAB</span>';
        chip.addEventListener('click', () => { this.host.handheld.setShown(!this.host.handheld.shown); chip.blur(); });
        bar.appendChild(chip);
        this.paintHandheld = () => chip.classList.toggle('on', !!this.host.handheld?.shown);
    }

    // the page could not start: pick another scenario or GPU from here
    buildFallbackBar() {
        const bar = document.getElementById('engine-bar'), catalog = this.host.catalog || [], currentId = this.host.currentId;
        bar.innerHTML = '<span class="brand">ENTITIES</span>';
        const sel = document.createElement('select');
        sel.title = 'Scenario (picking one reloads the page)';
        const groups = new Map();
        for (const s of catalog) {
            if (!groups.has(s.group)) groups.set(s.group, []);
            groups.get(s.group).push(s);
        }
        for (const [g, list] of groups) {
            const og = document.createElement('optgroup');
            og.label = g;
            for (const s of list) og.appendChild(Object.assign(document.createElement('option'), { value: s.id, textContent: s.name }));
            sel.appendChild(og);
        }
        if (currentId && !catalog.some(s => s.id === currentId)) sel.prepend(Object.assign(document.createElement('option'), { value: currentId, textContent: currentId }));
        sel.value = currentId;
        sel.addEventListener('change', () => this.host.pickScenario(sel.value));
        bar.appendChild(sel);
        bar.appendChild(GpuChoice.panel());
    }

    // ------------------------------------------------------------------------------------------- hud.toast
    configure(entities) {
        for (const e of entities) {
            if (e.type === 'hud.toast') setTimeout(() => this.toast(e.text, e.ms || 3000), e.delay || 600);
        }
    }

    toast(msg, ms = 2400) {
        this.toastEl.textContent = msg;
        this.toastEl.style.display = 'block';
        clearTimeout(this.tid);
        this.tid = setTimeout(() => { this.toastEl.style.display = 'none'; }, ms);
    }
}
