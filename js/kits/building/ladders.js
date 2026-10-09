'use strict';
// Ladders: the emergency ladders up lift shafts' technical spaces (and any other a world adds): where they are, which
// one a walker can take hold of, where a climber hangs on one, and the landings it can step out to.

Features.kit('building', (engine, kit) => {
const { GridHash } = engine.kits.interior;

// A ladder (add): frame f (Common.GroundFrame: its building's), x (its middle along local x), z (its rungs' plane), n
// ([nx, nz]: from the rungs toward the climber), w (m), y0, y1 (its foot and top, world heights), along ([lx, lz]: from
// the shaft out through its landing doors), landings [{ y, g, x, z, w, shaft }] (the doors beside it: local x of the
// wall, z of the door's centre, its width, the shaft's key)
class Ladders {
    constructor() {
        this.list = [];
        this.grid = new GridHash(16);
    }

    add(l) {
        const f = l.f, [px, pz] = f.xz(l.x, l.z);
        const rot = ([x, z]) => [x * f.cs - z * f.sn, x * f.sn + z * f.cs];
        Object.assign(l, { p: [px, pz], nw: rot(l.n), tw: rot([-l.n[1], l.n[0]]), aw: rot(l.along || [1, 0]) });
        this.list.push(l);
        this.grid.insert(l, px - 1, pz - 1, px + 1, pz + 1);
        return l;
    }

    // the ladder a walker at feet (world) looking along fwd can take hold of: in front of its rungs within reach,
    // beside them, at a height it spans; or null
    grab(feet, fwd, reach = 0.9) {
        let best = null, bd = Infinity;
        for (const l of this.grid.at(feet[0], feet[2])) {
            const dx = feet[0] - l.p[0], dz = feet[2] - l.p[1], d = dx * l.nw[0] + dz * l.nw[1], u = dx * l.tw[0] + dz * l.tw[1];
            if (d < 0.05 || d > reach || Math.abs(u) > l.w / 2 + 0.35 || feet[1] < l.y0 - 0.6 || feet[1] > l.y1 - 0.4) continue;
            if (fwd && fwd[0] * -l.nw[0] + fwd[2] * -l.nw[1] < 0.2) continue;
            if (d < bd) { bd = d; best = l; }
        }
        return best;
    }

    // where a climber's feet are on ladder l at height y (clamped to it)
    hang(l, y) {
        const yy = Math.max(l.y0, Math.min(l.y1 - 1.0, y));
        return [l.p[0] + l.nw[0] * 0.34, yy, l.p[1] + l.nw[1] * 0.34];
    }

    // the landing of ladder l beside a climber's feet at height y, or null
    landingAt(l, y, tol = 0.8) {
        let best = null;
        for (const L of l.landings || []) if (Math.abs(y - L.y) < tol && (!best || Math.abs(y - L.y) < Math.abs(y - best.y))) best = L;
        return best;
    }

    // where one steps out to through landing L of ladder l: in front of its door, on the landing's floor (world)
    exit(l, L) {
        const [x, z] = l.f.xz(L.x + (l.along?.[0] ?? 1) * 0.75, L.z);
        return [x, L.y, z];
    }

    // the ladders within r (m) of world p
    near(p, r) {
        const out = [];
        this.grid.each(p[0] - r, p[2] - r, p[0] + r, p[2] + r, l => { if (Math.hypot(p[0] - l.p[0], p[2] - l.p[1]) <= r && p[1] > l.y0 - 3 && p[1] < l.y1 + 3) out.push(l); });
        return out;
    }
}

return { Ladders };
});
