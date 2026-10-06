'use strict';
// Architecture: areas and portals built from the scenario's rooms.

Features.part('portal', (engine, feature) => {
const { Common } = engine;
const { v3 } = Common;
const { g2, MeshBuilder } = feature;

// Architecture generated from the area shapes: inner walls, floors and ceilings per area, the exterior
// shell and roofs (no faces on edges shared with a neighbour, none underground), portal apertures cut out
// of all of them, and frames around the portals.

class Architecture {
    constructor(world) {
        this.world = world;
    }

    build() {
        const w = this.world;
        for (let ai = 1; ai < w.areas.length; ai++) this.buildArea(w.areas[ai]);
        for (const P of w.portals) if (P.frame) this.buildFrame(P);
    }

    // apertures of the vertical portals lying on wall edge e, in (u along the edge, y) coordinates
    wallHoles(e) {
        const holes = [];
        for (const P of this.world.portals) {
            if (P.horizontal) continue;
            const l = Math.hypot(P.normal[0], P.normal[2]);
            if (Math.abs((P.normal[0] * e.n[0] + P.normal[2] * e.n[1]) / l) < 0.99) continue;
            const dist = (P.center[0] - e.a[0]) * e.n[0] + (P.center[2] - e.a[1]) * e.n[1];
            if (Math.abs(dist) > 0.05) continue;
            const poly = P.verts.map(v => [(v[0] - e.a[0]) * e.dir[0] + (v[2] - e.a[1]) * e.dir[1], v[1]]);
            const us = poly.map(p => p[0]);
            if (Math.max(...us) <= 0 || Math.min(...us) >= e.L) continue;
            holes.push(poly);
        }
        return holes;
    }

    // parts of edge e (of area A) that are shared with a neighbouring area: no exterior face there
    wallCover(A, e) {
        const rects = [], areas = this.world.areas;
        for (let i = 1; i < areas.length; i++) {
            const B = areas[i];
            if (B === A) continue;
            for (const f of B.edges) {
                if (f.n[0] * e.n[0] + f.n[1] * e.n[1] > -0.99) continue;
                const da = (f.a[0] - e.a[0]) * e.n[0] + (f.a[1] - e.a[1]) * e.n[1], db = (f.b[0] - e.a[0]) * e.n[0] + (f.b[1] - e.a[1]) * e.n[1];
                if (Math.abs(da) > 0.02 || Math.abs(db) > 0.02) continue;
                const u0 = (f.a[0] - e.a[0]) * e.dir[0] + (f.a[1] - e.a[1]) * e.dir[1], u1 = (f.b[0] - e.a[0]) * e.dir[0] + (f.b[1] - e.a[1]) * e.dir[1];
                const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(e.L, Math.max(u0, u1));
                const ylo = Math.max(A.y, B.y), yhi = Math.min(A.top, B.top);
                if (hi - lo > 1e-3 && yhi - ylo > 1e-3) rects.push([[lo, ylo], [hi, ylo], [hi, yhi], [lo, yhi]]);
            }
        }
        return rects;
    }

    // apertures of the horizontal portals (hatches, skylights) in A's floor or ceiling at height y
    horizontalHoles(A, y) {
        const holes = [];
        for (const P of this.world.portals) {
            if (!P.horizontal || Math.abs(P.center[1] - y) > 0.05) continue;
            if (!g2.inside([P.center[0], P.center[2]], A.shape)) continue;
            holes.push(P.verts.map(v => [v[0], v[2]]));
        }
        return holes;
    }

    buildArea(A) {
        const w = this.world, inner = new MeshBuilder(), shell = new MeshBuilder();
        const mWall = w.mat(A.mats.wall), mExt = w.mat(A.mats.exterior), mFloor = w.mat(A.mats.floor);
        const mCeil = w.mat(A.mats.ceiling), mRoof = w.mat(A.mats.roof);
        const extBottom = Math.max(A.y, A.shellFrom), hasWalls = A.top > extBottom + 0.01, hasRoof = A.top > 0.01;
        for (const e of A.edges) {
            const to3 = p => [e.a[0] + e.dir[0] * p[0], p[1], e.a[1] + e.dir[1] * p[0]];
            const holes = this.wallHoles(e);
            let pieces = [[[0, A.y], [e.L, A.y], [e.L, A.top], [0, A.top]]];
            for (const h of holes) pieces = g2.subtract(pieces, h);
            for (const p of pieces) inner.poly(p.map(to3), [e.n[0], 0, e.n[1]], mWall);
            if (!hasWalls) continue;
            let ext = [[[0, extBottom], [e.L, extBottom], [e.L, A.top], [0, A.top]]];
            for (const r of this.wallCover(A, e)) ext = g2.subtract(ext, r);
            for (const h of holes) ext = g2.subtract(ext, h);
            for (const p of ext) shell.poly(p.map(to3), [-e.n[0], 0, -e.n[1]], mExt);
        }
        const tris = g2.triangulate(A.shape);
        const emitH = (b, pieces, y, n, m) => { for (const p of pieces) b.poly(p.map(q => [q[0], y, q[1]]), n, m); };
        let floor = tris;
        for (const h of this.horizontalHoles(A, A.y)) floor = g2.subtract(floor, h);
        emitH(inner, floor, A.y, [0, 1, 0], mFloor);
        let ceil = tris;
        for (const h of this.horizontalHoles(A, A.top)) ceil = g2.subtract(ceil, h);
        emitH(inner, ceil, A.top, [0, -1, 0], mCeil);
        if (hasRoof) {
            // roof: ceiling footprint minus areas stacked on top of it
            let roof = ceil;
            for (let bi = 1; bi < w.areas.length; bi++) {
                const B = w.areas[bi];
                if (B !== A && Math.abs(B.y - A.top) < 0.01) for (const t of g2.triangulate(B.shape)) roof = g2.subtract(roof, t);
            }
            emitH(shell, roof, A.top + 0.001, [0, 1, 0], mRoof);
        }
        w.addStatic(inner, { name: `area:${A.id}`, owners: [A.index], lightArea: A.index });
        w.addStatic(shell, { name: `shell:${A.id}`, owners: [0], lightArea: 0 });
    }

    buildFrame(P) {
        const w = this.world, m = w.mat('frame'), t = 0.12, depth = 0.3;
        const b = new MeshBuilder(), ax = [P.right, P.up, P.normal], hw = P.w / 2, hh = P.h / 2;
        b.box(v3.madd(P.center, P.right, -(hw + t / 2)), ax, [t / 2, hh, depth / 2], m);
        b.box(v3.madd(P.center, P.right, hw + t / 2), ax, [t / 2, hh, depth / 2], m);
        b.box(v3.madd(P.center, P.up, hh + t / 2), ax, [hw + t, t / 2, depth / 2], m);
        if (P.kind !== 'door' && P.kind !== 'opening') b.box(v3.madd(P.center, P.up, -(hh + t / 2)), ax, [hw + t, t / 2, depth / 2], m);
        w.addStatic(b, { name: `frame:${P.id}`, owners: [...new Set([P.front, P.back])], lightArea: P.front || P.back });
    }
}

return { Architecture };
});
