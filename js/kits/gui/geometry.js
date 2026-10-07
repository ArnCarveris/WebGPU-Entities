'use strict';
// Meshes and the Doom 3 GUI-surface mapping.

Features.kit('gui', (engine, kit) => {
const { V3, M4, rad } = kit;

// Mesh building and the Doom 3 GUI-surface mapping.

// Vertex layout: pos3 normal3 uv2 material1. UVs are planar and world-scaled (1 unit = 1 m).
// Material names resolve to ids through the world MaterialTable.
class MeshBuilder {
    constructor(materials) {
        this.materials = materials;
        this.data = [];
    }

    vertex(p, n, uv, m) {
        this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], m);
    }

    box(x0, y0, z0, x1, y1, z1, mat) {
        const m = this.materials.id(mat);
        const faces = [
            [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
            [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
            [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
            [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
            [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
            [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]]
        ];
        for (const [n, c] of faces) {
            const uvOf = (p) => n[0] ? [p[2], p[1]] : n[1] ? [p[0], p[2]] : [p[0], p[1]];
            for (const i of [0, 1, 2, 0, 2, 3]) this.vertex(c[i], n, uvOf(c[i]), m);
        }
        return this;
    }

    cylinder(center, radius, length, axis, mat, segments = 16) {
        const m = this.materials.id(mat);
        const place = (u, v, along) => axis === 'x' ? [along, u, v] : axis === 'y' ? [u, along, v] : [u, v, along];
        const h = length / 2;
        for (let i = 0; i < segments; i++) {
            const ring = [i, i + 1].map((k) => {
                const a = (k / segments) * Math.PI * 2;
                return { n: place(Math.cos(a), Math.sin(a), 0), off: place(Math.cos(a) * radius, Math.sin(a) * radius, 0), u: a * radius };
            });
            const corner = (r, along) => V3.add(V3.add(center, r.off), place(0, 0, along));
            const quad = [[ring[0], -h], [ring[1], -h], [ring[1], h], [ring[0], h]];
            for (const i of [0, 1, 2, 0, 2, 3]) {
                const [r, along] = quad[i];
                this.vertex(corner(r, along), r.n, [r.u, along], m);
            }
        }
        return this;
    }

    // The two triangles of a GUI surface; their texture coordinates define the GUI frame
    surface(tri, mat) {
        const m = this.materials.id(mat);
        const { xyz, st, normal, corner } = tri;
        for (const [p, uv] of [[xyz[0], st[0]], [xyz[1], st[1]], [xyz[2], st[2]], [xyz[0], st[0]], [xyz[2], st[2]], [corner, [0, 1]]]) {
            this.vertex(p, normal, uv, m);
        }
        return this;
    }

    // Data-driven parts: { box: [x0, y0, z0, x1, y1, z1], mat } or
    //                    { cylinder: [cx, cy, cz], r, len, axis, mat, seg? }
    parts(list) {
        for (const part of list) {
            if (part.box) this.box(...part.box, part.mat);
            else if (part.cylinder) this.cylinder(part.cylinder, part.r, part.len, part.axis, part.mat, part.seg);
            else throw new Error(`Unknown model part ${JSON.stringify(part)}`);
        }
        return this;
    }

    toFloat32() {
        return new Float32Array(this.data);
    }
}

// Doom 3 gui surfaces (ports of R_SurfaceToTextureAxis / R_RenderGuiSurf / idRenderWorld::GuiTrace)
const GuiSurface = {
    // A GUI surface triangle in local space. s runs right, t runs down, (0,0) = top-left.
    tri(w, h, z = 0) {
        return {
            xyz: [[-w / 2, h / 2, z], [w / 2, h / 2, z], [w / 2, -h / 2, z]],
            st: [[0, 0], [1, 0], [1, 1]],
            normal: [0, 0, 1],
            corner: [-w / 2, -h / 2, z]
        };
    },

    // The surface's texture-space origin and axes, so that xyz = origin + s * axis[0] + t * axis[1]
    textureAxis(tri) {
        const [a, b, c] = tri.xyz;
        const [sa, sb, sc] = tri.st;
        const d0 = [...V3.sub(b, a), sb[0] - sa[0], sb[1] - sa[1]];
        const d1 = [...V3.sub(c, a), sc[0] - sa[0], sc[1] - sa[1]];
        const inva = 1 / (d0[3] * d1[4] - d0[4] * d1[3]);
        const axis0 = [0, 1, 2].map((i) => (d0[i] * d1[4] - d0[4] * d1[i]) * inva);
        const axis1 = [0, 1, 2].map((i) => (d0[3] * d1[i] - d0[i] * d1[3]) * inva);
        const origin = [0, 1, 2].map((i) => a[i] - sa[0] * axis0[i] - sa[1] * axis1[i]);
        return { origin, axis: [axis0, axis1, tri.normal] };
    },

    // GUI (x, y) in its virtual screen -> surface local space, then through the surface's model matrix
    modelMatrix(tri, surfaceModel, vw, vh) {
        const { origin, axis } = GuiSurface.textureAxis(tri);
        return M4.multiply(surfaceModel, new Float32Array([
            axis[0][0] / vw, axis[0][1] / vw, axis[0][2] / vw, 0,
            axis[1][0] / vh, axis[1][1] / vh, axis[1][2] / vh, 0,
            axis[2][0], axis[2][1], axis[2][2], 0,
            origin[0], origin[1], origin[2], 1
        ]));
    },

    // Ray vs surface -> GUI cursor position and hit distance, or null
    trace(tri, surfaceModel, vw, vh, rayOrigin, rayDir) {
        const { origin, axis } = GuiSurface.textureAxis(tri);
        const o = M4.transformPoint(surfaceModel, origin);
        const a0 = M4.transformVector(surfaceModel, axis[0]);
        const a1 = M4.transformVector(surfaceModel, axis[1]);
        const n = M4.transformVector(surfaceModel, axis[2]);
        const denom = V3.dot(rayDir, n);
        if (denom >= -1e-6) return null; // back-facing
        const t = V3.dot(V3.sub(o, rayOrigin), n) / denom;
        if (t <= 0) return null;
        const hit = V3.sub(V3.add(rayOrigin, V3.scale(rayDir, t)), o);
        const x = V3.dot(hit, a0) / V3.dot(a0, a0);
        const y = V3.dot(hit, a1) / V3.dot(a1, a1);
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: x * vw, y: y * vh, t };
    }
};

return { MeshBuilder, GuiSurface };
});
