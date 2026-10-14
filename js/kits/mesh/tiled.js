'use strict';
// TiledMesh: big static geometry (a real place's roads and buildings: the geo kit) as compact indexed triangles, kept
// in square tiles so a renderer draws only the tiles in view.

Features.kit('mesh', (engine, kit) => {

// a typed array that grows as it is filled
class Grow {
    constructor(Type, cap = 1024) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
    reserve(k) {
        if (this.n + k <= this.a.length) return;
        const b = new this.Type(Math.max(this.a.length * 2, this.n + k));
        b.set(this.a.subarray(0, this.n));
        this.a = b;
    }
}

const enc = c => Math.round(Math.sqrt(Math.min(Math.max(c, 0), 1)) * 255);

// A vertex is its position (3 floats) and a colour word: r, g, b the square root of the linear colour (more steps in
// the darks), a the material (the KINDS index the world shades it as). Normals are the renderer's to derive (flat, per
// triangle): what is drawn this way is flat-faced. Tiles are `tile` m squares on x, z; a primitive goes into the tile
// its caller picks (at(x, z): where it starts), and its bounds grow to cover it.
class TiledMesh {
    static FLOATS = 4;

    constructor({ tile = 2048 } = {}) {
        this.tile = tile;
        this.tiles = new Map();
        this.built = null;
    }

    // a colour word: rgb linear 0..1, material
    static color(rgb, mat = 0) { return (enc(rgb[0]) | enc(rgb[1]) << 8 | enc(rgb[2]) << 16 | (mat & 255) << 24) >>> 0; }

    // the tile holding x, z
    at(x, z) {
        const i = Math.floor(x / this.tile), j = Math.floor(z / this.tile), key = i * 100003 + j;
        let t = this.tiles.get(key);
        if (!t) this.tiles.set(key, t = { pos: new Grow(Float32Array, 3072), col: new Grow(Uint32Array, 1024), idx: new Grow(Uint32Array, 3072),
            box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] });
        return t;
    }

    // a vertex of tile t: its index there
    vertex(t, x, y, z, color) {
        t.pos.reserve(3); t.col.reserve(1);
        const p = t.pos.a, k = t.pos.n, b = t.box;
        p[k] = x; p[k + 1] = y; p[k + 2] = z;
        t.pos.n += 3;
        t.col.a[t.col.n] = color;
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
        return t.col.n++;
    }

    tri(t, a, b, c) {
        t.idx.reserve(3);
        const q = t.idx.a, k = t.idx.n;
        q[k] = a; q[k + 1] = b; q[k + 2] = c;
        t.idx.n += 3;
    }

    // a quad of four corners [x, y, z] in order round it, one colour
    quad(t, a, b, c, d, color) {
        const i = this.vertex(t, ...a, color), j = this.vertex(t, ...b, color), k = this.vertex(t, ...c, color), l = this.vertex(t, ...d, color);
        this.tri(t, i, j, k);
        this.tri(t, i, k, l);
    }

    get empty() { return !this.built && !this.tiles.size; }

    // everything in one vertex array (FLOATS per vertex; the colour word in the 4th, as its bits) and one index array,
    // each tile's indices contiguous: { vertices, indices, tiles: [{ first, count, box [x0, y0, z0, x1, y1, z1] }] }.
    // Once: after it the mesh takes nothing more
    finish() {
        if (this.built) return this.built;
        let nv = 0, ni = 0;
        for (const t of this.tiles.values()) { nv += t.col.n; ni += t.idx.n; }
        const vertices = new Float32Array(nv * 4), bits = new Uint32Array(vertices.buffer), indices = new Uint32Array(ni), tiles = [];
        let v0 = 0, i0 = 0;
        for (const t of this.tiles.values()) {
            if (!t.idx.n) continue;
            for (let k = 0; k < t.col.n; k++) {
                vertices[(v0 + k) * 4] = t.pos.a[k * 3]; vertices[(v0 + k) * 4 + 1] = t.pos.a[k * 3 + 1]; vertices[(v0 + k) * 4 + 2] = t.pos.a[k * 3 + 2];
                bits[(v0 + k) * 4 + 3] = t.col.a[k];
            }
            for (let k = 0; k < t.idx.n; k++) indices[i0 + k] = t.idx.a[k] + v0;
            tiles.push({ first: i0, count: t.idx.n, box: t.box });
            v0 += t.col.n; i0 += t.idx.n;
        }
        this.tiles = null;
        return (this.built = { vertices, indices, tiles });
    }
}

return { TiledMesh };
});
