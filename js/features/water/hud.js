'use strict';
// The HUD: readouts of the simulation.

Features.part('water', (engine, feature) => {
const { Common } = engine;
const { v3, Toast, LabelLayer } = Common;
const { RENDER_MODES, Dam, Sea, Lake, Spring } = feature;

function fmtNum(x, unit = '') {
    const a = Math.abs(x);
    if (a >= 1e9) return `${(x / 1e9).toFixed(2)}G${unit}`;
    if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M${unit}`;
    if (a >= 1e4) return `${(x / 1e3).toFixed(1)}k${unit}`;
    return `${x.toFixed(a < 10 ? 1 : 0)}${unit}`;
}

// The screen keeps the in-world labels and toasts; the readout (lines) and every option are on the engine's handheld
// (FeatureWorld.handheld)
class Hud {
    constructor(ui) {
        this.lines = [];
        this.toaster = new Toast(ui.$('toast'));
        this.labels = new LabelLayer(ui.$('labels'));
        this.showLabels = true;
        this.last = 0;
    }

    toast(msg, ms) { this.toaster.show(msg, ms); }

    update(app, now) {
        if (now - this.last < 150) return;
        this.last = now;
        const w = app.world, f = w.field, sim = app.flow, st = sim.stats, c = sim.cfg;
        const onoff = v => v ? '<span class="on">on </span>' : '<span class="m">off</span>';
        const simRate = app.stepsPerFrame * c.stepTime * app.fps;
        const layers = app.waves.layers.map(l => `${l.size} m @ ${l.texel.toFixed(2)} m, ${l.hz.toFixed(0)} Hz`).join(' · ');
        const dams = w.entities.filter(e => e instanceof Dam);
        const lines = [
            `<span class="t">ENTITY WATER // ${w.scenario.name || 'scenario'}</span>`,
            `flow sim  ${f.n}×${f.n} cells of ${f.cell.toFixed(1)} m · ${app.paused ? '<span class="w">paused</span>' : `${app.stepsPerFrame} steps/frame`} · ${fmtNum(simRate)}× real time`,
            `water     ${fmtNum(st.volume, ' m³')} · wet ${(st.wet * f.cell * f.cell / 1e6).toFixed(2)} km² · max ${st.maxSpeed.toFixed(1)} m/s`,
            `inflow    ${fmtNum(sim.inflow || 0, ' m³/s')}   boost ${onoff(w.boost)}  rain ${onoff(w.rainOn)}${dams.length ? `  dam ${dams.some(d => d.target) ? '<span class="off">breached</span>' : '<span class="on">intact</span>'}` : ''}`,
            `waves     ${layers || 'none'}`,
            `debris    ${app.debris.count.toLocaleString()} logs · ${w.entities.length} entities · edges ${['closed', 'open', `sea ${w.seaLevel} m`][sim.edgeMode]}`,
            `view      ${RENDER_MODES[app.mode]} · ${app.lightName} · ${app.fps.toFixed(0)} fps`,
        ];
        if (sim.warmupLeft > 0) lines.push(`<span class="w">settling water... ${Math.round(100 * (1 - sim.warmupLeft / c.warmup))}%</span>`);
        if (app.renderer.lastError) lines.push(`<span class="off">${app.renderer.lastError.slice(0, 90)}</span>`);
        this.lines = lines;
    }

    drawLabels(app) {
        const L = this.labels;
        L.begin();
        if (!this.showLabels) return;
        L.font();
        for (const e of app.world.entities) {
            if (!e.label) continue;
            const p = e.anchor, at = p && L.place(app.viewProj, p);
            if (!at) continue;
            const d = v3.len(v3.sub(p, app.camera.pos));
            const extra = e instanceof Spring ? ` ${(e.def.rate * (app.world.boost ? (e.def.boost ?? 8) : 1)).toFixed(0)} m³/s` : '';
            L.mark(at, e instanceof Spring || e instanceof Lake || e instanceof Sea ? 'rgba(110,220,255,0.9)' : 'rgba(255,201,74,0.9)',
                `${e.label}${extra}  ${d < 1000 ? d.toFixed(0) + ' m' : (d / 1000).toFixed(2) + ' km'}`);
        }
    }
}

return { Hud };
});
