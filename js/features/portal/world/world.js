'use strict';
// The world: builds the scenario's architecture and entities and runs them.

Features.part('portal', (engine, feature) => {
const { Common, kits } = engine;
const { v3 } = Common;
const { GridHash, AreaSet } = kits.interior;
const { tiltAxes, worldBounds } = kits.mesh;
const {
    MAX_LIGHTS, THROUGH_FLOATS, AREA_FLOATS, AXES, IDENTITY, g2, GeometryPool, MeshBuilder, splitMesh, MaterialTable, BVHTree, QuadTree,
    pushSeg, CollisionSet, Area, Portal, Occluder, LightTransport, Architecture, Outdoors, NavGraph, Vehicle, PowerGrid, SCREEN_GUIS,
    ENTITY_TYPES,
} = feature;

// World: built entirely from the scenario data; its areas, portals and occluders are an AreaSet (kits.interior: areaAt,
// the outdoor portal tree, the PortalVis graph).
//
// Build order: materials -> areas -> portals -> occluders -> generated architecture -> outdoors
// (terrain, scatter, seabed) -> entities -> vehicles (claim what is inside their hulls) -> link entities
// -> object trees -> collision -> sea surface.

class World extends AreaSet {
    constructor(scn) {
        super();
        // the planned buildings (`structures`: placements of the floor plans in its `plans`) built into its own areas,
        // portals, models and entities first (the building kit)
        this.scn = scn = kits.building.withStructures(scn);
        this.warnings = [];
        this.pool = new GeometryPool();
        this.objects = [];              // static members (chunks with owners), in the per-area trees
        this.dynamic = [];              // entities updated every frame, in spawn order
        this.entities = [];
        this.doors = [];
        this.helms = [];
        this.drones = [];
        this.hulls = [];
        this.screens = [];              // GUI screens (entities.js Screen)
        this.cameras = [];              // security cameras (entities.js SecurityCamera)
        this.maxLights = MAX_LIGHTS;    // per area
        this.guiKinds = SCREEN_GUIS;    // the GUI screens' kinds (gui/screens.js)
        // the common mesh interface (kits.mesh): builders resolve material names and scenario models; static geometry
        // goes into the area trees (addStatic: opts { name, owners, lightArea, vehicle, dockedOnly, solid, climbable }),
        // parts are pool chunks drawn with their own matrix
        this.meshes = {
            builder: () => new MeshBuilder(m => this.mat(m), (b, name, M) => this.addModel(b, name, M)),
            add: (b, opts) => this.addStatic(typeof b === 'function' ? b() : b, opts),
            part: (b, opts) => this.pool.add(b, { ...opts, dynamic: true }),
            bounds: (part, M) => worldBounds(M, part),
            split: (b, plane) => splitMesh(b, plane),
        };
        this.power = new PowerGrid(this);
        this.materials = new MaterialTable(scn.materials, this.warnings);
        this.nav = new NavGraph(this);
        this.buildAreas();
        this.buildPortals();
        this.occluders = (scn.occluders || []).map((d, i) => new Occluder(d, i, this));
        for (const O of this.occluders) this.areas[O.area].occluders.push(O.index);
        new Architecture(this).build();
        this.outdoors = new Outdoors(this, scn.outdoor);
        this.water = this.outdoors.water;
        this.outdoors.build();
        this.spawnEntities();
        this.vehicles = (scn.vehicles || []).map(d => new Vehicle(this, d));
        for (const veh of this.vehicles) veh.claim();
        this.indexAreas();
        // the vehicles in a GridHash by their bounding spheres (re-bucketed as they cross cells, Vehicle.update): point
        // queries (areaAt, groundAt, collide) look only at the ones over p, however many sail
        this.vehicleGrid = new GridHash(64);
        for (const veh of this.vehicles) this.vehicleGrid.insert(veh, ...veh.rect());
        for (const e of this.entities) e.link();
        this.buildTrees();
        this.buildCollision();
        this.water?.update(this.hulls);
        this.lightTransport = new LightTransport(this);
        this.totalTris = this.objects.reduce((s, o) => s + o.chunk.count / 3, 0);
        for (const w of this.warnings) console.warn('[scenario]', w);
    }

    mat(name) { return this.materials.index(name); }

    // toward the sun (not normalized)
    get sunDir() { return this.scn.outdoor?.sunDir || [0.4, 0.8, 0.3]; }

    // ---- areas (FarCry VisArea / SECTR Sector) ----
    buildAreas() {
        this.areas = [Area.outdoors(this.scn.outdoor)];
        for (const def of this.scn.areas || []) this.areas.push(new Area(def, this.areas.length));
        this.areaById = new Map(this.areas.map(a => [a.id, a.index]));
        this.indexAreas();
    }

    // (indexAreas, areaIndex, vehiclesAt, areaAt: AreaSet's)

    // the interior (kits.interior) p is sheltered in from the weather: its area, or null outdoors
    shelterAt(p) { const a = this.areas[this.areaAt(p)]; return a.shelter ? a : null; }

    // SECTR Member: an AABB may belong to several sectors (and to the outdoors)
    areasOverlapping(min, max) {
        const out = [];
        let covered = false;
        const pts = [[min[0], min[2]], [max[0], min[2]], [max[0], max[2]], [min[0], max[2]], [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2]];
        for (let i = 1; i < this.areas.length; i++) {
            const a = this.areas[i];
            if (max[1] <= a.y + 1e-3 || min[1] >= a.top - 1e-3) continue;
            if (max[0] < a.bbox[0] || min[0] > a.bbox[2] || max[2] < a.bbox[1] || min[2] > a.bbox[3]) continue;
            const hits = pts.filter(p => g2.inside(p, a.shape)).length;
            const vin = a.shape.some(p => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[2] && p[1] <= max[2]);
            if (hits || vin) out.push(i);
            if (hits === pts.length && min[1] >= a.y - 1e-3 && max[1] <= a.top + 1e-3) covered = true;
        }
        if (!covered && max[1] > -0.05) {
            const outside = pts.some(p => !this.areas.some((a, i) => i > 0 && g2.inside(p, a.shape) && min[1] < a.top && max[1] > a.y));
            if (outside || !out.length) out.push(0);
        }
        if (!out.length) out.push(0);
        return out;
    }

    // ---- portals ----
    buildPortals() {
        this.portals = [];
        this.portalById = new Map();
        for (const d of this.scn.portals || []) this.addPortal(d);
    }

    // ---- static geometry ----
    // info: { name, owners, lightArea, vehicle?, dockedOnly?, terrain?, solid?, climbable? }
    addStatic(b, info) {
        const parts = this.splitByPortals(b, info.owners, info.lightArea);
        parts.forEach(part => {
            const name = parts.length > 1 ? `${info.name}|${this.areas[part.owners[0]].id}` : info.name;
            const chunk = this.pool.add(part.b, Object.assign({}, info, { name, owners: part.owners, lightArea: part.lightArea }));
            if (chunk) this.objects.push({
                name, chunk, min: chunk.min, max: chunk.max, owners: part.owners, lightArea: part.lightArea, model: IDENTITY, stamp: -1,
                vehicleId: info.vehicle, dockedOnly: !!info.dockedOnly, terrain: !!info.terrain, solid: info.solid !== false, climbable: !!info.climbable,
            });
        });
    }

    // does the mesh cross portal P's plane close to its aperture?
    straddles(b, P, margin = 0.6) {
        const c = v3.lerp(b.min, b.max, 0.5), h = v3.mul(v3.sub(b.max, b.min), 0.5);
        const ext = ax => Math.abs(ax[0]) * h[0] + Math.abs(ax[1]) * h[1] + Math.abs(ax[2]) * h[2];
        const dn = v3.dot(P.normal, c) + P.d, rn = ext(P.normal);
        if (dn - rn > -1e-3 || dn + rn < 1e-3) return false;
        const rel = v3.sub(c, P.center);
        return Math.abs(v3.dot(rel, P.right)) <= P.w / 2 + margin + ext(P.right) && Math.abs(v3.dot(rel, P.up)) <= P.h / 2 + margin + ext(P.up);
    }

    // cut geometry owned by both sides of a portal along the portal plane: each half belongs to
    // (and is lit by) the area on its side, so stencil masks and lighting stay per area
    splitByPortals(b, owners, lightArea) {
        let pieces = [{ b, owners }];
        if (owners.length > 1) for (const P of this.portals) {
            const next = [];
            for (const pc of pieces) {
                if (!pc.owners.includes(P.front) || !pc.owners.includes(P.back) || !this.straddles(pc.b, P)) { next.push(pc); continue; }
                const [neg, pos] = splitMesh(pc.b, [P.normal[0], P.normal[1], P.normal[2], P.d]);   // normal points to the back side
                // a piece keeps the owners on its side that its own bounds still overlap
                const refine = (half, owners) => { const ov = this.areasOverlapping(half.min, half.max), r = owners.filter(o => ov.includes(o)); return r.length ? r : ov; };
                if (neg.idx.length) next.push({ b: neg, owners: refine(neg, pc.owners.filter(o => o !== P.back)) });
                if (pos.idx.length) next.push({ b: pos, owners: refine(pos, pc.owners.filter(o => o !== P.front)) });
            }
            pieces = next;
        }
        return pieces.map(pc => ({ b: pc.b, owners: pc.owners, lightArea: pc.owners.includes(lightArea) ? lightArea : pc.owners[0] }));
    }

    // add a scenario model (box / cyl / cone parts) to b, placed with matrix M. A box may `tilt` (degrees about the model's
    // x axis, its top toward +z): a sloped desk screen
    addModel(b, name, M) {
        const parts = (this.scn.models || {})[name];
        if (!parts) { this.warnings.push(`unknown model "${name}"`); return; }
        b.M = M;
        for (const part of parts) {
            const m = this.mat(part.mat);
            if (part.box) { const [x, y, z, sx, sy, sz] = part.box; b.box([x, y, z], part.tilt ? tiltAxes(part.tilt) : AXES, [sx / 2, sy / 2, sz / 2], m); }
            else if (part.cyl) { const [x, y, z, r, h] = part.cyl; b.cylinder([x, y, z], r, h, part.seg || 12, m); }
            else if (part.cone) { const [x, y, z, r, h] = part.cone; b.cone([x, y, z], r, h, part.seg || 12, m); }
        }
        b.M = null;
    }

    terrainHeight(x, z) { return this.outdoors.height(x, z); }

    // ---- entities ----
    spawnEntities() {
        for (const def of this.scn.entities || []) kits.world.addEntity(this, ENTITY_TYPES, def, { warnings: this.warnings });
    }

    addDynamic(e) { this.dynamic.push(e); }

    // a collision set with `cell` m cells (a vehicle's: kits.transit shipType)
    collisionSet(cell) { return new CollisionSet(cell); }

    // outdoor objects -> one quadtree; each indoor area -> its own BVH (SECTR Members may be in several)
    buildTrees() {
        this.outdoorTree = new QuadTree(this.objects.filter(o => !o.vehicle && o.owners.includes(0)));
        this.areaTrees = this.areas.map((a, i) => i === 0 ? null : new BVHTree(this.objects.filter(o => o.owners.includes(i))));
        // a vehicle keeps its outdoor parts (hull, deck gear) in its own tree, in vehicle space
        for (const veh of this.vehicles) veh.outdoorTree = new BVHTree(veh.objects.filter(o => o.owners.includes(0)));
        this.dynamicByArea = this.areas.map(() => []);
        // the portals out to the outdoors: from outdoors, PortalVis asks this tree for those in its frustum instead of
        // testing every one in the world (a vehicle's move with it: tested while the vehicle is in view)
        this.indexOutdoorPortals(QuadTree);
    }

    // ---- walking: collision, ground, ladders ----
    // walkable floors and wall segments from the scene triangles (terrain uses terrainHeight)
    buildCollision() {
        this.col = new CollisionSet(2);
        const pv = this.pool.vdata, pi = this.pool.idata, V = i => [pv[i * 7], pv[i * 7 + 1], pv[i * 7 + 2]];
        for (const o of this.objects) {
            if (o.terrain || !o.solid) continue;               // light fixtures are not solid
            const set = o.vehicle ? (o.dockedOnly ? o.vehicle.dockCol : o.vehicle.col) : this.col, c = o.chunk;
            for (let k = 0; k < c.count; k += 3) set.addTri(V(c.baseVertex + pi[c.first + k]), V(c.baseVertex + pi[c.first + k + 1]), V(c.baseVertex + pi[c.first + k + 2]));
        }
        this.ladders = this.objects.filter(o => o.climbable);
    }

    // highest walkable surface under p that is at most `step` above its feet
    groundAt(p, step) {
        const maxY = p[1] + step;
        let best = { y: -Infinity, support: null };
        const th = this.terrainHeight(p[0], p[2]);
        if (th <= maxY && this.areaAt([p[0], th + 0.1, p[2]]) === 0) best.y = th;     // no terrain inside buildings
        const gw = this.col.ground(p[0], p[2], maxY);
        if (gw > best.y) best = { y: gw, support: null };
        for (const veh of this.vehiclesAt(p)) {
            if (!veh.over(p, 1)) continue;                             // not above or below it
            const l = veh.toLocal(p);
            let gl = veh.col.ground(l[0], l[2], l[1] + step);
            if (veh.docked) gl = Math.max(gl, veh.dockCol.ground(l[0], l[2], l[1] + step));
            if (gl > -Infinity) { const y = veh.toWorld([l[0], gl, l[2]])[1]; if (y > best.y) best = { y, support: veh }; }
        }
        for (const d of this.doors) {                                     // closed hatch covers can be stood on
            if (!d.portal.horizontal || d.open > 0.7) continue;
            const P = d.portal, r = v3.sub(p, P.center), y = P.center[1] + 0.05;
            if (Math.abs(v3.dot(r, P.right)) < P.w / 2 && Math.abs(v3.dot(r, P.up)) < P.h / 2 && y <= maxY && y > best.y) best = { y, support: P.vehicle || null };
        }
        return best;
    }

    // push a player cylinder (radius r, from feet+lo to feet+hi) out of walls, hulls and closed doors
    collide(p, r, lo, hi) {
        this.col.pushOut(p, r, p[1] + lo, p[1] + hi);
        for (const veh of this.vehiclesAt(p)) {
            if (!veh.near(p, r + hi)) continue;                        // nothing of it within reach
            const l = veh.toLocal(p);
            veh.col.pushOut(l, r, l[1] + lo, l[1] + hi);
            if (veh.docked) veh.dockCol.pushOut(l, r, l[1] + lo, l[1] + hi);
            const q = veh.toWorld(l); p[0] = q[0]; p[2] = q[2];
        }
        for (const d of this.doors) {
            if (d.portal.horizontal || d.open > 0.7) continue;
            const P = d.portal, a = P.verts[0], b = P.verts[1];
            if (Math.abs(p[0] - P.center[0]) > P.w + 2 || Math.abs(p[2] - P.center[2]) > P.w + 2) continue;
            pushSeg(p, r, p[1] + lo, p[1] + hi, { x0: a[0], z0: a[2], x1: b[0], z1: b[2], y0: P.center[1] - P.h / 2, y1: P.center[1] + P.h / 2 });
        }
    }

    ladderAt(p, r) {
        for (const o of this.ladders) {
            if (o.dockedOnly && !o.vehicle.docked) continue;
            const q = o.vehicle ? o.vehicle.toLocal(p) : p, m = r + 0.15;
            if (q[0] > o.min[0] - m && q[0] < o.max[0] + m && q[2] > o.min[2] - m && q[2] < o.max[2] + m && q[1] > o.min[1] - 0.3 && q[1] < o.max[1] + 0.2)
                return { o, top: o.vehicle ? o.vehicle.toWorld([q[0], o.max[1], q[2]])[1] : o.max[1] };
        }
        return null;
    }

    // ---- per frame ----
    update(dt, t, actors) {
        this.time = t;
        for (const veh of this.vehicles) veh.update(dt, t);
        this.power.update(dt, t);
        const all = actors.concat(this.drones.map(d => d.pos));
        for (const e of this.dynamic) e.update(dt, t, all);
        for (const list of this.dynamicByArea) list.length = 0;
        for (const e of this.dynamic) for (const o of e.owners) this.dynamicByArea[o].push(e);
        this.water?.update(this.hulls);
    }

    // per-area lighting table: its own lights (static + dynamic ones of the frame; an area without power keeps its
    // emergency beacons only), then those that shine in through its portals (LightTransport, ranked for the view from eye)
    lightingTable(t, eye) {
        const data = new Float32Array(this.areas.length * AREA_FLOATS);
        const on = this.areas.map(() => []);
        for (const e of this.dynamic) if (e.light && e.lightOn) on[e.lightArea].push(e.light);
        this.areas.forEach((a, i) => on[i].push(...(this.power.powered(i) ? a.lights : a.lights.filter(L => L.signal === 'pulse'))));
        const through = this.lightTransport.gather(on, t, eye);
        this.areas.forEach((a, i) => {
            const o = i * AREA_FLOATS, lights = on[i].slice(0, MAX_LIGHTS), into = through[i];
            data.set([a.ambient[0], a.ambient[1], a.ambient[2], 0, a.fog[0], a.fog[1], a.fog[2], a.fog[3], a.sun, lights.length, into.length, 0], o);
            lights.forEach((L, k) => data.set([L.pos[0], L.pos[1], L.pos[2], L.radius, L.color[0], L.color[1], L.color[2], L.intensityAt(t)], o + 12 + k * 8));
            into.forEach((x, k) => LightTransport.write(data, o + 12 + MAX_LIGHTS * 8 + k * THROUGH_FLOATS, x));
        });
        return data;
    }
}

return { World, tiltAxes };
});
