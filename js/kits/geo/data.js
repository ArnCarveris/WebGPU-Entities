'use strict';
// A real place's data as tools/geo-import.mjs writes it (scenarios/data/<region>/*.js, loaded by ScenarioData before
// the worlds are built), decoded once per id: the terrain (heights, land cover, place names), the roads, the buildings,
// the tree canopy.
// Coordinates are the scenario's metres about the region's centre: x east, z south.

Features.kit('geo', (engine, kit) => {

// the varint stream of a data file: unsigned, zigzag signed, and point lists (a count, then x, z deltas in decimetres)
class GeoReader {
    constructor(bytes) { this.b = bytes; this.p = 0; }
    uv() { const b = this.b; let r = 0, s = 1, c; do { c = b[this.p++]; r += (c & 127) * s; s *= 128; } while (c & 128); return r; }
    sv() { const v = this.uv(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    // [x0, z0, x1, z1, ...] in metres
    pts() {
        const n = this.uv(), out = new Float32Array(n * 2);
        let x = 0, z = 0;
        for (let k = 0; k < n; k++) { x += this.sv(); z += this.sv(); out[k * 2] = x / 10; out[k * 2 + 1] = z / 10; }
        return out;
    }
}

const decoded = new Map();
const once = (id, fn) => { if (!decoded.has(id)) decoded.set(id, fn(ScenarioData.get(id))); return decoded.get(id); };

// { meta, n, size, heights (n x n, m; row j runs along x at z = cell j), planes [built-up, woods, water] (n x n, 0..255) }
function terrainData(id) {
    return once(id, ({ meta, bytes }) => {
        const n = meta.resolution, heights = new Float32Array(n * n), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let j = 0; j < n; j++) { let v = 0; for (let i = 0; i < n; i++) { v += dv.getInt16((j * n + i) * 2, true); heights[j * n + i] = v / 10; } }
        const planes = [0, 1, 2].map(c => bytes.subarray(n * n * 2 + c * n * n, n * n * 2 + (c + 1) * n * n));
        return { meta, n, size: meta.size, heights, planes };
    });
}

// { meta, roads: [{ kind (highway class), flags, layer, lanes, width (m, 0 unknown), pts }] }
function roadData(id) {
    return once(id, ({ meta, bytes }) => {
        const r = new GeoReader(bytes), count = r.uv(), roads = new Array(count);
        for (let k = 0; k < count; k++) {
            const kind = meta.classes[r.uv()], flags = r.uv(), layer = r.uv() - 8, lanes = r.uv(), width = r.uv() / 10;
            roads[k] = { kind, flags, layer, lanes, width, pts: r.pts() };
        }
        return { meta, roads };
    });
}

// { meta, buildings: [{ kind (building=*), height (m, 0 unknown), levels, minHeight (m), roofLevels, pts (outer ring, open,
// positive shoelace area in x, z) }] }
function buildingData(id) {
    return once(id, ({ meta, bytes }) => {
        const r = new GeoReader(bytes), count = r.uv(), list = new Array(count);
        for (let k = 0; k < count; k++) {
            const kind = meta.kinds[r.uv()], height = r.uv() / 10, levels = r.uv(), minHeight = r.uv() / 10, roofLevels = r.uv();
            list[k] = { kind, height, levels, minHeight, roofLevels, pts: r.pts() };
        }
        return { meta, buildings: list };
    });
}

// { meta, n, size, cover (n x n, 0..255: the share of each cell under canopy), height (n x n, m: the canopy's mean height) }
function canopyData(id) {
    return once(id, ({ meta, bytes }) => {
        const n = meta.resolution;
        return { meta, n, size: meta.size, cover: bytes.subarray(0, n * n), height: bytes.subarray(n * n, 2 * n * n) };
    });
}

return { GeoReader, terrainData, roadData, buildingData, canopyData };
});
