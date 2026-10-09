'use strict';
// What a walker collides with: the structures' solids, and the ones near a point.

Features.part('cloud', (engine, feature) => {

class Solids {
    constructor() {
        this.list = [];
        this.stacks = [];
        this.grid = null;
        this.into = null;            // a stack being filled (stack()): add() puts its boxes there
    }

    // what a walker collides with (see Walker): every box, and the bridges' decks and parapets. { x, z, hx, hz, cs, sn,
    // y0, y1 (at the centre), slope (m per m along local x) }. A top within a step of the feet is a floor, else a wall
    // (a door's solids are switched `off` while it is open, or shut)
    add(f, ox, oz, hx, hz, y0, y1, slope = 0) {
        const [x, z] = f.xz(ox, oz), b = { x, z, hx, hz, cs: f.cs, sn: f.sn, y0, y1, slope };
        (this.into ? this.into.list : this.list).push(b);
        this.grid = null;
        return b;
    }

    // A storey's solids that many storeys share (a tower's typical floor): what fill() adds goes into the stack, built
    // at storey 0 (its floor at `base`), and stands again `H` m higher on each storey s that has(s). Only the storeys
    // round a point's height are made real when it asks (near), so a thousand storeys cost what three do
    stack(base, H, has, fill) {
        const st = { base, H, has, list: [], made: new Map() };
        const keep = this.into;
        this.into = st;
        fill();
        this.into = keep;
        if (st.list.length) this.stacks.push(st);
        this.grid = null;
        return st;
    }

    // the solids that reach within r of x, z (a 16 m grid over their footprints, built on first use); of the stacks,
    // the storeys within one of height y (all of them for y undefined: not meant for stacks that tall)
    near(x, z, r, y) {
        const G = 16, key = (i, j) => i * 65536 + j;
        if (!this.grid) {
            this.grid = new Map();
            const put = (item, b) => {
                const e = Math.hypot(b.hx, b.hz);
                for (let i = Math.floor((b.x - e) / G); i <= Math.floor((b.x + e) / G); i++)
                    for (let j = Math.floor((b.z - e) / G); j <= Math.floor((b.z + e) / G); j++) {
                        const k = key(i, j);
                        if (!this.grid.has(k)) this.grid.set(k, []);
                        this.grid.get(k).push(item);
                    }
            };
            for (const b of this.list) put(b, b);
            for (const st of this.stacks) for (const b of st.list) put({ st, b }, b);
        }
        const out = new Set();
        for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++)
            for (let j = Math.floor((z - r) / G); j <= Math.floor((z + r) / G); j++) for (const it of this.grid.get(key(i, j)) || []) {
                if (!it.st) { out.add(it); continue; }
                const st = it.st, s0 = y === undefined ? 0 : Math.floor((y - st.base) / st.H);
                for (let s = s0 - 1; s <= s0 + 1; s++) if (s >= 0 && st.has(s)) out.add(Solids.lift(st, it.b, s));
            }
        return [...out];
    }

    // box b of a stack on storey s (made once, kept while the storeys near are asked for)
    static lift(st, b, s) {
        let m = st.made.get(s);
        if (!m) {
            if (st.made.size > 8) st.made.clear();
            st.made.set(s, m = new Map());
        }
        let c = m.get(b);
        if (!c) m.set(b, c = { ...b, y0: b.y0 + s * st.H, y1: b.y1 + s * st.H });
        return c;
    }
}

return { Solids };
});
