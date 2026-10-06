'use strict';
// The persistent clouds of the scenario: which are shown, and the one J toggles.

Features.part('cloud', (engine, feature) => {
const { Supercell, SquallLine } = feature;

class CloudPicker {
    constructor(app) {
        this.app = app;
        this.persistent = [];
        this.focus = 0;                 // the persistent cloud J hides / shows: the last one picked
    }

    // a new world: its persistent clouds, no tornado or hurricane yet
    reset(world) {
        this.persistent = world.persistent;
        this.focus = 0;
        world.hurricaneCat = 0;
        world.tornadoCat = 0;
        this.app.menus.sync();
    }

    name(e) { return e.def.label || e.id || e.def.type; }

    label(e) {
        const kind = e instanceof Supercell ? 'mothership' : e instanceof SquallLine ? 'squall line' : e.def.pinned ? 'pinned cell' : 'held cell';
        return `${this.name(e)}${this.name(e).toLowerCase() === kind ? '' : ` · ${kind}`}`;
    }

    // shows or hides persistent cloud i, which J then toggles
    set(i, show, toast = true) {
        const a = this.app, e = this.persistent[i];
        if (!e) return;
        this.focus = i;
        if (!e.off !== show) {
            a.world.setOff(e, !show);
            a.reset = true;                 // no ghost of it in the temporal history
        }
        if (toast) a.hud.toast(`${this.name(e)}: ${show ? 'shown' : 'hidden'}`);
        a.menus.sync();
    }

    toggle() {
        const e = this.persistent[this.focus];
        if (e) this.set(this.focus, !!e.off);
    }
}

return { CloudPicker };
});
