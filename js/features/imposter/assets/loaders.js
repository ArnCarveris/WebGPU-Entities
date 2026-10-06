'use strict';
// Loaders for dropped files: glTF / GLB and OBJ.

Features.part('imposter', (engine, feature) => {
const { Common } = engine;
const { lerp, v3 } = Common;
const { basename, srgbToLinear, m4, Material, MeshBuilder } = feature;

function computeNormals(p, idx) {
    const n = new Float32Array(p.length);
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const fn = v3.cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
        for (const k of [a, b, c]) { n[k] += fn[0]; n[k + 1] += fn[1]; n[k + 2] += fn[2]; }
    }
    for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    return n;
}

const GltfLoader = {
    async load(file, files) {
        const buf = await file.arrayBuffer(), dv = new DataView(buf);
        let json, bin = null;
        if (buf.byteLength >= 12 && dv.getUint32(0, true) === 0x46546C67) {            // 'glTF'
            for (let off = 12; off + 8 <= buf.byteLength;) {
                const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
                if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
                else if (type === 0x004E4942) bin = buf.slice(off + 8, off + 8 + len);
                off += 8 + len;
            }
        } else json = JSON.parse(new TextDecoder().decode(buf));
        const bad = (json.extensionsRequired || []).filter(e => !['KHR_materials_unlit', 'KHR_texture_transform'].includes(e));
        if (bad.length) throw new Error('unsupported glTF extension: ' + bad.join(', '));

        const fetchUri = async uri => {
            if (uri.startsWith('data:')) {
                const s = atob(uri.slice(uri.indexOf(',') + 1)), a = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
                return a.buffer;
            }
            const f = files.get(basename(decodeURIComponent(uri)).toLowerCase());
            if (!f) throw new Error(`missing "${uri}": drop it together with the .gltf`);
            return f.arrayBuffer();
        };
        const buffers = await Promise.all((json.buffers || []).map(b => (b.uri === undefined ? bin : fetchUri(b.uri))));
        const images = [];
        const image = async i => {
            if (images[i] === undefined) {
                const im = json.images[i];
                let blob;
                if (im.bufferView !== undefined) {
                    const bv = json.bufferViews[im.bufferView];
                    blob = new Blob([new Uint8Array(buffers[bv.buffer], bv.byteOffset || 0, bv.byteLength)], { type: im.mimeType });
                } else blob = new Blob([await fetchUri(im.uri)]);
                images[i] = await createImageBitmap(blob);
            }
            return images[i];
        };
        const mats = await Promise.all((json.materials || []).map(async (m, i) => {
            const pbr = m.pbrMetallicRoughness || {}, f = pbr.baseColorFactor || [1, 1, 1, 1];
            let img = null;
            if (pbr.baseColorTexture) {
                const tx = json.textures[pbr.baseColorTexture.index], src = tx.source ?? tx.extensions?.EXT_texture_webp?.source;
                if (src !== undefined) img = await image(src).catch(e => { console.warn('glTF image:', e); return null; });
            }
            const ef = m.emissiveFactor || [0, 0, 0], es = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
            return new Material(m.name || `material ${i}`, {
                color: f, alpha: f[3], image: img, doubleSided: !!m.doubleSided,
                spec: lerp(0.08, 0.8, pbr.metallicFactor ?? 1), gloss: 1 - (pbr.roughnessFactor ?? 1),
                emissive: ef.some(x => x > 0) ? { color: ef, linear: true, strength: es } : null,
                alphaCutoff: m.alphaMode === 'MASK' ? (m.alphaCutoff ?? 0.5) : m.alphaMode === 'BLEND' ? 0.35 : 0,
            });
        }));
        const defMat = new Material('glTF default', { color: [0.8, 0.8, 0.8] });

        const COMP = { 5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767], 5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 1], 5126: [4, 'getFloat32', 1] };
        const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
        const read = (ai, asIndex = false) => {
            const a = json.accessors[ai], nc = NUM[a.type], out = asIndex ? new Uint32Array(a.count * nc) : new Float32Array(a.count * nc);
            if (a.bufferView === undefined) return out;
            const bv = json.bufferViews[a.bufferView], [size, get, max] = COMP[a.componentType];
            const stride = bv.byteStride || size * nc, base = (bv.byteOffset || 0) + (a.byteOffset || 0), view = new DataView(buffers[bv.buffer]);
            const norm = !asIndex && a.normalized && max > 1;
            for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) {
                const x = view[get](base + i * stride + c * size, true);
                out[i * nc + c] = norm ? Math.max(x / max, -1) : x;
            }
            return out;
        };

        const b = new MeshBuilder();
        const visit = (ni, parent) => {
            const node = json.nodes[ni];
            const local = node.matrix ? Float64Array.from(node.matrix) : m4.fromTRS(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
            const M = m4.mul(parent, local);
            if (node.mesh !== undefined) for (const prim of json.meshes[node.mesh].primitives) {
                const at = prim.attributes;
                if ((prim.mode ?? 4) !== 4 || at.POSITION === undefined) continue;
                const p = read(at.POSITION), count = p.length / 3;
                const idx = prim.indices !== undefined ? read(prim.indices, true) : Uint32Array.from({ length: count }, (_, i) => i);
                const n = at.NORMAL !== undefined ? read(at.NORMAL) : computeNormals(p, idx);
                const uv = at.TEXCOORD_0 !== undefined ? read(at.TEXCOORD_0) : new Float32Array(count * 2);
                let col = null;
                if (at.COLOR_0 !== undefined) {
                    const c = read(at.COLOR_0), k = json.accessors[at.COLOR_0].type === 'VEC4' ? 4 : 3;
                    col = new Float32Array(count * 3);
                    for (let i = 0; i < count; i++) { col[i * 3] = c[i * k]; col[i * 3 + 1] = c[i * k + 1]; col[i * 3 + 2] = c[i * k + 2]; }
                }
                b.add({ p, n, uv, col, idx }, prim.material !== undefined ? mats[prim.material] : defMat, M);
            }
            for (const c of node.children || []) visit(c, M);
        };
        const roots = json.scenes ? json.scenes[json.scene ?? 0].nodes : (json.nodes || []).map((_, i) => i);
        for (const n of roots) visit(n, m4.identity());
        const mesh = b.finish();
        if (!mesh.indices.length) throw new Error('no triangle meshes in the file');
        return mesh;
    },
};

const ObjLoader = {
    async load(file, files) {
        const text = await file.text(), P = [], T = [], N = [], mtl = {}, groups = new Map();
        let cur = null;
        const use = name => {
            if (!groups.has(name)) groups.set(name, { keys: new Map(), p: [], n: [], uv: [], idx: [], pi: [], hasN: [] });
            cur = groups.get(name);
        };
        use('default');
        const ix = (s, len) => { const i = parseInt(s, 10); return i < 0 ? len + i : i - 1; };
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line || line[0] === '#') continue;
            const t = line.split(/\s+/), k = t[0];
            if (k === 'v') P.push(+t[1], +t[2], +t[3]);
            else if (k === 'vt') T.push(+t[1], +(t[2] ?? 0));
            else if (k === 'vn') N.push(+t[1], +t[2], +t[3]);
            else if (k === 'usemtl') use(t.slice(1).join(' '));
            else if (k === 'mtllib') {
                const f = files.get(basename(t.slice(1).join(' ')).toLowerCase());
                if (f) Object.assign(mtl, ObjLoader.parseMtl(await f.text()));
            } else if (k === 'f') {
                const ids = t.slice(1).map(tok => {
                    let v = cur.keys.get(tok);
                    if (v !== undefined) return v;
                    const [a, bb, c] = tok.split('/'), vi = ix(a, P.length / 3), ti = bb ? ix(bb, T.length / 2) : -1, ni = c ? ix(c, N.length / 3) : -1;
                    v = cur.p.length / 3;
                    cur.p.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
                    cur.uv.push(ti >= 0 ? T[ti * 2] : 0, ti >= 0 ? 1 - T[ti * 2 + 1] : 0);
                    cur.n.push(ni >= 0 ? N[ni * 3] : 0, ni >= 0 ? N[ni * 3 + 1] : 0, ni >= 0 ? N[ni * 3 + 2] : 0);
                    cur.pi.push(vi); cur.hasN.push(ni >= 0);
                    cur.keys.set(tok, v);
                    return v;
                });
                for (let i = 1; i + 1 < ids.length; i++) cur.idx.push(ids[0], ids[i], ids[i + 1]);
            }
        }
        const b = new MeshBuilder();
        for (const [name, g] of groups) {
            if (!g.idx.length) continue;
            if (g.hasN.some(h => !h)) {                                                    // smooth normals by position index
                const acc = new Float32Array(P.length);
                for (let i = 0; i < g.idx.length; i += 3) {
                    const [a, c, e] = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
                    const pa = [g.p[a * 3], g.p[a * 3 + 1], g.p[a * 3 + 2]];
                    const fn = v3.cross(v3.sub([g.p[c * 3], g.p[c * 3 + 1], g.p[c * 3 + 2]], pa), v3.sub([g.p[e * 3], g.p[e * 3 + 1], g.p[e * 3 + 2]], pa));
                    for (const v of [a, c, e]) for (let q = 0; q < 3; q++) acc[g.pi[v] * 3 + q] += fn[q];
                }
                g.hasN.forEach((h, v) => {
                    if (h) return;
                    const n = v3.norm([acc[g.pi[v] * 3], acc[g.pi[v] * 3 + 1], acc[g.pi[v] * 3 + 2]]);
                    g.n[v * 3] = n[0]; g.n[v * 3 + 1] = n[1]; g.n[v * 3 + 2] = n[2];
                });
            }
            const m = mtl[name] || {};
            let img = null;
            if (m.map) { const f = files.get(basename(m.map).toLowerCase()); if (f) img = await createImageBitmap(f).catch(() => null); }
            b.add(g, new Material(name, { color: srgbToLinear(m.kd || [0.75, 0.75, 0.75]), image: img, alphaCutoff: m.map && m.d < 1 ? 0.5 : 0, doubleSided: true }));
        }
        const mesh = b.finish();
        if (!mesh.indices.length) throw new Error('no faces in the .obj');
        return mesh;
    },
    parseMtl(text) {
        const out = {};
        let cur = null;
        for (const raw of text.split('\n')) {
            const t = raw.trim().split(/\s+/);
            if (t[0] === 'newmtl') out[t.slice(1).join(' ')] = cur = { d: 1 };
            else if (!cur) continue;
            else if (t[0] === 'Kd') cur.kd = [+t[1], +t[2], +t[3]];
            else if (t[0] === 'map_Kd') cur.map = t[t.length - 1];
            else if (t[0] === 'd') cur.d = +t[1];
        }
        return out;
    },
};

return { GltfLoader, ObjLoader };
});
