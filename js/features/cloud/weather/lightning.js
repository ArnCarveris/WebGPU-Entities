'use strict';
// Lightning: flashes and their bolts.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { lerp, v3 } = Common;
const { MAX_FLASHES, MAX_BOLT_SEGS } = feature;

// lightning flashes (light inside the cloud) and, for some, cloud-to-ground bolts
class Lightning {
    constructor() {
        this.flashes = [];
        this.segs = new Float32Array(MAX_BOLT_SEGS * 8);
        this.count = 0;
        this.nearClock = 0;
        this.onStrike = null;            // f => (the App plays its thunder)
    }

    // at [x, z] (else somewhere in the cell's core)
    strike(cell, forceBolt = false, at = null) {
        if (this.flashes.length >= MAX_FLASHES) this.flashes.shift();
        const s = cell.state, w = cell.world.weather.cur, ang = Math.random() * Math.PI * 2, r = s.radius * 0.35 * Math.sqrt(Math.random());
        const x = at ? at[0] : cell.pos[0] + Math.cos(ang) * r, z = at ? at[1] : cell.pos[1] + Math.sin(ang) * r;
        const y = lerp(w.base + 800, s.top * 0.75, Math.random());
        const f = { pos: [x, y, z], age: 0, dur: 0.35 + Math.random() * 0.5, peak: 25 + Math.random() * 35, seed: Math.random() * 100, bolt: null };
        if (forceBolt || Math.random() < 0.35) f.bolt = this.makeBolt([x, w.base + 150, z], cell.world.field);
        this.flashes.push(f);
        cell.world.flashCount++;
        if (this.onStrike) this.onStrike(f);
    }

    // more strikes around the camera when it is under or beside a mature storm: the nearer, the more often, and
    // mostly cloud-to-ground; each lands within 5 km of the camera, pulled in under the storm
    around(world, cam, dt) {
        const wl = world.weather.cur.lightning;
        if (!(wl > 0)) return;
        let rate = 0, best = null, bestP = 0;
        for (const c of world.storms) {
            const L = c.def.lightning || 0;
            if (!L || !c.mature || c.state.precip < 0.15) continue;
            const reach = c.state.radius * 1.3 + 3000, d = Math.hypot(c.pos[0] - cam[0], c.pos[1] - cam[2]);
            if (d >= reach) continue;
            const prox = 1 - d / reach;
            rate += L * wl / 60 * 1.5 * prox;
            if (prox > bestP) { bestP = prox; best = c; }
        }
        if (!best) { this.nearClock = 0; return; }
        this.nearClock -= dt;
        if (this.nearClock > 0) return;
        this.nearClock = -Math.log(1 - Math.random() * 0.999) / rate;
        const ang = Math.random() * Math.PI * 2, r = 250 + 4750 * Math.pow(Math.random(), 1.5);
        let x = cam[0] + Math.cos(ang) * r, z = cam[2] + Math.sin(ang) * r;
        const R = best.state.radius * 0.8, dx = x - best.pos[0], dz = z - best.pos[1], dl = Math.hypot(dx, dz);
        if (dl > R) { x = best.pos[0] + dx * R / dl; z = best.pos[1] + dz * R / dl; }
        this.strike(best, Math.random() < 0.7, [x, z]);
    }

    // nearest and farthest point of a flash (its channel, for a bolt) from p
    reach(f, p) {
        let lo = v3.len(v3.sub(f.pos, p)), hi = lo;
        if (f.bolt) for (const [a, c] of f.bolt) for (const q of [a, c]) { const d = v3.len(v3.sub(q, p)); lo = Math.min(lo, d); hi = Math.max(hi, d); }
        return [lo, hi];
    }

    // how much the flashes near p flood the view (0 far away, ~1 for a strike a few hundred metres off)
    veil(p) {
        let v = 0;
        for (const f of this.flashes) {
            const d = this.reach(f, p)[0] / 1200;
            v += this.level(f) / 40 * (f.bolt ? 1 : 0.6) / (1 + d * d);
        }
        return Math.min(v, 1.5);
    }

    // jagged path from the cloud base to the ground, with a few branches
    makeBolt(start, field) {
        const end = [start[0] + (Math.random() - 0.5) * 2500, 0, start[2] + (Math.random() - 0.5) * 2500];
        end[1] = field.sample(end[0], end[2]);
        const segs = [];
        const walk = (a, b, depth, width, out) => {
            let pts = [a, b];
            for (let level = 0; level < depth; level++) {
                const next = [pts[0]];
                for (let k = 0; k < pts.length - 1; k++) {
                    const p = pts[k], q = pts[k + 1], len = v3.len(v3.sub(q, p));
                    const m = v3.add(v3.mul(v3.add(p, q), 0.5), [(Math.random() - 0.5) * len * 0.45, (Math.random() - 0.5) * len * 0.15, (Math.random() - 0.5) * len * 0.45]);
                    next.push(m, q);
                }
                pts = next;
            }
            for (let k = 0; k < pts.length - 1; k++) out.push([pts[k], pts[k + 1], width]);
            return pts;
        };
        const main = walk(start, end, 6, 6, segs);
        for (let b = 0; b < 3; b++) {
            const from = main[Math.floor(Math.random() * main.length * 0.6)];
            const to = v3.add(from, [(Math.random() - 0.5) * 1800, -300 - Math.random() * 900, (Math.random() - 0.5) * 1800]);
            walk(from, to, 4, 2.5, segs);
        }
        return segs;
    }

    update(dt) {
        for (const f of this.flashes) f.age += dt;
        this.flashes = this.flashes.filter(f => f.age < f.dur);
    }

    // intensity with a few return strokes
    level(f) {
        const t = f.age / f.dur, strokes = Math.max(0, Math.sin(f.age * 38 + f.seed)) * 0.6 + 0.4;
        return f.peak * Math.exp(-t * 4) * strokes;
    }

    write(frame) {
        for (let k = 0; k < MAX_FLASHES; k++) {
            const f = this.flashes[k];
            frame.set('flash', f ? [...f.pos, this.level(f)] : [0, 0, 0, 0], k * 4);
        }
        this.segs.fill(0);
        let n = 0;
        for (const f of this.flashes) {
            if (!f.bolt) continue;
            const b = this.level(f) * 40;
            for (const [a, c, w] of f.bolt) {
                if (n >= MAX_BOLT_SEGS) break;
                this.segs.set([...a, b, ...c, w], n * 8);
                n++;
            }
        }
        this.count = n;
    }

    get brightness() { return this.flashes.reduce((s, f) => s + this.level(f), 0); }
}

return { Lightning };
});
