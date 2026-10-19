'use strict';
// WGSL as named chunks, composed per module on demand.

Features.kit('gpu', (engine, kit) => {
// A renderer's shaders as a library of named chunks: its core defines them (an optional part's interface as a neutral
// stub: the functions the core calls, doing nothing), the features on in its world replace or add chunks, and each
// module is the chunks it names, every chunk after those it needs and once. So a module holds only the code of what
// the world has: a world without buildings compiles the stubs of their functions, not their code.
//   define(name, code, { needs })   a chunk (code: a string, or a function of the library, made when first asked for)
//   replace(name, code, opts)       the same, over a chunk defined before (a feature's, over the core's stub)
//   has(name), code(...names)       the joined code of names and what they need
class WgslLibrary {
    constructor() { this.chunks = new Map(); }

    define(name, code, { needs = [] } = {}) {
        if (this.chunks.has(name)) throw new Error(`WGSL chunk "${name}" defined twice (replace it)`);
        this.chunks.set(name, { code, needs });
        return this;
    }

    replace(name, code, { needs } = {}) {
        const c = this.chunks.get(name);
        if (!c) throw new Error(`WGSL chunk "${name}" to replace is not defined`);
        this.chunks.set(name, { code, needs: needs ?? c.needs });
        return this;
    }

    has(name) { return this.chunks.has(name); }

    code(...names) {
        const out = [], done = new Set();
        const add = name => {
            if (done.has(name)) return;
            const c = this.chunks.get(name);
            if (!c) throw new Error(`no WGSL chunk "${name}"`);
            done.add(name);
            for (const n of c.needs) add(n);
            if (typeof c.code === 'function') c.code = c.code(this);
            out.push(c.code);
        };
        for (const n of names) add(n);
        return out.join('\n');
    }
}

return { WgslLibrary };
});
