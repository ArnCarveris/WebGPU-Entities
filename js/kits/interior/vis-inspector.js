'use strict';
// VisInspector: a world's portal visibility as the engine's handheld shows it, the same in every world built of areas:
// the floor map (AreaMap), the traversal (readout and tree), its options (culling, freeze) and the sector and portal
// frames (VisDebug lines, drawn by the world's renderer).

Features.kit('interior', (engine, kit) => {
const { VisDebug, AreaMap, portalStateOf } = kit;

const OPTS = { culling: true, freeze: false, portals: false, volumes: false, map: true, wide: false, tree: true };

// o: { set (the world's areas: an AreaSet), opts (the world's options object to share, OPTS filled in), map (AreaMap's
// options: spans, level, teleport, under, over), name(area) (what to call an area in the readout), options() (the
// world's own extra cells for the Portals page), hud (the world's readout lines, if it keeps its own), keys ({ option:
// key name }: shown beside the toggles) }. The world: vis = inspector.frozen || its traversal (with
// enabled = opts.culling), then inspector.update(vis, view, ms); its renderer draws inspector.lines(origin)
class VisInspector {
    constructor(o) {
        this.o = o;
        this.set = o.set;
        this.opts = Object.assign(o.opts || {}, { ...OPTS, ...(o.opts || {}) });
        this.debug = new VisDebug(o.set);
        this.map = new AreaMap(o.set, o.map || {});
        this.vis = null;
        this.view = null;
        this.frozenState = null;
        this.ms = 0;
        this.mapAt = 0;
    }

    // the traversal to use again while frozen (null: compute one)
    get frozen() { return this.opts.freeze && this.frozenState ? this.frozenState.vis : null; }

    // this frame's traversal and view ({ eye, basis { fwd, right, up }, aspect, fov }), how long it took (ms)
    update(vis, view, ms = 0) {
        const o = this.opts;
        if (o.freeze && !this.frozenState) this.frozenState = { vis, eye: view.eye.slice(), basis: view.basis, aspect: view.aspect };
        if (!o.freeze) this.frozenState = null;
        this.vis = vis;
        this.view = view;
        this.ms = this.ms * 0.9 + ms * 0.1;
        const now = performance.now();
        if (o.map && now - this.mapAt > 90) {
            this.mapAt = now;
            this.map.draw(vis, { eye: view.eye, fwd: view.basis.fwd, wide: o.wide, frozenEye: this.frozenState?.eye });
        }
    }

    // the sector and portal frames as lines about `origin` ({ data, depthCount }: [x, y, z, r, g, b, a] per vertex)
    lines(origin) {
        const o = this.opts;
        if (!this.vis || !(o.portals || o.volumes || o.freeze)) return { data: VisInspector.NONE, depthCount: 0 };
        return this.debug.build(this.vis, o, o.freeze ? this.frozenState : null, this.view.fov, origin);
    }

    // what to call area i
    areaName(i) {
        const a = this.set.areas[i];
        return i === 0 ? 'outdoors' : this.o.name?.(a) ?? a?.name ?? `area ${i}`;
    }

    // the readout: the traversal's numbers (its tree is on the screen: tree())
    readout() {
        const vis = this.vis, o = this.opts, out = [];
        if (!vis) return ['no traversal yet'];
        const flag = (v, a = 'ON', b = 'off') => `<span class="${v ? 'on' : 'off'}">${v ? a : b}</span>`;
        const reached = vis.nodes.get ? vis.nodes.size : vis.nodes.filter(Boolean).length;
        out.push(`<span class="t">PORTAL TRAVERSAL</span>   cpu ${this.ms.toFixed(2)} ms`);
        out.push(`camera area   ${this.areaName(vis.root)}${o.freeze ? '  <span class="w">[frozen]</span>' : ''}`);
        out.push(`culling ${flag(o.culling)}  areas reached ${reached}/${this.set.areas.filter(Boolean).length}  entries ${vis.entries.length}${vis.truncated ? ' <span class="w">[truncated]</span>' : ''}  sky ${flag(vis.sky, 'yes', 'no')}`);
        out.push(`portals       tested ${vis.tested}  passed ${vis.passed}  <span class="d">closed ${vis.closed}</span>  occluded ${vis.occludedPortals}`);
        return out;
    }

    // the traversal tree (the engine keeps it on the screen while opts.tree is on: Host.sidePanels)
    // (null in a world with no areas but the outdoors: nothing to show)
    tree() {
        const vis = this.vis, out = [];
        if (!vis || !this.set.areas.some((a, i) => i && a)) return null;
        out.push(`<span class="t">PORTAL TREE</span>  ${vis.entries.length} entries  ${vis.passed} passed${vis.truncated ? '  <span class="w">[truncated]</span>' : ''}${this.opts.freeze ? '  <span class="w">[frozen]</span>' : ''}`);
        const shown = vis.entries.slice(0, 32);
        for (const e of shown) {
            const via = e.via ? `<span class="m">[${e.via.kind || 'portal'}]</span> ` : '';
            out.push(`${'  '.repeat(Math.min(e.depth, 10))}${e.depth ? '└ ' : ''}${via}${this.areaName(e.area)}${e.skyOnly ? ' <span class="w">[sky only]</span>' : ''}`);
        }
        if (vis.entries.length > shown.length) out.push(`  … ${vis.entries.length - shown.length} more`);
        return out;
    }

    // the handheld pages (js/engine/handheld.js): the floor map and the visibility page
    pages() {
        const o = this.opts, k = this.o.keys || {}, key = n => (k[n] ? ` (${k[n]})` : '');
        const passed = this.vis ? this.vis.passed : 0;
        return [
            { id: 'map', title: 'Floor map', sub: `${o.wide ? 'wide' : 'around you'}${this.o.map?.teleport ? ' · tap to teleport' : ''}`, icon: [[52, 199, 89], 'M'], sections: [
                { cells: [
                    o.map ? { image: this.map.canvas, aspect: 1, click: (u, v) => this.map.click(u, v) } : { text: 'The map is off.' },
                    { toggle: `Map${key('map')}`, on: o.map, set: v => { o.map = v; } },
                    { toggle: `Wide${key('wide')}`, on: o.wide, set: v => { o.wide = v; } }],
                  footer: 'Areas: cyan yours, green reached. Portals: green passed, cyan sky only, amber culled, red closed, violet occluder.' }] },
            { id: 'portals', title: 'Portals', sub: `culling ${o.culling ? 'on' : 'off'} · ${passed} passed${o.freeze ? ' · frozen' : ''}`, icon: [[48, 176, 199], 'V'], sections: [
                { header: 'VISIBILITY', cells: [
                    { toggle: `Portal culling${key('culling')}`, on: o.culling, set: v => { o.culling = v; } },
                    { toggle: `Freeze visibility${key('freeze')}`, on: o.freeze, set: v => { o.freeze = v; } },
                    ...(this.o.options?.() || [])] },
                { header: 'FRAMES', cells: [
                    { toggle: `Portal frames${key('portals')}`, on: o.portals, set: v => { o.portals = v; } },
                    { toggle: `Sector volumes${key('volumes')}`, on: o.volumes, set: v => { o.volumes = v; } },
                    { toggle: 'Tree on HUD', on: o.tree, set: v => { o.tree = v; } }] },
                ...Handheld.panel(this.readout()),
            ] },
        ];
    }
}
VisInspector.NONE = new Float32Array(0);

return { VisInspector, VIS_OPTS: OPTS, visStateOf: portalStateOf };
});
