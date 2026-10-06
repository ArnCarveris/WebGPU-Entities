'use strict';
// The material table.

Features.part('origin', (engine, feature) => {
const { PATTERNS } = feature;

class MaterialTable {
    constructor(defs) {
        this.names = Object.keys(defs);
        this.byName = new Map(this.names.map((n, i) => [n, i]));
        this.data = new Float32Array(Math.max(1, this.names.length) * 12);
        this.names.forEach((n, i) => {
            const d = defs[n], a = d.albedo || [0.7, 0.7, 0.7], e = d.emissive || [0, 0, 0, 0];
            const pat = PATTERNS[d.pattern || 'flat'];
            if (pat === undefined) throw new Error(`material "${n}": unknown pattern "${d.pattern}"`);
            this.data.set([a[0], a[1], a[2], pat, e[0], e[1], e[2], e[3] ?? 1, d.spec ?? 0.2, d.shin ?? 16, d.scale ?? 1, d.rate ?? 1], i * 12);
        });
    }

    index(name) {
        const i = this.byName.get(name);
        if (i === undefined) throw new Error(`unknown material "${name}"`);
        return i;
    }
}

return { MaterialTable };
});
