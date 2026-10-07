'use strict';
// The HUD: crosshair and readouts.

Features.part('portal', (engine, feature) => {
const { kits } = engine;

// Hud: the stats / traversal readout (lines, shown on the engine's handheld, FeatureWorld.handheld) and toasts.

class Hud extends kits.world.WorldHud {
    constructor(game) {
        super(game.ui, { every: 120, toastMs: 1800 });
        this.game = game;
    }

    tick(now, vis) {
        if (this.due(now)) this.update(vis);
    }

    update(vis) {
        const g = this.game, w = g.world, o = g.opts, s = g.stats, fs = g.frameStats, P = g.player;
        const flag = (b, on = 'ON', off = 'OFF') => b ? `<span class="on">${on}</span>` : `<span class="off">${off}</span>`;
        const camArea = w.areas[w.areaAt(P.cam.pos)];
        const vAreas = w.areas.filter((a, i) => vis.nodes[i] && vis.nodes[i].some(e => !e.skyOnly));
        const lines = [];
        lines.push(`<span class="t">ENTITY PORTAL // WEBGPU</span>   ${s.fps.toFixed(0)} fps   cpu ${s.visMs.toFixed(2)} ms`);
        lines.push(`camera area   ${camArea.name}${o.freeze ? '  <span class="w">[vis frozen]</span>' : ''}`);
        lines.push(`culling ${flag(o.culling)}  masking <span class="${g.frameMode === 'stencil' ? 'on' : 'w'}">${g.frameMode}</span>  occluders ${flag(o.occluders)}`);
        lines.push(`areas visible ${vAreas.length}/${w.areas.length}  entries ${vis.entries.length}  sky ${flag(vis.sky, 'yes', 'no')}`);
        lines.push(`portals       tested ${vis.tested}  passed ${vis.passed}  <span class="d">closed ${vis.closed}</span>  occluded ${vis.occludedPortals}`);
        lines.push(`stencil       refs ${fs.refs - 1}  marks ${fs.marks}  glass panes ${fs.glass}  fog veils ${fs.veils}  water ${fs.water}`);
        lines.push(`outdoor tree  <span class="${fs.outNodes ? '' : 'off'}">quadtree ${w.outdoorTree.nodeCount} nodes: visited ${fs.outNodes}, tested ${fs.outObjs}</span>`);
        lines.push(`indoor trees  bvh per area: visited ${fs.inNodes}, tested ${fs.inObjs}`);
        lines.push(`draws         ${s.draws} (${s.objs} objs of ${w.objects.length + w.dynamic.length})  tris ${(s.tris / 1000).toFixed(1)}k/${(w.totalTris / 1000).toFixed(1)}k  occluded ${fs.occluded}`);
        lines.push('');
        lines.push('<span class="t">TRAVERSAL</span>');
        const shown = vis.entries.slice(0, 16);
        for (const e of shown) {
            const a = w.areas[e.area];
            const via = e.via ? `${e.via.id} → ` : '';
            lines.push(`${'  '.repeat(e.depth)}${e.depth ? '└ ' : ''}${via}${a.name}${e.skyOnly ? ' <span class="w">[sky only]</span>' : ''}${e.ref !== undefined && g.frameMode === 'stencil' ? ` <span class="off">#${e.ref}</span>` : ''}`);
        }
        if (vis.entries.length > shown.length) lines.push(`  … ${vis.entries.length - shown.length} more`);
        lines.push('');
        lines.push(`<span class="t">PLAYER</span> ${P.stateLabel}${o.walk && P.support ? ` on ${P.support.id}` : ''}`);
        if (o.walk && P.driving) {
            const c = P.driving.control, rud = Math.round(c.rudder * 35);
            lines.push(`<span class="t">HELM</span> throttle <span class="${c.throttle < 0 ? 'w' : 'on'}">${Math.round(c.throttle * 100)}%</span>  rudder ${Math.abs(rud)}° ${rud > 0 ? 'starboard' : rud < 0 ? 'port' : ''}   <span class="off">W/S A/D X Space · F leave</span>`);
        }
        for (const veh of w.vehicles) lines.push(`<span class="t">SHIP</span> ${veh.id}  ${veh.state}${veh.docked ? ` (${Math.max(0, veh.wait).toFixed(0)} s)` : ''}  ${(veh.v * 1.944).toFixed(1)} kn  hdg ${((veh.heading * 180 / Math.PI + 360) % 360).toFixed(0)}°  heel ${(veh.roll * 180 / Math.PI).toFixed(1)}°`);
        const drone = w.drones[0];
        if (drone) {
            lines.push('');
            lines.push(`<span class="t">DRONE</span> in ${drone.owners.map(i => w.areas[i].name).join(' + ')} → ${drone.target >= 0 ? w.areas[drone.target].name : '-'}`);
        }
        this.lines = lines;
    }
}

return { Hud };
});
