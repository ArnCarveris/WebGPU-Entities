'use strict';
// StencilLayout: a stencil buffer's bits, shared out by name, so no renderer writes a literal stencil value.
//
// Whoever draws into a depth-stencil target reserves what it needs before the pipelines are built:
//   reserve(name, { values: n })        a slot of n distinct values (1..n; 0 is "unmarked")
//   reserve(name, { values: n, min })   the same, but it may get as few as `min` values when the bits run out
//   reserve(name, { flag: true })       one bit
// resolve() packs them into the buffer's bits (flags from the top, value slots from the bottom, in reservation order)
// and gives every slot its shift, mask and capacity (how many values it got). It throws, naming every reservation,
// when what can't shrink doesn't fit. Then refs are composed from slots (compose({ vis: 3, mark: 1 })) and pipelines
// name the slots they test and write (stencilState), so features that share a target never step on each other's bits,
// and the engine, not the code, decides where each one lives.

Features.kit('gpu', (engine, kit) => {
const bitsFor = n => (n > 0 ? Math.ceil(Math.log2(n + 1)) : 0);

class StencilSlot {
    constructor(name, { values = 0, flag = false, min }) {
        if (!flag && !(values > 0)) throw new Error(`stencil slot "${name}": needs values > 0 or flag`);
        this.name = name;
        this.flag = !!flag;
        this.values = flag ? 1 : values;
        this.min = flag ? 1 : Math.min(min ?? values, values);
        this.bits = 0;
        this.shift = 0;
        this.mask = 0;
        this.capacity = 0;      // values it got: refs 1..capacity (a flag: 1)
    }

    get want() { return this.flag ? 1 : bitsFor(this.values); }
    get least() { return this.flag ? 1 : bitsFor(this.min); }

    // the stencil value of the slot's i-th value (1..capacity; 0 = unmarked)
    ref(i) {
        if (i < 0 || i > this.capacity) throw new Error(`stencil slot "${this.name}": value ${i} out of 0..${this.capacity}`);
        return i << this.shift;
    }

    toString() { return `${this.name} ${this.flag ? 'flag' : `${this.capacity}/${this.values}`} @${this.shift}:${this.bits}`; }
}

class StencilLayout {
    constructor(bits = 8) {
        this.bits = bits;
        this.slots = new Map();
        this.resolved = false;
    }

    reserve(name, spec) {
        if (this.resolved) throw new Error(`stencil slot "${name}": reserved after the layout was resolved (${this})`);
        if (this.slots.has(name)) throw new Error(`stencil slot "${name}": reserved twice`);
        const s = new StencilSlot(name, spec);
        this.slots.set(name, s);
        return s;
    }

    slot(name) {
        const s = this.slots.get(name);
        if (!s) throw new Error(`no stencil slot "${name}" (${this})`);
        return s;
    }

    resolve() {
        if (this.resolved) return this;
        const all = [...this.slots.values()];
        for (const s of all) s.bits = s.want;
        // over budget: shrink the slots that may shrink, the widest first, a bit at a time
        let over = all.reduce((n, s) => n + s.bits, 0) - this.bits;
        while (over > 0) {
            const s = all.filter(x => x.bits > x.least).sort((a, b) => b.bits - a.bits)[0];
            if (!s) throw new Error(`stencil: ${this.bits} bits can't hold ${all.map(x => `${x.name} (${x.least}+ bits)`).join(', ')}`);
            s.bits--;
            over--;
        }
        let lo = 0, hi = this.bits;
        for (const s of all) {
            if (s.flag) s.shift = --hi;
            else { s.shift = lo; lo += s.bits; }
            s.mask = ((1 << s.bits) - 1) << s.shift;
            s.capacity = s.flag ? 1 : Math.min(s.values, (1 << s.bits) - 1);
        }
        this.resolved = true;
        return this;
    }

    // one stencil value from slot values: { name: i } (a flag: 1 / true)
    compose(values) {
        let v = 0;
        for (const name in values) v |= this.slot(name).ref(+values[name]);
        return v;
    }

    // the bits of the named slots
    mask(names = []) {
        let m = 0;
        for (const n of [].concat(names)) m |= this.slot(n).mask;
        return m;
    }

    toString() { return [...this.slots.values()].join(', ') || 'empty'; }
}

// The stencil part of a GPUDepthStencilState, from slot names:
//   { test: names }                          compare EQUAL against the ref on those bits (none: ALWAYS)
//   { op: 'replace' | 'invert' | 'zero' | 'keep', write: names }   what a passing fragment does to those bits
// A test on slots that got no bits passes everywhere (EQUAL under a 0 read mask), so a slot squeezed out by
// resolve() degrades to "unmasked" instead of failing.
function stencilState(layout, spec) {
    if (!spec) return { stencilReadMask: 0, stencilWriteMask: 0 };
    const face = { compare: spec.test ? 'equal' : 'always', passOp: spec.op || 'keep', failOp: 'keep', depthFailOp: 'keep' };
    return {
        stencilFront: face, stencilBack: face,
        stencilReadMask: spec.test ? layout.mask(spec.test) : 0,
        stencilWriteMask: spec.write ? layout.mask(spec.write) : 0,
    };
}

return { StencilLayout, StencilSlot, stencilState };
});
