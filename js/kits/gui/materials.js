'use strict';
// World materials as data: the scenario's material table, packed for the scene shader.

Features.kit('gui', (engine, kit) => {
const { col } = kit;

// World materials as data. The scenario's `materials` block is packed into a storage buffer that the
// scene shader indexes with the per-vertex material id; a material picks a procedural pattern (surface
// detail around its albedo) and an emission signal (what drives its glow over time).

// Patterns implemented by pattern() in the scene shader. `args` are the defaults for the material's `args`.
const MATERIAL_PATTERNS = Object.freeze({
    flat:    { id: 0, args: [] },
    panels:  { id: 1, args: [] },                       // wall panels with rivets and a wainscot stripe
    grating: { id: 2, args: [5, 0.02] },                // holes per metre, hole specular
    mottled: { id: 3, args: [4, 2, 0.75, 0.35] },       // cells per metre x/y, brightness min, variation
    plates:  { id: 4, args: [2, 0.8, 0.4, 0.6] },       // plates per metre, brightness min, variation, seam depth
    door:    { id: 5, args: [] },                       // sliding door panels with hazard ends
    tiles:   { id: 6, args: [1, 0.6] },                 // tiles per metre, seam depth
    hazard:  { id: 7, args: [2.5] },                    // stripes per metre (albedo = stripe colour)
    bands:   { id: 8, args: [4, 0.5] },                 // bands per metre, seam depth
    wood:    { id: 9, args: [] }                        // wood grain
});

// Emission signals implemented by signal() in the scene shader; emission = color * (base + gain * s)
const MATERIAL_SIGNALS = Object.freeze({
    constant: 0,    // s = 0
    wave: 1,        // s = sin(time * rate)
    blink: 2,       // s = step(duty, fract(time * rate + uv.x * spread))
    alarm: 3,       // s = alarm pulse (facility alarm)
    light0: 4       // s = first light's intensity; the colour is also tinted by that light
});

const MATERIAL_FLOATS = 20;        // 5 x vec4, see struct MaterialDef in shaders.js

// def: { pattern?, args?, albedo: [r, g, b], spec?, shin?,
//        emissive?: { color: [r, g, b], signal?, base?, gain?, rate?, spread?, duty?, idle? } }
// `idle` makes the emission react to the instance's "selected" flag: idle level when not selected.
class MaterialTable {
    constructor(defs) {
        this.names = Object.keys(defs);
        this.ids = new Map(this.names.map((name, i) => [name, i]));
        this.data = new Float32Array(Math.max(1, this.names.length) * MATERIAL_FLOATS);
        this.names.forEach((name, i) => this.data.set(MaterialTable.pack(name, defs[name]), i * MATERIAL_FLOATS));
    }

    id(name) {
        const id = this.ids.get(name);
        if (id === undefined) throw new Error(`Unknown material "${name}"`);
        return id;
    }

    static pack(name, def) {
        const pattern = MATERIAL_PATTERNS[def.pattern || 'flat'];
        if (!pattern) throw new Error(`Material "${name}": unknown pattern "${def.pattern}"`);
        const e = def.emissive || { color: [0, 0, 0] };
        const signal = MATERIAL_SIGNALS[e.signal || 'constant'];
        if (signal === undefined) throw new Error(`Material "${name}": unknown signal "${e.signal}"`);
        const args = [0, 1, 2, 3].map((i) => (def.args && def.args[i] !== undefined ? def.args[i] : pattern.args[i]) || 0);
        const albedo = def.albedo || [0.3, 0.3, 0.3];
        return [
            ...albedo, pattern.id,
            ...e.color, signal,
            def.spec ?? 0.3, def.shin ?? 32, e.idle ?? -1, e.duty ?? 0.5,
            e.base ?? 1, e.gain ?? 0, e.rate ?? 1, e.spread ?? 0,
            ...args
        ];
    }
}

return { MATERIAL_PATTERNS, MATERIAL_SIGNALS, MATERIAL_FLOATS, MaterialTable };
});
