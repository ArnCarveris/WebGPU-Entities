'use strict';
// The structures as the renderer draws them (its RendererExtension, renderer.ext.structures): their meshes and the bulk
// geometry of a real place, the buildings' interiors, lift boxes, doors and panes, the distant lights and the fake street
// lamps' poles, the windows' glass, the world-space GUIs (the lifts' panels); the buildings' records the shaders read.

Features.feature('atmosphere/structures', (engine, kit) => {
const { Common, kits } = engine;
const { makeBuffer, frustumPlanes, GroundFrame } = Common;
const { GuiAtlas, DeviceContext, WorldGuiPass } = kits.gui;
const { FAR_FLOATS, MAX_FAR_DYN, FAR_LAMP_H, FAR_LAMP_REACH, MAX_POLES, BUS_UNIFORM } = kit;
const { STRUCT_FLOATS, BUILDING_FLOATS, STRUCT_COLORS, Structures, MAX_BLOCKERS, BLOCK_GRID, MAX_DRIPS } = kits.settlement;
const { TiledMesh } = kits.mesh;
const { BOX_FLOATS } = kits.transit;
const MAX_BOXES = 4096;          // lift parts drawn a frame (vsBox)
const MAX_ORIGINS = 96;          // buildings whose interiors (and lifts) are drawn a frame, each in its Origin's frame (busData slots)
const MAX_PANELS = 16;           // world-space GUIs drawn a frame (the GUI pass's default; render.gui.max)

// a structure mesh vertex (Structures: STRUCT_FLOATS): position, normal, colour + material
const STRUCT_VERTS = [{
    arrayStride: STRUCT_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x4' }],
}];

class StructuresRenderer {
    static key = 'structures';

    constructor(r) { this.r = r; }

    // (what the lifts' panels' GUIs attach to: the device, and dc, the device context over the atlas)
    get device() { return this.r.device; }

    // the frame uniform's structure boxes (WGSL_BLOCKERS) and the roof edges the rain drips off (WGSL_DRIP)
    get frame() {
        return [
            ['blocks', 'vec4f'],    // structure boxes: count, lowest bottom, highest top (m), -
            ['blockBox', 'vec4f'],  // their bounds x0, z0, x1, z1, padded for the shadows and rain shadows they cast
            ['dripEdges', `array<vec4f, ${MAX_DRIPS * 3}>`], // [x, z, half x, half z] [cos yaw, sin yaw, edge height, drop to the ground] [share of drops up to this edge, edges (0 all four, 1 along local x), share of its drops kept, -]
            ['blockers', `array<vec4f, ${MAX_BLOCKERS * 3}>`], // [x, z, half x, half z] [cos yaw, sin yaw, bottom, top] [sky occlusion, slope, moving, enclosed]
            ['blockGrid', `array<vec4u, ${BLOCK_GRID * BLOCK_GRID}>`], // per cell of blockBox: bit k set if box k can shade a point in it
        ];
    }

    wgsl(lib, modules) {
        lib.define('BUILDING', kit.WGSL_BUILDING);
        lib.replace('BLOCKERS', kit.WGSL_BLOCKERS, { needs: ['BUILDING'] });
        lib.replace('SHELTERED_RAY', kit.WGSL_SHELTERED_RAY);
        lib.replace('DRIP', kit.WGSL_DRIP);
        lib.define('STRUCT', kit.WGSL_STRUCT, { needs: ['BUILDING', 'OBJECT1'] });
        lib.define('WINDOW', kit.WGSL_WINDOW, { needs: ['BUILDING'] });
        modules.scene.push('STRUCT');
        modules.final.push('WINDOW');
    }

    pipelines({ scene, final, layoutA, layoutB, layoutBus, pipe, blendAlpha }) {
        const r = this.r, d = r.device, structVerts = STRUCT_VERTS;
        this.pStruct = pipe(layoutA, scene, 'vsStruct', 'fsStruct', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        // big static geometry (Structures.bulk, the mesh kit's TiledMesh: a real place's roads and buildings): indexed,
        // position + colour word, flat-shaded
        this.pBulk = pipe(layoutA, scene, 'vsBulk', 'fsBulk', 'rgba16float', { write: true, compare: 'greater' }, undefined, [{
            arrayStride: TiledMesh.FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'unorm8x4' }] }]);
        // buildings (Buildings.add): interiors near them, door leaves, the opaque panes far off, the glass near
        this.pInterior = pipe(layoutBus, scene, 'vsInterior', 'fsInterior', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        // the lifts' parts: a unit cube per instance (Lifts.instances), shaded as the interior they stand in
        const boxVerts = [structVerts[0], { arrayStride: BOX_FLOATS * 4, stepMode: 'instance', attributes: [3, 4, 5].map((k, i) => ({ shaderLocation: k, offset: i * 16, format: 'float32x4' })) }];
        this.pBox = pipe(layoutBus, scene, 'vsBox', 'fsInterior', 'rgba16float', { write: true, compare: 'greater' }, undefined, boxVerts);
        const U = new Structures(null);
        U.cur = [];
        U.prism(new GroundFrame([0, 0], 0), 0, 0, 1, 1, -1, 1, [1, 1, 1], 0);
        const cm = new Float32Array(U.cur);
        this.cube = { n: cm.length / STRUCT_FLOATS, buf: makeBuffer(d, cm.byteLength, GPUBufferUsage.VERTEX, cm) };
        this.pDoor = pipe(layoutA, scene, 'vsStruct', 'fsDoor', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        this.pPane = pipe(layoutA, scene, 'vsStruct', 'fsPane', 'rgba16float', { write: true, compare: 'greater' }, undefined, structVerts);
        // the distant lights (vsFar): a quad per instance, added
        const farVerts = [{ arrayStride: FAR_FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map(k => ({ shaderLocation: k, offset: k * 16, format: 'float32x4' })) }];
        const blendSum = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
        this.pFar = pipe(layoutA, scene, 'vsFar', 'fsFar', 'rgba16float', { write: false, compare: 'greater' }, blendSum, farVerts);
        this.pFarPool = pipe(layoutA, scene, 'vsFarPool', 'fsFarPool', 'rgba16float', { write: false, compare: 'greater' }, blendSum, farVerts);
        const poleVerts = [structVerts[0], { arrayStride: 32, stepMode: 'instance', attributes: [3, 4].map((k, i) => ({ shaderLocation: k, offset: i * 16, format: 'float32x4' })) }];
        this.pFarPole = pipe(layoutA, scene, 'vsFarPole', 'fsStruct', 'rgba16float', { write: true, compare: 'greater' }, undefined, poleVerts);
        // one street lamp in its own frame (as Fixtures.lamp builds it, head FAR_LAMP_H up), for every fake one drawn
        const T = new Structures(null), f = new GroundFrame([0, 0], 0), h = FAR_LAMP_H + 0.3, reach = FAR_LAMP_REACH, C = STRUCT_COLORS;
        T.cur = [];
        T.prism(f, 0, 0, 0.08, 0.08, -0.3, h, C.metal, 4);
        T.prism(f, reach / 2, 0, reach / 2, 0.04, h - 0.07, h, C.metal, 4);
        T.prism(f, reach, 0, 0.34, 0.15, h - 0.14, h + 0.04, C.metal, 4);
        T.prism(f, reach, 0, 0.29, 0.12, h - 0.19, h - 0.14, [1, 1, 1], 7);
        const pm = new Float32Array(T.cur);
        this.poleMesh = { n: pm.length / STRUCT_FLOATS, buf: makeBuffer(d, pm.byteLength, GPUBufferUsage.VERTEX, pm) };
        this.poleBuf = makeBuffer(d, MAX_POLES * 32, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this.poleCount = 0;
        this.pWindow = pipe(layoutB, final, 'vsWindow', 'fsWindow', r.format, { write: false, compare: 'greater' }, blendAlpha, structVerts);
    }

    // the world-space GUIs (the lifts' panels: the gui kit's WorldGuiPass, set up for the scenario's `render.gui` by
    // setGui); the box instances of the lifts (vsBox)
    async init() {
        const d = this.r.device;
        await GuiAtlas.loadFonts();
        this.atlas = new GuiAtlas();
        this.atlasView = this.atlas.upload(this.r);
        this.dc = new DeviceContext(this.atlas);
        this.panelDraws = [];
        this.setGui({});
        this.boxData = new Float32Array(MAX_BOXES * BOX_FLOATS);
        this.boxBuf = makeBuffer(d, this.boxData.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this.boxCount = 0;
        this.boxGroups = [];
        this.originCount = 0;
    }

    // How world-space GUIs are drawn (data: the scenario's `render.gui`: { mode: 'auto' (world-space while the stencil
    // has a value free for them, else render targets) | 'world' | 'target', max (GUIs a frame), rtMax (a target's
    // longest side, texels), glass ([r, g, b]: under the GUI, linear), stencil (bits the layout shares out; default the
    // depth target's) }): a stencil layout for the scene's depth, the GUI pass reserving its slot in it
    setGui(cfg = {}) {
        const r = this.r, key = JSON.stringify(cfg);
        if (this.guiKey === key) return;
        this.guiKey = key;
        this.stencil = r.stencilLayout(`scene ${key}`, Math.min(r.stencilBits, cfg.stencil ?? r.stencilBits));
        this.gui = new WorldGuiPass(r.device, { color: 'rgba16float', depth: { format: r.depthFormat, compare: 'greater' }, stencil: this.stencil,
            mode: cfg.mode ?? 'auto', max: cfg.max ?? MAX_PANELS, rtMax: cfg.rtMax ?? 512, ...(cfg.glass ? { glass: cfg.glass } : {}) });
        this.gui.reserve();
        this.stencil.resolve();
        this.gui.init();
        this.gui.registerMaterial('atlas', this.atlasView);
    }

    // the GUIs to draw this frame (EntityGUIs, placed)
    setPanels(list) { this.panelDraws = list.slice(0, this.gui.o.max); }

    // the buildings drawn a frame, each in its Origin's frame
    frames() { return MAX_ORIGINS; }

    setWorld(world) {
        const d = this.r.device, S = world.structures;
        this.structBuf?.destroy();
        const sv = new Float32Array(S.v);
        this.structCount = sv.length / STRUCT_FLOATS;
        this.structBuf = this.structCount ? makeBuffer(d, sv.byteLength, GPUBufferUsage.VERTEX, sv) : null;
        // the bulk geometry: one vertex and one index buffer, drawn by the tiles in view (bulkDraws)
        this.bulkV?.destroy();
        this.bulkI?.destroy();
        const bk = S.bulk.finish();
        this.bulkTiles = bk.tiles;
        this.bulkV = bk.indices.length ? makeBuffer(d, bk.vertices.byteLength, GPUBufferUsage.VERTEX, bk.vertices) : null;
        this.bulkI = bk.indices.length ? makeBuffer(d, bk.indices.byteLength, GPUBufferUsage.INDEX, bk.indices) : null;
        // the buildings: their records (WGSL_BUILDING), interiors (one vertex range each, drawn near them: interiorDraws),
        // window glass and far panes, and the door leaves (rewritten when one moves: writeDoors)
        const vb = arr => { const a = new Float32Array(arr); return { n: a.length / STRUCT_FLOATS, buf: a.length ? makeBuffer(d, a.byteLength, GPUBufferUsage.VERTEX, a) : null }; };
        for (const k of ['interior', 'glassV', 'paneV', 'doorV']) this[k]?.buf?.destroy();
        this.buildingBuf?.destroy();
        this.interior = vb(S.iv);
        this.glassV = vb(S.glass);
        this.paneV = vb(S.panes);
        const dm = S.doors.mesh();
        this.doorV = { n: dm.length / STRUCT_FLOATS, buf: dm.length ? makeBuffer(d, dm.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, new Float32Array(dm)) : null };
        const rec = S.buildings.buffer(BUILDING_FLOATS);          // (the records, then the planned storeys' codes)
        this.buildingBuf = makeBuffer(d, rec.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, rec);
        this.buildingRec = rec;
        this.interiorDraws = [];
        // the distant lights: the static ones (FarLights), then MAX_FAR_DYN slots for the buses' (LightWriter.writeFar)
        this.farBuf?.destroy();
        this.farStatic = world.far.lights.length / FAR_FLOATS;
        this.farBuf = makeBuffer(d, (this.farStatic + MAX_FAR_DYN) * FAR_FLOATS * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        if (this.farStatic) d.queue.writeBuffer(this.farBuf, 0, world.far.lights);
        this.farCount = 0;
        this.realFar = world.far.real;
    }

    bindings(res) { res.buildings = this.buildingBuf; }

    // the door leaves as they stand now (Doors.mesh, same size every time)
    writeDoors(mesh) { if (this.doorV.buf) this.r.device.queue.writeBuffer(this.doorV.buf, 0, new Float32Array(mesh)); }

    // the buildings' records again (their doors moved: the light through them, WGSL_BUILDING)
    writeBuildings(B) {
        B.list.forEach((b, i) => this.buildingRec.set(B.record(b), i * BUILDING_FLOATS));
        this.r.device.queue.writeBuffer(this.buildingBuf, 0, this.buildingRec, 0, B.list.length * BUILDING_FLOATS);
    }

    // the bulk tiles in view this frame, neighbouring ones merged: [[first index, count], ...]. A tile's box reaches down by
    // as much as the outdoors drawn curved lowers it at its far side (curveToRender), so no tile is culled where it shows
    bulkDraws() {
        const r = this.r, F = r.frame.data, o = r.frame.offsets, planes = frustumPlanes(F.subarray(o.viewProj, o.viewProj + 16), { reversed: true });
        const cam = [F[o.cam], F[o.cam + 1], F[o.cam + 2]], R = F[o.curve + 3] || 6371000, out = [];
        this.bulkSeen = 0;
        for (const t of this.bulkTiles) {
            const b = t.box, far = Math.hypot(Math.max(Math.abs(cam[0] - b[0]), Math.abs(cam[0] - b[3])), Math.max(Math.abs(cam[2] - b[2]), Math.abs(cam[2] - b[5])));
            const lo = [b[0], b[1] - far * far / (2 * R), b[2]], hi = [b[3], b[4], b[5]];
            if (planes.some(p => p[0] * (p[0] > 0 ? hi[0] : lo[0]) + p[1] * (p[1] > 0 ? hi[1] : lo[1]) + p[2] * (p[2] > 0 ? hi[2] : lo[2]) + p[3] < 0)) continue;
            const last = out[out.length - 1];
            if (last && last[0] + last[1] === t.first) last[1] += t.count; else out.push([t.first, t.count]);
            this.bulkSeen++;
        }
        return out;
    }

    // the world-space GUIs' uniforms (the fallback: their targets, when their models changed), lit as the lamps are, the
    // eye adapted; the lift boxes' instances
    prepare(enc) {
        const r = this.r, q = r.device.queue, Fd = r.frame.data, fo = r.frame.offsets;
        if (this.boxCount) q.writeBuffer(this.boxBuf, 0, this.boxData, 0, this.boxCount * BOX_FLOATS);
        this.gui.prepare(enc, this.panelDraws, Fd.subarray(fo.viewProj, fo.viewProj + 16), 0.9 / Math.max(Fd[fo.sunCol + 3], 0.2));
    }

    outdoor(a) {
        if (this.structCount) {
            a.setPipeline(this.pStruct);
            a.setVertexBuffer(0, this.structBuf);
            a.draw(this.structCount);
        }
        if (this.bulkV) {
            a.setPipeline(this.pBulk);
            a.setVertexBuffer(0, this.bulkV);
            a.setIndexBuffer(this.bulkI, 'uint32');
            for (const [first, count] of this.bulkDraws()) a.drawIndexed(count, 1, first);
        }
    }

    // buildings: interiors within INTERIOR_DRAW (vertex ranges, nearest first): a storey many share is drawn instanced
    // ([first, count, storeys, how many storeys up the first is]), each in its building's Origin frame (the slot
    // FrameWriter gave it); the lift boxes; the world-space GUIs
    indoor(a) {
        const r = this.r;
        if (this.interiorDraws.length) {
            a.setPipeline(this.pInterior);
            a.setVertexBuffer(0, this.interior.buf);
            let slot = -1;
            for (const [first, count, inst, base, , k] of this.interiorDraws) {
                if (k !== slot) { a.setBindGroup(1, r.busGroup, [k * BUS_UNIFORM]); slot = k; }
                a.draw(count, inst, first, base);
            }
        }
        if (this.boxCount) {
            a.setPipeline(this.pBox);
            a.setVertexBuffer(0, this.cube.buf);
            a.setVertexBuffer(1, this.boxBuf);
            for (const g of this.boxGroups) { a.setBindGroup(1, r.busGroup, [g.slot * BUS_UNIFORM]); a.draw(this.cube.n, g.count, 0, g.first); }
        }
        if (this.panelDraws.length) { this.gui.draw(a); a.setBindGroup(0, r.worldGroup); }
    }

    // the door leaves, the panes of the windows further off (fsPane drops those of the near ones), the fake street lamps'
    // poles and the distant lights
    late(a) {
        if (this.doorV.n) { a.setPipeline(this.pDoor); a.setVertexBuffer(0, this.doorV.buf); a.draw(this.doorV.n); }
        if (this.paneV.n) { a.setPipeline(this.pPane); a.setVertexBuffer(0, this.paneV.buf); a.draw(this.paneV.n); }
        if (this.poleCount) {
            a.setPipeline(this.pFarPole);
            a.setVertexBuffer(0, this.poleMesh.buf);
            a.setVertexBuffer(1, this.poleBuf);
            a.draw(this.poleMesh.n, this.poleCount);
        }
        if (this.farCount) {
            a.setVertexBuffer(0, this.farBuf);
            if (this.realFar[1]) { a.setPipeline(this.pFarPool); a.draw(6, this.realFar[1], 0, this.realFar[0]); }
            a.setPipeline(this.pFar);
            a.draw(6, this.farCount);
        }
    }

    // the buildings' window glass after the rain (fsWindow drops the panes of buildings beyond INTERIOR_DRAW)
    final(b) {
        if (this.glassV.n && this.interiorDraws.length) { b.setPipeline(this.pWindow); b.setVertexBuffer(0, this.glassV.buf); b.draw(this.glassV.n); }
    }
}

return { StructuresRenderer, STRUCT_VERTS };
});
