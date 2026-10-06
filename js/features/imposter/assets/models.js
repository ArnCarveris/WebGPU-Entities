'use strict';
// Models: a model's mesh, GPU buffers and imposter atlas, and the library that builds them.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { clamp } = Common;
const { lin, m4, Material, SHAPES, MeshBuilder, GpuMesh } = feature;

// ModelAsset: a model's mesh, its GPU buffers, its imposter bake settings and atlas. Shared by every
// world built while it is valid; kind = 'model' (scenario), 'generated' (terrain) or 'import' (dropped file).
class ModelAsset {
    constructor(name, mesh, settings, lodBias = 1, kind = 'model') {
        this.name = name;
        this.mesh = mesh;
        this.settings = settings;               // bake: enabled, grid, res, mode, ao (strength, 0 = none)
        this.emissive = mesh.submeshes.some(s => s.material.isEmissive);
        this.lodBias = lodBias;
        this.kind = kind;
        this.gpuMesh = null;
        this.atlas = null;
        this.castShadows = kind !== 'generated';
        this.version = 0;               // bumps when the atlas changes
    }

    gpu(r) { return this.gpuMesh || (this.gpuMesh = new GpuMesh(r, this.mesh, this.settings.ao || 0)); }

    destroy() {
        this.gpuMesh?.destroy(); this.gpuMesh = null;
        this.atlas?.destroy(); this.atlas = null;
        if (this.kind === 'import') for (const s of this.mesh.submeshes) s.material.destroy();
    }
}

// ModelLibrary: scenario materials and models -> ModelAssets (built on first use), plus imported models.
// Assets made stale by a new scenario are retired and destroyed once the new world is live.
class ModelLibrary {
    constructor() {
        this.materials = new Map();
        this.assets = new Map();
        this.defs = {};
        this.defaults = {};
        this.retired = [];
        this.warnings = [];
        this.fallback = new Material('default', { tint: '#b0b0b0' });
    }

    load(sc) {
        this.warnings = [];
        for (const [name, def] of Object.entries(sc.materials || {})) {
            const key = JSON.stringify(def), m = this.materials.get(name);
            if (m && m.key === key) continue;
            if (m) this.retired.push(m);
            this.materials.set(name, Object.assign(new Material(name, def), { key }));
        }
        this.defs = sc.models || {};
        this.defaults = sc.imposter || {};
        // what the bakes depend on: geometry, materials, bake settings. Never the lighting.
        const key = JSON.stringify([sc.models, sc.materials, this.defaults.grid, this.defaults.res, this.defaults.mode, this.defaults.ao]);
        if (key !== this.key) {
            for (const [n, a] of this.assets) if (a.kind !== 'import') { this.retired.push(a); this.assets.delete(n); }
            this.key = key;
        }
    }

    flushRetired() { for (const x of this.retired) x.destroy(); this.retired = []; }

    material(name) {
        const m = this.materials.get(name);
        if (m) return m;
        if (name) this.warnings.push(`unknown material "${name}"`);
        return this.fallback;
    }

    settings(imp) {
        const s = { ...this.defaults, ...(imp || {}) }, ao = clamp(s.ao ?? 1, 0, 1);
        if (imp === false) return { enabled: false, ao };
        return { enabled: true, grid: clamp(s.grid ?? 12, 2, 64), res: s.res ?? 128, mode: s.mode === 'full' ? 'full' : 'hemi', ao };
    }

    asset(name) {
        let a = this.assets.get(name);
        if (a) return a;
        const def = this.defs[name];
        if (!def) throw new Error(`unknown model "${name}"`);
        const b = new MeshBuilder();
        this.build(def, b, m4.identity(), 0);
        a = new ModelAsset(name, b.finish(), this.settings(def.imposter), def.lodBias ?? 1, 'model');
        a.castShadows = def.castShadows !== false;
        this.assets.set(name, a);
        return a;
    }

    generated(key, make) {
        let a = this.assets.get(key);
        if (!a) this.assets.set(key, a = new ModelAsset(key, make(), { enabled: false, ao: 0 }, 1, 'generated'));
        return a;
    }

    addImport(name, mesh, imp) {
        for (const [n, a] of this.assets) if (a.kind === 'import') { this.retired.push(a); this.assets.delete(n); }
        const a = new ModelAsset(name, mesh, this.settings(imp), 1, 'import');
        this.assets.set(name, a);
        return a;
    }

    // parts -> builder. `array` repeats a part: copy k is placed by step^k (step = array pos / rot / scale)
    build(def, b, M, depth) {
        if (depth > 8) throw new Error('models nested too deep');
        for (const part of def.parts || []) {
            const arr = part.array || {}, n = arr.count || 1, step = m4.compose(arr.pos, arr.rot, arr.scale);
            const local = m4.compose(part.pos, part.rot, part.scale);
            let S = m4.identity();
            for (let k = 0; k < n; k++) {
                const PM = m4.mul(M, m4.mul(S, local));
                if (part.shape === 'model') {
                    const sub = this.assets.get(part.model);
                    if (sub && sub.kind === 'import') b.addMesh(sub.mesh, PM);
                    else if (this.defs[part.model]) this.build(this.defs[part.model], b, PM, depth + 1);
                    else throw new Error(`unknown model "${part.model}"`);
                } else {
                    const shape = SHAPES[part.shape];
                    if (!shape) throw new Error(`unknown shape "${part.shape}"`);
                    b.add(shape({ ...part, seed: (part.seed ?? 1) + k * 17 }), this.material(part.mat), PM, part.color ? lin(part.color) : null);
                }
                S = m4.mul(S, step);
            }
        }
    }
}

return { ModelLibrary };
});
