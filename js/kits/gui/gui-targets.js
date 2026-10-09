'use strict';
// GuiTargets: EntityGUIs drawn into textures of their own, for a renderer that shows them as a texture on a surface
// (no stencil to mask them with, or a pass that cannot draw the GUI's quads itself).

Features.kit('gui', (engine, kit) => {
const { GUI_VERTEX_LAYOUT } = kit;

// a GUI model flat into its target: virtual screen units to clip space, premultiplied alpha
const WGSL_FLAT = /* wgsl */`
struct Flat { size: vec4f };
@group(0) @binding(0) var<uniform> F: Flat;
@group(1) @binding(0) var guiSampler: sampler;
@group(1) @binding(1) var guiTex: texture_2d<f32>;
struct O { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f, @location(2) c: vec4f) -> O {
    var o: O;
    o.pos = vec4f(p.x / F.size.x * 2.0 - 1.0, 1.0 - p.y / F.size.y * 2.0, 0.0, 1.0);
    o.uv = uv;
    o.color = c;
    return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
    let c = textureSample(guiTex, guiSampler, i.uv) * i.color;
    return vec4f(c.rgb * c.a, c.a);
}
`;

// Each GUI gets a target at its virtual screen's aspect, at most `max` texels on its longest side, redrawn only when its
// model changed (GuiModel.version), so a view that sees it again, or another view, costs nothing. Materials are the
// GUI's surfaces' textures: name -> bind group of `layout` (a filtering sampler, a float texture), the atlas's for one.
//   device, format (the targets'), { max, layout (to share the caller's material bind groups) }
class GuiTargets {
    constructor(device, format, { max = 1024, layout = null } = {}) {
        this.device = device;
        this.format = format;
        this.max = max;
        const S = GPUShaderStage;
        this.layout = layout || device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
        ] });
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        this.flatLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: S.VERTEX, buffer: { type: 'uniform' } }] });
        const module = device.createShaderModule({ code: WGSL_FLAT });
        this.pipe = device.createRenderPipeline({
            label: 'gui.flat',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.flatLayout, this.layout] }),
            vertex: { module, entryPoint: 'vs', buffers: [GUI_VERTEX_LAYOUT] },
            fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            } }] },
            primitive: { topology: 'triangle-list' },
        });
        this.targets = new WeakMap();
        this.materials = new Map();     // name -> bind group (layout)
    }

    // a material bind group for a texture view, with the targets' sampler
    group(view) {
        return this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: view }] });
    }

    registerMaterial(name, view) { this.materials.set(name, this.group(view)); }

    // the GUI's target: { texture, view, version }
    target(gui) {
        let rt = this.targets.get(gui);
        if (rt) return rt;
        const device = this.device, k = Math.min(1, this.max / Math.max(gui.vw, gui.vh));
        const texture = device.createTexture({
            size: [Math.max(1, Math.round(gui.vw * k)), Math.max(1, Math.round(gui.vh * k))], format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const size = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(size, 0, new Float32Array([gui.vw, gui.vh, 0, 0]));
        rt = { texture, view: texture.createView(), version: -1, flat: device.createBindGroup({ layout: this.flatLayout, entries: [{ binding: 0, resource: { buffer: size } }] }) };
        this.targets.set(gui, rt);
        return rt;
    }

    // draw the GUI's model into its target if it changed since; materials: name -> bind group (default: this one's);
    // skip: a material not to draw (a view target's own). Returns its target
    update(enc, gui, materials = this.materials, skip = null) {
        const rt = this.target(gui), m = gui.model;
        if (rt.version === m.version || !m.buffer) return rt;
        rt.version = m.version;
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: rt.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
        if (m.count) {
            pass.setPipeline(this.pipe);
            pass.setBindGroup(0, rt.flat);
            pass.setVertexBuffer(0, m.buffer);
            for (const surf of m.surfaces) {
                const mat = materials.get(surf.material), g = surf.material !== skip && (mat?.group ?? mat);
                if (!g) continue;
                pass.setBindGroup(1, g);
                pass.draw(surf.count, 1, surf.first);
            }
        }
        pass.end();
        return rt;
    }
}

return { GuiTargets };
});
