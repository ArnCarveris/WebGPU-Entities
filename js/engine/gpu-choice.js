'use strict';
// GPU choice: WebGPU cannot list the adapters, a page can only ask for one by power preference (or for the software
// fallback), so those are the choices. The pick is kept in localStorage (?gpu=<id> in the URL overrides it) and takes
// effect on a reload: every GPU resource belongs to the device made from the adapter.

const GpuChoice = {
    CHOICES: [
        { id: 'default', label: 'browser default', options: {} },
        { id: 'high-performance', label: 'high performance', options: { powerPreference: 'high-performance' } },
        { id: 'low-power', label: 'low power', options: { powerPreference: 'low-power' } },
        { id: 'fallback', label: 'software', options: { forceFallbackAdapter: true } },
    ],
    INITIAL: 'default',              // until something is picked
    STORAGE_KEY: 'webgpu-entity.gpu',
    names: null,                     // { id: adapter name | null } once probed

    get id() {
        let id = new URLSearchParams(location.search).get('gpu');
        if (!id) try { id = localStorage.getItem(this.STORAGE_KEY); } catch { /* storage blocked */ }
        return this.CHOICES.some(c => c.id === id) ? id : this.INITIAL;
    },

    // the adapter of the current choice, or the browser default when that choice has none
    async requestAdapter() {
        const choice = this.CHOICES.find(c => c.id === this.id);
        let adapter = await navigator.gpu.requestAdapter(choice.options);
        if (!adapter && choice.id !== 'default') {
            console.warn(`GPU choice '${choice.label}' has no adapter, using the browser default`);
            adapter = await navigator.gpu.requestAdapter();
        }
        return adapter;
    },

    // The GPU's product name, as Task Manager shows it. WebGPU only gives it with the browser's WebGPU developer features
    // on (else just vendor + architecture, "nvidia ampere"), so it is taken from WebGL's renderer string for the same
    // power preference when that names a GPU of the adapter's vendor.
    describe(adapter, options = {}) {
        const info = adapter.info || {};
        if (info.description) return info.description;
        if (info.isFallbackAdapter) return 'software (CPU)';
        const vendor = info.vendor || '';
        const aliases = { amd: ['amd', 'ati', 'radeon'], qualcomm: ['qualcomm', 'adreno'] }[vendor] || [vendor];
        const gl = this.webglRenderer(options.powerPreference);
        if (gl && vendor && aliases.some(a => gl.toLowerCase().includes(a))) return gl;
        return [vendor, info.architecture].filter(Boolean).join(' ') || 'unknown GPU';
    },

    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)" ->
    // "NVIDIA GeForce RTX 3050 Ti Laptop GPU"; null where the browser hides it
    webglRenderer(powerPreference = 'default') {
        try {
            const gl = document.createElement('canvas').getContext('webgl', { powerPreference });
            const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
            const s = ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            if (!s) return null;
            const angle = /^ANGLE \((.*)\)$/.exec(s);
            const name = angle ? angle[1].split(', ').slice(1, -1).join(', ') || angle[1] : s;
            return name.replace(/^ANGLE \w+ Renderer: /, '').replace(/\s*\(0x[0-9a-f]+\).*$|\s+(Direct3D|OpenGL|Vulkan|Metal)\b.*$/i, '').trim() || null;
        } catch {
            return null;
        }
    },

    // which GPU each choice gets on this machine
    probe() {
        return this.probing ||= Promise.all(this.CHOICES.map(c => navigator.gpu
            ? navigator.gpu.requestAdapter(c.options).then(a => a && this.describe(a, c.options), () => null) : null))
            .then(names => this.names = Object.fromEntries(this.CHOICES.map((c, i) => [c.id, names[i]])));
    },

    pick(id) {
        if (id === this.id) return;
        try { localStorage.setItem(this.STORAGE_KEY, id); } catch { /* storage blocked: the URL still carries it */ }
        const url = new URL(location.href);
        url.searchParams.set('gpu', id);
        location.replace(url);
    },

    // a <select> of the choices, each labelled with the adapter it gets; picking one reloads the page
    select() {
        const sel = document.createElement('select');
        sel.title = 'GPU adapter (picking one reloads the page)';
        sel.innerHTML = this.CHOICES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
        sel.value = this.id;
        sel.addEventListener('change', () => this.pick(sel.value));
        sel.addEventListener('keydown', e => e.stopPropagation());     // keep the demo's keys out of the open list
        this.probe().then(names => {
            for (const o of sel.options) {
                const c = this.CHOICES.find(c => c.id === o.value);
                o.textContent = `${c.label} · ${names[c.id] || 'none'}`;
                o.disabled = !names[c.id] && !o.selected;
            }
        });
        return sel;
    },

    // <label>GPU <select></label>
    panel() {
        const el = document.createElement('label');
        el.className = 'gpu-pick';
        el.innerHTML = '<span>GPU</span>';
        el.appendChild(this.select());
        return el;
    },
};
