'use strict';
// Object trees for culling: BVH and quadtree.

Features.part('portal', (engine, feature) => {
const { classify } = feature;

// Object trees. Outdoors and indoors are partitioned differently:
//   QuadTree   big open outdoor area (terrain chunks, scatter, building shells)
//   BVHTree    one small tree per indoor area (its static members)
// Both are queried with a frustum and a plane mask, so nodes fully inside stop testing planes.

function growBounds(n, o) {
    for (let k = 0; k < 3; k++) { n.min[k] = Math.min(n.min[k], o.min[k]); n.max[k] = Math.max(n.max[k], o.max[k]); }
}
function queryNode(n, planes, mask, visit, st) {
    st.nodes++;
    if (mask) { mask = classify(n.min, n.max, planes, mask); if (mask < 0) return; }
    if (n.objs) for (const o of n.objs) { st.objs++; if (!mask || classify(o.min, o.max, planes, mask) >= 0) visit(o); }
    if (n.kids) for (const k of n.kids) queryNode(k, planes, mask, visit, st);
}
const fullMask = planes => planes.length >= 31 ? 0x7fffffff : (1 << planes.length) - 1;

class BVHTree {
    constructor(objs) { this.kind = 'bvh'; this.count = objs.length; this.nodeCount = 0; this.root = objs.length ? this.build(objs.slice()) : null; }
    build(objs) {
        this.nodeCount++;
        const n = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], objs: null, kids: null };
        for (const o of objs) growBounds(n, o);
        if (objs.length <= 3) { n.objs = objs; return n; }
        const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
        for (const o of objs) for (let k = 0; k < 3; k++) { const c = (o.min[k] + o.max[k]) / 2; cmin[k] = Math.min(cmin[k], c); cmax[k] = Math.max(cmax[k], c); }
        let axis = 0;
        for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
        objs.sort((a, b) => (a.min[axis] + a.max[axis]) - (b.min[axis] + b.max[axis]));
        const mid = objs.length >> 1;
        n.kids = [this.build(objs.slice(0, mid)), this.build(objs.slice(mid))];
        return n;
    }
    query(planes, visit, st) { if (this.root) queryNode(this.root, planes, fullMask(planes), visit, st); }
}

class QuadTree {
    constructor(objs, maxDepth = 6, leafCap = 4) {
        this.kind = 'quadtree'; this.count = objs.length; this.maxDepth = maxDepth; this.leafCap = leafCap; this.nodeCount = 0;
        if (!objs.length) { this.root = null; return; }
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const o of objs) { x0 = Math.min(x0, o.min[0]); z0 = Math.min(z0, o.min[2]); x1 = Math.max(x1, o.max[0]); z1 = Math.max(z1, o.max[2]); }
        const s = Math.max(x1 - x0, z1 - z0) + 0.01;
        this.root = this.node(x0, z0, s, 0);
        for (const o of objs) this.insert(this.root, o);
        this.finalize(this.root);
    }
    node(x, z, s, depth) {
        this.nodeCount++;
        return { x, z, s, depth, objs: [], kids: null, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    }
    child(n, o) {
        const h = n.s / 2;
        for (const k of n.kids) if (o.min[0] >= k.x && o.max[0] <= k.x + h && o.min[2] >= k.z && o.max[2] <= k.z + h) return k;
        return null;
    }
    insert(n, o) {
        if (n.depth < this.maxDepth && (n.kids || n.objs.length >= this.leafCap)) {
            if (!n.kids) {
                const h = n.s / 2;
                n.kids = [this.node(n.x, n.z, h, n.depth + 1), this.node(n.x + h, n.z, h, n.depth + 1), this.node(n.x, n.z + h, h, n.depth + 1), this.node(n.x + h, n.z + h, h, n.depth + 1)];
                const old = n.objs; n.objs = [];
                for (const q of old) { const k = this.child(n, q); if (k) this.insert(k, q); else n.objs.push(q); }
            }
            const k = this.child(n, o);
            if (k) { this.insert(k, o); return; }
        }
        n.objs.push(o);                                                   // loose: straddlers stay in the parent
    }
    finalize(n) {
        for (const o of n.objs) growBounds(n, o);
        if (n.kids) {
            n.kids = n.kids.filter(k => this.finalize(k));
            for (const k of n.kids) growBounds(n, k);
            if (!n.kids.length) n.kids = null;
        }
        if (!n.objs.length) n.objs = null;
        return !!(n.objs || n.kids);
    }
    query(planes, visit, st) { if (this.root) queryNode(this.root, planes, fullMask(planes), visit, st); }
}

return { BVHTree, QuadTree };
});
