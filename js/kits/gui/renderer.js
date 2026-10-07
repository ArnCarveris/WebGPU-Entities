'use strict';
// The renderer: device, pipelines, instances, GUI materials, views and scene passes.

Features.kit('gui', (engine, kit) => {
const { MeshBuilder, GuiSurface, sceneShader, VIDEO_SHADER } = kit;
const { StencilLayout, buildPipelines } = engine.kits.gpu;

// WebGPU renderer: device, pipelines, instance data, GUI materials and views (view targets: views.js).

const UNIFORM_FLOATS = 76;       // viewProj 16 + camPos 4 + params 4 + 6 lights * 8 + env 4
const MAX_LIGHTS = 6;
const INSTANCE_FLOATS = 20;      // model 16 + tint 4
const GUI_STRIDE = 8;            // x y u v r g b a
const DEPTH_FORMAT = 'depth24plus-stencil8';
const CLEAR_COLOR = { r: 0.004, g: 0.005, b: 0.007, a: 1 };

const WORLD_VERTEX_LAYOUT = {
    arrayStride: 9 * 4,
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'float32' }
    ]
};
const GUI_VERTEX_LAYOUT = {
    arrayStride: GUI_STRIDE * 4,
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32x4' }
    ]
};
const ALPHA_BLEND = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
};

async function checkShaderModule(module) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
        throw new Error('WGSL compile error:\n' + errors.map((m) => `L${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    }
}

class Renderer {
    // fx: the feature context (the host's device, canvas size and target; see js/engine/host.js)
    constructor(fx) {
        this.fx = fx;
        this.pipelines = {};
        this.materials = new Map();     // name -> { shading, view, version }
        this.instanceCount = 0;
        // the depth-stencil target's bits, by name (js/kits/gpu/stencil.js): GUI surfaces reserve theirs with
        // reserveSurfaces() before createPipelines()
        this.stencil = new StencilLayout();
        this.surfaceSlot = null;
        this.surfaces = 0;
        this.useStencil = true;         // false = GUI surfaces rely on the depth test alone (z-fights)
        this.onError = null;
        this.mirror = null;             // another renderer (the handheld's) that gets this one's GUI materials too
    }

    async init() {
        this.device = this.fx.device;
        this.format = this.fx.format;
        this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.resize();
    }

    get aspect() {
        return this.width / this.height;
    }

    // the world's depth (sampled by a composition, js/engine/compositor.js) and the phone's own, so the view model
    // never clips into a wall nor clears the world's depth
    resize() {
        const [w, h] = this.fx.size();
        if (!this.device || (w === this.width && h === this.height)) return;
        this.width = w;
        this.height = h;
        for (const t of [this.depthTexture, this.phoneDepth]) t?.destroy();
        const U = GPUTextureUsage;
        this.depthTexture = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
        this.depthView = this.depthTexture.createView();
        this.depthSample = this.depthTexture.createView({ aspect: 'depth-only' });
        this.phoneDepth = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: U.RENDER_ATTACHMENT });
        this.phoneDepthView = this.phoneDepth.createView();
    }

    // ---- resources ----
    createBuffer(size, usage) {
        return this.device.createBuffer({ size, usage });
    }

    createMesh(builder) {
        const data = builder.toFloat32();
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return { buffer, count: data.length / 9 };
    }

    // Instances are allocated by entities / GUIs during setup; the buffer is created afterwards
    allocInstances(n = 1) {
        if (this.instanceData) throw new Error('allocInstances after finalizeInstances');
        const first = this.instanceCount;
        this.instanceCount += n;
        return first;
    }

    finalizeInstances() {
        this.instanceData = new Float32Array(this.instanceCount * INSTANCE_FLOATS);
        this.instanceBuffer = this.createBuffer(this.instanceData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    }

    setInstance(index, matrix, tint = null) {
        const o = index * INSTANCE_FLOATS;
        this.instanceData.set(matrix, o);
        this.instanceData.fill(0, o + 16, o + 20);
        if (tint) this.instanceData.set(tint, o + 16);
    }

    // GUI surfaces mask their quads with a stencil value of their own, so one GUI never draws through another: `n`
    // values of the "gui.surface" slot. It may get fewer (the layout's other users come first); a surface without
    // one falls back to the depth test.
    reserveSurfaces(n) {
        this.surfaceSlot = this.stencil.reserve('gui.surface', { values: Math.max(1, n), min: 0 });
    }

    // an EntityGUI on this renderer (EntityGUI.attach): its surface geometry ("anchor"), instances and stencil value
    bindGui(gui) {
        const slot = this.surfaceSlot, i = ++this.surfaces;
        gui.stencilRef = slot && i <= slot.capacity ? slot.ref(i) : null;
        gui.anchorInstance = this.allocInstances(1);
        gui.guiInstance = this.allocInstances(1);
        gui.anchorMesh = this.createMesh(new MeshBuilder(this.worldMaterials).surface(gui.tri, gui.def.anchorMaterial || 'glass'));
    }

    writeGui(gui) {
        this.setInstance(gui.anchorInstance, gui.surfaceMatrix);
        this.setInstance(gui.guiInstance, GuiSurface.modelMatrix(gui.tri, gui.surfaceMatrix, gui.vw, gui.vh), [gui.crt ? 1 : 0, 0, 0, 0]);
    }

    // ---- pipelines: a table (js/kits/gpu/pipelines.js) over the resolved stencil layout ----
    async createPipelines() {
        const device = this.device;
        const module = device.createShaderModule({ code: sceneShader() });
        const videoModule = device.createShaderModule({ code: VIDEO_SHADER });
        await checkShaderModule(module);
        await checkShaderModule(videoModule);

        const layoutEntries = (viewDimension) => [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
        ];
        this.groupLayouts = {
            '2d': device.createBindGroupLayout({ entries: layoutEntries('2d') }),
            '2d-array': device.createBindGroupLayout({ entries: layoutEntries('2d-array') })
        };
        const ctx = {
            device, format: this.format, depthFormat: DEPTH_FORMAT, samples: 1, stencil: this.stencil.resolve(),
            modules: { scene: module, video: videoModule },
            layouts: {
                '2d': device.createPipelineLayout({ bindGroupLayouts: [this.groupLayouts['2d']] }),
                '2d-array': device.createPipelineLayout({ bindGroupLayouts: [this.groupLayouts['2d-array']] })
            },
            buffers: { world: [WORLD_VERTEX_LAYOUT], gui: [GUI_VERTEX_LAYOUT] },
            blends: { alpha: ALPHA_BLEND }
        };
        const surface = this.surfaceSlot ? ['gui.surface'] : null;
        // GUI model shading: stencil-masked (depth ALWAYS + its surface's value) or plain depth-tested
        const gui = (fs, extra = {}) => ({
            layout: '2d', module: 'scene', vs: 'vs_gui', fs, buffers: 'gui', blend: 'alpha', ...extra,
            variants: {
                stencil: { depth: { compare: 'always' }, stencil: surface && { test: surface } },
                depth: { depth: { compare: 'less-equal' } }
            }
        });
        const P = buildPipelines(ctx, {
            scene: { layout: '2d', module: 'scene', vs: 'vs_main', fs: 'fs_scene', buffers: 'world', depth: { write: true, compare: 'less' } },
            // GUI surface geometry ("anchor"): writes its surface's value wherever it survives the depth test
            anchor: {
                layout: '2d', module: 'scene', vs: 'vs_main', fs: 'fs_scene', buffers: 'world', depth: { write: true, compare: 'less' },
                stencil: surface && { op: 'replace', write: surface }
            },
            gui: gui('fs_gui'),
            cctv: gui('fs_cctv'),
            video: gui('fs_video', { layout: '2d-array', fsModule: 'video' })
        });
        this.pipelines = { scene: P.scene, anchor: P.anchor };
        this.shadings = {
            gui: { layout: '2d', ...P.gui },
            cctv: { layout: '2d', ...P.cctv },
            video: { layout: '2d-array', ...P.video }
        };
    }

    // ---- World materials: the scenario's material table, indexed by the mesh vertices' material id ----
    setWorldMaterials(table) {
        this.worldMaterials = table;
        this.worldMaterialBuffer = this.createBuffer(table.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        this.device.queue.writeBuffer(this.worldMaterialBuffer, 0, table.data);
    }

    // ---- GUI materials: a named texture + a shading ----
    registerMaterial(name, shading, textureView) {
        if (!this.shadings[shading]) throw new Error(`Unknown shading "${shading}"`);
        this.materials.set(name, { shading, view: textureView, version: 0 });
        if (this.mirror && name !== 'atlas') this.mirror.registerMaterial(name, shading, textureView);
    }

    setMaterialTexture(name, textureView) {
        const m = this.materials.get(name);
        m.view = textureView;
        m.version++;
        if (this.mirror && name !== 'atlas') this.mirror.setMaterialTexture(name, textureView);
    }

    // Lends this renderer's GUI materials (view targets: CCTV, viewfinder, photos...) to `other`, now and later
    mirrorTo(other) {
        this.mirror = other;
        for (const [name, m] of this.materials) if (name !== 'atlas') other.registerMaterial(name, m.shading, m.view);
    }

    createView() {
        return new RenderView(this);
    }

    // Bind group for (view, material), cached per view until the material's texture changes
    groupFor(view, name) {
        if (view.exclude.has(name)) return null;
        const mat = this.materials.get(name);
        if (!mat) return null;
        const cached = view.groups.get(name);
        if (cached && cached.version === mat.version) return cached.group;
        const layout = this.groupLayouts[this.shadings[mat.shading].layout];
        const group = this.device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: { buffer: view.buffer } },
                { binding: 1, resource: { buffer: this.instanceBuffer } },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: mat.view },
                { binding: 4, resource: { buffer: this.worldMaterialBuffer } }
            ]
        });
        view.groups.set(name, { version: mat.version, group });
        return group;
    }

    // ---- frames & passes ----
    beginFrame() {
        this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData);
        this.encoder = this.device.createCommandEncoder();
        this.swapView = this.fx.target();
        return this.encoder;
    }

    endFrame() {
        this.device.queue.submit([this.encoder.finish()]);
        this.encoder = null;
    }

    depthAttachment(view) {
        return {
            view,
            depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
            stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store'
        };
    }

    // A scene pass into `colorView`. `load` keeps what's already there (the phone draws over the world).
    beginScenePass(colorView, depthView, view, { load = false, forceStencil = false } = {}) {
        const pass = this.encoder.beginRenderPass({
            colorAttachments: [{ view: colorView, clearValue: CLEAR_COLOR, loadOp: load ? 'load' : 'clear', storeOp: 'store' }],
            depthStencilAttachment: this.depthAttachment(depthView)
        });
        return new ScenePass(this, pass, view, forceStencil);
    }
}

// Per-camera uniforms and the bind groups that use them
class RenderView {
    constructor(renderer) {
        this.renderer = renderer;
        this.buffer = renderer.createBuffer(UNIFORM_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        this.groups = new Map();
        this.exclude = new Set();       // materials this view can't sample (its own render target)
        this.data = new Float32Array(UNIFORM_FLOATS);
    }

    // frame: { time, lightsOn, alarmPulse, lights: up to 6 x [x, y, z, intensity, r, g, b, 0] }
    update(viewProj, eye, frame) {
        const u = this.data;
        u.fill(0);
        u.set(viewProj, 0);
        u.set([eye[0], eye[1], eye[2], 1], 16);
        u.set([frame.time, frame.lightsOn ? 1 : 0, frame.alarmPulse, 0], 20);
        frame.lights.slice(0, MAX_LIGHTS).forEach((l, i) => u.set(l, 24 + i * 8));
        u.set([frame.fog ?? 0.05, frame.ambient ?? 0, 0, 0], 72);
        this.renderer.device.queue.writeBuffer(this.buffer, 0, u);
    }

    group(material) {
        return this.renderer.groupFor(this, material);
    }
}

// Thin wrapper over a render pass that avoids redundant pipeline / bind-group switches
class ScenePass {
    constructor(renderer, pass, view, forceStencil) {
        this.renderer = renderer;
        this.pass = pass;
        this.view = view;
        this.forceStencil = forceStencil;
        this.pipeline = null;
        this.bindGroup = null;
    }

    use(pipeline, group) {
        if (pipeline !== this.pipeline) { this.pass.setPipeline(pipeline); this.pipeline = pipeline; }
        if (group !== this.bindGroup) { this.pass.setBindGroup(0, group); this.bindGroup = group; }
    }

    mesh(mesh, firstInstance, count = 1) {
        this.use(this.renderer.pipelines.scene, this.view.group('atlas'));
        this.pass.setVertexBuffer(0, mesh.buffer);
        this.pass.draw(mesh.count, count, 0, firstInstance);
    }

    // an EntityGUI: its surface geometry marks its visible pixels with its stencil value, then its model's surfaces
    // draw, each material with its shading's pipeline and texture
    surface(gui) {
        const ref = gui.stencilRef;
        this.use(ref == null ? this.renderer.pipelines.scene : this.renderer.pipelines.anchor, this.view.group('atlas'));
        if (ref != null) this.pass.setStencilReference(ref);
        this.pass.setVertexBuffer(0, gui.anchorMesh.buffer);
        this.pass.draw(gui.anchorMesh.count, 1, 0, gui.anchorInstance);
        this.gui(gui.model, gui.guiInstance, ref);
    }

    // A GUI model's surfaces; each material picks its shading pipeline and texture. `stencilRef` null: depth-tested
    gui(model, instance, stencilRef) {
        if (!model.count) return;
        const r = this.renderer;
        const stencil = stencilRef != null && (r.useStencil || this.forceStencil);
        if (stencil) this.pass.setStencilReference(stencilRef);
        this.pass.setVertexBuffer(0, model.buffer);
        for (const surf of model.surfaces) {
            const group = this.view.group(surf.material);
            if (!group) continue;
            const shading = r.shadings[r.materials.get(surf.material).shading];
            this.use(stencil ? shading.stencil : shading.depth, group);
            this.pass.draw(surf.count, 1, surf.first, instance);
        }
    }

    end() {
        this.pass.end();
    }
}

return { UNIFORM_FLOATS, MAX_LIGHTS, INSTANCE_FLOATS, GUI_STRIDE, DEPTH_FORMAT, CLEAR_COLOR, WORLD_VERTEX_LAYOUT, GUI_VERTEX_LAYOUT, ALPHA_BLEND, checkShaderModule, Renderer, RenderView, ScenePass };
});
