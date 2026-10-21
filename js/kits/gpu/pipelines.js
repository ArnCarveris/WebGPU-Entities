'use strict';
// Render pipelines as data. A renderer describes its pipelines as a table of plain descriptors and builds them in one
// go against its context (device, formats, sample count, stencil layout and the named shader modules, pipeline
// layouts, vertex layouts and blends they refer to). Stencil is named by slot (js/kits/gpu/stencil.js), never by value,
// so what a pipeline masks with follows wherever the layout put that slot.
//
// def: {
//   layout, module, fsModule (default: module), vs, fs, buffers,     names in ctx (buffers: a list or a ctx name)
//   topology ('triangle-list'), cull ('none'), frontFace ('ccw'),
//   blend (a ctx.blends name or a GPUBlendState), colorWrite (false: no colour, stencil-only marks),
//   depth: { write, compare, bias: { constant, slopeScale, clamp } } | false (no depth-stencil), stencil: { test, op, write } (stencilState),
//   variants: { name: overrides }         one pipeline per variant (out[def][variant]), overrides merged shallowly
// }
// A table's compares are written for standard depth (nearer is less) unless ctx.tableDepth is 'reversed'; built with
// ctx.depth 'reversed' (the frame's convention: Renderer.frameSpec) they are turned round.

Features.kit('gpu', (engine, kit) => {
const { stencilState } = kit;

function pick(ctx, kind, v) {
    if (typeof v !== 'string') return v;
    const got = ctx[kind]?.[v];
    if (got === undefined) throw new Error(`pipelines: no ${kind.replace(/s$/, '')} "${v}"`);
    return got;
}

// a table written for standard depth (nearer is less) drawn in reversed depth: every compare turned round, the biases too
const FLIP = { less: 'greater', 'less-equal': 'greater-equal', greater: 'less', 'greater-equal': 'less-equal' };

function buildPipeline(ctx, name, d) {
    const module = pick(ctx, 'modules', d.module);
    const target = { format: ctx.format };
    if (d.blend) target.blend = pick(ctx, 'blends', d.blend);
    if (d.colorWrite === false) target.writeMask = 0;
    const desc = {
        label: name,
        layout: d.layout ? pick(ctx, 'layouts', d.layout) : 'auto',
        vertex: { module, entryPoint: d.vs, buffers: d.buffers ? pick(ctx, 'buffers', d.buffers) : [] },
        fragment: { module: d.fsModule ? pick(ctx, 'modules', d.fsModule) : module, entryPoint: d.fs, targets: [target] },
        primitive: { topology: d.topology || 'triangle-list', cullMode: d.cull || 'none', frontFace: d.frontFace || 'ccw' },
    };
    if (d.depth !== false) {
        const z = d.depth || {}, flip = ctx.depth === 'reversed' && ctx.tableDepth !== 'reversed', s = flip ? -1 : 1;
        const compare = z.compare || 'less';
        desc.depthStencil = {
            format: ctx.depthFormat, depthWriteEnabled: !!z.write, depthCompare: flip ? FLIP[compare] || compare : compare,
            ...stencilState(ctx.stencil, d.stencil),
            ...(z.bias && { depthBias: s * (z.bias.constant ?? 0), depthBiasSlopeScale: s * (z.bias.slopeScale ?? 0), depthBiasClamp: z.bias.clamp ?? 0 }),
        };
    }
    if (ctx.samples > 1) desc.multisample = { count: ctx.samples };
    return ctx.device.createRenderPipeline(desc);
}

// ctx: { device, format, depthFormat, samples, stencil, modules, layouts, buffers, blends, depth, tableDepth }
function buildPipelines(ctx, defs) {
    if (ctx.stencil && !ctx.stencil.resolved) ctx.stencil.resolve();
    const out = {};
    for (const [name, def] of Object.entries(defs)) {
        const { variants, ...base } = def;
        if (!variants) { out[name] = buildPipeline(ctx, name, base); continue; }
        out[name] = {};
        for (const [v, over] of Object.entries(variants)) out[name][v] = buildPipeline(ctx, `${name}.${v}`, { ...base, ...over });
    }
    return out;
}

return { buildPipelines };
});
