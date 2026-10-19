'use strict';
// The vegetation: the plants' meshes (built here, low-poly and flat-shaded like the world's structures) and the pass that
// scatters them each frame about the eye and draws them (shaders/vegetation.js): full meshes near, octahedral imposters
// (the imposter kit: each species' near mesh baked once into an atlas) from VEG_NEAR out, the low-poly meshes there until
// the atlases are baked.

Features.kit('atmosphere', (engine, kit) => {
const { Common } = engine;
const { makeBuffer, bindLayout, bindGroup } = Common;
const { mulberry32 } = engine.kits.noise;
const { ImposterGpu, ImposterBaker, WGSL_BAKE_FRAME, IMPOSTER_VERTICES } = engine.kits.imposter;
const {
    VEG_N, VEG_SPECIES, VEG_CAP, VEG_SLOT, WGSL_FOREST, WGSL_VEG_SCATTER, WGSL_VEG_ALBEDO, WGSL_VEG_BAKE, shaderSource,
    WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, WGSL_TERRAIN,
} = kit;

const VEG_FLOATS = 10;      // a mesh vertex: position, normal, part (0 wood, 1 foliage), ambient occlusion, slot, 0
const VEG_ATLAS = { grid: 8, res: 64, full: false };       // the imposter atlases: frames a side, px a frame (a plant past
                                                            // VEG_NEAR is a few dozen px tall), upper hemisphere
const VEG_BUFFERS = [{ arrayStride: VEG_FLOATS * 4, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x4' }] }];

// A plant's mesh: triangles in its own frame (base at the origin, y up, metres), flat normals
class PlantMesh {
    constructor(slot) { this.slot = slot; this.v = []; }

    tri(a, b, c, part, ao = 1) {
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const l = Math.hypot(...n) || 1;
        n = n.map(x => x / l);
        const aoOf = p => typeof ao === 'function' ? ao(p) : ao;
        for (const p of [a, b, c]) this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], part, aoOf(p), this.slot, 0);
    }

    // a tapered tube along the points `path` (radius r0 at the first, r1 at the last), `sides` round
    tube(path, r0, r1, sides) {
        const ring = (k) => {
            const p = path[k], q = path[Math.min(k + 1, path.length - 1)], o = path[Math.max(k - 1, 0)];
            const t = [q[0] - o[0], q[1] - o[1], q[2] - o[2]], tl = Math.hypot(...t) || 1;
            const T = t.map(x => x / tl), A = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            let U = [T[1] * A[2] - T[2] * A[1], T[2] * A[0] - T[0] * A[2], T[0] * A[1] - T[1] * A[0]];
            const ul = Math.hypot(...U); U = U.map(x => x / ul);
            const V = [T[1] * U[2] - T[2] * U[1], T[2] * U[0] - T[0] * U[2], T[0] * U[1] - T[1] * U[0]];
            const r = r0 + (r1 - r0) * k / (path.length - 1);
            return Array.from({ length: sides }, (_, s) => {
                const a = s / sides * Math.PI * 2, c = Math.cos(a) * r, d = Math.sin(a) * r;
                return [p[0] + U[0] * c + V[0] * d, p[1] + U[1] * c + V[1] * d, p[2] + U[2] * c + V[2] * d];
            });
        };
        const rings = path.map((_, k) => ring(k));
        for (let k = 0; k + 1 < rings.length; k++) for (let s = 0; s < sides; s++) {
            const a = rings[k][s], b = rings[k][(s + 1) % sides], c = rings[k + 1][s], d = rings[k + 1][(s + 1) % sides];
            this.tri(a, b, c, 0, 0.7); this.tri(b, d, c, 0, 0.7);
        }
    }

    // a lumpy blob of foliage: an icosahedron (subdivided `sub` times) at c, radii [rx, ry, rz], its vertices jittered;
    // darker underneath and towards the plant's axis
    blob(c, rad, sub, rnd, jitter = 0.18) {
        const t = (1 + Math.sqrt(5)) / 2;
        let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
            .map(v => { const l = Math.hypot(...v); return v.map(x => x / l); });
        let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        for (let s = 0; s < sub; s++) {
            const mid = new Map(), m = (a, b) => {
                const k = a < b ? a * 1e6 + b : b * 1e6 + a;
                if (!mid.has(k)) { const p = V[a].map((x, i) => x + V[b][i]), l = Math.hypot(...p); V.push(p.map(x => x / l)); mid.set(k, V.length - 1); }
                return mid.get(k);
            };
            F = F.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
        }
        const P = V.map(v => { const j = 1 + (rnd() * 2 - 1) * jitter; return [c[0] + v[0] * rad[0] * j, c[1] + v[1] * rad[1] * j, c[2] + v[2] * rad[2] * j]; });
        const ao = p => Math.min(1, 0.45 + 0.4 * (p[1] - c[1] + rad[1]) / (2 * rad[1]) + 0.25 * Math.hypot(p[0], p[2]) / Math.max(rad[0], rad[2]));
        for (const [a, b, cc] of F) this.tri(P[a], P[b], P[cc], 1, ao);
    }

    // a palm frond: from p along the horizontal direction (dx, dz), `len` long, drooping; a V of leaflets along it
    frond(p, dx, dz, len, segs, droop) {
        const pts = Array.from({ length: segs + 1 }, (_, k) => {
            const t = k / segs;
            return [p[0] + dx * len * t, p[1] + len * (0.35 * t - droop * t * t), p[2] + dz * len * t];
        });
        const sx = -dz, sz = dx;
        for (let k = 0; k < segs; k++) {
            const a = pts[k], b = pts[k + 1], w0 = 0.55 * Math.sin(Math.PI * (k + 0.3) / segs) * len / 4, w1 = 0.55 * Math.sin(Math.PI * (k + 1.3) / segs) * len / 4;
            for (const side of [-1, 1]) {
                const a2 = [a[0] + sx * w0 * side, a[1] - 0.25 * w0, a[2] + sz * w0 * side], b2 = [b[0] + sx * w1 * side, b[1] - 0.25 * w1, b[2] + sz * w1 * side];
                this.tri(a, b, a2, 1, 0.9); this.tri(b, b2, a2, 1, 0.9);
            }
        }
    }
}

// The species' meshes, near (lod 0) and far (lod 1): slot = species * 2 + lod (shaders/vegetation.js)
function plantMeshes() {
    const out = [];
    for (let sp = 0; sp < VEG_SPECIES; sp++) for (let lod = 0; lod < 2; lod++) {
        const m = new PlantMesh(sp * 2 + lod), rnd = mulberry32(17 + sp * 31 + lod), near = lod === 0;
        if (sp === 0) {             // broadleaf: a trunk forking into a crown of three lumps
            m.tube([[0, 0, 0], [0.1, 3, 0], [0.3, 5, 0.1]], 0.32, 0.16, near ? 6 : 3);
            if (near) {
                m.blob([0.3, 7, 0.1], [2.8, 2.1, 2.8], 1, rnd);
                m.blob([1.6, 5.9, 0.9], [2.1, 1.6, 2.1], 1, rnd);
                m.blob([-1.2, 6.1, -1.0], [2.0, 1.6, 2.0], 1, rnd);
            } else m.blob([0.3, 6.6, 0.1], [3.4, 2.4, 3.4], 0, rnd, 0.1);
        } else if (sp === 1) {      // kiawe: a short leaning trunk under a wide flat crown
            m.tube([[0, 0, 0], [0.4, 1.8, 0.2], [0.6, 3.2, 0.3]], 0.22, 0.12, near ? 5 : 3);
            if (near) {
                m.blob([0.6, 4.0, 0.3], [3.6, 1.1, 3.4], 1, rnd, 0.22);
                m.blob([-0.8, 3.6, -0.6], [2.2, 0.8, 2.0], 1, rnd, 0.22);
            } else m.blob([0.4, 3.9, 0.2], [3.8, 1.2, 3.6], 0, rnd, 0.1);
        } else if (sp === 2) {      // coconut palm: a curved trunk, fronds fanning from its top
            const segs = near ? 6 : 2, path = Array.from({ length: segs + 1 }, (_, k) => { const t = k / segs; return [1.6 * t * t, 11 * t, 0.3 * t]; });
            m.tube(path, 0.26, 0.17, near ? 6 : 3);
            const top = path[path.length - 1], n = near ? 9 : 6;
            for (let k = 0; k < n; k++) {
                const a = k / n * Math.PI * 2 + rnd() * 0.3;
                m.frond(top, Math.cos(a), Math.sin(a), 4.2 + rnd(), near ? 4 : 2, 0.55 + 0.25 * rnd());
            }
        } else {                    // shrub: two low lumps
            if (near) {
                m.blob([0, 0.9, 0], [1.1, 0.9, 1.1], 1, rnd);
                m.blob([0.7, 0.7, 0.4], [0.8, 0.7, 0.8], 1, rnd);
            } else m.blob([0.2, 0.9, 0.1], [1.3, 0.9, 1.3], 0, rnd, 0.1);
        }
        out.push(m);
    }
    return out;
}

// Scatters the plants about the eye each frame (vegScatter, then vegClamp) and draws them (vsVeg / fsVeg): one indirect
// draw per species and lod, its instance count written by the scatter
class VegetationPass {
    constructor(r) {
        const d = r.device;
        this.r = r;
        const meshes = plantMeshes(), verts = new Float32Array(meshes.reduce((n, m) => n + m.v.length, 0));
        this.args = new Uint32Array(VEG_SPECIES * 2 * 4);
        let first = 0;
        meshes.forEach((m, s) => {
            verts.set(m.v, first * VEG_FLOATS);
            const n = m.v.length / VEG_FLOATS;
            this.args.set([n, 0, first, 0], s * 4);
            first += n;
        });
        this.triangles = meshes.map(m => m.v.length / VEG_FLOATS / 3);
        this.ranges = meshes.map((m, s) => [this.args[s * 4 + 2], this.args[s * 4]]);
        this.meshes = meshes;
        this.vertexBuf = makeBuffer(d, verts.byteLength, GPUBufferUsage.VERTEX, verts);
        this.instBuf = d.createBuffer({ label: 'veg-instances', size: VEG_SPECIES * VEG_SLOT * 32, usage: GPUBufferUsage.STORAGE });
        this.argsBuf = d.createBuffer({ label: 'veg-args', size: this.args.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        // the scatter: the world's bindings (as the scene pass), its output
        const out = bindLayout(d, GPUShaderStage.COMPUTE, ['storage', 'storage']);
        const code = shaderSource(r.worldSet, WGSL_SKY, WGSL_WEATHER_SAMPLE, WGSL_SHADOW_SAMPLE, WGSL_SHELTER, WGSL_BUILDING, WGSL_TERRAIN, WGSL_FOREST, WGSL_VEG_SCATTER);
        const module = d.createShaderModule({ label: 'vegetation', code });
        const layout = d.createPipelineLayout({ bindGroupLayouts: [r.worldSet.layout, out] });
        this.scatter = d.createComputePipeline({ label: 'veg-scatter', layout, compute: { module, entryPoint: 'vegScatter' } });
        this.clamp = d.createComputePipeline({ label: 'veg-clamp', layout, compute: { module, entryPoint: 'vegClamp' } });
        this.outGroup = bindGroup(d, out, [this.instBuf, this.argsBuf], 'veg-out');
        // the draw: the instances, read in the vertex stage (group 2 of the scene pass)
        this.drawLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
        this.drawGroup = d.createBindGroup({ label: 'veg-draw', layout: this.drawLayout, entries: [{ binding: 0, resource: { buffer: this.instBuf } }] });
        // a species' far slot alone (the imposters index it from 0)
        this.farGroups = Array.from({ length: VEG_SPECIES }, (_, sp) => d.createBindGroup({ label: `veg-far-${sp}`, layout: this.drawLayout,
            entries: [{ binding: 0, resource: { buffer: this.instBuf, offset: (sp * VEG_SLOT + VEG_CAP[0]) * 32, size: VEG_CAP[1] * 32 } }] }));
        this.atlases = null;
        this.bakeAtlases().catch(e => console.warn('vegetation: imposter bake failed, low-poly far plants', e));
    }

    // each species' near mesh baked into an imposter atlas; then the far slots draw as imposters (their args: a quad each)
    async bakeAtlases() {
        const d = this.r.device, gpu = ImposterGpu.of(d), baker = new ImposterBaker(d), t0 = performance.now();
        const pipe = gpu.bakePipeline({ key: 'veg-plant', module: gpu.module(WGSL_BAKE_FRAME + WGSL_VEG_ALBEDO + WGSL_VEG_BAKE), buffers: VEG_BUFFERS, cullMode: 'none' });
        const atlases = [];
        for (let sp = 0; sp < VEG_SPECIES; sp++) {
            const v = this.meshes[sp * 2].v, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (let k = 0; k < v.length; k += VEG_FLOATS) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[k + a]); hi[a] = Math.max(hi[a], v[k + a]); }
            const center = lo.map((x, a) => (x + hi[a]) / 2);
            let radius = 0;
            for (let k = 0; k < v.length; k += VEG_FLOATS) radius = Math.max(radius, Math.hypot(v[k] - center[0], v[k + 1] - center[1], v[k + 2] - center[2]));
            const [first, count] = this.ranges[sp * 2];
            atlases.push(await baker.bake({ center, radius, emissive: false, draw: pass => {
                pass.setPipeline(pipe);
                pass.setVertexBuffer(0, this.vertexBuf);
                pass.draw(count, 1, first, 0);
            } }, VEG_ATLAS));
        }
        if (this.destroyed) { atlases.forEach(a => a.destroy()); return; }
        this.atlases = atlases;
        for (let sp = 0; sp < VEG_SPECIES; sp++) this.args.set([IMPOSTER_VERTICES, 0, 0, 0], (sp * 2 + 1) * 4);
        console.info(`vegetation: ${VEG_SPECIES} imposter atlases (${VEG_ATLAS.grid}^2 x ${atlases[0].res} px, ${(atlases.reduce((n, a) => n + a.bytes, 0) / 1048576).toFixed(0)} MB) in ${(performance.now() - t0).toFixed(0)} ms`);
    }

    // the pipelines drawing the plants from the scene module (layouts: the world's, the bus's): the meshes (vsVeg / fsVeg,
    // group 2 the instances) and the imposters (vsVegImp / fsVegImp, group 3 a species' atlas)
    pipelines(module, layouts, format, depthFormat) {
        const d = this.r.device, gpu = ImposterGpu.of(d);
        const make = (label, vs, fs, buffers, extra = []) => d.createRenderPipeline({
            label, layout: d.createPipelineLayout({ bindGroupLayouts: [...layouts, this.drawLayout, ...extra] }),
            vertex: { module, entryPoint: vs, buffers }, fragment: { module, entryPoint: fs, targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        });
        return { mesh: make('vegetation', 'vsVeg', 'fsVeg', VEG_BUFFERS), imposter: make('vegetation-imposters', 'vsVegImp', 'fsVegImp', [], [gpu.atlasLayout]) };
    }

    encode(enc, prof) {
        this.r.device.queue.writeBuffer(this.argsBuf, 0, this.args);
        const pass = enc.beginComputePass({ label: 'vegetation', timestampWrites: prof.writes('vegetation') });
        pass.setPipeline(this.scatter);
        pass.setBindGroup(0, this.r.worldGroup);
        pass.setBindGroup(1, this.outGroup);
        pass.dispatchWorkgroups(Math.ceil(VEG_N / 8), Math.ceil(VEG_N / 8));
        pass.setPipeline(this.clamp);
        pass.dispatchWorkgroups(1);
        pass.end();
    }

    draw(a, pipes, busGroup) {
        a.setPipeline(pipes.mesh);
        a.setBindGroup(1, busGroup, [0]);
        a.setBindGroup(2, this.drawGroup);
        a.setVertexBuffer(0, this.vertexBuf);
        for (let s = 0; s < VEG_SPECIES * 2; s++) if (!(this.atlases && s % 2)) a.drawIndirect(this.argsBuf, s * 16);
        if (!this.atlases) return;
        a.setPipeline(pipes.imposter);
        for (let sp = 0; sp < VEG_SPECIES; sp++) {
            a.setBindGroup(2, this.farGroups[sp]);
            a.setBindGroup(3, this.atlases[sp].bg);
            a.drawIndirect(this.argsBuf, (sp * 2 + 1) * 16);
        }
    }

    destroy() {
        this.destroyed = true;
        for (const b of [this.vertexBuf, this.instBuf, this.argsBuf]) b.destroy();
        this.atlases?.forEach(at => at.destroy());
    }
}

return { VegetationPass, plantMeshes };
});
