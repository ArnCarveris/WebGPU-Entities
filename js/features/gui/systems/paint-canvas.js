'use strict';
// The paint canvas: brush dabs stamped into a texture.

Features.part('gui', (engine, feature) => {
const { ALPHA_BLEND } = GuiKit;
const { stampShader } = feature;

// GPU paint canvas: brush dabs are stamped into a render target, which GUIs show through a material.
// One level of undo is a GPU copy taken at the start of each stroke.

const DAB_FLOATS = 12;      // x y radius type | r g b a | seed angle flow -

class PaintCanvas {
    constructor(material, cfg) {
        this.material = material;
        this.cfg = cfg;
        [this.width, this.height] = cfg.resolution;
        this.dabs = new Float32Array(cfg.maxDabs * DAB_FLOATS);
        this.dabCount = 0;
        this.pendingClear = true;       // start with blank paper
        this.pendingSnapshot = false;
        this.pendingUndo = false;
        this.canUndo = false;
    }

    init(renderer) {
        const device = renderer.device;
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
        this.texture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.undoTexture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.view = this.texture.createView();
        this.dabBuffer = renderer.createBuffer(this.dabs.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        renderer.registerMaterial(this.material, 'gui', this.view);

        const module = device.createShaderModule({ code: stampShader(this.width, this.height) });
        this.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_stamp',
                buffers: [{
                    arrayStride: DAB_FLOATS * 4,
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x4' },
                        { shaderLocation: 1, offset: 16, format: 'float32x4' },
                        { shaderLocation: 2, offset: 32, format: 'float32x4' }
                    ]
                }]
            },
            fragment: { module, entryPoint: 'fs_stamp', targets: [{ format: 'rgba8unorm', blend: ALPHA_BLEND }] },
            primitive: { topology: 'triangle-list' }
        });
    }

    // color: 0..1 RGB
    pushDab(x, y, radius, brush, color) {
        if (this.dabCount >= this.cfg.maxDabs) return;
        this.dabs.set([x, y, radius, brush.type, color[0], color[1], color[2], 1, Math.random() * 1000, brush.angle || 0, brush.flow, 0], this.dabCount * DAB_FLOATS);
        this.dabCount++;
    }

    beginStroke() {
        this.pendingSnapshot = true;
        this.canUndo = true;
    }

    undo() {
        if (!this.canUndo) return;
        this.pendingUndo = true;
        this.canUndo = false;
    }

    clear() {
        this.pendingSnapshot = true;
        this.pendingClear = true;
        this.canUndo = true;
    }

    // Record pending work into the frame's encoder (before any view samples the painting)
    flush(renderer) {
        const enc = renderer.encoder, size = [this.width, this.height];
        if (this.pendingSnapshot) {
            enc.copyTextureToTexture({ texture: this.texture }, { texture: this.undoTexture }, size);
            this.pendingSnapshot = false;
        }
        if (this.pendingUndo) {
            enc.copyTextureToTexture({ texture: this.undoTexture }, { texture: this.texture }, size);
            this.pendingUndo = false;
        }
        if (!this.pendingClear && !this.dabCount) return;
        if (this.dabCount) renderer.device.queue.writeBuffer(this.dabBuffer, 0, this.dabs, 0, this.dabCount * DAB_FLOATS);
        const [r, g, b] = this.cfg.paper;
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.view, loadOp: this.pendingClear ? 'clear' : 'load', clearValue: { r, g, b, a: 1 }, storeOp: 'store' }]
        });
        if (this.dabCount) {
            pass.setPipeline(this.pipeline);
            pass.setVertexBuffer(0, this.dabBuffer);
            pass.draw(6, this.dabCount);
        }
        pass.end();
        this.pendingClear = false;
        this.dabCount = 0;
    }
}

return { PaintCanvas };
});
