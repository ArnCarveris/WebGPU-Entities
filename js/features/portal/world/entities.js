'use strict';
// Entities: props, lamps, stairs, hulls, helms, doors and drones.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3, mulberry32 } = Common;
const { MAX_LIGHTS, AXES, m4, IDENTITY, g2, newell, MeshBuilder, splitMesh, worldBounds, PointLight } = feature;

// World entities. Each is constructed from a scenario definition ({ type, ... }) and spawned once, in
// scenario order: static ones add geometry to the world, dynamic ones also register for per-frame updates.

class Entity {
    constructor(def, world) {
        this.def = def;
        this.world = world;
        this.id = def && def.id;
        this.owners = [];           // areas it is drawn in (dynamic members only)
    }

    spawn() {}                      // build geometry, register with the world
    link() {}                       // resolve references once every entity and vehicle exists
    update(dt, t, actors) {}        // actors: positions that open automatic doors
}

// Dynamic SECTR Member: one geometry chunk drawn with its own model matrix, in every area it overlaps
class Member extends Entity {
    constructor(def, world, chunk = null, area = 0) {
        super(def, world);
        this.chunk = chunk;
        this.stamp = -1;
        this.owners = [area];
        this.lightArea = area;
        this.model = IDENTITY;
        this.min = [0, 0, 0];
        this.max = [0, 0, 0];
    }

    place(model) {
        this.model = model;
        const b = worldBounds(model, this.chunk);
        this.min = b.min;
        this.max = b.max;
    }
}

// A scenario model placed at pos / rot / scale; belongs to every area its bounds overlap
class Prop extends Entity {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model, m4.trs(e.pos, e.rot || 0, e.scale || 1));
        const owners = e.area !== undefined ? [w.areaIndex(e.area)] : w.areasOverlapping(b.min, b.max);
        const lightArea = w.areaAt(v3.add(e.pos, [0, 0.3, 0]));
        w.addStatic(b, {
            name: `prop:${e.model}`, owners, lightArea, vehicle: e.vehicle, dockedOnly: e.dockedOnly,
            solid: e.solid !== false, climbable: !!e.climbable,
        });
    }
}

// Point light of the area it is in, with an optional (non-solid) fixture model
class Lamp extends Entity {
    spawn() {
        const w = this.world, e = this.def, L = new PointLight(e);
        const a = e.area !== undefined ? w.areaIndex(e.area) : w.areaAt(e.pos), area = w.areas[a];
        area.lights.push(L);
        if (area.lights.length > MAX_LIGHTS) w.warnings.push(`area "${area.id}" has more than ${MAX_LIGHTS} lights`);
        if (e.model) new Prop({ model: e.model, pos: e.pos, rot: e.rot || 0, area: area.id, solid: false }, w).spawn();
    }
}

// Solid steps from `from` (top) to `to` (bottom), with an optional landing before the top step;
// `open` builds treads only (gangway), `rails` adds hand rails
class Stairs extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const b = new MeshBuilder(), m = w.mat(e.mat || 'concrete'), mEdge = w.mat(e.edgeMat || 'hazard');
        const f = e.from, t = e.to, L = Math.hypot(t[0] - f[0], t[2] - f[2]);
        const d = [(t[0] - f[0]) / L, 0, (t[2] - f[2]) / L], side = [-d[2], 0, d[0]], ax = [d, [0, 1, 0], side];
        const hw = (e.width || 2) / 2, n = e.steps || 12, rise = (f[1] - t[1]) / n, run = L / n;
        if (e.landing) {
            const c = v3.madd(f, d, -e.landing / 2);
            b.box([c[0], (f[1] + t[1]) / 2, c[2]], ax, [e.landing / 2, (f[1] - t[1]) / 2, hw], m);
        }
        for (let i = 0; i < n; i++) {
            const top = f[1] - (i + 1) * rise, h = top - t[1];
            if (h <= 1e-3) continue;
            const c = v3.madd(f, d, (i + 0.5) * run);
            if (e.open) b.box([c[0], top - 0.03, c[2]], ax, [run / 2 + 0.02, 0.03, hw], m);     // gangway: treads only
            else b.box([c[0], t[1] + h / 2, c[2]], ax, [run / 2, h / 2, hw], m);
            const nose = v3.madd(f, d, i * run + 0.06);
            b.box([nose[0], top + 0.006, nose[2]], ax, [0.06, 0.006, hw], mEdge);
        }
        if (e.rails) {
            const len = Math.hypot(L, f[1] - t[1]), mid = v3.lerp(f, t, 0.5), slope = v3.norm(v3.sub(t, f));
            const rup = v3.norm(v3.cross(side, slope)), rax = [slope, rup, side], mr = w.mat(e.railMat || 'metal');
            for (const sgn of [-1, 1]) {
                const base = v3.madd(mid, side, sgn * hw);
                b.box(v3.madd(base, rup, 0.95), rax, [len / 2, 0.03, 0.03], mr);
                for (let k = 0; k <= 4; k++) b.box(v3.madd(v3.madd(v3.lerp(f, t, k / 4), side, sgn * hw), [0, 1, 0], 0.5), AXES, [0.025, 0.5, 0.025], mr);
            }
        }
        w.addStatic(b, { name: 'stairs', owners: w.areasOverlapping(b.min, b.max), lightArea: w.areaAt(v3.madd(t, [0, 1, 0], 0.5)), vehicle: e.vehicle, dockedOnly: e.dockedOnly });
    }
}

// Ship hull extruded from its deck outline: sides taper toward the keel, antifouling band below the
// paint line, deck = outline minus the roofs of the interior areas under it, bulwark with gaps
class Hull extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const b = new MeshBuilder(), out = e.outline.map(p => [p[0], p[1]]), deck = e.deck, keel = e.keel;
        const xs = out.map(p => p[0]), xc = (Math.min(...xs) + Math.max(...xs)) / 2, inset = e.inset ?? 1.5;
        const bottom = out.map(p => [p[0] + Math.sign(xc - p[0]) * Math.min(inset, Math.abs(xc - p[0])), p[1]]);
        const mTop = w.mat(e.mat || 'hullpaint'), mBot = w.mat(e.bottomMat || e.mat || 'hullpaint');
        const mDeck = w.mat(e.deckMat || 'shipdeck'), mBul = w.mat(e.bulwarkMat || e.mat || 'hullpaint');
        const band = e.band ?? keel;
        const at = (i, y) => { const t = (y - keel) / (deck - keel); return [bottom[i][0] + (out[i][0] - bottom[i][0]) * t, y, bottom[i][1] + (out[i][1] - bottom[i][1]) * t]; };
        const face = (pts, outward, m) => { if (v3.dot(newell(pts), outward) < 0) pts = pts.slice().reverse(); b.poly(pts, null, m); };
        const gaps = e.bulwarkGaps || [], hb = e.bulwark || 0, th = 0.14;
        for (let i = 0; i < out.length; i++) {
            const j = (i + 1) % out.length, a = out[i], c = out[j];
            let n = v3.norm([c[1] - a[1], 0, -(c[0] - a[0])]);
            if (g2.inside([(a[0] + c[0]) / 2 + n[0] * 0.05, (a[1] + c[1]) / 2 + n[2] * 0.05], out)) n = v3.mul(n, -1);
            face([at(i, keel), at(j, keel), at(j, band), at(i, band)], n, mBot);
            face([at(i, band), at(j, band), at(j, deck), at(i, deck)], n, mTop);
            if (!hb) continue;
            const L = Math.hypot(c[0] - a[0], c[1] - a[1]), steps = Math.max(1, Math.ceil(L));
            for (let k = 0; k < steps; k++) {
                const p0 = [a[0] + (c[0] - a[0]) * k / steps, a[1] + (c[1] - a[1]) * k / steps], p1 = [a[0] + (c[0] - a[0]) * (k + 1) / steps, a[1] + (c[1] - a[1]) * (k + 1) / steps];
                const pm = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
                if (gaps.some(r => pm[0] > r[0] && pm[0] < r[2] && pm[1] > r[1] && pm[1] < r[3])) continue;
                const o0 = [p0[0], deck, p0[1]], o1 = [p1[0], deck, p1[1]], i0 = v3.madd(o0, n, -th), i1 = v3.madd(o1, n, -th), up = [0, hb, 0];
                face([o0, o1, v3.add(o1, up), v3.add(o0, up)], n, mTop);
                face([i0, i1, v3.add(i1, up), v3.add(i0, up)], v3.mul(n, -1), mBul);
                face([v3.add(o0, up), v3.add(o1, up), v3.add(i1, up), v3.add(i0, up)], [0, 1, 0], mBul);
            }
        }
        for (const t of g2.triangulate(bottom)) b.poly(t.map(p => [p[0], keel, p[1]]), [0, -1, 0], mBot);
        let top = g2.triangulate(out);
        for (let ai = 1; ai < w.areas.length; ai++) {
            const A = w.areas[ai];
            if (Math.abs(A.top - deck) < 0.01) for (const t of g2.triangulate(A.shape)) top = g2.subtract(top, t);
        }
        for (const p of top) b.poly(p.map(q => [q[0], deck, q[1]]), [0, 1, 0], mDeck);
        this.id = e.id || 'ship';
        this.outline = out;
        this.keel = keel;
        this.deck = deck;
        this.inset = inset;
        this.waterline2D = w.water ? out.map((_, i) => { const q = at(i, w.water.level); return [q[0], q[2]]; }) : [];
        this.vehicle = null;        // set by the Vehicle that moves this hull
        w.addStatic(b, { name: `hull:${this.id}`, owners: [0], lightArea: 0, vehicle: this.id });
        w.hulls.push(this);
    }

    // waterline cross-section in world space (cut out of the sea)
    worldWaterline() { return this.vehicle ? this.vehicle.waterline() : this.waterline2D; }
}

// One part of the helm (wheel or lever) riding its vehicle, posed from the helm state
class HelmPart extends Member {
    constructor(helm, chunk, area, pos, rotate) {
        super(null, helm.world, chunk, area);
        this.helm = helm;
        this.pos = pos;
        this.rotate = rotate;
    }

    update() {
        const v = this.helm.vehicle;
        if (v) this.place(m4.mul(m4.mul(v.M, m4.translate(this.pos)), this.rotate(v.helm)));
    }
}

// Ship's helm: a spoked wheel turning with the rudder and a throttle lever; `F` at the stand takes control
class Helm extends Entity {
    spawn() {
        const w = this.world, e = this.def;
        const mk = (name, build) => { const b = new MeshBuilder(); build(b); return w.pool.add(b, { name, dynamic: true }); };
        const mw = w.mat(e.wheelMat || 'wood'), mm = w.mat('metal'), r = e.wheel.radius || 0.35, Z = [0, 0, 1];
        const wheel = mk('helm:wheel', b => {
            for (let k = 0; k < 20; k++) {
                const a = k / 20 * Math.PI * 2, rad = [Math.cos(a), Math.sin(a), 0], tan = [-Math.sin(a), Math.cos(a), 0];
                b.box([rad[0] * r, rad[1] * r, 0], [tan, rad, Z], [Math.PI * r / 20 + 0.012, 0.025, 0.03], mw);          // rim
            }
            for (let k = 0; k < 8; k++) {
                const a = k / 8 * Math.PI * 2, rad = [Math.cos(a), Math.sin(a), 0], tan = [-Math.sin(a), Math.cos(a), 0];
                b.box([rad[0] * r / 2, rad[1] * r / 2, 0], [rad, tan, Z], [r / 2, 0.015, 0.015], mm);                     // spoke
                b.box([rad[0] * (r + 0.08), rad[1] * (r + 0.08), 0], [rad, tan, Z], [0.07, 0.022, 0.022], mw);            // handle
            }
            b.box([0, 0, 0], AXES, [0.07, 0.07, 0.05], mm);
            b.box([0, 0, 0.15], AXES, [0.03, 0.03, 0.12], mm);                                                           // shaft
        });
        const lever = mk('helm:lever', b => {
            b.box([0, 0, 0], AXES, [0.09, 0.04, 0.14], mm);
            b.box([0, 0.2, 0], AXES, [0.022, 0.2, 0.022], mm);
            b.box([0, 0.42, 0], AXES, [0.06, 0.04, 0.04], w.mat('hazard'));
        });
        const area = w.areaAt([e.stand[0], e.stand[1] + 0.5, e.stand[2]]);
        this.stand = e.stand;
        this.reach = e.reach || 1.4;
        this.lightArea = area;
        this.vehicle = null;
        w.addDynamic(this);
        w.helms.push(this);
        w.addDynamic(new HelmPart(this, wheel, area, e.wheel.pos, h => m4.rotZ(h.rudder * 2.6)));   // about 3/4 turn each way
        w.addDynamic(new HelmPart(this, lever, area, e.lever.pos, h => m4.rotX(h.throttle * 0.6))); // forward = ahead, back = astern
    }

    link() {
        this.vehicle = this.world.vehicles.find(v => v.id === this.def.vehicle) || null;
        if (this.vehicle) this.vehicle.helmStation = this;
    }
}

// One half of a door panel, cut along the portal plane. It always belongs to the area its face looks
// into, however far the panel slides or lifts: the underside of a hatch cover stays part of (and lit by)
// the room below.
class DoorPanel extends Member {
    constructor(door, chunk, area) {
        super(null, door.world, chunk, area);
        this.door = door;
    }

    update() { this.place(this.door.model); }
}

// SECTR_Door: drives the Closed flag of its portal; `auto` doors open for nearby actors.
// slide: right | left | up | down (in the portal frame), lift: pops the panel out first (hatches)
class Door extends Entity {
    spawn() {
        const w = this.world, e = this.def, P = w.portalById.get(e.portal);
        if (!P) { w.warnings.push(`door: unknown portal "${e.portal}"`); return; }
        const b = new MeshBuilder();
        b.box([0, 0, 0], AXES, [P.w / 2, P.h / 2, 0.04], w.mat(e.mat || (e.auto ? 'autodoor' : 'door')));
        if (e.style === 'ship') {
            // watertight ship door: raised frame ring, dogs and a hand wheel on both faces
            const mf = w.mat(e.frameMat || 'metal'), hw = P.w / 2, hh = P.h / 2;
            for (const z of [-0.06, 0.06]) {
                b.box([0, hh - 0.08, z], AXES, [hw - 0.04, 0.04, 0.02], mf); b.box([0, -hh + 0.08, z], AXES, [hw - 0.04, 0.04, 0.02], mf);
                b.box([-hw + 0.08, 0, z], AXES, [0.04, hh - 0.04, 0.02], mf); b.box([hw - 0.08, 0, z], AXES, [0.04, hh - 0.04, 0.02], mf);
                b.box([0, 0.05, z * 1.4], AXES, [0.22, 0.025, 0.02], mf); b.box([0, 0.05, z * 1.4], AXES, [0.025, 0.22, 0.02], mf);
                for (const yy of [-hh * 0.6, hh * 0.6]) b.box([hw - 0.12, yy, z * 1.3], AXES, [0.08, 0.03, 0.02], w.mat('hazard'));
            }
        } else {
            b.box([0, -P.h / 2 + 0.12, 0], AXES, [P.w / 2 - 0.02, 0.1, 0.05], w.mat('hazard'));
            if (e.auto) b.box([0, P.h / 2 - 0.2, 0], AXES, [0.25, 0.04, 0.06], w.mat('coldlamp'));
        }
        const halves = splitMesh(b, [0, 0, 1, 0]);
        P.locked = !!e.locked;
        P.autoDoor = !!e.auto && !P.locked;
        const startOpen = !!e.open && !e.auto;
        this.portal = P;
        this.auto = !!e.auto;
        this.lift = e.lift || 0;
        this.slide = e.slide || 'right';
        this.radius = e.radius || 3.2;
        this.delay = e.delay ?? 1.2;
        this.hold = 0;
        this.open = startOpen ? 1 : 0;
        this.target = this.open;
        this.speed = e.speed || (e.auto ? 2.6 : 1.4);
        this.lightArea = P.front || P.back;
        this.model = IDENTITY;
        this.update(0, 0, []);
        w.addDynamic(this);
        w.doors.push(this);
        halves.forEach((half, k) => {
            const chunk = w.pool.add(half, { name: `door:${P.id}:${k ? 'back' : 'front'}`, dynamic: true });
            if (!chunk) return;
            const panel = new DoorPanel(this, chunk, k ? P.back : P.front);
            panel.update();
            w.addDynamic(panel);
        });
    }

    get name() { return this.portal.id; }

    toggle() {
        if (this.portal.locked) return 'locked';
        if (this.auto) return 'auto';
        this.target = this.target > 0.5 ? 0 : 1;
        return 'ok';
    }

    update(dt, t, actors) {
        const P = this.portal;
        if (this.auto && !P.locked) {
            const near = actors.some(a => v3.dist(a, P.center) < this.radius);
            if (near) { this.target = 1; this.hold = this.delay; }
            else if ((this.hold -= dt) <= 0) this.target = 0;
        }
        const d = this.target - this.open;
        this.open += Math.sign(d) * Math.min(Math.abs(d), this.speed * dt);
        P.closed = this.open < 0.02;
        const ease = this.open * this.open * (3 - 2 * this.open);
        const lift = this.lift * Math.min(1, this.open * 4);
        const sd = { right: [P.right, P.w], left: [v3.mul(P.right, -1), P.w], up: [P.up, P.h], down: [v3.mul(P.up, -1), P.h] }[this.slide];
        this.model = m4.basis(P.right, P.up, P.normal, v3.madd(v3.madd(P.center, sd[0], sd[1] * 0.97 * ease), P.normal, lift));
    }
}

// Dynamic SECTR Member that walks the sector graph between random areas, waiting at automatic doors
class Drone extends Member {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model || 'drone', IDENTITY);
        this.chunk = w.pool.add(b, { name: 'drone', dynamic: true });
        this.rnd = mulberry32(e.seed || 99);
        this.pos = e.pos.slice();
        this.yaw = 0;
        this.speed = e.speed || 3;
        this.queue = [];
        this.wait = 0.5;
        this.target = -1;
        this.lightOn = !!e.light;
        this.light = e.light ? new PointLight({ pos: e.pos.slice(), color: e.light.color, intensity: e.light.intensity, radius: e.light.radius }) : null;
        w.addDynamic(this);
        w.drones.push(this);
    }

    plan() {
        const w = this.world, from = w.areaAt(this.pos);
        const path = w.nav.findPath(from, this.target);
        if (!path) return false;
        this.queue = [{ pos: w.areas[from].hub }];
        for (const step of path) this.queue.push({ pos: step.portal.navPoint(), portal: step.portal }, { pos: w.areas[step.area].hub });
        return true;
    }

    update(dt, t) {
        const w = this.world;
        if (!this.queue.length) {
            this.wait -= dt;
            if (this.wait <= 0) {
                const cur = w.areaAt(this.pos);
                for (let k = 0; k < 8; k++) {
                    this.target = Math.floor(this.rnd() * w.areas.length);
                    if (this.target !== cur && this.plan()) break;
                }
                this.wait = 1.0;
            }
        } else {
            const wp = this.queue[0];
            const d = v3.sub(wp.pos, this.pos), l = v3.len(d);
            if (wp.portal && !wp.portal.navigable) {                          // a door got locked/closed on us: replan
                if (!this.plan()) { this.queue = []; this.wait = 1.5; }
            } else if (!(wp.portal && wp.portal.closed && l < 1.6)) {         // wait for an automatic door
                const step = this.speed * dt;
                if (l <= step) { this.pos = wp.pos.slice(); this.queue.shift(); }
                else {
                    this.pos = v3.madd(this.pos, d, step / l);
                    if (Math.hypot(d[0], d[2]) > 0.05) {
                        const want = Math.atan2(-d[0], -d[2]) * 180 / Math.PI;
                        const dy = ((want - this.yaw + 540) % 360) - 180;
                        this.yaw += dy * Math.min(1, dt * 6);
                    }
                }
            }
        }
        const bob = Math.sin(t * 3) * 0.05;
        this.place(m4.trs([this.pos[0], this.pos[1] + bob, this.pos[2]], this.yaw, 1));
        this.owners = w.areasOverlapping(this.min, this.max);                // SECTR Member: may span several sectors
        this.lightArea = w.areaAt(this.pos);
        if (this.light) this.light.pos = [this.pos[0], this.pos[1] - 0.2, this.pos[2]];
    }
}

const ENTITY_TYPES = {
    prop: Prop,
    light: Lamp,
    stairs: Stairs,
    hull: Hull,
    helm: Helm,
    door: Door,
    drone: Drone,
};

return { ENTITY_TYPES };
});
