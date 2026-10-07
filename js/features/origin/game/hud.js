'use strict';
// The HUD: in-world labels and readouts.

Features.part('origin', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, clamp, v3 } = Common;
const { f32Step, fmtDist, Body } = feature;

// The screen keeps the in-world labels and toasts; the readout (lines) and every option are on the engine's handheld
// (FeatureWorld.handheld)
class Hud extends kits.world.WorldHud {
    constructor(ui) { super(ui, { labels: true, every: 100 }); }

    update(app, prox, now) {
        if (!this.due(now)) return;
        const f = app.floating, o = f.origin, cam = app.camera, w = app.world, st = f.stats;
        const onoff = v => v ? '<span class="on">on </span>' : '<span class="off">OFF</span>';
        const camO = o.toLocal(cam.pos), wp = cam.pos.metres(), up = o.up;
        const tilt = Math.acos(clamp(up[1], -1, 1)) / DEG;
        const where = prox.body ? `${prox.body.label || prox.body.id}  alt ${fmtDist(prox.alt)}` : '-';
        const lines = [
            `<span class="t">ENTITY ORIGIN // ${w.scenario.name || 'scenario'}</span>`,
            `camera   ${fmtDist(v3.len(wp))} from world 0   speed ${fmtDist(v3.len(cam.vel))}/s`,
            `nearest  ${where}${prox.near ? `   · ${prox.near.label} ${fmtDist(v3.len(cam.pos.sub(prox.near.pos)))}` : ''}`,
            `<span class="t">ORIGIN MATRIX</span>  <span class="m">p' = R^T (p - T) / s</span>`,
            `${onoff(f.translate)} T  cell (${o.pos.c.join(', ')})`,
            `        local (${o.pos.l.map(x => x.toFixed(2)).join(', ')}) m`,
            `${onoff(f.rotate)} R  +Y = (${up.map(x => x.toFixed(3)).join(', ')})  ${tilt.toFixed(1)}° off world Y`,
            `${onoff(f.scale)} G  s = 2^${Math.log2(o.scale).toFixed(0)} = ${fmtDist(o.scale)} per unit`,
            `camera in origin space (${camO.map(x => x.toFixed(2)).join(', ')}) units   f32 step ${fmtDist(f32Step(v3.len(camO)) * o.scale)}`,
            `<span class="t">REBASE</span>   #${st.count}  last ${st.reason}  ${st.ms < 0.1 ? '<100' : (st.ms * 1000).toFixed(0)} µs  ${st.bytes} B${f.everyFrame ? '  <span class="w">every frame</span>' : ''}`,
            `<span class="m">         O(1): instance buffer untouched (${w.instanceCount.toLocaleString()} instances, ${(w.store.byteLength / 1048576).toFixed(1)} MB)</span>`,
            `GPU      ${app.renderer.draws} draws · ${w.bodies.length} bodies · ${w.dynamic.length} dynamic (${w.store.bytes} B/frame) · density ×${w.density}`,
            `         ${app.fps.toFixed(0)} fps${app.paused ? '  <span class="w">paused</span>' : ''}${w.store.outOfRange ? `  <span class="off">${w.store.outOfRange} beyond ±2^30 cells</span>` : ''}`,
        ];
        if (!f.translate) lines.push('<span class="off">translation rebasing off: classic float32 coordinates around world 0</span>');
        this.lines = lines;
    }

    // names of bodies and landmarks, projected in doubles
    drawLabels(app) {
        const L = this.labels;
        L.begin();
        if (!this.showLabels) return;
        L.font();
        const dpr = L.dpr, o = app.floating.origin, cam = app.camera, vp = app.viewProj;
        const items = [...app.world.bodies, ...app.world.landmarks], placed = [];
        for (const e of items) {
            if (!e.label) continue;
            const d = v3.len(cam.pos.sub(e.pos));
            if (d < e.radius * 1.5 && !(e instanceof Body)) continue;
            if (e instanceof Body && d - e.radius < e.radius * 0.05) continue;
            const at = L.place(vp, o.toLocal(e.pos));
            if (!at) continue;
            const [x, y] = at;
            if (placed.some(p => Math.abs(p[0] - x) < 140 * dpr && Math.abs(p[1] - y) < 13 * dpr)) continue;
            placed.push(at);
            const body = e instanceof Body;
            L.mark(at, body ? 'rgba(110,220,255,0.85)' : 'rgba(255,201,74,0.85)', `${e.label}  ${fmtDist(body ? d - e.radius : d)}`);
        }
    }
}

return { Hud };
});
