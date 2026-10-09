'use strict';
// The GUI screens' pass: a render extension of the portal renderer.

Features.part('portal', (engine, feature) => {
const { RenderExtensions } = engine.kits.gpu;
const { GuiAtlas, GUI_VERTEX_LAYOUT, GuiTargets } = engine.kits.gui;
const { WGSL_GUI, WGSL_WORLD } = feature;

// the fallback's screen: the glass showing its GUI's render target (the gui kit's GuiTargets): the world shader's own
// vertex stage (the same module code and entry, so exactly the glass's depth) with a fragment stage that maps the
// glass's local position (virtual units) to the target and shades it like the quads
const WGSL_SCREEN = WGSL_WORLD + /* wgsl */`
@group(2) @binding(0) var screenSampler: sampler;
@group(2) @binding(1) var screenTex: texture_2d<f32>;
fn untonemapScreen(c: vec3f) -> vec3f { return -log(vec3f(1.0) - pow(min(c, vec3f(0.995)), vec3f(2.2))) / 1.15; }
@fragment fn fsScreen(i: VOut) -> @location(0) vec4f {
    let vh = D.info.z;
    let dims = vec2f(textureDimensions(screenTex));
    let vw = vh * dims.x / dims.y;
    let uv = vec2f(i.lpos.x / vw, 1.0 - i.lpos.y / vh);
    let t = textureSample(screenTex, screenSampler, clamp(uv, vec2f(0.0), vec2f(1.0)));
    if (t.a < 0.004 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { discard; }
    let scan = 0.93 + 0.07 * sin(uv.y * vh * 2.0944 - G.params.x * 3.0);
    let lin = untonemapScreen(t.rgb / t.a * scan) * 1.15;
    return vec4f(tonemap(applyFog(lin, i.wpos, areas[u32(D.info.x)].fog)), t.a);
}
`;
const RT_MAX = 1024;            // a fallback target's longest side, in texels

// World-space GUI screens (kits.entities sectorTypes Screen, js/kits/entities/sectors.js; gui/screens.js) drawn in the portal render pass, as a render
// extension (render/renderer.js): a 'gui' overlay command for every visible object with a GUI, right after its entry's
// objects, in its draw slot (the screen's model matrix and fog chain; info.z = the GUI's virtual height).
//
// Masking: one value of the gui kit's "gui.surface" stencil slot is enough: a screen's glass, drawn again, sets it
// where it is seen in its entry's region, the quads draw with depth ALWAYS inside it, and the glass clears it before
// the next screen. With no bits left for it (the layout's other users come first), the fallback needs no stencil at
// all: before the frame's pass (prepare), every screen the frame draws renders its GUI model into a render target of
// its own (when the model changed since: once however many views draw it), and the screen's glass is drawn again with
// that target as its texture, at exactly the glass's depth: no offset, nothing to z-fight.
//
// It also holds the GUI materials the screens draw with (the gui kit's materials contract, js/kits/gui/views.js: the
// atlas, CCTV feeds, the viewfinder...), lent to the handheld's renderer too; video (a 2d-array frame pool) only shows
// on the handheld. A view target's own material isn't drawn into it.

class GuiPass {
    constructor(renderer) {
        this.name = 'gui';
        this.renderer = renderer;
        this.stencil = { 'gui.surface': { values: 1, min: 0 } };
        this.materials = new Map();     // name -> { shading, view, group }
        this.mirror = null;             // another renderer (the handheld's) that gets these materials too
        this.flat = null;               // the fallback: the GUIs' render targets (GuiTargets)
        this.glass = new WeakMap();     // and per GUI, the glass's bind group showing its target
        this.commands = { gui: (c, x) => this.draw(c, x) };
    }

    get device() { return this.renderer.device; }
    get format() { return this.renderer.format; }

    async init(r, ctx) {
        const device = r.device, S = GPUShaderStage;
        this.surface = r.stencil.slot('gui.surface');
        this.bgl = device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
        ] });
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        await GuiAtlas.loadFonts();
        this.atlas = new GuiAtlas();
        this.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        ctx.modules.gui = device.createShaderModule({ code: WGSL_GUI });
        ctx.layouts.gui = device.createPipelineLayout({ bindGroupLayouts: [ctx.bgl0, ctx.bgl1, this.bgl] });
        ctx.buffers.gui = [GUI_VERTEX_LAYOUT];
        if (this.surface.capacity === 0) await this.initFallback(r, ctx);
    }

    async initFallback(r, ctx) {
        this.flat = new GuiTargets(r.device, r.format, { max: RT_MAX, layout: this.bgl });
        ctx.modules.screen = r.device.createShaderModule({ code: WGSL_SCREEN });
    }

    pipelines(ctx) {
        const R = ctx.region, SURF = ['gui.surface'];
        const glass = (op) => ({
            layout: 'world', module: 'world', vs: 'vs', fs: 'fs', buffers: 'world', cull: 'back', colorWrite: false, depth: { compare: 'less-equal' },
            variants: { stencil: { stencil: { test: R, op, write: SURF } }, plain: { stencil: { op, write: SURF } } },
        });
        if (this.surface.capacity === 0) {
            // the fallback: the glass again, showing the GUI's render target, in the entry's region
            return { screen: {
                layout: 'gui', module: 'screen', vs: 'vs', fs: 'fsScreen', buffers: 'world', cull: 'back', blend: 'alpha', depth: { compare: 'less-equal' },
                variants: { stencil: { stencil: { test: R } }, plain: {} },
            } };
        }
        const quads = { layout: 'gui', module: 'gui', vs: 'vs', fs: 'fs', buffers: 'gui', blend: 'alpha' };
        return {
            // the glass again (same vertex shader, so the same depth) sets / clears the mask
            anchor: glass('replace'),
            unanchor: glass('zero'),
            masked: { ...quads, depth: { compare: 'always' }, variants: { stencil: { stencil: { test: [...R, ...SURF] } }, plain: { stencil: { test: SURF } } } },
        };
    }

    // FrameBuilder: a screen's command
    overlay(o) { return o.gui ? { op: 'gui', gui: o.gui } : null; }

    // the GUI shader places quads with y up from the virtual height
    info(o) { return o.gui ? o.gui.vh : undefined; }

    // the fallback, before the frame's pass: the GUI models its commands draw, into their render targets (once however
    // many views draw them, and only when they changed)
    prepare(f, enc, target) {
        if (this.surface.capacity > 0) return;
        const skip = target?.material;
        for (const c of f.cmds) if (c.op === 'gui' && c.gui.model.count) this.flat.update(enc, c.gui, this.materials, skip);
    }

    // the glass's bind group showing a GUI's render target
    target(gui) {
        let g = this.glass.get(gui);
        if (!g) this.glass.set(gui, g = { group: this.group('gui', this.flat.target(gui).view) });
        return g;
    }

    // a model's surfaces, each with its material's texture (bind group `slot`); a view target's own material is skipped
    drawSurfaces(pass, m, skip, slot) {
        for (const surf of m.surfaces) {
            const mat = surf.material !== skip && this.materials.get(surf.material);
            if (!mat?.group) continue;
            pass.setBindGroup(slot, mat.group);
            pass.draw(surf.count, 1, surf.first);
        }
    }

    draw(c, x) {
        const m = c.gui.model, P = this.pipes, v = x.variant;
        if (!m.count || !x.drawSlot(c.slot)) return;
        if (this.surface.capacity === 0) {
            x.pass.setStencilReference(x.regions.ref(c.ref));
            x.pass.setBindGroup(2, this.target(c.gui).group);
            x.drawChunk(c.chunk, P.screen[v]);
            return;
        }
        x.pass.setStencilReference(x.stencil.compose({ 'portal.regions': c.ref, 'gui.surface': 1 }));
        x.drawChunk(c.chunk, P.anchor[v]);
        x.use(P.masked[v], m.buffer);
        this.drawSurfaces(x.pass, m, x.target?.material, 2);
        x.drawChunk(c.chunk, P.unanchor[v]);
    }

    // ---- GUI materials (the gui kit's materials contract) ----
    registerMaterial(name, shading, view) {
        this.materials.set(name, { shading, view, group: this.group(shading, view) });
        if (this.mirror && name !== 'atlas') this.mirror.registerMaterial(name, shading, view);
    }

    setMaterialTexture(name, view) {
        const m = this.materials.get(name);
        m.view = view;
        m.group = this.group(m.shading, view);
        if (this.mirror && name !== 'atlas') this.mirror.setMaterialTexture(name, view);
    }

    group(shading, view) {
        if (shading === 'video') return null;
        return this.device.createBindGroup({ layout: this.bgl, entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: view }] });
    }

    // lends these materials (view targets: CCTV, viewfinder, photos...) to `other`, now and later
    mirrorTo(other) {
        this.mirror = other;
        for (const [name, m] of this.materials) if (name !== 'atlas') other.registerMaterial(name, m.shading, m.view);
    }
}

RenderExtensions.register('portal', r => new GuiPass(r));

return { GuiPass };
});
