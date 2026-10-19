'use strict';
// The app's commands and clicks: what each command does (through Controls; named by the key codes they once had, the
// handheld's pages run them: handle), the keyboard's (only what has no other way: keyboard), and right clicks on the
// ground. An app extension gets each command first (key(code): true if it took it) and each right click on the ground
// (click(hit): true if it took it).

Features.kit('atmosphere', (engine, kit) => {
const { Common } = engine;
const { clamp } = Common;
const { RENDER_MODES, QUALITY } = kit;
const { TIME_SCALES, RAIN_VARIANTS } = engine.kits.weather;

class KeyCommands {
    constructor(app) { this.app = app; }

    // the keyboard: F at the wheel of a bus (the buses feature's); E, the doors, lifts and seats, is theirs (DoorControl,
    // LiftControl, Walker); everything else is on the handheld
    keyboard(pressed) {
        for (const code of pressed) if (code === 'KeyF') this.app.extensions.some(x => x.key?.(code));
    }

    handle(pressed) {
        const a = this.app, c = a.controls, w = a.world, wx = w.weather;
        for (const code of pressed) {
            if (a.extensions.some(x => x.key?.(code))) continue;
            const digit = code.match(/^(?:Digit|Numpad)(\d)$/);
            if (digit) {
                const k = +digit[1];
                if (k === 0) c.toggleCycle();
                else if (wx.names[k - 1]) c.setWeather(wx.names[k - 1]);
                continue;
            }
            switch (code) {
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
                case 'KeyU': a.hud.toast(`Sound ${a.fx.sound.toggle() ? 'on' : 'off'}`); break;
                case 'KeyR': a.radar = !a.radar; break;
                case 'KeyG': c.toggleTiles(); break;
                case 'KeyO': c.toggleBloom(); break;
                case 'KeyF': c.toggleFroxels(); break;          // (by a bus F drives it: the buses feature's, before this)
                case 'KeyM': c.setMode((a.mode + 1) % RENDER_MODES.length); break;
                case 'KeyQ': c.setQuality((a.quality + 1) % QUALITY.length); break;
                case 'KeyV': if (a.views.length) c.setView((a.viewIndex + 1) % a.views.length); break;
                case 'KeyL': a.flashlight = !a.flashlight; a.hud.toast(`Flashlight ${a.flashlight ? 'on' : 'off'}`); break;
                case 'KeyI': a.hud.showLabels = !a.hud.showLabels; break;
                case 'KeyP': a.paused = !a.paused; break;
            }
        }
    }

    // right click: where the cursor ray meets the ground, for the extensions
    clicks(clicks) {
        const a = this.app;
        for (const [cx, cy] of clicks) {
            const rect = a.canvas.getBoundingClientRect();
            const cv = a.world.curvature;
            const hit = a.world.field.raycast(a.camera.pos, a.camera.ray(cx - rect.left, cy - rect.top, rect.width, rect.height), undefined, cv.on ? p => cv.toWorld(p) : null);
            if (!hit) { a.hud.toast('Click on the ground'); continue; }
            a.extensions.some(x => x.click?.(hit));
        }
    }
}

return { KeyCommands };
});
