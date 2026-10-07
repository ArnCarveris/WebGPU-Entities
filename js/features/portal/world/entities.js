'use strict';
// Entities: props, GUI screens, lamps, stairs, hulls, helms, doors, drones and security cameras.

Features.part('portal', (engine, feature) => {
const { Common, kits } = engine;
const { v3 } = Common;
const { door, securityCamera, drone } = kits.entities;
const { MAX_LIGHTS, AXES, m4, IDENTITY, g2, newell, MeshBuilder, splitMesh, worldBounds, PointLight, SCREEN_GUIS } = feature;

// World entities. Each is constructed from a scenario definition ({ type, ... }) and spawned once, in
// scenario order: static ones add geometry to the world, dynamic ones also register for per-frame updates.

class Entity extends kits.world.Entity {
    constructor(def, world) {
        super(def, world);
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

    // riding vehicle veh, posed by `local` in its frame: its world model and bounds are worked out through the vehicle's
    // Origin when read (drawn, culled) after it or the vehicle moved, so a ship's pose costs nothing per member
    ride(veh, local) {
        if (!this.rider) {
            this.rider = { veh, local, ver: 0, at: -1, atVer: -1, model: null, min: null, max: null };
            for (const k of ['model', 'min', 'max']) { delete this[k]; Object.defineProperty(this, k, { get: () => this.posed()[k], configurable: true }); }
        }
        this.rider.local = local;
        this.rider.ver++;
    }

    posed() {
        const r = this.rider;
        if (r.at !== r.veh.poseStamp || r.atVer !== r.ver) {
            r.model = m4.mul(r.veh.M, r.local);
            const b = worldBounds(r.model, this.chunk);
            r.min = b.min; r.max = b.max; r.at = r.veh.poseStamp; r.atVer = r.ver;
        }
        return r;
    }
}

// A scenario model placed at pos / rot / scale; belongs to every area its bounds overlap. `screen` puts a GUI screen
// on the model's display face (Screen)
class Prop extends Entity {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model, m4.trs(e.pos, e.rot || 0, e.scale || 1));
        const owners = e.area !== undefined ? [w.areaIndex(e.area)] : w.areasOverlapping(b.min, b.max);
        const lightArea = w.areaAt(v3.add(e.pos, [0, 0.3, 0]));
        const first = w.objects.length;
        w.addStatic(b, {
            name: `prop:${e.model}`, owners, lightArea, vehicle: e.vehicle, dockedOnly: e.dockedOnly,
            solid: e.solid !== false, climbable: !!e.climbable,
        });
        if (e.screen) (this.screen = new Screen(e.screen, w, e, w.objects.slice(first))).spawn();
    }

    link() { this.screen?.link(); }
}

// A world-space GUI screen (Doom 3 style; EntityGUI, the gui kit: js/kits/gui/) on a prop's display face: the model part with
// `face` ("+x" | "-x" | "+z" | "-z", the side it shows; with its `tilt`), less `inset` metres all round. A dynamic SECTR Member like the
// door panels: its chunk is the dark glass under the GUI, and FrameBuilder draws the GUI's quads right after it, in the
// same draw slot. Its model matrix maps the GUI's virtual units onto the face (x right and y up as the viewer sees it,
// z out of it in metres), so the glass is built in virtual units and the GUI shader places its quads with the same
// matrix. It rides the vehicle its prop was claimed by. def: { gui: kind (gui/screens.js SCREEN_GUIS), virtual: [w, h]
// (default: 360 high, the face's aspect), range, inset, mat, title, ... (what the kind reads) }
class Screen extends Member {
    constructor(def, world, prop, hostObjects) {
        super(def, world);
        this.prop = prop;
        this.hostObjects = hostObjects;
        this.gui = null;
    }

    spawn() {
        const w = this.world, e = this.def, p = this.prop;
        const part = (w.scn.models?.[p.model] || []).find(q => q.face && q.box);
        const n = part && { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] }[part.face];
        if (!n) { w.warnings.push(`screen: model "${p.model}" has no box part with a "face"`); return; }
        const Kind = SCREEN_GUIS[e.gui];
        if (!Kind) { w.warnings.push(`screen: unknown gui "${e.gui}"`); return; }
        // the face in the world (or the vehicle's frame), through the prop's yaw and scale: centre, axes, size in metres
        const [x, y, z, sx, sy, sz] = part.box, P = m4.trs(p.pos, p.rot || 0, p.scale || 1), inset = e.inset ?? 0.04;
        const right = v3.cross([0, 1, 0], n), size = [sx, sy, sz], T = (part.tilt || 0) * Math.PI / 180;
        const tilt = q => [q[0], q[1] * Math.cos(T) - q[2] * Math.sin(T), q[1] * Math.sin(T) + q[2] * Math.cos(T)];     // as World.addModel
        const across = m4.dir(P, tilt(v3.mul(right, Math.abs(v3.dot(right, size))))), out = m4.dir(P, tilt(v3.mul(n, Math.abs(v3.dot(n, size)) / 2)));
        const up = m4.dir(P, tilt([0, sy, 0])), W = v3.len(across) - 2 * inset, H = v3.len(up) - 2 * inset;
        const R = v3.norm(across), U = v3.norm(up), N = v3.norm(out);
        const vh = e.virtual?.[1] ?? 360, vw = e.virtual?.[0] ?? Math.round(vh * W / H);
        const corner = v3.madd(v3.madd(v3.madd(v3.add(m4.point(P, [x, y, z]), out), N, 0.002), R, -W / 2), U, -H / 2);
        this.local = m4.basis(v3.mul(R, W / vw), v3.mul(U, H / vh), N, corner);
        const b = new MeshBuilder();
        b.poly([[0, 0, 0], [vw, 0, 0], [vw, vh, 0], [0, vh, 0]], [0, 0, 1], w.mat(e.mat || 'display'));
        this.chunk = w.pool.add(b, { name: `screen:${e.gui}`, dynamic: true });
        this.place(this.local);
        this.owners = w.areasOverlapping(this.min, this.max);
        this.lightArea = w.areaAt(m4.point(this.local, [vw / 2, vh / 2, 0.3]));
        const range = e.range ?? 3;   // use range; the "move closer" hint within four times that
        this.gui = new Kind({ ...e, range, hintRange: e.hintRange ?? range * 4, id: e.id || `${e.gui}@${p.pos.join(',')}`, size: [W, H], virtual: [vw, vh], maxVerts: e.maxVerts || 24000 }, this);
        w.addDynamic(this);
        w.screens.push(this);
    }

    // aboard: the vehicle that claimed its prop carries it
    link() {
        const veh = this.world.vehicles.find(v => this.hostObjects.some(o => o.vehicle === v));
        if (veh) { this.ride(veh, this.local); this.veh = veh; }
    }

    // the view ray (world, dir normalized) on the GUI: its cursor in virtual units and the distance, or null
    trace(eye, dir) {
        if (!this.gui) return null;
        const inv = m4.invert(this.model), o = m4.point(inv, eye), d = m4.dir(inv, dir);
        if (d[2] >= -1e-9) return null;                              // from behind
        const t = (0.003 - o[2]) / d[2];
        if (t <= 0) return null;
        const gx = o[0] + d[0] * t, gy = o[1] + d[1] * t, g = this.gui;
        if (gx < 0 || gx > g.vw || gy < 0 || gy > g.vh) return null;
        return { x: gx, y: g.vh - gy, t };
    }

    // the GUI's centre in the world (use range)
    get centre() { return m4.point(this.model, [this.gui.vw / 2, this.gui.vh / 2, 0]); }
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

    // posed in the ship's frame, and only when the wheel or the lever moved
    update() {
        const v = this.helm.vehicle;
        if (!v) return;
        const h = v.helm, key = `${h.rudder},${h.throttle}`;
        if (this.rider && this.key === key) return;
        this.key = key;
        this.ride(v, m4.mul(m4.translate(this.pos), this.rotate(h)));
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

    // follows its door: only when the door moved (in the vehicle's frame for a door aboard one)
    update() {
        const d = this.door;
        if (this.ver === d.ver) return;
        this.ver = d.ver;
        if (d.portal.vehicle) this.ride(d.portal.vehicle, d.local); else this.place(d.model);
    }
}

// SECTR_Door (kits.entities door: open / target / speed, auto, toggle): drives the Closed flag of its portal; `auto` doors
// open for nearby actors; `locked` lives on the portal. slide: right | left | up | down (in the portal frame), lift: pops
// the panel out first (hatches)
class Door extends door(Entity) {
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
        this.portal = P;
        this.lift = e.lift || 0;
        this.slide = e.slide || 'right';
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
    get locked() { return this.portal.locked; }

    // A door aboard a vehicle is posed in the vehicle's frame (its portal's local pose; the world one follows through the
    // vehicle's Origin when read): moving the vehicle costs it nothing. Its panel is re-posed only while it moves (ver)
    update(dt, t, actors) {
        const P = this.portal, veh = P.vehicle;
        // aboard: nobody near the vehicle is near the door, without posing it
        if (this.auto && !P.locked) this.sense((!veh || actors.some(a => veh.near(a, this.radius))) && actors.some(a => v3.dist(a, P.center) < this.radius), dt);
        this.step(dt);
        P.closed = this.open < 0.02;
        if (this.ver !== undefined && this.posedOpen === this.open && this.posedOn === veh) return;     // (or it boarded: Vehicle.claim)
        this.posedOpen = this.open;
        this.posedOn = veh;
        this.ver = (this.ver || 0) + 1;
        const F = veh ? P.local : P, ease = this.openAmount;
        const lift = this.lift * Math.min(1, this.open * 4);
        const sd = { right: [F.right, P.w], left: [v3.mul(F.right, -1), P.w], up: [F.up, P.h], down: [v3.mul(F.up, -1), P.h] }[this.slide];
        const M = m4.basis(F.right, F.up, F.normal, v3.madd(v3.madd(F.center, sd[0], sd[1] * 0.97 * ease), F.normal, lift));
        if (veh) this.local = M; else this.model = M;
    }
}

// A drone (kits.entities drone) that wanders the sector graph between random areas, waiting at automatic doors (its
// gates are portals); a dynamic SECTR Member. A `center` + `radius` def patrols a loop instead
class Drone extends drone(Member) {
    spawn() {
        const w = this.world, e = this.def, b = new MeshBuilder();
        w.addModel(b, e.model || 'drone', IDENTITY);
        this.chunk = w.pool.add(b, { name: 'drone', dynamic: true });
        w.addDynamic(this);
        w.drones.push(this);
    }

    makeLight(spec) { return new PointLight(spec); }

    // a random other area to fly to
    wander() {
        const w = this.world, cur = w.areaAt(this.pos);
        for (let k = 0; k < 8; k++) {
            this.target = Math.floor(this.rnd() * w.areas.length);
            if (this.target !== cur && this.plan()) break;
        }
    }

    plan() {
        const w = this.world, from = w.areaAt(this.pos);
        const path = w.nav.findPath(from, this.target);
        if (!path) return false;
        this.queue = [{ pos: w.areas[from].hub }];
        for (const step of path) this.queue.push({ pos: step.portal.navPoint(), gate: step.portal }, { pos: w.areas[step.area].hub });
        return true;
    }

    update(dt, t) {
        super.update(dt, t);
        const w = this.world;
        this.place(m4.trs(this.at, this.yaw, 1));
        this.owners = w.areasOverlapping(this.min, this.max);                // SECTR Member: may span several sectors
        this.lightArea = w.areaAt(this.pos);
    }
}

// A security camera (kits.entities securityCamera: pos, target, sweep, speed, phase, name, loc, offline): a viewpoint the
// gui kit's CctvSystem renders through (game/media.js). It has no geometry; its housing is a prop of its own. Unlabelled
// cameras are numbered CAM-01, CAM-02...
class SecurityCamera extends securityCamera(Entity) {
    constructor(def, world) {
        super(def, world);
        this.label = def.label || def.id || `CAM-${String(world.cameras.length + 1).padStart(2, '0')}`;
    }

    spawn() {
        this.world.cameras.push(this);
        this.world.addDynamic(this);
    }
}

const ENTITY_TYPES = {
    securityCamera: SecurityCamera,
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
