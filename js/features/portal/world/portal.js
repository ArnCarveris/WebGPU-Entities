'use strict';
// Portals and occluders.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { DEFAULT_GLASS, m4 } = feature;

// Portals (SECTR_Portal hull + FarCry portal flags) and occluders (SECTR_Occluder).

// Rectangle (center, size, normal) as a planar convex hull. Front / back areas are found by probing
// both sides of the plane; a side with no area is the outdoors.
class Portal {
    constructor(def, index, world) {
        const n = v3.norm(def.normal), c = def.center, horizontal = Math.abs(n[1]) > 0.9;
        const right = horizontal ? [1, 0, 0] : v3.norm(v3.cross([0, 1, 0], n));
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

    // the portal rides a vehicle: remember its docked (local) pose
    attach(vehicle) {
        this.vehicle = vehicle;
        this.local = { verts: this.verts.map(v => v.slice()), center: this.center.slice(), normal: this.normal.slice(), right: this.right.slice(), up: this.up.slice() };
    }

    // move to the vehicle pose M
    place(M) {
        const l = this.local;
        this.verts = l.verts.map(v => m4.point(M, v));
        this.center = m4.point(M, l.center);
        this.normal = v3.norm(m4.dir(M, l.normal));
        this.right = v3.norm(m4.dir(M, l.right));
        this.up = v3.norm(m4.dir(M, l.up));
        this.d = -v3.dot(this.normal, this.center);
        this.updateBounds();
    }
}

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

return { Portal, Occluder };
});
