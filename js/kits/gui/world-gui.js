'use strict';
// WorldGuiPass: EntityGUIs as world-space surfaces in any renderer's scene pass. World-space first: each GUI's glass
// sets a stencil slot where it is seen, its quads draw into that mask (depth ALWAYS: they lie on the glass), the glass
// clears it again. When the renderer's stencil layout has no free value for the slot (or the depth target has no
// stencil, or the data asks for it), the fallback: each GUI drawn into a render target of its own (GuiTargets, only
// when its model changed) and its glass shows that texture.

Features.kit('gui', (engine, kit) => {
const { GuiTargets, GUI_VERTEX_LAYOUT } = kit;
const UNIFORM = 256;                // bytes per GUI (a dynamic offset)

// glass and quads: the GUI's surface matrix (columns right, up, normal in metres, its centre) and its size place
// virtual units (x right, y down from the top) on it; colours come out linear, times `gain` (the host's exposure)
const WGSL = /* wgsl */`
struct G { viewProj: mat4x4f, surface: mat4x4f, size: vec4f, glass: vec4f };    // size: w, h (m), vw, vh; glass: rgb, gain
@group(0) @binding(0) var<uniform> P: G;
@group(1) @binding(0) var guiSampler: sampler;
@group(1) @binding(1) var guiTex: texture_2d<f32>;

fn place(v: vec2f, z: f32) -> vec4f {
    let l = vec3f((v.x / P.size.z - 0.5) * P.size.x, (0.5 - v.y / P.size.w) * P.size.y, z);
    return P.viewProj * (P.surface * vec4f(l, 1.0));
}

struct GO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsGlass(@builtin(vertex_index) i: u32) -> GO {
    let c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0))[i];
    var o: GO;
    o.pos = place(c * P.size.zw, 0.0015);
    o.uv = c;
    return o;
}
fn lin(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)) * P.glass.w; }
// the glass under the quads (world-space): dark
@fragment fn fsGlass(i: GO) -> @location(0) vec4f { return vec4f(P.glass.rgb, 1.0); }
// the fallback: the glass showing the GUI's target (premultiplied alpha)
@fragment fn fsTarget(i: GO) -> @location(0) vec4f {
    let t = textureSample(guiTex, guiSampler, i.uv);
    return vec4f(lin(t.rgb / max(t.a, 1e-4)) * t.a + P.glass.rgb * (1.0 - t.a), 1.0);
}

struct QO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vsQuad(@location(0) p: vec2f, @location(1) uv: vec2f, @location(2) c: vec4f) -> QO {
    var o: QO;
    o.pos = place(p, 0.003);
    o.uv = uv;
    o.color = c;
    return o;
}
@fragment fn fsQuad(i: QO) -> @location(0) vec4f {
    let c = textureSample(guiTex, guiSampler, i.uv) * i.color;
    if (c.a < 0.004) { discard; }
    return vec4f(lin(c.rgb), c.a);
}
`;

// device; o: { color (the scene target's format), depth { format, compare (the scene's: 'greater' for reversed Z),
// write }, stencil (the renderer's gpu-kit StencilLayout, or null: none), slot (its name), mode ('auto': world-space
// when the slot gets a value, else targets; 'world'; 'target'), max (GUIs a frame), rtMax (a target's longest side),
// glass ([r, g, b] linear) }. Lifecycle: reserve() before the layout resolves, init() after, then per frame
// prepare(enc, guis, viewProj, gain) before the scene pass and draw(pass) in it
class WorldGuiPass {
    constructor(device, o) {
        this.device = device;
        this.o = { slot: 'gui.surface', mode: 'auto', max: 16, rtMax: 512, glass: [0.004, 0.005, 0.006], ...o };
        this.slot = null;
        this.materials = new Map();         // name -> bind group (sampler + texture): the GUIs' surfaces' textures
        this.list = [];
    }

    // its stencil slot (one value, may get none), unless the data says targets only
    reserve() {
        const { stencil, mode, slot } = this.o;
        if (stencil && mode !== 'target' && stencil.bits > 0) this.slot = stencil.reserve(slot, { values: 1, min: 0 });
    }

    // the mode it ended up in, and its pipelines
    init() {
        const d = this.device, o = this.o, S = GPUShaderStage;
        this.mode = this.slot?.capacity > 0 ? 'world' : 'target';
        if (o.mode === 'world' && this.mode !== 'world') console.warn(`WorldGuiPass: no stencil value for "${o.slot}": GUIs drawn through render targets`);
        this.uniformLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
        this.texLayout = d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
        ] });
        this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.ubuf = d.createBuffer({ size: o.max * UNIFORM, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.udata = new Float32Array(o.max * UNIFORM / 4);
        this.ugroup = d.createBindGroup({ layout: this.uniformLayout, entries: [{ binding: 0, resource: { buffer: this.ubuf, size: 160 } }] });
        const module = d.createShaderModule({ code: WGSL }), layout = d.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout, this.texLayout] });
        const glassLayout = d.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout] });
        const hasStencil = /stencil/.test(o.depth.format);
        const st = (compare, passOp) => {
            if (!hasStencil) return {};
            const m = this.slot?.capacity > 0 ? this.slot.mask : 0;
            const face = { compare, passOp, failOp: 'keep', depthFailOp: 'keep' };
            return { stencilFront: face, stencilBack: face, stencilReadMask: m, stencilWriteMask: m };
        };
        const pipe = (label, vs, fs, { pl = layout, buffers = [], blend, depth, stencil = st('always', 'keep'), colorWrite = true }) => d.createRenderPipeline({
            label, layout: pl, vertex: { module, entryPoint: vs, buffers },
            fragment: { module, entryPoint: fs, targets: [{ format: o.color, blend, writeMask: colorWrite ? GPUColorWrite.ALL : 0 }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: o.depth.format, ...depth, ...stencil },
        });
        const D = { depthWriteEnabled: true, depthCompare: o.depth.compare === 'greater' ? 'greater-equal' : 'less-equal' };
        const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
        if (this.mode === 'world') {
            this.pAnchor = pipe('gui.anchor', 'vsGlass', 'fsGlass', { pl: glassLayout, depth: D, stencil: st('always', 'replace') });
            this.pQuad = pipe('gui.quads', 'vsQuad', 'fsQuad', { buffers: [GUI_VERTEX_LAYOUT], blend, depth: { depthWriteEnabled: false, depthCompare: 'always' }, stencil: st('equal', 'keep') });
            this.pUnanchor = pipe('gui.unanchor', 'vsGlass', 'fsGlass', { pl: glassLayout, depth: { depthWriteEnabled: false, depthCompare: D.depthCompare }, stencil: st('always', 'zero'), colorWrite: false });
        } else {
            this.targets = new GuiTargets(d, 'rgba8unorm', { max: o.rtMax, layout: this.texLayout });
            this.targetGroups = new WeakMap();
            this.pTarget = pipe('gui.target', 'vsGlass', 'fsTarget', { depth: D });
        }
        return this;
    }

    registerMaterial(name, view) {
        const g = this.device.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: view }] });
        this.materials.set(name, g);
        this.targets?.materials.set(name, g);
    }

    // this frame's GUIs (EntityGUI: surfaceMatrix, width, height, vw, vh, model), the scene's view-projection (world:
    // the GUIs' surface matrices are in its space), gain (the host's exposure on their light)
    prepare(enc, guis, viewProj, gain = 1) {
        const o = this.o, U = this.udata, F = UNIFORM / 4;
        this.list = guis.slice(0, o.max);
        this.list.forEach((g, i) => {
            U.set(viewProj, i * F);
            U.set(g.surfaceMatrix, i * F + 16);
            U.set([g.width, g.height, g.vw, g.vh, ...o.glass, gain], i * F + 32);
        });
        if (this.list.length) this.device.queue.writeBuffer(this.ubuf, 0, U, 0, this.list.length * F);
        if (this.mode === 'target') for (const g of this.list) {
            const rt = this.targets.update(enc, g);
            if (!this.targetGroups.has(rt)) this.targetGroups.set(rt, this.targets.group(rt.view));
            g._worldGuiGroup = this.targetGroups.get(rt);
        }
    }

    // into the scene pass (its depth-stencil target the one `depth` describes); ref: the stencil reference the slot's
    // value composes into (the renderer's StencilLayout.compose)
    draw(pass) {
        if (!this.list.length) return;
        if (this.mode === 'target') {
            pass.setPipeline(this.pTarget);
            this.list.forEach((g, i) => { pass.setBindGroup(0, this.ugroup, [i * UNIFORM]); pass.setBindGroup(1, g._worldGuiGroup); pass.draw(6); });
            return;
        }
        pass.setStencilReference(this.o.stencil.compose({ [this.o.slot]: 1 }));
        this.list.forEach((g, i) => {
            const m = g.model;
            pass.setBindGroup(0, this.ugroup, [i * UNIFORM]);
            pass.setPipeline(this.pAnchor);
            pass.draw(6);
            if (m?.count && m.buffer) {
                pass.setPipeline(this.pQuad);
                pass.setVertexBuffer(0, m.buffer);
                for (const surf of m.surfaces) {
                    const grp = this.materials.get(surf.material);
                    if (!grp) continue;
                    pass.setBindGroup(1, grp);
                    pass.draw(surf.count, 1, surf.first);
                }
            }
            pass.setPipeline(this.pUnanchor);
            pass.draw(6);
        });
    }
}

return { WorldGuiPass };
});
