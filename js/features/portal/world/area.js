'use strict';
// Areas and their lights.

Features.part('portal', (engine, feature) => {
const { g2 } = feature;

// Areas (FarCry1 VisArea / SECTR Sector) and the point lights that live in them.

// Point light; `signal` modulates the intensity: flicker | pulse
class PointLight {
    constructor(def) {
        this.pos = def.pos;
        this.color = def.color || [1, 1, 1];
        this.intensity = def.intensity ?? 1;
        this.radius = def.radius || 8;
        this.signal = def.signal;
        this.vehicle = null;        // set when the light rides a vehicle (pos is then moved from `local`)
        this.local = null;
    }

    intensityAt(t) {
        let I = this.intensity;
        if (this.signal === 'flicker') I *= (Math.sin(t * 23.0 + this.pos[0]) * Math.sin(t * 7.3 + 1.0 + this.pos[2]) > -0.25) ? 1 : 0.1;
        else if (this.signal === 'pulse') I *= 0.2 + 0.8 * Math.max(0, Math.sin(t * 4.0));
        return I;
    }
}

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
    }

    // the implicit outdoor area: holds every portal with only one area on it (FarCry exit portals)
    static outdoors(def = {}) {
        const a = Object.create(Area.prototype);
        return Object.assign(a, {
            index: 0, id: 'outdoor', name: def.name || 'Outdoors', outdoor: true, portals: [], lights: [], occluders: [], vehicle: null,
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
    contains(p0) {
        const p = this.vehicle ? this.vehicle.toLocal(p0) : p0;
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

return { PointLight, Area };
});
