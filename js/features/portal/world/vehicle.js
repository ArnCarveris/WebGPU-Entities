'use strict';
// Vehicles on routes: the ship (a transit line's vehicle that can also be steered).

Features.part('portal', (engine, feature) => {
const { kits } = engine;
const { SplineRoute, TransitLine, LineVehicle } = kits.transit;
const { m4, g2, worldBounds, CollisionSet } = feature;

// Vehicle: a moving group of areas, portals, objects and lights (the freighter). Everything is
// authored at the docked pose, which is the vehicle's local space; each frame one transform M
// carries it along its route, with heel from steering and pitch / roll / heave from the waves.
// Visibility queries transform the frustum planes into vehicle space instead of moving trees.
// On autopilot it is the one vehicle of a transit line (kits.transit): round a closed spline through the scenario's
// waypoints (`route.points`, a SplineRoute) at `route.speed`, pulling away at `route.accel`, braking gently to rest on
// the dock mark (waypoint `route.dock`) and waiting `route.wait` s there; no doors. At the helm, or finding its way back
// to the route after it, it steers freely (steer); `free` says which ('manual', 'rejoin').

class Vehicle extends LineVehicle {
    constructor(world, d) {
        const R = d.route, acc = R.accel || 0.3, route = new SplineRoute(R.points);
        const line = new TransitLine({ route, stops: [route.waypointS(R.dock || 0)], dwell: [R.wait ?? 25], names: ['the dock'], limit: () => R.speed || 6 });
        super(line, { accel: acc, brake: acc * 1.2, maxDecel: acc * 1.5, stopMargin: 0, doors: false });
        line.vehicles.push(this);
        this.route = route;
        this.s = line.stops[0];
        this.free = null;
        this.travelled = 0;
        this.world = world;
        this.id = d.id;
        this.data = d;
        this.hull = world.hulls.find(h => h.id === (d.hull || d.id));
        if (!this.hull) throw new Error(`vehicle "${d.id}": no hull "${d.hull || d.id}"`);
        this.hull.vehicle = this;
        this.pivot = d.pivot || [0, 0, 0];
        this.M = m4.identity();
        this.inv = m4.identity();
        this.col = new CollisionSet(2);
        this.dockCol = new CollisionSet(2);         // parts that are only there while docked (gangway)
        this.objects = [];
        this.lights = [];
        this.portals = [];
        this.areas = [];
        this.helmStation = null;                    // Helm entity, linked after the entities are spawned
        this.docked = true;
        this.heading = 0; this.dHeading = 0; this.heel = 0; this.pitch = 0; this.roll = 0; this.yawRate = 0;
        [this.px, this.pz] = this.route.at(this.s);
        this.control = null;
        this.helm = { throttle: 0, rudder: 0 };
        this.backoff = 0;
        // hull sample points for grounding / quay checks: deck line and (tapered) keel line
        const out = this.hull.outline, xs = out.map(q => q[0]), xc = (Math.min(...xs) + Math.max(...xs)) / 2, ins = this.hull.inset ?? 1.2;
        const edgeSamples = poly => poly.flatMap((a, i) => {
            const b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
            return Array.from({ length: n }, (_, k) => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
        });
        this.deckSamples = edgeSamples(out);
        this.keelSamples = edgeSamples(out.map(q => [q[0] + Math.sign(xc - q[0]) * Math.min(ins, Math.abs(xc - q[0])), q[1]]));
    }

    get maxSpeed() { return this.data.maxSpeed ?? 9; }

    // what it does: docked, departing (its first 10 m), cruising, manual (at the helm), rejoin (back to the route)
    get state() { return this.free || (this.mode === 'dwell' ? 'docked' : this.travelled > 10 ? 'cruising' : 'departing'); }
    // seconds before it leaves the dock
    get wait() { return this.clock; }

    // it poses itself (update), not from axles on the route
    moved() {}
    get maxYawRate() { return this.data.maxYawRate ?? 0.12; }

    toLocal(p) { return m4.point(this.inv, p); }
    toWorld(p) { return m4.point(this.M, p); }
    // world planes -> vehicle planes (R orthonormal: n' = R^T n, d' = n.t + d)
    localPlanes(planes) {
        const M = this.M;
        return planes.map(q => [M[0] * q[0] + M[1] * q[1] + M[2] * q[2], M[4] * q[0] + M[5] * q[1] + M[6] * q[2], M[8] * q[0] + M[9] * q[1] + M[10] * q[2], M[12] * q[0] + M[13] * q[1] + M[14] * q[2] + q[3]]);
    }

    // everything authored inside the hull (at the docked pose) moves with the vehicle
    claim() {
        const w = this.world, out = this.hull.outline, keel = this.hull.keel;
        const segD2 = (x, z, a, b) => {
            const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
            return (x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2;
        };
        const near = (x, z, m) => g2.inside([x, z], out) || out.some((a, i) => segD2(x, z, a, out[(i + 1) % out.length]) < m * m);
        for (const a of w.areas) if (a.index > 0 && a.shape.every(q => near(q[0], q[1], 0.5))) { a.vehicle = this; this.areas.push(a); }
        for (const P of w.portals) if (P.center[1] > keel && near(P.center[0], P.center[2], 0.5)) { P.attach(this); this.portals.push(P); }
        for (const a of w.areas) for (const L of a.lights) if (L.pos[1] > keel && near(L.pos[0], L.pos[2], 0.5)) { L.vehicle = this; L.local = L.pos.slice(); this.lights.push(L); }
        for (const o of w.objects) {
            if (o.terrain) continue;
            const tagged = o.vehicleId && (o.vehicleId === this.id || o.vehicleId === this.hull.id);
            const inside = o.min[1] > keel - 1 && [[o.min[0], o.min[2]], [o.max[0], o.min[2]], [o.max[0], o.max[2]], [o.min[0], o.max[2]]].every(q => near(q[0], q[1], 1.0));
            if (!tagged && !inside) continue;
            o.vehicle = this; o.model = this.M; this.objects.push(o);
        }
        this.place();
    }

    update(dt, t) {
        const cruise = this.data.route.speed || 6, heading0 = this.heading;
        if (this.free) this.steer(dt);
        else this.followRoute(dt);
        this.docked = this.state === 'docked';
        this.helmFromMotion();
        const p = [this.px, this.pz], heading = this.heading, dh = heading - heading0;
        this.dHeading = dh;
        const W = this.data.waves || {}, deg = Math.PI / 180, yawRate = dt > 0 ? dh / dt : 0;
        // heel away from the turn with a slow spring, plus wave pitch / roll / heave
        const heelTarget = Math.max(-1, Math.min(1, -yawRate * this.v * (this.data.steerHeel ?? 0.6))) * (this.data.maxHeel ?? 6) * deg;
        this.heel += (heelTarget - this.heel) * Math.min(1, dt * 0.7);
        const ampTarget = this.docked ? 0.08 : 0.35 + 0.65 * Math.min(1, Math.abs(this.v) / cruise);  // calm in harbour
        this.amp = this.amp === undefined ? ampTarget : this.amp + (ampTarget - this.amp) * Math.min(1, dt * 0.4);
        const amp = this.amp;
        this.pitch = amp * (W.pitch ?? 1.2) * deg * (Math.sin(t * 0.55) + 0.5 * Math.sin(t * 0.93 + 1.3));
        this.roll = this.heel + amp * (W.roll ?? 2) * deg * (Math.sin(t * 0.41 + 0.7) + 0.4 * Math.sin(t * 1.07));
        const heave = amp * (W.heave ?? 0.25) * (Math.sin(t * 0.63) + 0.5 * Math.sin(t * 1.21 + 2)), pv = this.pivot;
        const M = m4.mul(m4.mul(m4.mul(m4.mul(m4.translate([p[0], pv[1] + heave, p[1]]), m4.rotY(heading)), m4.rotX(-this.pitch)), m4.rotZ(this.roll)), m4.translate([-pv[0], -pv[1], -pv[2]]));
        this.M.set(M); this.inv.set(m4.invert(M));
        this.place();
    }

    // autopilot on the route: its line runs it (wait at the dock, cruise, brake to rest on the dock mark)
    followRoute(dt) {
        const route = this.route, s0 = this.s;
        this.step(dt);
        this.travelled = this.mode === 'dwell' ? 0 : this.travelled + (this.s - s0 + route.length) % route.length;
        const p = route.at(this.s), tg = route.dir(this.s);
        // the hull yaws toward the path tangent through a critically damped spring: turn rate and
        // angular acceleration stay continuous even where the spline's curvature jumps at waypoints
        const target = Math.atan2(tg[0], tg[1]), k = this.data.yawResponse ?? 2.5;
        const err = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
        this.yawRate = (this.yawRate || 0) + (k * k * err - 2 * k * (this.yawRate || 0)) * dt;
        this.heading += this.yawRate * dt;
        this.px = p[0]; this.pz = p[1];
    }

    // free steering: the player at the helm, or the autopilot bringing the ship back to its route
    steer(dt) {
        const D = this.data, route = this.route, vmax = this.maxSpeed, acc = (D.route.accel || 0.3) * 1.5;
        let throttle, rudder;
        if (this.control) ({ throttle, rudder } = this.control);
        else {
            const near = route.nearest(this.px, this.pz), aim = route.at(near + 45);      // pure pursuit along the route
            const want = Math.atan2(aim[0] - this.px, aim[1] - this.pz);
            const err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
            rudder = Math.max(-1, Math.min(1, -err * 3)); throttle = 0.6;
            if (this.backoff > 0) { this.backoff -= dt; throttle = -0.4; rudder = -rudder; }
            const q = route.at(near), tg = route.dir(near), th = Math.atan2(tg[0], tg[1]);
            if (Math.hypot(q[0] - this.px, q[1] - this.pz) < 0.6 && Math.abs(Math.atan2(Math.sin(th - this.heading), Math.cos(th - this.heading))) < 0.05) {
                Object.assign(this, { free: null, s: near, mode: 'drive', stop: 0, travelled: 100 });       // back on the route
                return this.followRoute(dt);
            }
        }
        this.v += Math.max(-acc * dt, Math.min(acc * dt, throttle * vmax - this.v));
        // the rudder only bites with water flowing past it: turn rate scales with speed (and flips astern)
        const flow = Math.max(-1, Math.min(1, this.v / (vmax * 0.5)));
        const target = -rudder * this.maxYawRate * flow;
        this.yawRate = (this.yawRate || 0) + (target - (this.yawRate || 0)) * Math.min(1, dt * 0.8);
        const h = this.heading + this.yawRate * dt;
        const nx = this.px + Math.sin(h) * this.v * dt, nz = this.pz + Math.cos(h) * this.v * dt;
        const free = !this.blocked(this.px, this.pz, this.heading);
        if (!free || !this.blocked(nx, nz, h)) { this.px = nx; this.pz = nz; this.heading = h; }
        else {
            // the turn would swing the hull into something: keep going straight if that is clear
            const sx = this.px + Math.sin(this.heading) * this.v * dt, sz = this.pz + Math.cos(this.heading) * this.v * dt;
            this.yawRate = 0;
            if (!this.blocked(sx, sz, this.heading)) { this.px = sx; this.pz = sz; }
            else { this.v = -this.v * 0.2; if (!this.control) this.backoff = 3; }       // bump against the quay or shore
        }
    }

    // would the hull at this pose touch the seabed (keel line) or a structure such as the quay (deck line)?
    blocked(x, z, h) {
        const c = Math.cos(h), sn = Math.sin(h), pv = this.pivot, w = this.world, wl = w.water ? w.water.level : 0;
        const at = q => { const ox = q[0] - pv[0], oz = q[1] - pv[2]; return [x + c * ox + sn * oz, z - sn * ox + c * oz]; };
        for (const q of this.keelSamples) { const r = at(q); if (w.terrainHeight(r[0], r[1]) > this.hull.keel + 0.3) return true; }
        // structures that reach above the water but not over the deck (quay, shore works; not crane booms)
        for (const q of this.deckSamples) { const r = at(q); if (w.col.ground(r[0], r[1], this.hull.deck) > wl + 0.3) return true; }
        return false;
    }

    // what the helm shows when nobody holds it: the wheel follows the turn, the lever the speed
    helmFromMotion() {
        if (this.control) return;
        const vmax = this.maxSpeed, flow = Math.max(0.3, Math.abs(this.v) / (vmax * 0.5));
        this.helm.throttle = this.v / vmax;
        this.helm.rudder = Math.max(-1, Math.min(1, -(this.yawRate || 0) / (this.maxYawRate * flow)));
    }

    takeHelm() { this.control = this.helm = { throttle: this.v / this.maxSpeed, rudder: 0 }; this.free = 'manual'; this.backoff = 0; }
    leaveHelm() { this.control = null; this.helm = { throttle: this.helm.throttle, rudder: this.helm.rudder }; this.free = 'rejoin'; }

    // move the vehicle's portals, lights and object bounds to its current pose
    place() {
        const M = this.M;
        for (const P of this.portals) P.place(M);
        for (const L of this.lights) L.pos = m4.point(M, L.local);
        for (const o of this.objects) {
            const b = worldBounds(M, o);
            o.wmin = b.min; o.wmax = b.max;
        }
    }

    waterline() { return this.hull.waterline2D.map(q => { const w = m4.point(this.M, [q[0], this.world.water.level, q[1]]); return [w[0], w[2]]; }); }
}

return { Vehicle };
});
