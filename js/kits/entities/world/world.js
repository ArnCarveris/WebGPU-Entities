'use strict';
// The origin's WorldExtension (the one World, kits.world): builds the scenario's entities and moves them.

Features.world('origin', (engine, kit) => {
const { Common } = engine;
const { DEG, v3 } = Common;
const {
    MAX_BODIES, SURFACES, quat, WorldPos, Model, GeometryPool, MaterialTable, Instance, InstanceStore, ENTITY_TYPES,
} = kit;

const PACE_REACH = 30;      // s

class WorldExtension {
    static key = 'origin';
    // what it answers on the World (Common.Composite)
    static exposes = ['addDynamic', 'bodies', 'carry', 'daylight', 'density', 'destroy', 'dynamic', 'geometry', 'instanceCount',
        'landmarks', 'materials', 'meshes', 'modelList', 'models', 'moon', 'proximity', 'resolve', 'scenario', 'store', 'sun',
        'sunPos', 'surfaces', 'types', 'update'];
    constructor(world, scenario, device, density = 1) {
        this.world = world;
        this.scenario = scenario;
        this.types = ENTITY_TYPES;
        this.density = density;
        this.materials = new MaterialTable(scenario.materials || {});
        this.models = new Map(Object.entries(scenario.models || {}).map(([n, parts]) => [n, new Model(n, parts, this.materials)]));
        this.modelList = [...this.models.values()];
        this.bodies = [];
        this.landmarks = [];
        this.dynamic = [];
        this.sun = null;
        this.moon = null;               // the moon a time of day placed (daylight): by night the sky's light
        this.surfaces = SURFACES;       // a body's surface name -> its shader's index
        // the common mesh interface (kits.mesh): model instances (poses { pos: a WorldPos, q, scale }; opts tint, seed),
        // re-uploaded when set once the store exists; rotations [yaw, pitch, roll] in degrees
        this.meshes = {
            instance: (model, p, opts) => {
                const inst = this.addInstance(model, p.pos, p.q, p.scale, opts);
                return { inst, radius: inst.model.radius, set: q => { inst.place(q.pos, q.q, q.scale); this.store?.touch(inst); } };
            },
            rotation: rot => quat.euler(rot),
        };
        for (const def of scenario.entities || []) world.add(def);
        if (this.bodies.length > MAX_BODIES) throw new Error(`more than ${MAX_BODIES} bodies`);
        this.geometry = new GeometryPool(this.modelList);
        this.store = new InstanceStore(device, this.modelList);
        this.sunPos = this.sun ? this.sun.pos : new WorldPos();
    }

    // the entity a placement refers to (an unknown one is an error)
    need(id) {
        const e = this.world.get(id);
        if (!e) throw new Error(`unknown entity "${id}"`);
        return e;
    }

    addInstance(model, pos, q, scale, opts = {}) {
        const m = this.models.get(model);
        if (!m) throw new Error(`unknown model "${model}"`);
        const inst = new Instance(m);
        inst.place(pos, q, scale);
        if (opts.tint !== undefined) inst.tint = typeof opts.tint === 'number' ? [1, 1, 1] : opts.tint;
        inst.seed = opts.seed ?? m.instances.length * 0.618 % 1 * 100;
        m.instances.push(inst);
        return inst;
    }

    addDynamic(e) { this.dynamic.push(e); }

    // placement -> { pos: WorldPos, q }
    resolve(spec) {
        let pos, q = quat.identity();
        if (spec.orbit) {
            const o = spec.orbit, P = this.need(o.parent), r = o.radius ?? P.radius + (o.altitude || 0);
            const qo = quat.mul(quat.mul(P.axes || P.frame.q, quat.axisAngle([0, 1, 0], (o.node || 0) * DEG)), quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
            const a = (o.angle || 0) * DEG, local = [Math.cos(a) * r, 0, -Math.sin(a) * r];
            const radial = quat.rotate(qo, v3.norm(local)), along = v3.cross(quat.rotate(qo, [0, 1, 0]), radial);
            pos = P.pos.add(quat.rotate(qo, local));
            q = quat.fromAxes(along, radial, v3.cross(along, radial));          // Y points away from the parent
        } else if (spec.surface && typeof spec.surface === 'object') {
            const s = spec.surface, P = this.need(s.parent), lat = (s.lat || 0) * DEG, lon = (s.lon || 0) * DEG;
            const n = quat.rotate(P.frame.q, [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
            let east = v3.cross(quat.rotate(P.frame.q, [0, 1, 0]), n);
            east = v3.len(east) < 1e-9 ? quat.rotate(P.frame.q, [1, 0, 0]) : v3.norm(east);
            pos = P.pos.add(v3.mul(n, P.radius + (s.alt || 0)));
            q = quat.mul(quat.fromAxes(east, n, v3.cross(east, n)), quat.axisAngle([0, 1, 0], (s.heading || 0) * DEG));
        } else if (spec.parent) {
            const P = this.need(spec.parent);
            pos = P.pos.add(quat.rotate(P.frame.q, spec.offset || [0, 0, 0]));
            q = P.frame.q;
        } else {
            pos = WorldPos.of(spec.pos || [0, 0, 0]);
        }
        if (spec.rot) q = quat.mul(q, quat.euler(spec.rot));
        return { pos, q };
    }

    // Moves entity e rigidly (m { pos(WorldPos), q(q) }), and everything placed on it (its surface, an offset from it; with
    // `orbits` what orbits it as well), in scenario order: an entity only ever stands on an earlier one
    carry(e, m, orbits = false) {
        const moved = new Set([e]);
        e.carry(m);
        for (const x of this.world.entities) {
            const d = x.def, on = d.orbit ? orbits && d.orbit.parent : d.surface?.parent ?? d.parent;
            if (x === e || !on || !x.carry || !moved.has(this.world.get(on))) continue;
            moved.add(x);
            x.carry(m);
        }
    }

    // A time of day for what stands on entity `on` (on a planet's surface): the planet turns about its own axis until,
    // seen from there, the sun stands toward `toward` (a direction in world axes, at `on` as it is now). By night (moon:
    // the lit fraction wanted) the planet's moon goes along its orbit to where it is lit that much (on either side of the
    // sun: the one that suits), and the planet turns until the moon stands there instead, the sun under the ground (with
    // no moon, the sun alone goes under). What stands on the planet turns with it (carry); what orbits it stays. As near
    // as a turn can (the sun and the moon keep to their circles in its sky): the height first, then the bearing. Returns
    // the turn ({ about: the planet's centre, q, radius }) or null
    daylight(on, toward, moon = 0) {
        const e = this.need(on);
        let P = e;
        while (P && !this.bodies.includes(P) && !P.def.orbit) P = this.world.get(P.def.surface?.parent ?? P.def.parent);
        if (!P || !this.bodies.includes(P) || !this.sun || P === e) return null;
        const C = P.pos, axis = quat.rotate(P.frame.q, [0, 1, 0]), rel = e.pos.sub(C), ie = quat.conj(e.frame.q);
        const M = moon > 0 ? this.bodies.find(b => b.def.orbit?.parent === P.id) : null;
        const t = quat.rotate(ie, v3.mul(v3.norm(toward), moon > 0 && !M ? -1 : 1));        // (in e's frame: y up)
        // (where point x is seen from e, the planet turned by a; how far that is from t, with the moon x the sun kept 6°
        // under the ground; the turn that puts it nearest)
        const seen = (x, a) => quat.rotate(ie, v3.norm(v3.sub(quat.rotate(quat.axisAngle(axis, -a), x.sub(C)), rel)));
        const off = (x, a) => {
            const d = seen(x, a), up = x === this.sunPos ? 0 : Math.max(0, seen(this.sunPos, a)[1] + 0.1);
            return 50 * (d[1] - t[1]) ** 2 + 1 - v3.dot(d, t) + 100 * up * up;
        };
        const best = x => {
            let a = 0, err = Infinity;
            for (let i = 0; i < 720; i++) { const f = off(x, i * Math.PI / 360); if (f < err) { err = f; a = i * Math.PI / 360; } }
            for (let h = Math.PI / 720; h > 1e-7; h /= 2) for (const b of [a - h, a + h]) { const f = off(x, b); if (f < err) { err = f; a = b; } }
            return { a, err };
        };
        let turn = M ? { err: Infinity } : best(this.sunPos), at = null;
        if (M) {
            // (lit fraction k at elongation E from the sun: k = (1 - cos E) / 2)
            const o = M.def.orbit, E = Math.acos(Common.clamp(1 - 2 * moon, -1, 1));
            const qo = quat.mul(quat.mul(P.axes, quat.axisAngle([0, 1, 0], (o.node || 0) * DEG)), quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
            const u = quat.rotate(quat.conj(qo), this.sunPos.sub(C)), sun = Math.atan2(-u[2], u[0]) / DEG;
            for (const s of [1, -1]) {
                const x = this.resolve({ orbit: { ...o, angle: sun + s * E / DEG } }).pos, b = best(x);
                if (b.err < turn.err) { turn = b; at = x; }
            }
            const d = at.sub(M.pos);
            this.carry(M, { pos: p => p.add(d), q: q => q }, true);
            this.moon = M;
        }
        const R = quat.axisAngle(axis, turn.a);
        this.carry(P, { pos: p => C.add(quat.rotate(R, p.sub(C))), q: q => quat.norm(quat.mul(R, q)) });
        return { about: C, q: R, radius: P.radius };
    }

    update(dt, t) {
        for (const e of this.dynamic) e.update(dt, t);
        this.store.flush();
    }

    // Distance to the nearest thing worth resolving (body surface or landmark), plus the dominant body, and `pace`: the
    // speed of the fastest moving thing that could reach pos within PACE_REACH seconds (flight there keeps ahead of it)
    proximity(pos) {
        let dist = Infinity, body = null, alt = Infinity, rel = Infinity, near = null, pace = 0;
        for (const b of this.bodies) {
            const a = v3.len(pos.sub(b.pos)) - b.radius;
            if (a < dist) dist = a;
            if (a / b.radius < rel) { rel = a / b.radius; body = b; alt = a; }
        }
        for (const l of this.landmarks) {
            const d = Math.max(v3.len(pos.sub(l.pos)) - l.radius, l.spacing);
            if (d < dist) { dist = d; near = l; }
        }
        for (const e of this.dynamic) {
            if (e.speed > pace && v3.len(pos.sub(e.pos)) - e.radius < e.speed * PACE_REACH) pace = e.speed;
        }
        return { dist: Math.max(dist, 0.5), body, alt, near, pace };
    }

    get instanceCount() { return this.store.count; }

    destroy() { this.store.destroy(); }
}

return { WorldExtension };
});
