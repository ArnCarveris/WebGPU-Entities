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
const { Common } = engine, { Composite } = Common;

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

// The conventions a frame is drawn in (docs/single-world-plan.md §2.3), as the Renderer's frameSpec:
//   display      'display': the scene colour is the canvas format and the shaders write display values into it;
//                'radiance': an rgba16float scene of radiance, mapped to the display by its post / final pass
//   depth        'reversed' (clear 0, compare greater, depth near / view distance) | 'standard' (clear 1, less)
//   depthFormat  the depth-stencil format, depthClear its clear value
//   samples      MSAA samples of the scene pass (every pipeline drawing into it is built for them)
//   near         the near plane, metres
// What its own extension draws with alone is its static frame ({ ...those, depths: the depth conventions it can draw
// in, formats: { <depth>: its depth format in that one }, sampleCounts }); over it the data's render block
// (fx.native.render: samples, depth, near) and the page's ?render.<key>= (the harness forces a variant with it), each
// only where the extension can draw that way.
const FRAME_DEFAULTS = { display: 'display', depth: 'reversed', depthFormat: 'depth32float', samples: 1, near: 0.1 };
function frameSpec(E, fx) {
    const own = E.frame || {}, spec = { ...FRAME_DEFAULTS, ...own };
    delete spec.depths; delete spec.formats; delete spec.sampleCounts; delete spec.single; delete spec.ranks;
    spec.native = spec.depth;
    const page = {};
    try { for (const [k, v] of new URLSearchParams(location.search)) if (k.startsWith('render.')) page[k.slice(7)] = v; } catch { /* no page */ }
    for (const o of [fx?.native?.render || {}, page]) {
        if (o.depth && (own.depths || [spec.depth]).includes(o.depth)) {
            spec.depth = o.depth;
            spec.depthFormat = own.formats?.[o.depth] || spec.depthFormat;
        }
        if (o.samples && (own.sampleCounts || [spec.samples]).includes(+o.samples)) spec.samples = +o.samples;
        if (+o.near > 0) spec.near = +o.near;
    }
    spec.depthClear = spec.depth === 'reversed' ? 0 : 1;
    return spec;
}

class Renderer {
    static STAGES = ['compute', 'views', 'scene', 'translucent', 'volumetric', 'post', 'final', 'overlay'];
    static SCENE = ['background', 'sky', 'outdoor', 'indoor', 'late'];

    // E: its own RendererExtension, new E(renderer, fx, ...) (or later: renderer.extend(E, fx, ...)): it keeps the
    // renderer (this.renderer = renderer) and composes in its features' (renderer.compose(list): new F(renderer),
    // renderer.ext[F.key]); fx.frame: the host's frame (GpuFrame), else one of its own; its frameSpec is E's
    constructor(E, ...args) {
        const renderer = Composite.of(this);
        this.gpuFrame = null;
        this.frameSpec = null;
        this.stencils = {};
        this.lineLayerOf = null;
        this.shared = null;             // a frame several kits draw in: its conventions (share), else null
        this.pending = [];              // ... the kits' frames still to encode after their compute (encode, encodeFrame)
        if (E) renderer.extend(E, ...args);
        return renderer;
    }

    extend(E, ...args) {
        this.gpuFrame ??= args[0]?.frame || null;
        const own = frameSpec(E, args[0]);
        this.frameSpec = this.shared ? { ...this.shared, native: own.native } : own;
        Composite.own(this, E, ...args);
        return this;
    }

    // A frame several kits draw in, each through its scope (Common.Composite.scope; kits: [{ key, E (its own
    // RendererExtension), fx }]): its conventions (docs/single-world-plan.md §2.3), what every kit's frameSpec is from
    // then on: radiance when any kit draws radiance; reversed depth; a stencil when any kit wants one and the device has
    // it; one sample with a kit whose volumetrics read single-sample depth (frame.single: the atmosphere's march), else the
    // most any asks for; the nearest near plane. And who draws what only one may (frame.ranks, the highest): `sky`, the
    // frame's one sky (the atmosphere's over space's over a kit's own); `post`, the kit whose scene targets the others draw
    // into and whose post and final passes map them to the canvas. With no such kit (display values only) the scene
    // targets are the core's (sceneTargets): output { format, size(), target() } (the canvas)
    share(device, kits, output) {
        this.output = { ...output, device };
        const specs = kits.map(k => ({ ...k, s: frameSpec(k.E, k.fx) }));
        const rank = (E, r) => E.frame?.ranks?.[r] ?? 0;
        const best = r => specs.reduce((b, k) => (rank(k.E, r) > (b ? rank(b.E, r) : 0) ? k : b), null)?.key ?? null;
        const stencil = specs.some(k => /stencil/.test(k.s.depthFormat)) && device.features.has('depth32float-stencil8');
        return this.shared = {
            display: specs.some(k => k.s.display === 'radiance') ? 'radiance' : 'display',
            depth: 'reversed', native: 'reversed', depthClear: 0,
            depthFormat: stencil ? 'depth32float-stencil8' : 'depth32float',
            samples: specs.some(k => k.E.frame?.single) ? 1 : Math.max(...specs.map(k => k.s.samples)),
            near: Math.min(...specs.map(k => k.s.near)),
            shared: true, sky: best('sky'), post: best('post'),
        };
    }

    // one beside it (Common.Composite): the handheld's GUI renderer, drawing in its own conventions (frameSpecOf)
    attach(key, E, ...args) {
        this.gpuFrame ??= args[0]?.frame || null;
        return Composite.attach(this, key, E, ...args);
    }

    // the conventions extension class E draws with, given its fx (see frameSpec)
    frameSpecOf(E, fx) { return frameSpec(E, fx); }

    // one StencilLayout per depth-stencil target (name; bits: what its format has, on first use), every extension
    // reserving its slots in it
    stencilLayout(name = 'scene', bits = 8) { return this.stencils[name] ??= new kit.StencilLayout(bits); }

    // the one LineLayer (debug frames, the vis inspector), for the pass it draws into (o: LineLayer's)
    debugLines(o) { return this.lineLayerOf ??= new kit.LineLayer(this.device, o); }

    // the scene's depth-stencil format: the frame's (depth32float-stencil8 only where the device has it, else
    // depth24plus-stencil8)
    sceneDepthFormat(spec = this.frameSpec, device = this.device) {
        const f = spec.depthFormat;
        return f === 'depth32float-stencil8' && !device.features.has(f) ? 'depth24plus-stencil8' : f;
    }

    // a view-projection made for standard depth, in the frame's convention: turned round (common.js m4.reverseDepth) when
    // the frame is reversed and its own extension draws in standard depth alone
    frameDepth(m, spec = this.frameSpec) { return spec.depth === 'reversed' && spec.native === 'standard' ? Common.m4.reverseDepth(m) : m; }

    compose(list, ...args) { return Composite.compose(this, list, ...args); }

    // its extensions' hooks, in compose order (Common.Composite): every one's, the first truthy result, the largest
    // number, every result
    each(name, ...args) { return Composite.each(this, name, ...args); }
    first(name, ...args) { return Composite.first(this, name, ...args); }
    most(name, ...args) { return Composite.most(this, name, ...args); }
    all(name, ...args) { return Composite.all(this, name, ...args); }

    // a shared frame's scene targets, the `post` kit's (its targets(): { color, colorView, depth, depthView (the
    // attachment), depthSample (its depth aspect), stencil (whether it has one), width, height })
    sceneTargets() {
        if (!this.shared) return null;
        return this.shared.post ? this.ext[this.shared.post]?.targets?.() : this.coreTargets();
    }

    // the core's scene targets (a shared frame of display values): the canvas, through an MSAA colour at the frame's
    // samples, and the frame's depth(-stencil)
    coreTargets() {
        const spec = this.shared, o = this.output, [w, h] = o.size(), U = GPUTextureUsage, d = o.device;
        let T = this.core;
        if (!T || T.width !== w || T.height !== h) {
            T?.colorTex?.destroy();
            T?.depth.destroy();
            const n = spec.samples;
            const colorTex = n > 1 ? d.createTexture({ size: [w, h], format: o.format, sampleCount: n, usage: U.RENDER_ATTACHMENT }) : null;
            const depth = d.createTexture({ size: [w, h], format: spec.depthFormat, sampleCount: n, usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
            T = this.core = { width: w, height: h, colorTex, msaaView: colorTex?.createView(), depth, depthView: depth.createView(),
                depthSample: depth.createView({ aspect: 'depth-only' }), stencil: /stencil/.test(spec.depthFormat) };
        }
        return { ...T, color: null, colorView: T.msaaView || o.target(), resolve: T.msaaView ? o.target() : null };
    }

    // the scene pass on the core's targets, cleared
    coreScene(enc) {
        const T = this.coreTargets(), ds = T.stencil ? { stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' } : {};
        return enc.beginRenderPass({
            label: 'scene',
            colorAttachments: [{ view: T.colorView, resolveTarget: T.resolve || undefined, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: T.resolve ? 'discard' : 'store' }],
            depthStencilAttachment: { view: T.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store', ...ds },
        });
    }

    // the frame's command encoder, and what runs once the frame is submitted
    frameEncoder() { return (this.gpuFrame ??= new GpuFrame(this.device)).enc; }
    afterSubmit(fn) { (this.gpuFrame ??= new GpuFrame(this.device)).after.push(fn); }
    get frameId() { return this.gpuFrame?.id ?? 0; }

    // the frame's stages, its own extension's (see above; or x's, one attached), into the frame encoder
    // In a shared frame (share) a kit's frame encodes its compute at once and the rest with every other kit's (encodeFrame);
    // one into a view target of its own (f.target: CCTV, the phone camera) all at once
    encode(f = {}, x = Composite.ownOf(this)) {
        f.enc ??= this.frameEncoder();
        if (this.shared && !f.target && Composite.isScope(this) && x === Composite.ownOf(this)) {
            x.compute?.(f);
            this.pending.push({ x, f });
            return f;
        }
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

    // A shared frame's stages after compute: each stage kit by kit (the `post` kit first), one scene pass, the `post`
    // kit's (its targets: every kit draws into them), in which only the `sky` kit draws a sky. Before a kit draws in the
    // scene pass after another one, its bind(f) puts its bind groups back
    encodeFrame() {
        const list = this.pending, spec = this.shared, key = p => p.x.constructor.key;
        this.pending = [];
        if (!list.length) return;
        list.sort((a, b) => (key(b) === spec.post) - (key(a) === spec.post));
        for (const s of Renderer.STAGES) {
            if (s === 'compute') continue;
            if (s !== 'scene') { for (const p of list) p.x[s]?.(p.f); continue; }
            const own = spec.post && key(list[0]) === spec.post;
            const pass = own ? list[0].x.scene?.(list[0].f) : this.coreScene(list[0].f.enc);
            if (!pass) continue;
            let last = own ? list[0] : null;
            for (const p of list) p.f.pass = pass;
            for (const t of Renderer.SCENE) {
                for (const p of list) {
                    if (!p.x[t] || (t === 'sky' && key(p) !== spec.sky)) continue;
                    if (p !== last) { p.x.bind?.(p.f); last = p; }
                    p.x[t](p.f);
                }
            }
            pass.end();
            for (const p of list) p.f.pass = null;
        }
    }
}

return { Renderer, GpuFrame };
});
