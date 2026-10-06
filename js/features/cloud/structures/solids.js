'use strict';
// What a walker collides with: the structures' solids, and the ones near a point.

Features.part('cloud', (engine, feature) => {

class Solids {
    constructor() {
        this.list = [];
        this.grid = null;
    }

    // what a walker collides with (see Walker): every box, and the bridges' decks and parapets. { x, z, hx, hz, cs, sn,
    // y0, y1 (at the centre), slope (m per m along local x) }. A top within a step of the feet is a floor, else a wall
    // (a door's solids are switched `off` while it is open, or shut)
    add(f, ox, oz, hx, hz, y0, y1, slope = 0) {
        const [x, z] = f.xz(ox, oz), b = { x, z, hx, hz, cs: f.cs, sn: f.sn, y0, y1, slope };
        this.list.push(b);
        this.grid = null;
        return b;
    }

    // the solids that reach within r of x, z (a 16 m grid over their footprints, built on first use)
    near(x, z, r) {
        const G = 16, key = (i, j) => i * 65536 + j;
        if (!this.grid) {
            this.grid = new Map();
            for (const b of this.list) {
                const e = Math.hypot(b.hx, b.hz);
                for (let i = Math.floor((b.x - e) / G); i <= Math.floor((b.x + e) / G); i++)
                    for (let j = Math.floor((b.z - e) / G); j <= Math.floor((b.z + e) / G); j++) {
                        const k = key(i, j);
                        if (!this.grid.has(k)) this.grid.set(k, []);
                        this.grid.get(k).push(b);
                    }
            }
        }
        const out = new Set();
        for (let i = Math.floor((x - r) / G); i <= Math.floor((x + r) / G); i++)
            for (let j = Math.floor((z - r) / G); j <= Math.floor((z + r) / G); j++) for (const b of this.grid.get(key(i, j)) || []) out.add(b);
        return [...out];
    }
}

return { Solids };
});
