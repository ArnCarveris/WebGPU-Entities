'use strict';
// Ground frames (a centre and yaw on the terrain) and rectangles less holes: what every structure is laid out with.

Features.part('cloud', (engine, feature) => {

// a frame on the ground: centre [x, z] and yaw; local x runs along (cos, sin) in xz, local z along (-sin, cos)
class GroundFrame {
    constructor(c, yaw) { this.c = c; this.yaw = yaw; this.cs = Math.cos(yaw); this.sn = Math.sin(yaw); }
    static facing(c, z) { return new GroundFrame(c, Math.atan2(-z[0], z[1])); }      // local +z along z
    at(lx, y, lz) { return [this.c[0] + lx * this.cs - lz * this.sn, y, this.c[1] + lx * this.sn + lz * this.cs]; }
    xz(lx, lz) { const p = this.at(lx, 0, lz); return [p[0], p[2]]; }
    turned(a) { return new GroundFrame(this.c, this.yaw + a); }
}

// the rectangle [u0, u1] x [v0, v1] less rectangular holes [a0, a1, b0, b1] (that do not overlap each other; clipped to
// it), as rectangles: in bands between the holes' edges, the stretches between the holes cutting each band
function rectMinusHoles(u0, u1, v0, v1, holes) {
    const hs = holes.map(([a0, a1, b0, b1]) => [Math.max(a0, u0), Math.min(a1, u1), Math.max(b0, v0), Math.min(b1, v1)]).filter(h => h[0] < h[1] && h[2] < h[3]);
    const vs = [...new Set([v0, v1, ...hs.flatMap(h => [h[2], h[3]])])].sort((a, b) => a - b), out = [];
    for (let k = 0; k + 1 < vs.length; k++) {
        const b0 = vs[k], b1 = vs[k + 1];
        if (b1 - b0 < 1e-4) continue;
        let a = u0;
        for (const h of hs.filter(h => h[2] < b1 - 1e-6 && h[3] > b0 + 1e-6).sort((p, q) => p[0] - q[0])) {
            if (h[0] > a + 1e-4) out.push([a, h[0], b0, b1]);
            a = Math.max(a, h[1]);
        }
        if (u1 > a + 1e-4) out.push([a, u1, b0, b1]);
    }
    return out;
}

return { GroundFrame, rectMinusHoles };
});
