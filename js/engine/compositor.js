'use strict';
// Compositor: puts the worlds of a composition into one picture by depth.
//
// Each visible world renders its finished frame (its own sky, lighting, tonemapping) into a layer texture of the
// canvas format, with the same camera. Its depth buffer, whatever its convention (reversed-Z with an infinite far
// plane, classic 0..1 with a far plane, multisampled, with stencil), is turned into view depth in metres (linearize);
// then every pixel takes the colour of the nearest world. Where a world shows only sky, the others show through; where
// all do, the first world flagged `sky` (else the first) gives the sky.
//
// A world with layer role "atmosphere" (the cloud engine) does not take part in the merge: the merged picture and its
// depth are handed to it instead (merge into `inject`), it puts them into its own scene before its volumetrics, and
// its clouds, rain, haze and tonemapping then cover the other worlds too.

class Compositor {
    static MAX = 6;
    static KIND = { reversed: 0, standard: 1 };

    constructor(device, format) {
        this.device = device;
        this.format = format;
        const d = device;
        const fullscreen = /* wgsl */`
            @vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
                return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
            }`;
        const lin = (ms) => /* wgsl */`
            ${fullscreen}
            struct P { kind: f32, near: f32, far: f32, scale: f32 }
            @group(0) @binding(0) var<uniform> prm: P;
            @group(0) @binding(1) var dep: ${ms ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
            @fragment fn fsLin(@builtin(position) fp: vec4f) -> @location(0) vec4f {
                let d = textureLoad(dep, vec2i(fp.xy), 0);
                var z = 3.0e38;
                if (prm.kind < 0.5) {
                    if (d > 0.0) { z = prm.near / d; }
                } else {
                    if (d < 1.0) { z = prm.near * prm.far / (prm.far - d * (prm.far - prm.near)); }
                }
                return vec4f(min(z * prm.scale, 3.0e38), 0.0, 0.0, 0.0);
            }`;
        this.linLayout = [false, true].map(ms => d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled: ms } },
        ] }));
        this.linPipe = [false, true].map((ms, k) => {
            const module = d.createShaderModule({ label: `linearize${ms ? '-ms' : ''}`, code: lin(ms) });
            return d.createRenderPipeline({
                label: 'linearize', layout: d.createPipelineLayout({ bindGroupLayouts: [this.linLayout[k]] }),
                vertex: { module, entryPoint: 'vsFull' },
                fragment: { module, entryPoint: 'fsLin', targets: [{ format: 'r32float' }] },
            });
        });

        const N = Compositor.MAX;
        const decl = Array.from({ length: N }, (_, i) => `@group(0) @binding(${1 + i}) var c${i}: texture_2d<f32>;\n@group(0) @binding(${1 + N + i}) var z${i}: texture_2d<f32>;`).join('\n');
        const pick = Array.from({ length: N }, (_, i) => `
                if (${i}u < prm.count) {
                    let z = textureLoad(z${i}, p, 0).x;
                    if (z < bz) { bz = z; bc = textureLoad(c${i}, p, 0); }
                    if (z >= 3.0e38 && !gotSky && (prm.sky == ${i}u)) { sky = textureLoad(c${i}, p, 0); gotSky = true; }
                }`).join('');
        const merge = (mrt) => /* wgsl */`
            ${fullscreen}
            struct P { count: u32, sky: u32, _a: u32, _b: u32 }
            @group(0) @binding(0) var<uniform> prm: P;
            ${decl}
            struct Out { @location(0) color: vec4f, ${mrt ? '@location(1) z: vec4f,' : ''} }
            @fragment fn fsMerge(@builtin(position) fp: vec4f) -> Out {
                let p = vec2i(fp.xy);
                var bz = 3.0e38;
                var bc = vec4f(0.0, 0.0, 0.0, 1.0);
                var sky = vec4f(0.0, 0.0, 0.0, 1.0);
                var gotSky = false;
                ${pick}
                var o: Out;
                o.color = select(vec4f(bc.rgb, 1.0), vec4f(sky.rgb, 1.0), bz >= 3.0e38);
                ${mrt ? 'o.z = vec4f(bz, 0.0, 0.0, 0.0);' : ''}
                return o;
            }`;
        const tex = (b) => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } });
        this.mergeLayout = d.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ...Array.from({ length: 2 * N }, (_, i) => tex(1 + i)),
        ] });
        const mergeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.mergeLayout] });
        this.mergePipe = [false, true].map(mrt => {
            const module = d.createShaderModule({ label: `merge${mrt ? '-mrt' : ''}`, code: merge(mrt) });
            return d.createRenderPipeline({
                label: 'merge', layout: mergeLayout,
                vertex: { module, entryPoint: 'vsFull' },
                fragment: { module, entryPoint: 'fsMerge', targets: mrt ? [{ format: 'rgba8unorm' }, { format: 'r32float' }] : [{ format }] },
            });
        });
        this.mergeParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const dummy = (fmt) => d.createTexture({ size: [1, 1], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
        this.dummyColor = dummy('rgba8unorm');
        this.dummyZ = dummy('r32float');
        this.layers = new Map();       // instance -> { color, z, params, ... }
        this.width = this.height = 0;
    }

    // every layer gets a colour target (what the world renders into) and a view-depth target
    resize(width, height, instances) {
        const d = this.device, U = GPUTextureUsage;
        if (width !== this.width || height !== this.height) {
            for (const l of this.layers.values()) { l.color.destroy(); l.z.destroy(); }
            this.layers.clear();
            this.inject?.color.destroy();
            this.inject?.z.destroy();
            this.inject = null;
            this.width = width;
            this.height = height;
        }
        for (const inst of instances) {
            if (this.layers.has(inst)) continue;
            const color = d.createTexture({ label: `layer ${inst.id}`, size: [width, height], format: this.format, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
            const z = d.createTexture({ label: `layer ${inst.id} z`, size: [width, height], format: 'r32float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
            const params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.layers.set(inst, { color, colorView: color.createView(), z, zView: z.createView(), params, depthKey: null, group: null });
        }
    }

    // what a composited world renders into this frame
    target(inst) { return this.layers.get(inst)?.colorView; }

    // the merged picture handed to an atmosphere world: rgba8unorm colour (display values) + r32float view depth (m)
    injectTarget() {
        if (!this.inject) {
            const d = this.device, U = GPUTextureUsage, size = [this.width, this.height];
            const color = d.createTexture({ label: 'inject', size, format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
            const z = d.createTexture({ label: 'inject z', size, format: 'r32float', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
            this.inject = { color, z, colorView: color.createView(), zView: z.createView() };
        }
        return this.inject;
    }

    // view depth of each world's frame (after it rendered)
    linearize(enc, inst) {
        const l = this.layers.get(inst), info = inst.world.depth?.();
        if (!l || !info) return false;
        const ms = (info.samples || 1) > 1 ? 1 : 0;
        if (l.depthKey !== info.view || l.ms !== ms) {
            l.group = this.device.createBindGroup({ layout: this.linLayout[ms], entries: [
                { binding: 0, resource: { buffer: l.params } },
                { binding: 1, resource: info.view },
            ] });
            l.depthKey = info.view;
            l.ms = ms;
        }
        this.device.queue.writeBuffer(l.params, 0, new Float32Array([Compositor.KIND[info.kind] ?? 0, info.near, info.far || 1e9, info.scale || 1]));
        const pass = enc.beginRenderPass({ label: `linearize ${inst.id}`, colorAttachments: [{ view: l.zView, loadOp: 'clear', storeOp: 'store', clearValue: [3e38, 0, 0, 0] }] });
        pass.setPipeline(this.linPipe[ms]);
        pass.setBindGroup(0, l.group);
        pass.draw(3);
        pass.end();
        return true;
    }

    // nearest-wins merge of `insts` (in priority order) into `out` (a canvas-format view), or into the inject targets
    merge(enc, insts, out, skyIndex = 0) {
        const N = Compositor.MAX, list = insts.slice(0, N), mrt = !out;
        this.device.queue.writeBuffer(this.mergeParams, 0, new Uint32Array([list.length, Math.max(0, skyIndex), 0, 0]));
        const entries = [{ binding: 0, resource: { buffer: this.mergeParams } }];
        for (let i = 0; i < N; i++) {
            const l = list[i] && this.layers.get(list[i]);
            entries.push({ binding: 1 + i, resource: l ? l.colorView : this.dummyColor });
            entries.push({ binding: 1 + N + i, resource: l ? l.zView : this.dummyZ });
        }
        const group = this.device.createBindGroup({ layout: this.mergeLayout, entries });
        const inj = mrt ? this.injectTarget() : null;
        const pass = enc.beginRenderPass({
            label: 'merge',
            colorAttachments: mrt
                ? [{ view: inj.colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }, { view: inj.zView, loadOp: 'clear', storeOp: 'store', clearValue: [3e38, 0, 0, 0] }]
                : [{ view: out, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        pass.setPipeline(this.mergePipe[mrt ? 1 : 0]);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        return inj;
    }
}
