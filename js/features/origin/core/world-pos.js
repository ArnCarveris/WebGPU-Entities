'use strict';
// Unbounded positions: an integer cell plus a double offset.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { CELL } = feature;

// Unbounded position: integer cell + double offset in [0, CELL). Differences are exact near each other.
class WorldPos {
    constructor(c = [0, 0, 0], l = [0, 0, 0]) {
        this.c = c.slice();
        this.l = l.slice();
        this.fix();
    }

    static of(metres) { return new WorldPos([0, 0, 0], metres); }

    fix() {
        for (let i = 0; i < 3; i++) {
            const k = Math.floor(this.l[i] / CELL);
            if (k) { this.c[i] += k; this.l[i] -= k * CELL; }
        }
        return this;
    }

    clone() { return new WorldPos(this.c, this.l); }
    add(d) { return new WorldPos(this.c, v3.add(this.l, d)); }
    addIn(d) { this.l = v3.add(this.l, d); return this.fix(); }
    // this - o, in metres
    sub(o) {
        return [(this.c[0] - o.c[0]) * CELL + (this.l[0] - o.l[0]), (this.c[1] - o.c[1]) * CELL + (this.l[1] - o.l[1]), (this.c[2] - o.c[2]) * CELL + (this.l[2] - o.l[2])];
    }
    metres() { return [this.c[0] * CELL + this.l[0], this.c[1] * CELL + this.l[1], this.c[2] * CELL + this.l[2]]; }
    isZero() { return !this.c[0] && !this.c[1] && !this.c[2] && !this.l[0] && !this.l[1] && !this.l[2]; }
}

return { WorldPos };
});
