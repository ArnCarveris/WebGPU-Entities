'use strict';
// The world: builds the scenario's entities and moves them.

Features.part('origin', (engine, feature) => {
const { Common } = engine;
const { DEG, v3 } = Common;
const {
    MAX_BODIES, quat, WorldPos, Model, GeometryPool, MaterialTable, Instance, InstanceStore, ENTITY_TYPES,
} = feature;

class World {
    constructor(scenario, device, density = 1) {
        this.scenario = scenario;
        this.density = density;
        this.materials = new MaterialTable(scenario.materials || {});
        this.models = new Map(Object.entries(scenario.models || {}).map(([n, parts]) => [n, new Model(n, parts, this.materials)]));
        this.modelList = [...this.models.values()];
        this.entities = [];
        this.byId = new Map();
        this.bodies = [];
        this.landmarks = [];
        this.dynamic = [];
        this.sun = null;
        for (const def of scenario.entities || []) {
            const Type = ENTITY_TYPES[def.type];
            if (!Type) throw new Error(`unknown entity type "${def.type}"`);
            const e = new Type(def, this);
            if (e.id) this.byId.set(e.id, e);
            e.spawn();
            this.entities.push(e);
        }
        if (this.bodies.length > MAX_BODIES) throw new Error(`more than ${MAX_BODIES} bodies`);
        this.geometry = new GeometryPool(this.modelList);
        this.store = new InstanceStore(device, this.modelList);
        this.sunPos = this.sun ? this.sun.pos : new WorldPos();
    }

    get(id) {
        const e = this.byId.get(id);
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
        let pos, q = quat.id();
        if (spec.orbit) {
            const o = spec.orbit, P = this.get(o.parent), r = o.radius ?? P.radius + (o.altitude || 0);
            const qo = quat.mul(quat.mul(P.frame.q, quat.axisAngle([0, 1, 0], (o.node || 0) * DEG)), quat.axisAngle([1, 0, 0], (o.incl || 0) * DEG));
            const a = (o.angle || 0) * DEG, local = [Math.cos(a) * r, 0, -Math.sin(a) * r];
            const radial = quat.rotate(qo, v3.norm(local)), along = v3.cross(quat.rotate(qo, [0, 1, 0]), radial);
            pos = P.pos.add(quat.rotate(qo, local));
            q = quat.fromAxes(along, radial, v3.cross(along, radial));          // Y points away from the parent
        } else if (spec.surface && typeof spec.surface === 'object') {
            const s = spec.surface, P = this.get(s.parent), lat = (s.lat || 0) * DEG, lon = (s.lon || 0) * DEG;
            const n = quat.rotate(P.frame.q, [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
            let east = v3.cross(quat.rotate(P.frame.q, [0, 1, 0]), n);
            east = v3.len(east) < 1e-9 ? quat.rotate(P.frame.q, [1, 0, 0]) : v3.norm(east);
            pos = P.pos.add(v3.mul(n, P.radius + (s.alt || 0)));
            q = quat.mul(quat.fromAxes(east, n, v3.cross(east, n)), quat.axisAngle([0, 1, 0], (s.heading || 0) * DEG));
        } else if (spec.parent) {
            const P = this.get(spec.parent);
            pos = P.pos.add(quat.rotate(P.frame.q, spec.offset || [0, 0, 0]));
            q = P.frame.q;
        } else {
            pos = WorldPos.of(spec.pos || [0, 0, 0]);
        }
        if (spec.rot) q = quat.mul(q, quat.euler(spec.rot));
        return { pos, q };
    }

    update(dt, t) {
        for (const e of this.dynamic) e.update(dt, t);
        this.store.flush();
    }

    // Distance to the nearest thing worth resolving (body surface or landmark), plus the dominant body
    proximity(pos) {
        let dist = Infinity, body = null, alt = Infinity, rel = Infinity, near = null;
        for (const b of this.bodies) {
            const a = v3.len(pos.sub(b.pos)) - b.radius;
            if (a < dist) dist = a;
            if (a / b.radius < rel) { rel = a / b.radius; body = b; alt = a; }
        }
        for (const l of this.landmarks) {
            const d = Math.max(v3.len(pos.sub(l.pos)) - l.radius, l.spacing);
            if (d < dist) { dist = d; near = l; }
        }
        return { dist: Math.max(dist, 0.5), body, alt, near };
    }

    get instanceCount() { return this.store.count; }

    destroy() { this.store.destroy(); }
}

return { World };
});
