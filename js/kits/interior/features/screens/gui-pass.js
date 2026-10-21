'use strict';
// The GUI screens' pass: a render extension of the portal renderer, with its WGSL.

Features.feature('interior/portal/screens', (engine, kit) => {
const { GuiAtlas, GUI_VERTEX_LAYOUT, GuiTargets, GuiMode } = engine.kits.gui;

// World-space GUI screens (Doom 3 style, the gui kit: js/kits/gui/): a GuiModel's quads (x y in the GUI's virtual screen, y
// down) drawn in the screen's draw slot, whose model matrix maps virtual units onto the screen surface (y up). They draw
// right after the screen's own surface, depth-tested just in front of it and masked by its portal entry's stencil ref.
// The GUI's colours are display values: taken back through the tone curve, they are fogged like the world around them.
const WGSL_GUI = /* wgsl */`
@group(2) @binding(0) var guiSampler: sampler;
@group(2) @binding(1) var guiAtlas: texture_2d<f32>;

struct GOut {
    @builtin(position) pos: vec4f,
    @location(0) wpos: vec3f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f,
    @location(3) gpos: vec2f,
};

@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f, @location(2) c: vec4f) -> GOut {
    var o: GOut;
    let w = D.model * vec4f(p.x, D.info.z - p.y, 0.003, 1.0);
    o.pos = G.viewProj * w;
    o.wpos = w.xyz;
    o.uv = uv;
    o.color = c;
    o.gpos = p;
    return o;
}

fn untonemap(c: vec3f) -> vec3f { return -log(vec3f(1.0) - pow(min(c, vec3f(0.995)), vec3f(2.2))) / 1.15; }

@fragment fn fs(i: GOut) -> @location(0) vec4f {
    // a page overflowing its screen (text past its panel) is not drawn: the stencil used to cut it
    if (i.gpos.x < 0.0 || i.gpos.y < 0.0 || i.gpos.x > D.info.w || i.gpos.y > D.info.z) { discard; }
    let c = textureSample(guiAtlas, guiSampler, i.uv) * i.color;
    if (c.a < 0.004) { discard; }
    let scan = 0.93 + 0.07 * sin(i.gpos.y * 2.0944 - G.params.x * 3.0);
    let lin = untonemap(c.rgb * scan) * 1.15;
    return vec4f(tonemap(applyFog(lin, i.wpos, areas[u32(D.info.x)].fog)), c.a);
}
`;

// the fallback's screen: the glass showing its GUI's render target (the gui kit's GuiTargets): the world shader's own
// vertex stage (the same module code and entry, so exactly the glass's depth) with a fragment stage that maps the
// glass's local position (virtual units) to the target and shades it like the quads: chunks after the world's
const WGSL_SCREEN = /* wgsl */`
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
const GUI_BIAS = { constant: -4, slopeScale: -2, clamp: 0 };     // the bias mode: the quads pulled toward the eye

// World-space GUI screens (kits.entities sectorTypes Screen, js/kits/entities/sectors.js; screens.js) drawn in the portal render pass, as a render
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
// It also holds the GUI materials the screens draw with (the gui kit's materials contract, js/kits/media/views.js: the
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

    // its modules: the quads (gui) and the fallback's glass (screen: the world module and its fragment stage)
    wgsl(lib, modules) {
        lib.define('GUI', WGSL_GUI, { needs: ['COMMON', 'DRAW'] });
        lib.define('SCREEN', WGSL_SCREEN, { needs: ['WORLD'] });
        modules.gui = ['GUI'];
        modules.screen = ['WORLD', 'SCREEN'];
    }
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
        ctx.layouts.gui = device.createPipelineLayout({ bindGroupLayouts: [ctx.bgl0, ctx.bgl1, this.bgl] });
        ctx.buffers.gui = [GUI_VERTEX_LAYOUT];
        this.flat = new GuiTargets(r.device, r.format, { max: RT_MAX, layout: this.bgl });
    }

    // the mode this frame draws with: the GuiMode choice, else stencil where the screens have a value and targets where
    // they don't. The portal has no offset mode of its own (its screens sit on their world faces): offset draws as bias
    resolved() {
        let m = GuiMode.of(this.surface.capacity > 0 ? 'stencil' : 'target');
        if (m === 'stencil' && this.surface.capacity === 0) m = 'target';
        return m === 'offset' ? 'bias' : m;
    }

    pipelines(ctx) {
        const R = ctx.region, SURF = ['gui.surface'];
        const glass = (op) => ({
            layout: 'world', module: 'world', vs: 'vs', fs: 'fs', buffers: 'world', cull: 'back', colorWrite: false, depth: { compare: 'less-equal' },
            variants: { stencil: { stencil: { test: R, op, write: SURF } }, plain: { stencil: { op, write: SURF } } },
        });
        // the target mode's fallback: the glass again, showing the GUI's render target, in the entry's region
        const pipes = { screen: {
            layout: 'gui', module: 'screen', vs: 'vs', fs: 'fsScreen', buffers: 'world', cull: 'back', blend: 'alpha', depth: { compare: 'less-equal' },
            variants: { stencil: { stencil: { test: R } }, plain: {} },
        } };
        // the bias mode: the quads on the screen's own face, depth-tested and pulled toward the eye
        pipes.bias = { layout: 'gui', module: 'gui', vs: 'vs', fs: 'fs', buffers: 'gui', blend: 'alpha', depth: { compare: 'less-equal', bias: GUI_BIAS } };
        if (this.surface.capacity === 0) return pipes;
        const quads = { layout: 'gui', module: 'gui', vs: 'vs', fs: 'fs', buffers: 'gui', blend: 'alpha' };
        return {
            ...pipes,
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

    // and its virtual width (info.w): the quads past the screen's virtual rectangle are not drawn
    infoW(o) { return o.gui ? o.gui.vw : undefined; }

    // the fallback, before the frame's pass: the GUI models its commands draw, into their render targets (once however
    // many views draw them, and only when they changed)
    prepare(f, enc, target) {
        if (this.resolved() !== 'target') return;
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
        const m = c.gui.model, P = this.pipes, v = x.variant, mode = this.resolved();
        if (!m.count || !x.drawSlot(c.slot)) return;
        if (mode === 'target') {
            x.pass.setStencilReference(x.regions.ref(c.ref));
            x.pass.setBindGroup(2, this.target(c.gui).group);
            x.drawChunk(c.chunk, P.screen[v]);
            return;
        }
        if (mode === 'bias') {
            // the quads on the screen's face, no mask
            x.use(P.bias, m.buffer);
            this.drawSurfaces(x.pass, m, x.target?.material, 2);
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

return { GuiPass, WGSL_GUI };
});
