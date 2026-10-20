'use strict';
// The HUD: in-world labels and the readout. An app extension adds to the readout's air line (air(): text), lines of its
// own (lines(): [html]) and styles the labels of the entities that are its own (label(e, d): null if not, { skip } or
// { color, text }).

Features.kit('atmosphere', (engine, kit) => {
const { Common, kits } = engine;
const { DEG, v3, fmtKm } = Common;

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
        const wind = Math.hypot(...c.wind), dirDeg = (Math.atan2(c.wind[0], -c.wind[1]) / DEG + 360) % 360;
        const from = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((dirDeg + 180) % 360) / 45) % 8];
        const here = p.rain + p.snow < 0.01 ? (app.camera.pos[1] > c.base && app.probe.coverage > 0.5 ? '<span class="m">in cloud</span>' : '<span class="m">dry</span>')
            : p.snow > p.rain ? `<span class="snow">snow ${(p.snow * 100).toFixed(0)}%</span>` : `<span class="on">${rainName(p.rain, app.frameWriter.drops ?? c.drops)} ${(p.rain * 100).toFixed(0)}%</span>`;
        const zone = w.rainZones.variantAt(app.camera.pos[0], app.camera.pos[2]);
        const cw = app.renderer.cloudPass, prof = app.renderer.profiler;
        const fx = (v, d = 1) => (v / 1000).toFixed(d), pc = v => `${(v * 100).toFixed(0)}%`;
        const lines = [
            `<span class="t">${app.title} // ${w.scenario.name || 'scenario'}</span> <span class="m">· ${app.fps.toFixed(0)} fps${prof.enabled ? ` · gpu ${prof.total.toFixed(1)} ms` : ''} · ${cw.w}×${cw.h} · ${app.lightName}</span>`,
            `weather ${wx.blend < 1 ? `<span class="w">${wx.target} ${pc(wx.blend)}</span>` : wx.target}${w.rainZones.fade > 0 && wx.cur.zones ? ` <span class="m">(${zone ? `${zone} here` : 'off the route'} · reshuffle ${Math.max(0, w.rainZones.clock).toFixed(0)} s)</span>` : ''}${wx.cycle.enabled ? ' <span class="m">(auto)</span>' : ''} · ×${app.timeScale}${app.paused ? ' <span class="w">paused</span>' : ''}`,
            `sky     ${fx(c.base)}-${fx(c.top)} km · ${w.clouds.active(c).map(([n, v]) => `${n} ${pc(v)}`).join(' · ') || 'clear'}`,
            `air     ${c.temperature.toFixed(0)} °C · freezing ${fx(wx.freezingLevel)} km · wind ${wind.toFixed(0)} m/s ${from} · ${[...app.extensions.map(x => x.air?.()).filter(Boolean), `${w.flashCount} flashes`].join(', ')}`,
            `here    ${here}${app.sheltered || app.indoors ? ` <span class="w">${app.inBus ? 'in the bus' : app.indoors ? `indoors, storey ${Math.min(app.indoors.n, 1 + Math.floor((app.camera.pos[1] - app.indoors.floor) / app.indoors.H))} of ${app.indoors.n}` : 'sheltered'}</span>` : ''} · alt ${fx(app.camera.pos[1], 2)} km · snow ${app.frameWriter.groundSnowHint}`,
            ...app.extensions.flatMap(x => x.lines?.() || []),
        ];
        if (app.renderer.lastError) lines.push(`<span class="off">${app.renderer.lastError.slice(0, 90)}</span>`);
        this.lines = lines;
        // the menus follow the weather (auto cycle, views, keys); the radar sits under the engine's corner chip (on a
        // phone at the bottom)
        app.menus.sync();
        app.radarTop = innerWidth > 700 ? 52 / innerHeight : 0;
    }

    drawLabels(app) {
        const L = this.labels, g = L.begin(), { W, H, dpr } = L, od = app.frameWriter.outdoors, air = app.airHere ?? 1;
        // (thinning out with the air, none above it: AppExtension.airAt)
        if (air <= 0) return;
        g.globalAlpha = air;
        // (the labels are of the outdoors: only where the portal traversal sees it from inside)
        L.region = od ? { ...od, W: app.renderer.width, H: app.renderer.height } : null;
        // on foot: a dot in the middle, and what E would do
        const wk = app.walker;
        if (wk.active) {
            g.fillStyle = wk.aim ? 'rgba(255,201,74,0.95)' : 'rgba(255,255,255,0.7)';
            g.beginPath(); g.arc(W / 2, H / 2, (wk.aim ? 3 : 2) * dpr, 0, 2 * Math.PI); g.fill();
        }
        // what E (on foot) or F (by a bus) would do
        const prompt = (wk.active && wk.prompt) || app.extensions.map(x => x.prompt).find(Boolean);
        if (prompt) {
            g.font = `${13 * dpr}px 'Share Tech Mono', monospace`;
            g.textAlign = 'center';
            g.textBaseline = 'top';
            g.fillStyle = 'rgba(0,0,0,0.55)';
            const tw = g.measureText(prompt).width;
            g.fillRect(W / 2 - tw / 2 - 6 * dpr, H / 2 + 14 * dpr, tw + 12 * dpr, 20 * dpr);
            g.fillStyle = 'rgba(255,201,74,0.95)';
            g.fillText(prompt, W / 2, H / 2 + 17 * dpr);
            g.textAlign = 'left';
        }
        if (!this.showLabels) return;
        L.font();
        for (const e of [...app.world.entities, ...app.world.buses]) {
            if (!e.label || e.off || (e === app.rideBus && app.inBus)) continue;
            const p = e.anchor, d = p && v3.len(v3.sub(p, app.camera.pos)), at = p && L.place(app.frameWriter.viewProj, app.world.curvature.toRender(p), d);
            if (!at) continue;
            if (e.labelRange && d > e.labelRange) continue;          // (a place name: only near it)
            let s = null;
            for (const x of app.extensions) if ((s = x.label?.(e, d))) break;
            if (s?.skip) continue;
            L.mark(at, s?.color || 'rgba(255,201,74,0.9)', `${s?.text || e.label}  ${fmtKm(d)}`);
        }
    }
}

return { Hud };
});
