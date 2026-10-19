'use strict';
// Clouds: the cloud's extension of the atmosphere kit's App (app.ext.clouds), over its World's Storms (world.ext.storms):
// the persistent clouds the scenario places (which are shown, the one J toggles: the cloud picker), lightning around the
// camera and K's strike at the nearest mature cell, a storm cell grown where a right click meets the ground, the
// hurricane and the tornado; their menus, handheld sections, readout and labels.

Features.world('cloud', (engine, kit) => {
const { Common } = engine;
const { v3, fmtKm } = Common;
const { StormCell, Supercell, SquallLine, HURRICANE, TORNADO } = kit;

class Clouds {
    static key = 'clouds';

    constructor(app) {
        this.app = app;
        this.persistent = [];
        this.focus = 0;                 // the persistent cloud J hides / shows: the last one picked
        const menu = (name, title) => app.menus.menu(name, title);
        this.menus = {
            clouds: menu('clouds', 'persistent clouds to show'),
            tornado: menu('tornado', "tornado under the supercell's wall cloud"),
            hurricane: menu('hurricane', 'hurricane with an eye (Saffir-Simpson category)'),
        };
    }

    get storms() { return this.app.world.ext.storms; }

    // a new world: its persistent clouds, no tornado or hurricane yet
    load(world) {
        const S = world.ext.storms;
        this.persistent = S.persistent;
        this.focus = 0;
        S.hurricaneCat = 0;
        S.tornadoCat = 0;
        this.app.menus.sync();
    }

    // more strikes around the camera under or beside a mature storm
    update(dt) {
        const a = this.app, w = a.world;
        if (!a.paused) w.lightning.around(this.storms.cells, w.weather.cur.lightning, a.camera.pos, dt);
    }

    // ------------------------------------------------------------------------------------------- the cloud picker
    name(e) { return e.def.label || e.id || e.def.type; }

    label0(e) {
        const kind = e instanceof Supercell ? 'mothership' : e instanceof SquallLine ? 'squall line' : e.def.pinned ? 'pinned cell' : 'held cell';
        return `${this.name(e)}${this.name(e).toLowerCase() === kind ? '' : ` · ${kind}`}`;
    }

    // shows or hides persistent cloud i, which J then toggles
    set(i, show, toast = true) {
        const a = this.app, e = this.persistent[i];
        if (!e) return;
        this.focus = i;
        if (!e.off !== show) {
            this.storms.setOff(e, !show);
            a.reset = true;                 // no ghost of it in the temporal history
        }
        if (toast) a.hud.toast(`${this.name(e)}: ${show ? 'shown' : 'hidden'}`);
        a.menus.sync();
    }

    toggle() {
        const e = this.persistent[this.focus];
        if (e) this.set(this.focus, !!e.off);
    }

    // ------------------------------------------------------------------------------------------- commands
    setHurricane(cat) {
        const a = this.app, S = this.storms;
        S.hurricaneCat = cat;
        a.reset = true;
        a.menus.sync();
        a.hud.toast(cat ? `${HURRICANE[cat].name} hurricane, eye at ${S.hurricanePos.map(v => (v / 1000).toFixed(0)).join(', ')} km` : 'Hurricane: off');
    }

    setTornado(cat) {
        const a = this.app, S = this.storms, P = this.persistent;
        S.tornadoCat = cat;
        a.menus.sync();
        if (!cat) { a.hud.toast('Tornado: off'); return; }
        // no supercell showing: show the first one the scenario places
        if (!S.tornadoHost) {
            const e = P.find(e => e instanceof Supercell);
            if (e) this.set(P.indexOf(e), true, false);
        }
        const host = S.tornadoHost;
        a.hud.toast(host ? `${TORNADO[cat].name} tornado under ${host.def.label || host.id}` : `${TORNADO[cat].name} tornado: waiting for a supercell`);
    }

    // a view on a hidden persistent cloud shows it (J then toggles it); a view's hurricane
    beforeJump(v, e) {
        const pick = this.persistent.indexOf(e);
        if (pick >= 0) this.set(pick, true, false);
    }
    afterJump(v) {
        if (v.hurricane !== undefined && v.hurricane !== this.storms.hurricaneCat) this.setHurricane(v.hurricane);
    }

    // K: a strike from the nearest mature cell; J: the persistent cloud picked last, hidden or shown
    key(code) {
        const a = this.app, cam = a.camera;
        if (code === 'KeyJ') { this.toggle(); return true; }
        if (code !== 'KeyK') return false;
        const cells = this.storms.cells.filter(s => s.state.precip > 0.1);
        if (!cells.length) { a.hud.toast('No mature storm cell'); return true; }
        const near = cells.reduce((p, q) => Math.hypot(p.pos[0] - cam.pos[0], p.pos[1] - cam.pos[2]) < Math.hypot(q.pos[0] - cam.pos[0], q.pos[1] - cam.pos[2]) ? p : q);
        a.world.lightning.strike(near, true);
        return true;
    }

    // a right click on the ground grows a storm cell there (the scenario's spawner's)
    click(hit) {
        const a = this.app, sp = this.storms.spawner;
        if (!sp) { a.hud.toast('No spawner in this scenario'); return true; }
        const e = sp.spawnAt(hit[0], hit[2]);
        a.hud.toast(`${e.label} growing ${fmtKm(v3.len(v3.sub(hit, a.camera.pos)))} away`);
        return true;
    }

    // ------------------------------------------------------------------------------------------- what it shows
    syncMenus() {
        const a = this.app, w = a.world, S = this.storms, m = this.menus, radio = (label, on, pick) => ({ label, kind: 'radio', on, pick });
        const P = this.persistent, shown = P.filter(e => !e.off);
        m.clouds.set(shown.length === P.length ? 'all' : !shown.length ? 'none' : shown.length === 1 ? this.name(shown[0]) : `${shown.length} of ${P.length}`,
            P.map((e, i) => ({ label: this.label0(e), kind: 'check', on: !e.off, pick: () => this.set(i, !!e.off) })), P.length > 0);
        const cats = (list, cur, set) => list.map((k, i) => radio(k ? `${k.name} · ${k.kmh} km/h` : 'off', i === cur, () => set(i)));
        m.tornado.set(TORNADO[S.tornadoCat]?.name || 'off', cats(TORNADO, S.tornadoCat, k => this.setTornado(k)), w.entities.some(e => e instanceof Supercell));
        m.hurricane.set(HURRICANE[S.hurricaneCat]?.name || 'off', cats(HURRICANE, S.hurricaneCat, k => this.setHurricane(k)));
    }

    page(id) {
        if (id !== 'weather') return null;
        const a = this.app, m = this.menus;
        return {
            cells: [{ action: 'Lightning strike', run: () => a.keys.handle(['KeyK']) }],
            sections: [
                { header: 'CLOUDS', cells: m.clouds.cells('Clouds') },
                { header: 'STORMS', cells: [...m.tornado.cells('Tornado'), ...m.hurricane.cells('Hurricane')],
                    footer: 'Right click (or Ctrl + click) on the ground grows a storm cell there.' },
            ],
        };
    }

    air() {
        const cells = this.storms.cells, raining = cells.filter(s => s.state.precip > 0.05 && s.state.virga < 0.7).length;
        return `${cells.length} cells, ${raining} raining`;
    }

    // a storm cell's label: blue, what it is doing; none for a thin one or one past 70 km
    label(e, d) {
        if (!(e instanceof StormCell)) return null;
        if (e.state.coverage < 0.1 || d > 70000) return { skip: true };
        return { color: 'rgba(110,220,255,0.9)', text: `${e.label} · ${e.describe()}` };
    }

    stats(out) { out.cells = this.storms.cells.length; }
}

return { Clouds };
});
