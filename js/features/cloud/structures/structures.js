'use strict';
// Structures: everything built on the terrain, as triangle meshes (outside, interiors, glass, far panes) standing on the
// terrain as drawn (Heightfield.surface), with its parts: the solids a walker collides with, the shader boxes and drip
// edges (WGSL_SHELTER), the doors, the buildings and the fixtures. Entities build into it (Entity.build).

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { lerp, v3 } = Common;
const { STRUCT_COLORS, Solids, ShelterBoxes, Doors, Buildings, Fixtures, BLD_LIT, BLD_ID } = feature;

class Structures {
    // types: the scenario's `buildings` (archetypes), plans: its floor plans (native `plans`: the building kit's
    // PlanLibrary, from scenarios/plans/)
    constructor(field, types = {}, plans = {}) {
        this.field = field;
        this.v = []; this.iv = []; this.glass = []; this.panes = [];
        this.cur = this.v;           // where tri() puts its triangles: the outside (v), or a building's interior (iv)
        this.solids = new Solids();
        this.boxes = new ShelterBoxes();
        this.interiors = new kits.interior.InteriorIndex(32);   // every building's and bus's interior (kits.interior)
        this.lib = new kits.building.PlanLibrary(plans, types);
        // the planned buildings' rooms as areas and portals (the interior kit's AreaSet: the portal feature's), bucketed
        // by 8 m height bands (a tower's storeys over the same footprint), their storeys made near the eye (stacks); the
        // lift cars areas aboard them (found before the shafts they run in); area 0 the outdoors
        this.areas = new kits.interior.AreaSet({ bandH: 8, vehiclesFirst: true });
        this.areas.areas.push(kits.interior.Area.outdoors());
        this.doors = new Doors(this);
        // the cars in the buildings' cores (the transit kit's Lifts), their parts as interiors' materials (a car's lit by
        // its lamp); the emergency ladders up their shafts (the building kit's)
        this.lifts = new kits.transit.Lifts({ material: (b, mat, lit) => mat + (lit ? BLD_LIT : 0) + b.id * BLD_ID });
        this.ladders = new kits.building.Ladders();
        this.buildings = new Buildings(this);
        this.fixtures = new Fixtures(this);
    }

    ground(x, z) { return this.field.surface(x, z); }

    // every entity built: the areas indexed (areaAt: the stairwells and shafts; the storeys' are made near the eye),
    // the lift cars in a grid by their shafts (they move only up and down), the static portals out to the outdoors in
    // a BVH
    finish() {
        const A = this.areas;
        A.indexAreas();
        A.vehicleGrid = new kits.interior.GridHash(16);
        for (const c of A.vehicles || []) {
            const [x0, x1, z0, z1] = c.out, cs = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => c.f.xz(x, z));
            A.vehicleGrid.insert(c, Math.min(...cs.map(q => q[0])), Math.min(...cs.map(q => q[1])), Math.max(...cs.map(q => q[0])), Math.max(...cs.map(q => q[1])));
        }
        A.indexOutdoorPortals(kits.interior.BVHTree);
    }

    tri(a, b, c, col, mat = 0) {
        const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));          // facing either way: the shader turns it to the eye
        for (const p of [a, b, c]) this.cur.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], mat);
    }
    quad(a, b, c, d, col, mat = 0) { this.tri(a, b, c, col, mat); this.tri(a, c, d, col, mat); }

    // box in frame f around local (ox, oz): half sizes hx, hz, from y0 up to y1 (prism: the mesh only, nothing to walk on)
    prism(f, ox, oz, hx, hz, y0, y1, col, mat = 0) {
        const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]], p = ([sx, sz], y) => f.at(ox + sx * hx, y, oz + sz * hz);
        for (let k = 0; k < 4; k++) this.quad(p(c[k], y0), p(c[(k + 1) % 4], y0), p(c[(k + 1) % 4], y1), p(c[k], y1), col, mat);
        this.quad(...c.map(q => p(q, y1)), col, mat);
        this.quad(...c.map(q => p(q, y0)), col, mat);
    }
    box(f, ox, oz, hx, hz, y0, y1, col, mat = 0) {
        this.prism(f, ox, oz, hx, hz, y0, y1, col, mat);
        return this.solids.add(f, ox, oz, hx, hz, y0, y1);
    }

    // a rectangular section swept along a path: at point k ([x, z]) it spans offsets o0..o1 along `side` (a horizontal
    // unit vector) and heights lo[k]..hi[k]
    sweep(pts, side, o0, o1, lo, hi, col, mat = 0) {
        const ring = k => [[o0, lo[k]], [o1, lo[k]], [o1, hi[k]], [o0, hi[k]]].map(([o, y]) => [pts[k][0] + side[0] * o, y, pts[k][1] + side[1] * o]);
        for (let k = 0; k + 1 < pts.length; k++) {
            const a = ring(k), b = ring(k + 1);
            for (let e = 0; e < 4; e++) this.quad(a[e], a[(e + 1) % 4], b[(e + 1) % 4], b[e], col, mat);
        }
        this.quad(...ring(0), col, mat);
        this.quad(...ring(pts.length - 1), col, mat);
    }

    // a quad with its normal given (the glass: outward, which fsWindow needs)
    quadN(a, b, c, d, n, col, mat) {
        for (const p of [a, b, c, a, c, d]) this.cur.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], mat);
    }

    // a road along a curve (points [x, z]; neighbouring pieces share their edges), half width hw, lifted above the terrain
    ribbon(pts, hw, col, mat = 3, lift = 0.14) {
        const n = pts.length, side = pts.map((p, k) => {
            const a = pts[Math.max(k - 1, 0)], b = pts[Math.min(k + 1, n - 1)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
            return [-dz / l, dx / l];
        });
        const edge = (k, o) => { const x = pts[k][0] + side[k][0] * o, z = pts[k][1] + side[k][1] * o; return [x, this.ground(x, z) + lift, z]; };
        for (let k = 0; k + 1 < n; k++) this.quad(edge(k, -hw), edge(k, hw), edge(k + 1, hw), edge(k + 1, -hw), col, mat);
    }

    // a strip on the ground from a to b ([x, z]), half width hw, lifted a little above the terrain
    strip(a, b, hw, col, mat = 0, lift = 0.12) {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], side = [-u[1], u[0]];
        const n = Math.max(1, Math.ceil(L / 6)), edge = (t, o) => {
            const x = a[0] + u[0] * L * t + side[0] * o, z = a[1] + u[1] * L * t + side[1] * o;
            return [x, this.ground(x, z) + lift, z];
        };
        for (let k = 0; k < n; k++) this.quad(edge(k / n, -hw), edge(k / n, hw), edge((k + 1) / n, hw), edge((k + 1) / n, -hw), col, mat);
    }

    // a water surface along a centre line (points [x, z, half width across `side`]), level with its banks
    water(line, side) {
        const row = c => {
            const hw = c[2];
            const e0 = [c[0] - side[0] * hw, c[1] - side[1] * hw], e1 = [c[0] + side[0] * hw, c[1] + side[1] * hw];
            const y = Math.max(this.ground(...e0), this.ground(...e1), this.ground(...c)) + 0.1;
            return [[e0[0], y, e0[1]], [e1[0], y, e1[1]]];
        };
        for (let k = 0; k + 1 < line.length; k++) {
            const a = row(line[k]), b = row(line[k + 1]);
            this.quad(a[0], a[1], b[1], b[0], [0, 0, 0], 6);
        }
    }

    // a road: asphalt with a dashed centre line
    road(a, b, hw) {
        this.strip(a, b, hw, STRUCT_COLORS.asphalt, 3);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 3; s + 3 < L; s += 9) {
            const t0 = s / L, t1 = (s + 3) / L, p = t => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
            this.strip(p(t0), p(t1), 0.08, STRUCT_COLORS.paint, 0, 0.14);
        }
    }
}

return { Structures };
});
