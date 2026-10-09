'use strict';
// LineLayer: debug lines ([x, y, z, r, g, b, a] per vertex, line-list) drawn into a render pass: the ones depth-tested
// against the scene, then the overlay ones over it. Any renderer draws a world's sector and portal frames
// (kits.interior VisInspector.lines) with it.

Features.kit('gpu', (engine, kit) => {
const WGSL_LINES = /* wgsl */`
struct U { m: mat4x4f, gain: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) pos: vec4f, @location(0) col: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec4f) -> V {
    var o: V;
    o.pos = u.m * vec4f(p, 1.0);
    o.col = c;
    return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f { return vec4f(i.col.rgb * u.gain.x, i.col.a); }
`;

// device; o: { format (the pass's colour target), depth { format, compare ('greater' for reversed-Z) } | null, stencil
// (the depth format has one: the pipelines keep it) }
class LineLayer {
    constructor(device, { format, depth = null }) {
        this.device = device;
        const d = device, module = d.createShaderModule({ code: WGSL_LINES });
        this.ubuf = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
        this.group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
        const pipe = compare => d.createRenderPipeline({
            layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
            vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }] },
            fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
            primitive: { topology: 'line-list' },
            ...(depth ? { depthStencil: { format: depth.format, depthWriteEnabled: false, depthCompare: compare } } : {}),
        });
        this.pDepth = pipe(depth ? depth.compare : 'always');
        this.pOverlay = pipe('always');
        this.buf = null;
        this.count = 0;
        this.depthCount = 0;
    }

    // lines: { data, depthCount }; m: the view-projection they are drawn with (about whatever point they were built
    // about); gain: their colour scale (an HDR target's exposure)
    write(lines, m, gain = 1) {
        const d = this.device, data = lines?.data;
        this.count = data ? data.length / 7 : 0;
        this.depthCount = lines?.depthCount || 0;
        if (!this.count) return;
        if (!this.buf || this.buf.size < data.byteLength) {
            this.buf?.destroy();
            this.buf = d.createBuffer({ size: Math.max(4096, data.byteLength * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        d.queue.writeBuffer(this.buf, 0, data);
        const u = new Float32Array(20);
        u.set(m);
        u[16] = gain;
        d.queue.writeBuffer(this.ubuf, 0, u);
    }

    draw(pass) {
        if (!this.count) return;
        pass.setBindGroup(0, this.group);
        pass.setVertexBuffer(0, this.buf);
        if (this.depthCount) { pass.setPipeline(this.pDepth); pass.draw(this.depthCount); }
        if (this.count > this.depthCount) { pass.setPipeline(this.pOverlay); pass.draw(this.count - this.depthCount, 1, this.depthCount); }
    }
}

return { LineLayer };
});
