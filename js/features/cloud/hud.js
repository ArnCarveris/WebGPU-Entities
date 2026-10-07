'use strict';
// The HUD: in-world labels and the readout.

Features.part('cloud', (engine, feature) => {
const { Common, kits } = engine;
const { DEG, v3, fmtKm } = Common;
const { StormCell } = feature;

// what falling rain is called: by its rate (near-field intensity) and how fine its drops are
const rainName = (rate, drops) => drops < 0.2 && rate < 0.3 ? 'drizzle' : rate < 0.3 ? 'light rain' : rate < 0.7 ? 'moderate rain'
    : rate <= 1 ? 'heavy rain' : drops > 0.9 ? 'downpour' : 'torrential rain';

// The screen keeps the in-world labels, the walker's dot and toasts; the readout (lines) and every option (the menus)
// are on the engine's handheld (FeatureWorld.handheld)
class Hud extends kits.world.WorldHud {
    constructor(ui) { super(ui, { labels: true }); }

    update(app, now) {
        if (!this.due(now)) return;
        const w = app.world, wx = w.weather, c = wx.cur, p = app.near;
        const storms = w.storms, raining = storms.filter(s => s.state.precip > 0.05 && s.state.virga < 0.7).length;
        const wind = Math.hypot(...c.wind), dirDeg = (Math.atan2(c.wind[0], -c.wind[1]) / DEG + 360) % 360;
        const from = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((dirDeg + 180) % 360) / 45) % 8];
        const here = p.rain + p.snow < 0.01 ? (app.camera.pos[1] > c.base && app.probe.coverage > 0.5 ? '<span class="m">in cloud</span>' : '<span class="m">dry</span>')
            : p.snow > p.rain ? `<span class="snow">snow ${(p.snow * 100).toFixed(0)}%</span>` : `<span class="on">${rainName(p.rain, app.frameWriter.drops ?? c.drops)} ${(p.rain * 100).toFixed(0)}%</span>`;
        const zone = w.rainZones.variantAt(app.camera.pos[0], app.camera.pos[2]);
        const cw = app.renderer.cloudPass, prof = app.renderer.profiler;
        const fx = (v, d = 1) => (v / 1000).toFixed(d), pc = v => `${(v * 100).toFixed(0)}%`;
        const lines = [
            `<span class="t">ENTITY CLOUD // ${w.scenario.name || 'scenario'}</span> <span class="m">· ${app.fps.toFixed(0)} fps${prof.enabled ? ` · gpu ${prof.total.toFixed(1)} ms` : ''} · ${cw.w}×${cw.h} · ${app.lightName}</span>`,
            `weather ${wx.blend < 1 ? `<span class="w">${wx.target} ${pc(wx.blend)}</span>` : wx.target}${w.rainZones.fade > 0 && wx.cur.zones ? ` <span class="m">(${zone ? `${zone} here` : 'off the route'} · reshuffle ${Math.max(0, w.rainZones.clock).toFixed(0)} s)</span>` : ''}${wx.cycle.enabled ? ' <span class="m">(auto)</span>' : ''} · ×${app.timeScale}${app.paused ? ' <span class="w">paused</span>' : ''}`,
            `sky     ${fx(c.base)}-${fx(c.top)} km · ${w.clouds.active(c).map(([n, v]) => `${n} ${pc(v)}`).join(' · ') || 'clear'}`,
            `air     ${c.temperature.toFixed(0)} °C · freezing ${fx(wx.freezingLevel)} km · wind ${wind.toFixed(0)} m/s ${from} · ${storms.length} cells, ${raining} raining, ${w.flashCount} flashes`,
            `here    ${here}${app.sheltered || app.indoors ? ` <span class="w">${app.inBus ? 'in the bus' : app.indoors ? `indoors, storey ${Math.min(app.indoors.n, 1 + Math.floor((app.camera.pos[1] - app.indoors.floor) / app.indoors.H))} of ${app.indoors.n}` : 'sheltered'}</span>` : ''} · alt ${fx(app.camera.pos[1], 2)} km · snow ${app.frameWriter.groundSnowHint}`,
            ...(app.rideBus ? [`bus     ${app.rideBus.label} ${app.rideBus.describe()}${app.walker.active ? ` · <span class="w">${app.walker.seat ? 'seated' : app.walker.bus ? 'aboard' : 'on foot'}</span>` : ''}${w.busBoost > 1 ? ' <span class="w">×10</span>' : ''}`] : []),
        ];
        if (app.renderer.lastError) lines.push(`<span class="off">${app.renderer.lastError.slice(0, 90)}</span>`);
        this.lines = lines;
        // the menus follow the weather (auto cycle, views, keys); the radar sits under the engine's corner chip (on a
        // phone at the bottom)
        app.menus.sync();
        app.radarTop = innerWidth > 700 ? 52 / innerHeight : 0;
    }

    drawLabels(app) {
        const L = this.labels, g = L.begin(), { W, H, dpr } = L;
        // on foot: a dot in the middle, and what E would do
        const wk = app.walker;
        if (wk.active) {
            g.fillStyle = wk.aim ? 'rgba(255,201,74,0.95)' : 'rgba(255,255,255,0.7)';
            g.beginPath(); g.arc(W / 2, H / 2, (wk.aim ? 3 : 2) * dpr, 0, 2 * Math.PI); g.fill();
            if (wk.prompt) {
                g.font = `${13 * dpr}px 'Share Tech Mono', monospace`;
                g.textAlign = 'center';
                g.textBaseline = 'top';
                g.fillStyle = 'rgba(0,0,0,0.55)';
                const tw = g.measureText(wk.prompt).width;
                g.fillRect(W / 2 - tw / 2 - 6 * dpr, H / 2 + 14 * dpr, tw + 12 * dpr, 20 * dpr);
                g.fillStyle = 'rgba(255,201,74,0.95)';
                g.fillText(wk.prompt, W / 2, H / 2 + 17 * dpr);
                g.textAlign = 'left';
            }
        }
        if (!this.showLabels) return;
        L.font();
        for (const e of [...app.world.entities, ...app.world.buses]) {
            if (!e.label || e.off || (e === app.rideBus && app.inBus)) continue;
            const storm = e instanceof StormCell;
            if (storm && e.state.coverage < 0.1) continue;
            const p = e.anchor, at = p && L.place(app.frameWriter.viewProj, p);
            if (!at) continue;
            const d = v3.len(v3.sub(p, app.camera.pos));
            if (storm && d > 70000) continue;
            L.mark(at, storm ? 'rgba(110,220,255,0.9)' : 'rgba(255,201,74,0.9)', `${e.label}${storm ? ` · ${e.describe()}` : ''}  ${fmtKm(d)}`);
        }
    }
}

return { Hud };
});
