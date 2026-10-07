'use strict';
// The app's keys and clicks: what each key does (through Controls), right clicks growing storm cells, and the arrow
// keys moving the sun.

Features.part('cloud', (engine, feature) => {
const { Common } = engine;
const { DEG, clamp, v3, fmtKm } = Common;
const { RENDER_MODES, QUALITY, TIME_SCALES, RAIN_VARIANTS } = feature;

class KeyCommands {
    constructor(app) { this.app = app; }

    handle(pressed) {
        const a = this.app, c = a.controls, w = a.world, wx = w.weather, cam = a.camera;
        for (const code of pressed) {
            const digit = code.match(/^(?:Digit|Numpad)(\d)$/);
            if (digit) {
                const k = +digit[1];
                if (k === 0) c.toggleCycle();
                else if (wx.names[k - 1]) c.setWeather(wx.names[k - 1]);
                continue;
            }
            switch (code) {
                case 'KeyK': {
                    const cells = w.storms.filter(s => s.state.precip > 0.1);
                    if (!cells.length) { a.hud.toast('No mature storm cell'); break; }
                    const near = cells.reduce((p, q) => Math.hypot(p.pos[0] - cam.pos[0], p.pos[1] - cam.pos[2]) < Math.hypot(q.pos[0] - cam.pos[0], q.pos[1] - cam.pos[2]) ? p : q);
                    w.lightning.strike(near, true);
                    break;
                }
                case 'Comma': case 'Period': {
                    const i = TIME_SCALES.indexOf(a.timeScale);
                    c.setTimeScale(TIME_SCALES[clamp((i < 0 ? 3 : i) + (code === 'Period' ? 1 : -1), 0, TIME_SCALES.length - 1)]);
                    break;
                }
                case 'KeyT': c.pickLight(a.lightNames[(a.lightNames.indexOf(a.lightName) + 1) % a.lightNames.length]); break;
                case 'KeyN': {
                    // step through the rain variants: drizzle, light rain, medium rain, downpour, mixed rain
                    const names = RAIN_VARIANTS.filter(n => wx.states[n]);
                    if (!names.length) { a.hud.toast('No rain variants in this scenario'); break; }
                    c.setWeather(names[(names.indexOf(wx.target) + 1) % names.length]);
                    break;
                }
                case 'KeyB':
                    // to the next bus of the fleet (each press another)
                    if (!w.buses.length) { a.hud.toast('No bus in this scenario'); break; }
                    c.toBus(((a.busPick ?? -1) + 1) % w.buses.length);
                    break;
                case 'KeyU': a.hud.toast(`Sound ${a.fx.sound.toggle() ? 'on' : 'off'}`); break;
                case 'KeyR': a.radar = !a.radar; break;
                case 'KeyG': c.toggleTiles(); break;
                case 'KeyO': c.toggleBloom(); break;
                case 'KeyF': c.toggleFroxels(); break;
                case 'KeyM': c.setMode((a.mode + 1) % RENDER_MODES.length); break;
                case 'KeyQ': c.setQuality((a.quality + 1) % QUALITY.length); break;
                case 'KeyV': if (a.views.length) c.setView((a.viewIndex + 1) % a.views.length); break;
                case 'KeyJ': a.clouds.toggle(); break;
                case 'KeyL': a.flashlight = !a.flashlight; a.hud.toast(`Flashlight ${a.flashlight ? 'on' : 'off'}`); break;
                case 'KeyI': a.hud.showLabels = !a.hud.showLabels; break;
                case 'KeyP': a.paused = !a.paused; break;
            }
        }
    }

    // right click: grow a storm cell where the cursor ray meets the ground
    clicks(clicks) {
        const a = this.app;
        for (const [cx, cy] of clicks) {
            const rect = a.canvas.getBoundingClientRect();
            const hit = a.world.field.raycast(a.camera.pos, a.camera.ray(cx - rect.left, cy - rect.top, rect.width, rect.height));
            const sp = a.world.spawner;
            if (!hit) { a.hud.toast('Click on the ground'); continue; }
            if (!sp) { a.hud.toast('No spawner in this scenario'); continue; }
            const e = sp.spawnAt(hit[0], hit[2]);
            a.hud.toast(`${e.label} growing ${fmtKm(v3.len(v3.sub(hit, a.camera.pos)))} away`);
        }
    }

    // the arrow keys move the sun
    sun(dt) {
        const k = this.app.input.keys, s = this.app.sun;
        if (k.has('ArrowLeft')) s.azimuth -= dt * 0.5;
        if (k.has('ArrowRight')) s.azimuth += dt * 0.5;
        if (k.has('ArrowUp')) s.elevation = Math.min(s.elevation + dt * 0.25, 85 * DEG);
        if (k.has('ArrowDown')) s.elevation = Math.max(s.elevation - dt * 0.25, 2 * DEG);
    }
}

return { KeyCommands };
});
