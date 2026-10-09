'use strict';
// Areas (FarCry1 VisArea / SECTR Sector), portals and occluders: what a world's PortalVis traversal runs over (the
// portal feature's bunker, a city's buildings).

Features.kit('interior', (engine, kit) => {
const { v3 } = engine.Common;
const { g2 } = engine.kits.mesh;
const DEFAULT_GLASS = [0.55, 0.7, 0.75, 0.12];      // a portal's glass ([r, g, b, opacity]) when it says only `glass: true`

// Extruded 2D shape (x, z) from y to y + height, with its own ambient, sun amount and fog.
// Area 0 is the implicit outdoors (see Area.outdoors).
class Area {
    constructor(def, index) {
        const shape = def.shape.map(p => [p[0], p[1]]), y = def.y || 0;
        this.index = index;
        this.id = def.id;
        this.name = def.name || def.id;
        this.outdoor = false;
        this.shape = shape;
        this.y = y;
        this.height = def.height;
        this.top = y + def.height;
        this.bbox = g2.bounds(shape);
        this.edges = Area.edges(shape);
        const cen = shape.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map(v => v / shape.length);
        this.ambient = def.ambient || [0.02, 0.02, 0.02];
        this.sun = def.sun || 0;
        this.fog = def.fog || [0, 0, 0, 0];
        this.hub = def.hub || [cen[0], y + 1.6, cen[1]];
        this.shellFrom = def.shellFrom ?? -0.05;          // exterior faces only above this height (ground / ship deck)
        this.terrain = def.terrain !== false;              // flatten the terrain around it (off for ships)
        this.nav = def.nav !== false;                      // reachable by navigating actors
        this.mats = Object.assign({ floor: 'tiles', wall: 'plaster', ceiling: 'panel', exterior: 'concrete', roof: 'roof' }, def.materials);
        this.portals = [];
        this.lights = [];
        this.occluders = [];
        this.vehicle = null;
        this.shelter = def.shelter !== false;              // a weather shelter (kits.interior): no rain or snow inside
    }

    // its Origin: the vehicle's pose for an area aboard one, else the world's
    get origin() { return this.vehicle ? this.vehicle.origin : null; }

    // the implicit outdoor area: holds every portal with only one area on it (FarCry exit portals)
    static outdoors(def = {}) {
        const a = Object.create(Area.prototype);
        return Object.assign(a, {
            index: 0, id: 'outdoor', name: def.name || 'Outdoors', outdoor: true, portals: [], lights: [], occluders: [], vehicle: null, shelter: false,
            ambient: def.ambient || [0.3, 0.3, 0.35], sun: def.sun ?? 1, fog: def.fog || [0.6, 0.7, 0.8, 0.006], hub: def.hub || [0, 1.8, -8],
        });
    }

    // wall edges with their inward normals
    static edges(shape) {
        return shape.map((p, i) => {
            const q = shape[(i + 1) % shape.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const dir = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
            const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
            let n = [-dir[1], dir[0]];
            if (!g2.inside([mid[0] + n[0] * 0.01, mid[1] + n[1] * 0.01], shape)) n = [-n[0], -n[1]];
            return { a: p, b: q, dir, L, n };
        });
    }

    // point (world space) inside the extruded shape; vehicle areas test in vehicle space
    contains(p0) { return this.containsLocal(this.vehicle ? this.vehicle.toLocal(p0) : p0); }

    // p already in its frame (the vehicle's for an area aboard one)
    containsLocal(p) {
        if (p[1] < this.y || p[1] >= this.top) return false;
        if (p[0] < this.bbox[0] || p[0] > this.bbox[2] || p[2] < this.bbox[1] || p[2] > this.bbox[3]) return false;
        return g2.inside([p[0], p[2]], this.shape);
    }

    // 2D footprint in world space (vehicle areas move)
    shape2D() {
        const v = this.vehicle;
        return v ? this.shape.map(q => { const r = v.toWorld([q[0], this.y, q[1]]); return [r[0], r[2]]; }) : this.shape;
    }
}

// Portals (SECTR_Portal hull + FarCry portal flags) and occluders (SECTR_Occluder).

// Rectangle (center, size, normal) as a planar convex hull. Front / back areas are found by probing
// both sides of the plane; a side with no area is the outdoors.
class Portal {
    constructor(def, index, world) {
        const n = v3.norm(def.normal), c = def.center, horizontal = Math.abs(n[1]) > 0.9;
        const right = def.right ? v3.norm(def.right) : horizontal ? [1, 0, 0] : v3.norm(v3.cross([0, 1, 0], n));      // (def.right: a turned hatch's)
        const up = horizontal ? v3.norm(v3.cross(n, right)) : [0, 1, 0];
        const [w, h] = def.size, hw = w / 2, hh = h / 2;
        const corner = (sx, sy) => v3.madd(v3.madd(c, right, sx * hw), up, sy * hh);
        this.index = index;
        this.id = def.id;
        this.kind = def.kind || 'opening';                 // door | opening | window | hatch
        this.center = c;
        this.normal = n;
        this.d = -v3.dot(n, c);
        this.right = right;
        this.up = up;
        this.w = w;
        this.h = h;
        this.horizontal = horizontal;
        this.verts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        this.skyOnly = !!def.skyOnly;
        this.passThrough = !!def.passThrough;
        this.doubleSide = !!def.doubleSide;
        this.frame = def.frame !== false;
        this.closed = !!def.closed;
        this.locked = !!def.locked;
        this.autoDoor = false;
        this.glass = def.glass ? (Array.isArray(def.glass) ? def.glass : DEFAULT_GLASS) : null;
        this.vehicle = null;
        // FarCry derives connections from overlap; probe both sides of the plane
        this.front = def.front !== undefined ? world.areaIndex(def.front) : world.areaAt(v3.madd(c, n, -0.25));
        this.back = def.back !== undefined ? world.areaIndex(def.back) : world.areaAt(v3.madd(c, n, 0.25));
        this.updateBounds();
    }

    updateBounds() {
        this.min = [0, 1, 2].map(k => Math.min(...this.verts.map(v => v[k])));
        this.max = [0, 1, 2].map(k => Math.max(...this.verts.map(v => v[k])));
    }

    // is p (projected onto the plane) inside the aperture?
    containsProjected(p) {
        const r = v3.sub(p, this.center);
        return Math.abs(v3.dot(r, this.right)) <= this.w / 2 + 0.1 && Math.abs(v3.dot(r, this.up)) <= this.h / 2 + 0.1;
    }

    // nav point used by actors crossing the portal
    navPoint() {
        if (this.horizontal) return this.center.slice();
        const bottom = this.center[1] - this.h / 2;
        return [this.center[0], Math.min(bottom + 1.5, this.center[1] + this.h / 2 - 0.4), this.center[2]];
    }

    // stop flags for navigation: closed (unless automatic), locked, windows, sky-only
    get navigable() { return !this.locked && (!this.closed || this.autoDoor) && this.kind !== 'window' && !this.skyOnly; }

    // the portal rides a vehicle: it keeps its docked (local) pose, and its world pose (verts, center, normal, right, up,
    // d, min, max) is worked out through the vehicle's Origin when read after the vehicle moved, so moving the vehicle
    // costs nothing per portal
    attach(vehicle) {
        this.vehicle = vehicle;
        this.local = { verts: this.verts.map(v => v.slice()), center: this.center.slice(), normal: this.normal.slice(), right: this.right.slice(), up: this.up.slice() };
        this.posed = null;
        this.poseStamp = -1;
        for (const k of Portal.POSED) { delete this[k]; Object.defineProperty(this, k, { get: () => this.pose()[k], configurable: true }); }
    }

    // its world pose for the vehicle's current one
    pose() {
        const veh = this.vehicle;
        if (this.poseStamp === veh.poseStamp) return this.posed;
        const O = veh.origin, l = this.local, center = O.toWorld(l.center), normal = v3.norm(O.toWorld(l.normal, 0)), verts = l.verts.map(v => O.toWorld(v));
        const p = { verts, center, normal, right: v3.norm(O.toWorld(l.right, 0)), up: v3.norm(O.toWorld(l.up, 0)), d: -v3.dot(normal, center),
            min: [0, 1, 2].map(k => Math.min(...verts.map(v => v[k]))), max: [0, 1, 2].map(k => Math.max(...verts.map(v => v[k]))) };
        this.posed = p;
        this.poseStamp = veh.poseStamp;
        return p;
    }
}
Portal.POSED = ['verts', 'center', 'normal', 'right', 'up', 'd', 'min', 'max'];

// Planar convex hull that hides what is fully behind it; autoOrient "y" turns it toward the camera
class Occluder {
    constructor(def, index, world) {
        this.index = index;
        this.id = def.id;
        this.center = def.center;
        this.size = def.size;
        this.normal = v3.norm(def.normal || [0, 0, 1]);
        this.autoOrient = def.autoOrient || 'none';
        this.area = def.area !== undefined ? world.areaIndex(def.area) : world.areaAt(def.center);
        const r = Math.hypot(def.size[0], def.size[1]) / 2;
        this.min = v3.sub(def.center, [r, r, r]);
        this.max = v3.add(def.center, [r, r, r]);
    }

    verts(eye) {
        let n = this.normal;
        if (this.autoOrient === 'y') { const t = v3.sub(eye, this.center); t[1] = 0; if (v3.len(t) > 1e-3) n = v3.norm(t); }
        const horizontal = Math.abs(n[1]) > 0.9;
        const right = horizontal ? [1, 0, 0] : v3.norm(v3.cross([0, 1, 0], n)), up = horizontal ? v3.norm(v3.cross(n, right)) : [0, 1, 0];
        const hw = this.size[0] / 2, hh = this.size[1] / 2, c = this.center;
        return { n, verts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => v3.madd(v3.madd(c, right, sx * hw), up, sy * hh)) };
    }
}

return { Area, Portal, Occluder, DEFAULT_GLASS };
});
