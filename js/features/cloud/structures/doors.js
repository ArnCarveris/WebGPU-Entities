'use strict';
// The buildings' doors: their leaves' mesh as they stand, their swing, and the one in view.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;
const { DOOR_SPEED, DOOR_REACH, GroundFrame, STRUCT_COLORS } = feature;

class Doors {
    constructor(S) {
        this.S = S;
        this.list = [];
    }

    add(door) { this.list.push(door); }

    // the doors' leaves as they stand (rebuilt whenever one moves, DoorControl): each turned about its hinge into the room by up
    // to 95 degrees, with a handle on both sides
    mesh() {
        const S = this.S;
        const out = [], keep = S.cur;
        S.cur = out;
        for (const d of this.list) {
            const a = d.open * 95 * DEG, dir = [d.u[0] * Math.cos(a) + d.d[0] * Math.sin(a), d.u[1] * Math.cos(a) + d.d[1] * Math.sin(a)];
            const lf = new GroundFrame([d.hinge[0] + dir[0] * d.w / 2, d.hinge[1] + dir[1] * d.w / 2], Math.atan2(dir[1], dir[0]));
            S.prism(lf, 0, 0, d.w / 2, d.lt / 2, d.y, d.y + d.h, d.col, d.mat);
            S.prism(lf, d.w / 2 - 0.12, 0, 0.06, d.lt / 2 + 0.04, d.y + 0.98, d.y + 1.03, STRUCT_COLORS.metal, d.mat + 4);
        }
        S.cur = keep;
        return out;
    }

    // the doors swing toward where they were sent; true if one moved (its leaf's mesh, and its solids, change)
    update(dt) {
        let moved = false;
        for (const d of this.list) {
            if (d.open === d.target) continue;
            d.open = d.target > d.open ? Math.min(d.target, d.open + dt * DOOR_SPEED) : Math.max(d.target, d.open - dt * DOOR_SPEED);
            d.shut.off = d.open > 0.05;
            d.openSolid.off = d.open < 0.95;
            moved = true;
        }
        return moved;
    }

    // the door the eye looks at, within DOOR_REACH (its opening, mid-height), or null
    at(eye, fwd) {
        let best = null, score = 0;
        for (const d of this.list) {
            const v = v3.sub(d.centre, eye), l = v3.len(v);
            if (l > DOOR_REACH || l < 1e-3) continue;
            const c = v3.dot(v, fwd) / l, need = Math.cos(Math.atan2(d.w / 2 + 0.25, l));
            if (c > need && c - need > score) { score = c - need; best = d; }
        }
        return best;
    }
}

return { Doors };
});
