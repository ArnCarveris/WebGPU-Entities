'use strict';
// A world's options and readout as the engine's handheld shows them (js/engine/handheld.js): option menus as data, and
// the pages and cells every world has.

Features.kit('world', (engine, kit) => {
// a menu of a world's options as data: radio items (pick one), check items (any number on) and info items, with a
// summary; the handheld shows them as cells (Menu.cells)
class Menu {
    constructor(name, title) {
        this.name = name;
        this.title = title;
        this.summary = '';
        this.items = [];
        this.shown = true;
    }

    // items: { label, kind: 'radio' | 'check', on, key (its shortcut), pick }, { label, kind: 'info', key (its value) } or
    // { sep: true }
    set(summary, items, shown = true) {
        this.summary = summary;
        this.items = items;
        this.shown = shown;
    }

    // as handheld cells: the radio items one choice, each check item a toggle, each info item a label
    cells(title, { radios = true } = {}) {
        if (!this.shown) return [];
        const radio = this.items.filter(i => i.kind === 'radio'), out = [];
        if (radios && radio.length) {
            out.push({ choice: title, options: radio.map(r => ({ label: r.label, sub: r.key || undefined })), index: radio.findIndex(r => r.on),
                value: this.summary, pick: i => radio[i].pick() });
        }
        for (const it of this.items) {
            if (it.kind === 'check') out.push({ toggle: it.label, on: !!it.on, set: () => it.pick() });
            else if (it.kind === 'info') out.push({ label: it.label, value: it.key || '' });
        }
        return out;
    }
}

// pages and cells every world's handheld section has
const Pages = {
    // the readout page: the HUD's lines (WorldHud.lines)
    status: (sub, icon, hud) => ({ id: 'status', title: 'Status', sub, icon, sections: Handheld.panel(hud.lines) }),
    // the in-world labels on or off
    labels: hud => ({ toggle: 'Labels', on: hud.showLabels, set: v => { hud.showLabels = v; } }),
    // the world's time stopped or running (its `paused`)
    paused: app => ({ toggle: 'Paused', on: app.paused, set: v => { app.paused = v; } }),
};

return { Menu, Pages };
});
