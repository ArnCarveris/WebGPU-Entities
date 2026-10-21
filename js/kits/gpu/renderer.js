'use strict';
// Renderer: the one renderer every world type (and the handheld) draws with (Common.Composite). What a type makes of it is
// its RendererExtension (the atmosphere's, the water's, the gui kit's...), which answers for it what it exposes: init(),
// its pipelines, resize and render.
//
// The core owns the frame's GPU work: one command encoder per frame and one queue.submit (the host's frame, fx.frame,
// shared by every Renderer of the page until there is one), and the order of a frame's stages
// (docs/single-world-plan.md §2.2). Its own extension draws in them: encode(f) calls, in this order, whichever it has of
//
//   compute      its compute and render-to-texture passes: simulations, GUI targets, culling, shadow maps
//   views        other cameras into their targets (CCTV, the phone camera)
//   scene        opens the scene pass and returns it (f.pass), then background, sky, outdoor, indoor and late draw into
//                it, in that order, and the core ends it
//   translucent  what goes over the opaque scene (into a pass of its own that loads it)
//   volumetric   froxels, the cloud march and its resolve
//   post         bloom
//   final        the final pass into the canvas: the composite and what is drawn over it
//   overlay      over the finished frame
//
// each given the frame f ({ enc, ...what its render() put in }). Nothing draws outside the frame encoder: a queue write
// lands before every command of the frame, so a buffer written twice in a frame holds only the last value (a view per
// call: a ring of slots), and a readback maps after the submit (afterSubmit).

Features.kit('gpu', (engine, kit) => {
const { Composite } = engine.Common;

// one frame's GPU work, the host's: { device, encoder (made on first use), after: callbacks once it is submitted, id }
class GpuFrame {
    constructor(device) {
        this.device = device;
        this.encoder = null;
        this.after = [];
        this.id = 0;
        this.submits = 0;
    }

    get enc() { return this.encoder ??= this.device.createCommandEncoder({ label: 'frame' }); }

    // the frame's one submit, then what waited for it (readbacks, freeing what the frame still used)
    submit() {
        const enc = this.encoder, after = this.after;
        this.encoder = null;
        this.after = [];
        this.id++;
        if (enc) { this.device.queue.submit([enc.finish()]); this.submits++; }
        for (const fn of after) fn();
    }
}

class Renderer {
    static STAGES = ['compute', 'views', 'scene', 'translucent', 'volumetric', 'post', 'final', 'overlay'];
    static SCENE = ['background', 'sky', 'outdoor', 'indoor', 'late'];

    // E: its own RendererExtension, new E(renderer, fx, ...): it keeps the renderer (this.renderer = renderer) and
    // composes in its features' (renderer.compose(list): new F(renderer), renderer.ext[F.key]); fx.frame: the host's
    // frame (GpuFrame), else one of its own
    constructor(E, ...args) {
        const renderer = Composite.of(this);
        this.gpuFrame = args[0]?.frame || null;
        Composite.own(renderer, E, ...args);
        return renderer;
    }

    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // its extensions' hooks, in compose order (Common.Composite): every one's, the first truthy result, the largest
    // number, every result
    each(name, ...args) { return Composite.each(this, name, ...args); }
    first(name, ...args) { return Composite.first(this, name, ...args); }
    most(name, ...args) { return Composite.most(this, name, ...args); }
    all(name, ...args) { return Composite.all(this, name, ...args); }

    // the frame's command encoder, and what runs once the frame is submitted
    frameEncoder() { return (this.gpuFrame ??= new GpuFrame(this.device)).enc; }
    afterSubmit(fn) { (this.gpuFrame ??= new GpuFrame(this.device)).after.push(fn); }
    get frameId() { return this.gpuFrame?.id ?? 0; }

    // the frame's stages, its own extension's (see above), into the frame encoder
    encode(f = {}) {
        const x = Composite.ownOf(this);
        f.enc ??= this.frameEncoder();
        for (const s of Renderer.STAGES) {
            if (s !== 'scene') { x[s]?.(f); continue; }
            const pass = x.scene?.(f);
            if (!pass) continue;
            f.pass = pass;
            for (const t of Renderer.SCENE) x[t]?.(f);
            pass.end();
            f.pass = null;
        }
        return f;
    }
}

return { Renderer, GpuFrame };
});
