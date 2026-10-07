'use strict';
// World entities: bodies, props, fields and orbiters.

Features.part('origin', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, v3 } = Common;
const { mulberry32 } = kits.noise;
const { SURFACES, quat, vec3Of } = feature;

// World entities. Each is built from a scenario definition ({ type, id, ... }) and spawned once, in
// scenario order, so an entity can use any earlier one as its parent.
class Entity extends kits.world.Entity {
    constructor(def, world) {
        super(def, world);
        this.frame = null;          // { pos: WorldPos, q }
        this.radius = 0;
        this.spacing = 0;           // proximity floor inside volumes (fields)
    }

    get pos() { return this.frame.pos; }

    spawn() { this.frame = this.world.resolve(this.def); }
}

// Star / planet / moon: drawn as an exact per-pixel sphere (bodies pass), not as a mesh
class Body extends Entity {
    spawn() {
        super.spawn();
        const d = this.def;
        this.frame.q = quat.euler(d.rot || [0, 0, 0]);     // bodies keep world axes: lat / lon stay predictable
        this.radius = d.radius;
        this.surface = SURFACES[d.surface || 'rocky'];
        if (this.surface === undefined) throw new Error(`body "${this.id}": unknown surface "${d.surface}"`);
        this.atmosphere = d.atmosphere || null;
        this.seed = (this.world.bodies.length * 7.13) % 5;
        this.world.bodies.push(this);
        if (d.star && !this.world.sun) this.world.sun = this;
    }

    // per frame: origin-relative centre and camera altitude, both computed in doubles
    pack(f32, o, origin, cam) {
        const s = origin.scale, c = origin.toLocal(this.frame.pos), d = this.def, col = d.color || [1, 1, 1];
        const alt = (v3.len(cam.sub(this.frame.pos)) - this.radius) / s, a = this.atmosphere;
        f32.set([c[0], c[1], c[2], this.radius / s, alt, this.surface, this.seed, d.halo || 0,
            col[0], col[1], col[2], d.emissive || 0,
            a ? a.color[0] : 0, a ? a.color[1] : 0, a ? a.color[2] : 0, a ? a.height / s : 0], o);
    }
}

// One model instance; `spin` turns it about a local axis every frame
class Prop extends Entity {
    spawn() {
        super.spawn();
        const d = this.def;
        this.scale = vec3Of(d.scale ?? 1);
        this.inst = this.world.addInstance(d.model, this.frame.pos, this.frame.q, this.scale, { tint: d.tint });
        this.radius = this.inst.model.radius * Math.max(...this.scale);
        if (this.label) this.world.landmarks.push(this);
        if (d.spin) this.world.addDynamic(this);
    }

    update(dt, t) {
        const s = this.def.spin;
        const q = quat.mul(this.frame.q, quat.axisAngle(s.axis || [0, 1, 0], t * (s.rpm || 1) * Math.PI / 30));
        this.inst.place(this.frame.pos, q, this.scale);
        this.world.store.touch(this.inst);
    }
}

// Many instances scattered procedurally (seeded): sphere shell, ring, or disc on a surface frame
class Field extends Entity {
    spawn() {
        super.spawn();
        const d = this.def, w = this.world, rng = mulberry32(d.seed || 1), sh = d.shape || { sphere: 100 };
        const models = [].concat(d.model), n = Math.max(0, Math.round((d.count || 0) * w.density));
        const [smin, smax] = d.size || [1, 1], tintJ = d.tint ?? 0.15;
        for (let i = 0; i < n; i++) {
            const size = smin * Math.pow(smax / smin, rng() * rng());      // many small, few large
            const off = this.sample(sh, rng, size);
            const q = quat.norm([rng() - 0.5, rng() - 0.5, rng() - 0.5, rng() - 0.5]);
            const scale = [size, size * (0.6 + 0.4 * rng()), size * (0.6 + 0.4 * rng())];
            const k = 1 - tintJ + tintJ * 2 * rng();
            const tint = [k * (0.95 + 0.1 * rng()), k, k * (0.95 + 0.1 * rng())];
            w.addInstance(models[i % models.length], this.frame.pos.add(quat.rotate(this.frame.q, off)), q, scale, { tint, seed: rng() * 100 });
        }
        this.count = n;
        this.radius = sh.sphere || (sh.ring && sh.ring[1]) || sh.disc || 0;
        this.spacing = n ? this.radius / Math.cbrt(n) : 0;
        if (this.label) w.landmarks.push(this);
    }

    sample(sh, rng, size) {
        if (sh.ring) {
            const [r0, r1] = sh.ring, r = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * rng()), a = rng() * Math.PI * 2;
            return [Math.cos(a) * r, (rng() + rng() + rng() - 1.5) * (sh.thickness || 0) / 1.5, Math.sin(a) * r];
        }
        if (sh.disc) {
            const r0 = sh.inner || 0, r = Math.sqrt(r0 * r0 + (sh.disc * sh.disc - r0 * r0) * rng()), a = rng() * Math.PI * 2;
            return [Math.cos(a) * r, -size * (sh.sink ?? 0.3), Math.sin(a) * r];
        }
        const R = sh.sphere, k = Math.pow(sh.inner || 0, 3) / (R * R * R);
        const r = R * Math.cbrt(k + (1 - k) * rng());
        const z = rng() * 2 - 1, a = rng() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        return [s * Math.cos(a) * r, z * r, s * Math.sin(a) * r];
    }
}

// A model flying a circular orbit around a parent entity (its local XZ plane, tilted by `incl`)
class Orbiter extends Entity {
    spawn() {
        const d = this.def, o = d.orbit;
        this.parent = this.world.get(o.parent);
        this.scale = vec3Of(d.scale ?? 1);
        this.inst = this.world.addInstance(d.model, this.parent.pos, this.parent.frame.q, this.scale, { tint: d.tint });
        this.radius = this.inst.model.radius * Math.max(...this.scale);
        this.phase = (o.angle || 0) * DEG;
        this.update(0, 0, false);
        if (this.label) this.world.landmarks.push(this);
        this.world.addDynamic(this);
    }

    update(dt, t, touch = true) {
        const o = this.def.orbit, P = this.parent.frame;
        const a = this.phase + t * Math.PI * 2 / (o.period || 60);
        const qp = quat.mul(P.q, quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
        const pos = P.pos.add(quat.rotate(qp, [Math.cos(a) * o.radius, o.height || 0, -Math.sin(a) * o.radius]));
        const q = quat.look(quat.rotate(qp, [-Math.sin(a), 0, -Math.cos(a)]), quat.rotate(qp, [0, 1, 0]));
        this.frame = { pos, q };
        this.inst.place(pos, q, this.scale);
        if (touch) this.world.store.touch(this.inst);
    }
}

const ENTITY_TYPES = {
    body: Body,
    prop: Prop,
    field: Field,
    orbiter: Orbiter,
};

return { Body, ENTITY_TYPES };
});
