'use strict';
// The material table.

Features.part('portal', (engine, feature) => {
const { MAT_FLOATS, PATTERNS } = feature;

// Material table: scenario `materials` -> one storage buffer the scene shader indexes with each vertex's
// material id. Per material: albedo rgb + pattern, scale, spec, emissive rgb + strength (MAT_FLOATS).

class MaterialTable {
    constructor(defs = {}, warnings = []) {
        this.warnings = warnings;
        this.names = Object.keys(defs);
        if (!this.names.length) this.names.push('default');
        this.byName = new Map(this.names.map((n, i) => [n, i]));
        this.data = new Float32Array(this.names.length * MAT_FLOATS);
        this.names.forEach((name, i) => {
            const m = defs[name] || {}, a = m.albedo || [0.6, 0.6, 0.6], e = m.emissive || [0, 0, 0, 0];
            this.data.set([a[0], a[1], a[2], PATTERNS[m.pattern] ?? 0, m.scale ?? 1, m.spec ?? 0.2, 0, 0, e[0], e[1], e[2], e[3] ?? 1], i * MAT_FLOATS);
        });
    }

    // index of a material; unknown names fall back to the first one (with a scenario warning)
    index(name) {
        if (this.byName.has(name)) return this.byName.get(name);
        this.warnings.push(`unknown material "${name}"`);
        this.byName.set(name, 0);
        return 0;
    }
}

return { MaterialTable };
});
