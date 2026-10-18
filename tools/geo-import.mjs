// Imports a real place (tools/geo-regions.json) as scenario data: its heights, land cover, roads, buildings and place
// names, in the scenario's own metres (x east, z south, y up; 1 m = 1 m) about the region's centre.
//
//   node tools/geo-import.mjs <region> [--pbf <file.osm.pbf>] [--cache <dir>]
//
// Writes scenarios/data/<region>/{terrain,roads,buildings,canopy}.js: classic scripts (the page opened from disk can run them,
// not fetch them) each calling ScenarioData.put(id, meta, base64), the payload deflated (js/engine/scenario-data.js
// inflates it before the worlds are built). The geo kit (js/kits/geo/) reads them: the `geoTerrain`, `geoRoads` and
// `geoBuildings` entities, and `geoCanopy` (where the region has a `canopy`).
//
// Sources, downloaded once into the cache (default: <tmp>/webgpu-entities-geo):
//   heights   AWS Terrain Tiles (Terrarium PNGs, public): land and bathymetry, area-averaged into the grid's cells
//   the rest  an OpenStreetMap extract (.osm.pbf, the region's `pbf`): roads (highway=*), building footprints
//             (ways and multipolygons), land cover (landuse / natural / water polygons), place names and peaks
//   canopy    Meta / WRI Global Canopy Height Map v2 (CC BY 4.0; region's `canopy`): GeoTIFF tiles, read at an overview
// OpenStreetMap data is (c) OpenStreetMap contributors, ODbL; the canopy credits Meta, WRI and the imagery; each file's
// meta says so.
//
// No dependencies: the PBF, PNG and (tiled, Deflate) TIFF readers are here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { inflateSync, deflateRawSync } from 'zlib';
import { tmpdir } from 'os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf(name); return k >= 0 ? argv[k + 1] : def; };
const regionId = argv[0];
const regions = JSON.parse(readFileSync(join(root, 'tools/geo-regions.json'), 'utf8'));
const R = regions[regionId];
if (!R || regionId.startsWith('$')) {
    console.error(`usage: node tools/geo-import.mjs <region> [--pbf file] [--cache dir]\nregions: ${Object.keys(regions).filter(k => !k.startsWith('$')).join(', ')}`);
    process.exit(1);
}
const cache = opt('--cache', join(tmpdir(), 'webgpu-entities-geo'));
mkdirSync(cache, { recursive: true });
const UA = { 'User-Agent': 'WebGPU-Entities geo-import (https://github.com/ArnCarveris/WebGPU-Entities)' };

// ------------------------------------------------------------------------------------------------ projection
// A local projection about the centre: x east, z south (m). Metres per degree at each latitude (WGS84), so lengths and
// areas are true to well under 0.1 % over an island.
const DEG = Math.PI / 180;
const [LAT0, LON0] = R.center;
const mLat = p => 111132.92 - 559.82 * Math.cos(2 * p * DEG) + 1.175 * Math.cos(4 * p * DEG) - 0.0023 * Math.cos(6 * p * DEG);
const mLon = p => 111412.84 * Math.cos(p * DEG) - 93.5 * Math.cos(3 * p * DEG) + 0.118 * Math.cos(5 * p * DEG);
const toLocal = (lat, lon) => [(lon - LON0) * mLon(lat), -(lat - LAT0) * mLat((lat + LAT0) / 2)];
function toGeo(x, z) {
    let lat = LAT0 - z / mLat(LAT0);
    for (let k = 0; k < 3; k++) lat = LAT0 - z / mLat((lat + LAT0) / 2);
    return [lat, LON0 + x / mLon(lat)];
}

const N = R.resolution, SIZE = R.size, CELL = SIZE / N, ORIGIN = -SIZE / 2, HALF = SIZE / 2;
const cx = i => ORIGIN + (i + 0.5) * CELL;
const corners = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]].map(([x, z]) => toGeo(x, z));
const BBOX = {      // lat / lon bounds of the square, padded a little
    s: Math.min(...corners.map(c => c[0])) - 0.01, n: Math.max(...corners.map(c => c[0])) + 0.01,
    w: Math.min(...corners.map(c => c[1])) - 0.01, e: Math.max(...corners.map(c => c[1])) + 0.01,
};
console.log(`${R.name}: ${SIZE} m square, ${N}^2 cells of ${CELL.toFixed(2)} m, lat ${BBOX.s.toFixed(3)}..${BBOX.n.toFixed(3)} lon ${BBOX.w.toFixed(3)}..${BBOX.e.toFixed(3)}`);

// ------------------------------------------------------------------------------------------------ downloads
async function download(url, file) {
    if (existsSync(file)) return readFileSync(file);
    const res = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
    return buf;
}

// ------------------------------------------------------------------------------------------------ PNG (8-bit RGB / RGBA)
function decodePng(buf) {
    let pos = 8, w = 0, h = 0, type = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos), name = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
        if (name === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9];
            if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12]) throw new Error('PNG: only 8-bit RGB(A), not interlaced');
        } else if (name === 'IDAT') idat.push(data);
        else if (name === 'IEND') break;
        pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat)), bpp = type === 6 ? 4 : 3, stride = w * bpp, out = new Uint8Array(w * h * 3);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            let p = row[i];
            if (f === 1) p += a;
            else if (f === 2) p += b;
            else if (f === 3) p += (a + b) >> 1;
            else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            cur[i] = p & 255;
        }
        for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
        [prev, cur] = [cur, prev];
    }
    return { w, h, rgb: out };
}

// ------------------------------------------------------------------------------------------------ heights
async function heights() {
    const z = R.zoom, n2 = 2 ** z;
    const tx = lon => (lon + 180) / 360 * n2;
    const ty = lat => (1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2 * n2;
    const x0 = Math.floor(tx(BBOX.w)), x1 = Math.floor(tx(BBOX.e)), y0 = Math.floor(ty(BBOX.n)), y1 = Math.floor(ty(BBOX.s));
    const dir = join(cache, `terrarium-${z}`);
    mkdirSync(dir, { recursive: true });
    const tiles = new Map(), jobs = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);
    console.log(`heights: ${jobs.length} Terrarium tiles at zoom ${z}`);
    for (let k = 0; k < jobs.length; k += 8) {
        await Promise.all(jobs.slice(k, k + 8).map(async ([x, y]) => {
            const buf = await download(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, join(dir, `${x}-${y}.png`));
            const png = decodePng(buf), h = new Float32Array(256 * 256);
            for (let i = 0; i < h.length; i++) h[i] = png.rgb[i * 3] * 256 + png.rgb[i * 3 + 1] + png.rgb[i * 3 + 2] / 256 - 32768;
            tiles.set(`${x},${y}`, h);
        }));
    }
    // the mosaic's height at global pixel (gx, gy), bilinear
    const px = (gx, gy) => {
        const t = tiles.get(`${Math.floor(gx / 256)},${Math.floor(gy / 256)}`);
        return t ? t[(gy & 255) * 256 + (gx & 255)] : -100;
    };
    const at = (lat, lon) => {
        const gx = tx(lon) * 256 - 0.5, gy = ty(lat) * 256 - 0.5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
        return (px(ix, iy) * (1 - fx) + px(ix + 1, iy) * fx) * (1 - fy) + (px(ix, iy + 1) * (1 - fx) + px(ix + 1, iy + 1) * fx) * fy;
    };
    // each cell: the mean of 3 x 3 samples over it (the tiles' pixels are about half a cell)
    const h = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let s = 0;
        for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) s += at(...toGeo(cx(i) + (a - 1) * CELL / 3, cx(j) + (b - 1) * CELL / 3));
        h[j * N + i] = s / 9;
    }
    return h;
}

// ------------------------------------------------------------------------------------------------ canopy
// Tree canopy height (the region's `canopy`: Meta and WRI's global canopy height map v2, CC BY 4.0): cloud-optimised
// GeoTIFFs of 1.2 m pixels (Web Mercator, uint8 metres, Deflate, 512^2 tiles, one per zoom-10 quadkey, with overviews).
// Read at the overview nearest `pixel` m, each cell of an M^2 grid over the square gets the share of it under canopy
// (pixels of 2 m and taller) and the canopy's mean height there.
const CANOPY_URL = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm';
const CANOPY_ATTR = 'Canopy height: Meta and World Resources Institute (WRI), Global Canopy Height Map v2, CC BY 4.0; imagery (c) 2016 Vantor.';
const MERC = 6378137;

// a classic little-endian TIFF's image file directories: size, tiles (offsets, byte counts), compression, and the first
// one's georeference (pixel scale, tie point), which the overviews share at their own scale
function tiffIfds(buf) {
    if (buf.toString('latin1', 0, 2) !== 'II' || buf.readUInt16LE(2) !== 42) throw new Error('canopy: not a little-endian classic TIFF');
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 }, out = [];
    for (let ifd = buf.readUInt32LE(4); ifd; ) {
        const n = buf.readUInt16LE(ifd), t = {};
        for (let k = 0; k < n; k++) {
            const e = ifd + 2 + k * 12, tag = buf.readUInt16LE(e), type = buf.readUInt16LE(e + 2), cnt = buf.readUInt32LE(e + 4);
            const sz = SIZE[type] || 1, at = cnt * sz <= 4 ? e + 8 : buf.readUInt32LE(e + 8);
            const v = i => type === 3 ? buf.readUInt16LE(at + i * 2) : type === 4 ? buf.readUInt32LE(at + i * 4) : type === 12 ? buf.readDoubleLE(at + i * 8) : buf[at + i];
            t[tag] = cnt === 1 ? v(0) : Array.from({ length: cnt }, (_, i) => v(i));
        }
        const arr = x => [].concat(x ?? []);
        out.push({ w: t[256], h: t[257], tw: t[322], th: t[323], comp: t[259], bits: t[258], offs: arr(t[324]), counts: arr(t[325]), scale: t[33550], tie: t[33922] });
        ifd = buf.readUInt32LE(ifd + 2 + n * 12);
    }
    return out;
}

async function canopy() {
    const C = R.canopy, M = C.resolution || N * 2, MC = SIZE / M, z = 10, n2 = 2 ** z;
    const tx = lon => (lon + 180) / 360 * n2;
    const ty = lat => (1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2 * n2;
    const quad = (x, y) => { let q = ''; for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); } return q; };
    const dir = join(cache, 'canopy-v2');
    mkdirSync(dir, { recursive: true });
    const cnt = new Uint16Array(M * M), cov = new Uint16Array(M * M), sum = new Float32Array(M * M);
    let files = 0, tilesRead = 0;
    for (let y = Math.floor(ty(BBOX.n)); y <= Math.floor(ty(BBOX.s)); y++) for (let x = Math.floor(tx(BBOX.w)); x <= Math.floor(tx(BBOX.e)); x++) {
        const q = quad(x, y);
        let buf;
        try { buf = await download(`${CANOPY_URL}/${q}.tif`, join(dir, `${q}.tif`)); } catch (e) { console.log(`canopy: ${q} none (${e.message})`); continue; }
        const ifds = tiffIfds(buf), top = ifds[0];
        // the overview nearest the wanted pixel size (on the ground, Mercator's scale at this latitude)
        const ground = s => s * Math.cos(LAT0 * DEG);
        const L = ifds.reduce((b, d) => Math.abs(ground(top.scale[0] * top.w / d.w) - (C.pixel || 4)) < Math.abs(ground(top.scale[0] * top.w / b.w) - (C.pixel || 4)) ? d : b);
        if (L.comp !== 8 || L.bits !== 8) throw new Error(`canopy: ${q}: compression ${L.comp}, ${L.bits} bits (want Deflate, 8)`);
        const sx = top.scale[0] * top.w / L.w, sy = top.scale[1] * top.h / L.h, X0 = top.tie[3], Y0 = top.tie[4];
        const across = Math.ceil(L.w / L.tw);
        files++;
        for (let t = 0; t < L.offs.length; t++) {
            if (!L.counts[t]) continue;
            const c0 = (t % across) * L.tw, r0 = Math.floor(t / across) * L.th;
            // the tile's lat / lon box against the square's
            const lonA = (X0 + c0 * sx) / MERC / DEG, lonB = (X0 + (c0 + L.tw) * sx) / MERC / DEG;
            const latOf = Y => (2 * Math.atan(Math.exp(Y / MERC)) - Math.PI / 2) / DEG;
            const latA = latOf(Y0 - r0 * sy), latB = latOf(Y0 - (r0 + L.th) * sy);
            if (lonB < BBOX.w || lonA > BBOX.e || latA < BBOX.s || latB > BBOX.n) continue;
            const px = inflateSync(buf.subarray(L.offs[t], L.offs[t] + L.counts[t]));
            tilesRead++;
            for (let r = 0; r < L.th && r0 + r < L.h; r++) {
                const lat = latOf(Y0 - (r0 + r + 0.5) * sy), zz = -(lat - LAT0) * mLat((lat + LAT0) / 2), j = Math.floor((zz - ORIGIN) / MC);
                if (j < 0 || j >= M) continue;
                const ml = mLon(lat);
                for (let c = 0; c < L.tw && c0 + c < L.w; c++) {
                    const xx = ((X0 + (c0 + c + 0.5) * sx) / MERC / DEG - LON0) * ml, i = Math.floor((xx - ORIGIN) / MC);
                    if (i < 0 || i >= M) continue;
                    const k = j * M + i, v = px[r * L.tw + c];
                    cnt[k]++;
                    if (v >= 2) { cov[k]++; sum[k] += v; }
                }
            }
        }
    }
    const out = Buffer.alloc(M * M * 2);
    let covered = 0;
    for (let k = 0; k < M * M; k++) {
        if (!cnt[k]) continue;
        out[k] = Math.round(cov[k] / cnt[k] * 255);
        out[M * M + k] = cov[k] ? Math.min(255, Math.round(sum[k] / cov[k])) : 0;
        covered += cov[k] / cnt[k];
    }
    console.log(`canopy: ${files} files, ${tilesRead} tiles, ${M}^2 cells of ${MC.toFixed(1)} m, ${(covered * MC * MC / 1e6).toFixed(0)} km^2 under canopy`);
    return { M, bytes: out };
}

// ------------------------------------------------------------------------------------------------ OSM PBF
class PB {
    constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
    get more() { return this.pos < this.end; }
    varint() { let r = 0, s = 1, b; do { b = this.buf[this.pos++]; r += (b & 127) * s; s *= 128; } while (b & 128); return r; }
    svarint() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    key() { const k = this.varint(); return [Math.floor(k / 8), k & 7]; }
    bytes() { const l = this.varint(), s = this.pos; this.pos += l; return this.buf.subarray(s, this.pos); }
    skip(t) { if (t === 0) this.varint(); else if (t === 1) this.pos += 8; else if (t === 2) { const l = this.varint(); this.pos += l; } else if (t === 5) this.pos += 4; else throw new Error(`PBF: wire type ${t}`); }
    packed(signed) { const b = this.bytes(), p = new PB(b), out = []; while (p.more) out.push(signed ? p.svarint() : p.varint()); return out; }
}

// every OSMData block of the file: fn(block) with block = { strings, groups: [PB of each PrimitiveGroup], gran, lat0, lon0 }
function eachBlock(file, fn) {
    let pos = 0;
    while (pos < file.length) {
        const hl = file.readUInt32BE(pos); pos += 4;
        const hp = new PB(file, pos, pos + hl);
        let type = '', size = 0;
        while (hp.more) { const [f, t] = hp.key(); if (f === 1) type = hp.bytes().toString(); else if (f === 3) size = hp.varint(); else hp.skip(t); }
        pos += hl;
        const bp = new PB(file, pos, pos + size);
        pos += size;
        if (type !== 'OSMData') continue;
        let data = null;
        while (bp.more) { const [f, t] = bp.key(); if (f === 1) data = bp.bytes(); else if (f === 3) data = inflateSync(bp.bytes()); else bp.skip(t); }
        const p = new PB(data), block = { strings: [], groups: [], gran: 100, lat0: 0, lon0: 0 };
        while (p.more) {
            const [f, t] = p.key();
            if (f === 1) { const s = new PB(p.bytes()); while (s.more) { const [g, u] = s.key(); if (g === 1) block.strings.push(s.bytes().toString('utf8')); else s.skip(u); } }
            else if (f === 2) block.groups.push(p.bytes());
            else if (f === 17) block.gran = p.varint();
            else if (f === 19) block.lat0 = p.varint();
            else if (f === 20) block.lon0 = p.varint();
            else p.skip(t);
        }
        fn(block);
    }
}

// every element of a group: onDense(ids, lats, lons, tags[]), onNode(id, lat, lon, tags), onWay(id, refs, tags), onRel(id, members, tags)
function eachElement(block, { node, way, rel }) {
    const S = block.strings, deg = v => v * 1e-9;
    for (const g of block.groups) {
        const p = new PB(g);
        while (p.more) {
            const [f, t] = p.key();
            if (f === 2 && node) {
                const d = new PB(p.bytes());
                let ids = [], lats = [], lons = [], kv = [];
                while (d.more) {
                    const [k, u] = d.key();
                    if (k === 1) ids = d.packed(true); else if (k === 8) lats = d.packed(true); else if (k === 9) lons = d.packed(true); else if (k === 10) kv = d.packed(false); else d.skip(u);
                }
                let id = 0, lat = 0, lon = 0, q = 0;
                for (let i = 0; i < ids.length; i++) {
                    id += ids[i]; lat += lats[i]; lon += lons[i];
                    let tags = null;
                    while (q < kv.length && kv[q] !== 0) { (tags ??= {})[S[kv[q]]] = S[kv[q + 1]]; q += 2; }
                    q++;
                    node(id, deg(block.lat0 + block.gran * lat), deg(block.lon0 + block.gran * lon), tags);
                }
            } else if (f === 1 && node) {
                const d = new PB(p.bytes());
                let id = 0, lat = 0, lon = 0, keys = [], vals = [];
                while (d.more) { const [k, u] = d.key(); if (k === 1) id = d.svarint(); else if (k === 2) keys = d.packed(); else if (k === 3) vals = d.packed(); else if (k === 8) lat = d.svarint(); else if (k === 9) lon = d.svarint(); else d.skip(u); }
                const tags = keys.length ? Object.fromEntries(keys.map((k, i) => [S[k], S[vals[i]]])) : null;
                node(id, deg(block.lat0 + block.gran * lat), deg(block.lon0 + block.gran * lon), tags);
            } else if (f === 3 && way) {
                const d = new PB(p.bytes());
                let id = 0, keys = [], vals = [], refs = [];
                while (d.more) { const [k, u] = d.key(); if (k === 1) id = d.varint(); else if (k === 2) keys = d.packed(); else if (k === 3) vals = d.packed(); else if (k === 8) refs = d.packed(true); else d.skip(u); }
                for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
                way(id, refs, Object.fromEntries(keys.map((k, i) => [S[k], S[vals[i]]])));
            } else if (f === 4 && rel) {
                const d = new PB(p.bytes());
                let id = 0, keys = [], vals = [], roles = [], mem = [], types = [];
                while (d.more) {
                    const [k, u] = d.key();
                    if (k === 1) id = d.varint(); else if (k === 2) keys = d.packed(); else if (k === 3) vals = d.packed();
                    else if (k === 8) roles = d.packed(); else if (k === 9) mem = d.packed(true); else if (k === 10) types = d.packed(); else d.skip(u);
                }
                let ref = 0;
                const members = mem.map((m, i) => ({ type: types[i], ref: (ref += m), role: S[roles[i]] }));
                rel(id, members, Object.fromEntries(keys.map((k, i) => [S[k], S[vals[i]]])));
            } else p.skip(t);
        }
    }
}

// ------------------------------------------------------------------------------------------------ what is kept
const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'motorway_link',
    'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'living_street', 'pedestrian', 'track', 'busway', 'road', 'footway',
    'cycleway', 'path', 'steps'];
const ROAD_BRIDGE = 1, ROAD_TUNNEL = 2, ROAD_ONEWAY = 4, ROAD_MINOR = 8, ROAD_ROUNDABOUT = 16;
const BUILDING_KINDS = ['yes', 'house', 'residential', 'apartments', 'detached', 'semidetached_house', 'terrace', 'garage', 'garages', 'shed',
    'roof', 'carport', 'commercial', 'retail', 'office', 'industrial', 'warehouse', 'hangar', 'school', 'university', 'hospital', 'church',
    'temple', 'hotel', 'public', 'civic', 'government', 'parking', 'greenhouse', 'farm', 'barn', 'hut', 'cabin', 'military', 'stadium',
    'grandstand', 'train_station', 'transportation', 'kiosk', 'service', 'construction', 'other'];
// land cover planes (0..1 per cell): 0 built-up, 1 woods, 2 water; what sets each
const COVER = [
    { landuse: ['residential', 'commercial', 'industrial', 'retail', 'railway', 'construction', 'garages', 'military', 'education', 'institutional', 'religious'], aeroway: ['aerodrome'], amenity: ['parking', 'school', 'university', 'hospital'] },
    { landuse: ['forest'], natural: ['wood'] },
    { natural: ['water', 'bay'], landuse: ['reservoir', 'basin'], water: ['*'] },
];
const SCRUB = { natural: ['scrub'] };     // half woods
const has = (tags, sel) => Object.entries(sel).some(([k, vs]) => tags[k] && (vs.includes('*') || vs.includes(tags[k])));
const coverOf = tags => {
    for (let c = 0; c < COVER.length; c++) if (has(tags, COVER[c])) return [c, 1];
    if (has(tags, SCRUB)) return [1, 0.55];
    return null;
};
const metres = s => {
    if (!s) return 0;
    const m = /^\s*([\d.]+)\s*(m|ft|')?/.exec(s.replace(',', '.'));
    if (!m) return 0;
    const v = parseFloat(m[1]);
    return m[2] === 'ft' || m[2] === "'" ? v * 0.3048 : v;
};

async function osm() {
    const pbfPath = opt('--pbf') || join(cache, basename(new URL(R.pbf).pathname));
    if (!existsSync(pbfPath)) console.log(`osm: downloading ${R.pbf}`);
    const file = await download(R.pbf, pbfPath);
    const inBox = (lat, lon) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;

    // pass 1: the multipolygons we keep, and the ways they need
    const rels = [], need = new Set();
    eachBlock(file, b => eachElement(b, { rel: (id, members, tags) => {
        if (tags.type !== 'multipolygon' || !(tags.building || coverOf(tags))) return;
        rels.push({ id, members: members.filter(m => m.type === 1 && (m.role === 'outer' || m.role === 'inner' || m.role === '')), tags });
        for (const m of members) if (m.type === 1) need.add(m.ref);
    } }));

    // pass 2: nodes (sorted ids, coordinates), the ways we keep, places and peaks
    let cap = 1 << 22, count = 0, ids = new Float64Array(cap), lat = new Float64Array(cap), lon = new Float64Array(cap), sorted = true;
    const ways = [], members = new Map(), places = [], coast = [];
    eachBlock(file, b => eachElement(b, {
        node: (id, la, lo, tags) => {
            if (count === cap) { cap *= 2; const grow = a => { const b = new Float64Array(cap); b.set(a); return b; }; ids = grow(ids); lat = grow(lat); lon = grow(lon); }
            if (count && id < ids[count - 1]) sorted = false;
            ids[count] = id; lat[count] = la; lon[count] = lo; count++;
            if (!tags || !tags.name || !inBox(la, lo)) return;
            const kind = tags.place && ['city', 'town', 'village', 'suburb', 'hamlet', 'neighbourhood', 'quarter', 'island', 'islet'].includes(tags.place) ? tags.place
                : tags.natural === 'peak' || tags.natural === 'volcano' ? 'peak' : tags.natural === 'cape' ? 'cape' : tags.natural === 'bay' ? 'bay'
                : tags.tourism === 'attraction' || tags.tourism === 'viewpoint' ? tags.tourism : null;
            if (kind) places.push({ name: tags.name, kind, lat: la, lon: lo, ele: metres(tags.ele) || undefined, population: +tags.population || undefined });
        },
        way: (id, refs, tags) => {
            if (need.has(id)) members.set(id, refs);
            if (tags.natural === 'coastline') coast.push(refs);
            if (tags.highway && ROAD_CLASSES.includes(tags.highway) && tags.area !== 'yes') ways.push({ kind: 'road', refs, tags });
            else if (tags.building && refs.length > 3 && refs[0] === refs[refs.length - 1]) ways.push({ kind: 'building', refs, tags });
            else if (coverOf(tags) && refs.length > 3 && refs[0] === refs[refs.length - 1]) ways.push({ kind: 'cover', refs, tags });
        },
    }));
    ids = ids.subarray(0, count); lat = lat.subarray(0, count); lon = lon.subarray(0, count);
    if (!sorted) {
        const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => ids[a] - ids[b]);
        ids = Float64Array.from(order, i => ids[i]); lat = Float64Array.from(order, i => lat[i]); lon = Float64Array.from(order, i => lon[i]);
    }
    const find = id => { let a = 0, b = count - 1; while (a <= b) { const m = (a + b) >> 1; if (ids[m] === id) return m; if (ids[m] < id) a = m + 1; else b = m - 1; } return -1; };
    // a way's points in local metres (null if a node is missing)
    const geom = refs => {
        const out = [];
        for (const r of refs) { const k = find(r); if (k < 0) return null; out.push(toLocal(lat[k], lon[k])); }
        return out;
    };
    // the closed rings ways make, joined end to end (node id lists), as points
    const joinRings = list => {
        const parts = list.map(r => [...r]), out = [];
        while (parts.length) {
            let ring = parts.shift();
            while (ring[0] !== ring[ring.length - 1]) {
                const end = ring[ring.length - 1], k = parts.findIndex(p => p[0] === end || p[p.length - 1] === end);
                if (k < 0) break;
                const p = parts.splice(k, 1)[0];
                ring = ring.concat(p[0] === end ? p.slice(1) : p.reverse().slice(1));
            }
            if (ring.length > 3 && ring[0] === ring[ring.length - 1]) { const g = geom(ring); if (g) out.push(g); }
        }
        return out;
    };
    // a multipolygon's rings: { outer: [...], inner: [...] }
    const rings = rel => ({
        outer: joinRings(rel.members.filter(m => (m.role || 'outer') === 'outer').map(m => members.get(m.ref)).filter(Boolean)),
        inner: joinRings(rel.members.filter(m => m.role === 'inner').map(m => members.get(m.ref)).filter(Boolean)),
    });
    const inside = pts => pts.some(([x, z]) => Math.abs(x) < HALF && Math.abs(z) < HALF);
    const roads = [], buildings = [], covers = [];
    for (const w of ways) {
        const g = geom(w.refs);
        if (!g || !inside(g)) continue;
        if (w.kind === 'road') roads.push({ pts: g, tags: w.tags });
        else if (w.kind === 'building') buildings.push({ outer: g, tags: w.tags });
        else covers.push({ outer: [g], inner: [], tags: w.tags });
    }
    for (const r of rels) {
        const rg = rings(r);
        if (!rg.outer.length || !rg.outer.some(inside)) continue;
        if (r.tags.building) for (const o of rg.outer) buildings.push({ outer: o, tags: r.tags });
        else covers.push({ ...rg, tags: r.tags });
    }
    // the coastline: the land's outlines (islands; an extract cuts none of them inside the square)
    const shore = joinRings(coast).filter(inside);
    console.log(`osm: ${count} nodes; ${roads.length} roads, ${buildings.length} buildings, ${covers.length} land cover areas, ${places.length} places, ${shore.length} coastline rings`);
    return { roads, buildings, covers, places, shore };
}

// ------------------------------------------------------------------------------------------------ rasters
// every cell centre inside the polygon (rings, even-odd) gets fn(idx)
function fillPolygon(rings, fn) {
    let z0 = Infinity, z1 = -Infinity;
    for (const r of rings) for (const p of r) { z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const j0 = Math.max(0, Math.ceil((z0 - ORIGIN) / CELL - 0.5)), j1 = Math.min(N - 1, Math.floor((z1 - ORIGIN) / CELL - 0.5));
    for (let j = j0; j <= j1; j++) {
        const z = cx(j), xs = [];
        for (const r of rings) for (let k = 0; k + 1 < r.length; k++) {
            const [ax, az] = r[k], [bx, bz] = r[k + 1];
            if ((az <= z) !== (bz <= z)) xs.push(ax + (z - az) / (bz - az) * (bx - ax));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const i0 = Math.max(0, Math.ceil((xs[k] - ORIGIN) / CELL - 0.5)), i1 = Math.min(N - 1, Math.floor((xs[k + 1] - ORIGIN) / CELL - 0.5));
            for (let i = i0; i <= i1; i++) fn(j * N + i);
        }
    }
}

const ringArea = r => { let a = 0; for (let k = 0; k + 1 < r.length; k++) a += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1]; return a / 2; };

function blur(src, radius) {
    const tmp = new Float32Array(N * N), out = new Float32Array(N * N), w = 2 * radius + 1;
    for (let j = 0; j < N; j++) { let s = 0; for (let i = -radius; i < N + radius; i++) { if (i + radius < N) s += src[j * N + Math.max(0, i + radius)] * (i + radius >= 0 ? 1 : 0); if (i - radius - 1 >= 0) s -= src[j * N + i - radius - 1]; if (i >= 0 && i < N) tmp[j * N + i] = s / w; } }
    for (let i = 0; i < N; i++) { let s = 0; for (let j = -radius; j < N + radius; j++) { if (j + radius < N) s += tmp[Math.max(0, j + radius) * N + i] * (j + radius >= 0 ? 1 : 0); if (j - radius - 1 >= 0) s -= tmp[(j - radius - 1) * N + i]; if (j >= 0 && j < N) out[j * N + i] = s / w; } }
    return out;
}

// the sea: every cell outside the coastline's rings (the elevation tiles' own shoreline is coarse, with flat shelves on
// the reefs)
function seaMask(shore) {
    const sea = new Uint8Array(N * N).fill(1);
    for (const r of shore) fillPolygon([r], k => { sea[k] ^= 1; });
    return sea;
}

// ------------------------------------------------------------------------------------------------ encoding
class Writer {
    constructor() { this.buf = Buffer.alloc(1 << 20); this.n = 0; }
    room(k) { if (this.n + k > this.buf.length) { const b = Buffer.alloc(Math.max(this.buf.length * 2, this.n + k)); this.buf.copy(b, 0, 0, this.n); this.buf = b; } }
    uv(v) { this.room(10); v = Math.max(0, Math.round(v)); while (v >= 128) { this.buf[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); } this.buf[this.n++] = v; }
    sv(v) { v = Math.round(v); this.uv(v < 0 ? -2 * v - 1 : 2 * v); }
    // points [x, z] in decimetres, delta coded from the previous point
    pts(p) { this.uv(p.length); let px = 0, pz = 0; for (const [x, z] of p) { const qx = Math.round(x * 10), qz = Math.round(z * 10); this.sv(qx - px); this.sv(qz - pz); px = qx; pz = qz; } }
    get bytes() { return this.buf.subarray(0, this.n); }
}

function writeData(name, meta, bytes) {
    const dir = join(root, 'scenarios/data', regionId);
    mkdirSync(dir, { recursive: true });
    const id = `${regionId}/${name}`, b64 = deflateRawSync(bytes, { level: 9 }).toString('base64');
    const text = `'use strict';\n// Generated by tools/geo-import.mjs ${regionId} - do not edit. ${meta.attribution || ''}\n` +
        `ScenarioData.put(${JSON.stringify(id)}, ${JSON.stringify(meta)},\n'${b64}');\n`;
    writeFileSync(join(dir, `${name}.js`), text);
    console.log(`scenarios/data/${id}.js: ${(text.length / 1048576).toFixed(2)} MB (${(bytes.length / 1048576).toFixed(2)} MB raw)`);
}

// ------------------------------------------------------------------------------------------------ main
const OSM_ATTR = 'Map data (c) OpenStreetMap contributors, ODbL (openstreetmap.org/copyright).';
const frame = { center: R.center, size: SIZE, resolution: N, axes: 'x east, z south, y up (m)' };
const h = await heights();
const data = await osm();

// the ground: below the sea level and open to the sea -> the sea's flat surface; heights in decimetres, each row delta coded
const sea = seaMask(data.shore), seaLevel = R.sea ?? -1.5;
let lo = Infinity, hi = -Infinity;
for (let k = 0; k < N * N; k++) { h[k] = sea[k] ? seaLevel : Math.max(h[k], seaLevel + 0.6); lo = Math.min(lo, h[k]); hi = Math.max(hi, h[k]); }
// land cover: built-up (land use, and the share of the ground under roofs), woods, water (the sea and the water areas)
const planes = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N)];
for (const c of data.covers) { const [ch, v] = coverOf(c.tags); fillPolygon([...c.outer, ...c.inner], k => { planes[ch][k] = Math.max(planes[ch][k], v * (ch === 0 ? 0.6 : 1)); }); }
const roofs = new Float32Array(N * N);
for (const b of data.buildings) {
    const a = Math.abs(ringArea(b.outer)), c = b.outer.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map(v => v / b.outer.length);
    const i = Math.floor((c[0] - ORIGIN) / CELL), j = Math.floor((c[1] - ORIGIN) / CELL);
    if (i >= 0 && j >= 0 && i < N && j < N) roofs[j * N + i] += a / (CELL * CELL);
}
const dense = blur(roofs, 2);
for (let k = 0; k < N * N; k++) {
    planes[0][k] = Math.max(planes[0][k], Math.min(1, dense[k] * 4));
    if (sea[k]) { planes[2][k] = 1; planes[0][k] = planes[1][k] = 0; }
}
const terr = Buffer.alloc(N * N * 2 + N * N * 3);
for (let j = 0; j < N; j++) { let prev = 0; for (let i = 0; i < N; i++) { const v = Math.round(h[j * N + i] * 10); terr.writeInt16LE(Math.max(-32768, Math.min(32767, v - prev)), (j * N + i) * 2); prev = v; } }
for (let c = 0; c < 3; c++) for (let k = 0; k < N * N; k++) terr[N * N * 2 + c * N * N + k] = Math.round(Math.max(0, Math.min(1, planes[c][k])) * 255);
const places = data.places.map(p => { const [x, z] = toLocal(p.lat, p.lon); return { ...p, x: Math.round(x), z: Math.round(z) }; })
    .filter(p => Math.abs(p.x) < HALF && Math.abs(p.z) < HALF);
writeData('terrain', { ...frame, sea: seaLevel, min: lo, max: hi, layout: 'int16 heights (dm, each row delta coded), then u8 planes: built-up, woods, water',
    places, attribution: `Heights: AWS Terrain Tiles (Terrarium; USGS 3DEP, NOAA and others). Land cover and places: ${OSM_ATTR}` }, terr);

// the tree canopy (the region's `canopy`): u8 cover (0..255, the share of each cell under canopy), then u8 height (m)
if (R.canopy) {
    const cn = await canopy();
    writeData('canopy', { ...frame, resolution: cn.M, layout: 'u8 cover (share of the cell under canopy of 2 m and taller, 0..255), then u8 height (m: the canopy\'s mean height there)', attribution: CANOPY_ATTR }, cn.bytes);
}

// roads: per way: class, flags, layer + 8, lanes, width (dm), then its points
const rw = new Writer();
let roadPts = 0;
rw.uv(data.roads.length);
for (const r of data.roads) {
    const t = r.tags, minor = t.highway === 'service' && ['driveway', 'parking_aisle', 'drive-through'].includes(t.service);
    const flags = (t.bridge && t.bridge !== 'no' ? ROAD_BRIDGE : 0) | (t.tunnel && t.tunnel !== 'no' ? ROAD_TUNNEL : 0)
        | (t.oneway === 'yes' || t.junction === 'roundabout' || t.highway === 'motorway' ? ROAD_ONEWAY : 0) | (minor ? ROAD_MINOR : 0) | (t.junction === 'roundabout' ? ROAD_ROUNDABOUT : 0);
    rw.uv(ROAD_CLASSES.indexOf(t.highway)); rw.uv(flags); rw.uv((parseInt(t.layer) || 0) + 8); rw.uv(parseInt(t.lanes) || 0); rw.uv(metres(t.width) * 10);
    rw.pts(r.pts);
    roadPts += r.pts.length;
}
writeData('roads', { ...frame, count: data.roads.length, points: roadPts, classes: ROAD_CLASSES, flags: { bridge: ROAD_BRIDGE, tunnel: ROAD_TUNNEL, oneway: ROAD_ONEWAY, minor: ROAD_MINOR, roundabout: ROAD_ROUNDABOUT },
    layout: 'varints: count, then per road: class, flags, layer + 8, lanes, width (dm), points (count, zigzag deltas in dm)', attribution: OSM_ATTR }, rw.bytes);

// buildings: per footprint (its outer ring, open, its shoelace area in (x, z) positive): kind, height (dm), levels,
// min height (dm), roof levels, then its points
const bw = new Writer();
let kept = 0, bPts = 0;
const blist = data.buildings.filter(b => b.outer.length >= 4 && Math.abs(ringArea(b.outer)) >= 4);
bw.uv(blist.length);
for (const b of blist) {
    const t = b.tags, ring = b.outer.slice(0, -1);
    if (ringArea(b.outer) < 0) ring.reverse();
    let kind = BUILDING_KINDS.indexOf(t.building);
    if (kind < 0) kind = BUILDING_KINDS.length - 1;
    bw.uv(kind); bw.uv(metres(t.height) * 10); bw.uv(parseFloat(t['building:levels']) || 0); bw.uv(metres(t.min_height) * 10); bw.uv(parseFloat(t['roof:levels']) || 0);
    bw.pts(ring);
    kept++; bPts += ring.length;
}
writeData('buildings', { ...frame, count: kept, points: bPts, kinds: BUILDING_KINDS,
    layout: 'varints: count, then per building: kind, height (dm, 0 unknown), levels, min height (dm), roof levels, outer ring (count, zigzag deltas in dm; open, positive shoelace area in x, z)', attribution: OSM_ATTR }, bw.bytes);
