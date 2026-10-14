'use strict';
// GuiMode: how EntityGUIs are drawn on their surfaces, chosen at runtime (the handheld's ENGINE page) for every renderer
// that draws them (the gui kit's Renderer, WorldGuiPass, the portal's screens).

Features.kit('gui', (engine, kit) => {

// stencil: the surface marks its visible pixels in the stencil, the quads draw masked by it (no offset, no depth fight)
// bias:    the quads depth-test against the surface, pulled toward the viewer by a depth bias (Doom 3's polygon offset)
// offset:  the quads are moved off the surface by OFFSET metres along its normal, then depth-tested
// target:  the GUI is drawn into a texture of its own and the surface shows it (no quads at all)
// auto:    each renderer's own default (the scenario's choice where it has one)
const MODES = [
    { id: 'auto', label: 'Per scene', sub: 'each scene\'s default' },
    { id: 'stencil', label: 'Stencil', sub: 'stencil mask, no offset' },
    { id: 'bias', label: 'Depth bias', sub: 'quads pulled toward the eye' },
    { id: 'offset', label: 'Offset', sub: 'quads moved off the surface' },
    { id: 'target', label: 'Target', sub: 'GUI drawn to a texture' },
];
const OFFSET = 0.004;               // metres off the surface for 'offset'

const listeners = new Set();
const GuiMode = {
    MODES, OFFSET,
    id: 'auto',
    label(id = this.id) { return MODES.find(m => m.id === id)?.label ?? id; },
    // the mode to draw with: the chosen one, else the renderer's own default
    of(dflt) { return this.id === 'auto' ? dflt : this.id; },
    set(id) {
        if (!MODES.some(m => m.id === id) || id === this.id) return;
        this.id = id;
        for (const f of listeners) f(id);
    },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
};

return { GuiMode };
});
