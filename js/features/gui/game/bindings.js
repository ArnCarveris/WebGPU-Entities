'use strict';
// Bindings: the values the screens and the phone read and set.

Features.part('gui', (engine, feature) => {
const { pad3, cardinal } = engine.kits.gui;

// Named bindings between data-driven GUI pages and game state.
//   value:  { get, set?, min?, max?, fmt?, label?, options? }  (switch / slider / picker / option cells)
//   text:   { text }                                         (label values, dynamic titles and footers)
// Actions are named commands for 'action' cells.

class Bindings {
    constructor(game) {
        this.game = game;
        this.specs = this.createSpecs(game);
        this.actions = this.createActions(game);
    }

    spec(key) {
        const s = this.specs[key];
        if (!s) throw new Error(`No binding "${key}"`);
        return s;
    }

    text(key) {
        const s = this.spec(key);
        return s.text ? s.text() : String(s.get());
    }

    action(name) {
        const fn = this.actions[name];
        if (!fn) throw new Error(`No action "${name}"`);
        fn();
    }

    createSpecs(g) {
        const links = g.scenario.phone.links;
        const door = () => g.world.get(links.door);
        const pct = (v) => `${Math.round(v)}%`;
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        return {
            // settings
            lights: { get: () => g.world.lightsOn, set: (v) => g.world.setLights(v) },
            alarm: { get: () => g.world.alarm, set: (v) => g.world.setAlarm(v) },
            stencil: { get: () => g.renderer.useStencil, set: (v) => { g.renderer.useStencil = v; } },
            sound: { get: () => g.audio.enabled, set: (v) => { g.audio.enabled = v; } },
            fov: { get: () => g.player.fovDeg, set: (v) => { g.player.fovDeg = v; }, min: 45, max: 95, fmt: (v) => `${Math.round(v)}°` },
            lamp: { get: () => g.world.lampScale * 100, set: (v) => { g.world.lampScale = v / 100; }, min: 0, max: 200, fmt: pct },
            stepVolume: { get: () => g.audio.stepVolume * 100, set: (v) => { g.audio.stepVolume = v / 100; }, min: 0, max: 100, fmt: pct },
            cctv: {
                get: () => g.cctv.selected,
                set: (i) => g.cctv.select(i),
                label: (i) => g.cctv.cameras[i].label,
                options: () => g.cctv.cameras.map((c) => ({ title: c.label, sub: c.offline ? `${c.name} (offline)` : c.name }))
            },

            // read-only text
            'player.position': { text: () => `${g.player.pos[0].toFixed(1)}, ${g.player.pos[2].toFixed(1)}` },
            'player.heading': { text: () => `${pad3(g.player.heading)}° ${cardinal(g.player.heading)}` },
            'player.noise': { text: () => pct(g.player.noise * 100) },
            'hatch.status': { text: () => cap(door().status) },
            'hatch.code': { text: () => g.world.get(links.terminal).gui.content.hatchCode },
            'hatch.action': { text: () => (door().isOpen ? 'Seal hatch' : 'Open hatch (override)') },
            'media.summary': { text: () => g.camera.library.summary() },
            'iptv.summary': { text: () => `${g.iptv.channels.length} channels · ${g.iptv.current.name}` },
            'stencil.description': {
                text: () => (g.renderer.useStencil
                    ? 'Each GUI surface writes its own stencil value where it wins the depth test. GUI quads draw with depth ALWAYS + stencil EQUAL in painter\'s order: no z-fighting, and the swinging lamp still occludes them.'
                    : 'Depth test only: GUI quads test LEQUAL against the co-planar screen. They reach the wall through a different matrix path than the screen, so their depth rounds differently and the terminal z-fights.')
            },
            'stats.fps': { text: () => `${g.stats.fps} fps` },
            'stats.resolution': { text: () => `${g.renderer.width} × ${g.renderer.height}` },
            'stats.guiMask': { text: () => (g.renderer.useStencil ? 'Stencil' : 'Depth only') },
            'stats.guiSurfaces': { text: () => String(g.interaction.guis.length) },
            'stats.terminal': { text: () => g.stats.gui(g.world.get(links.terminal).gui) },
            'stats.easel': { text: () => g.stats.gui(g.world.get(links.easel).gui) },
            'stats.phone': { text: () => g.stats.gui(g.handheld.gui) },
            'stats.cctv': { text: () => (g.cctv.renderingCamera ? `${g.cctv.renderingCamera.label} rendering` : 'Idle') },
            'stats.camera': { text: () => (g.camera.shot ? 'Rendering' : 'Idle') },
            'stats.photos': { text: () => `${g.camera.library.counts().photos} / ${g.camera.cfg.photo.capacity}` },
            'stats.videoFrames': { text: () => `${g.camera.cfg.video.pool - g.camera.library.freeLayers.length} / ${g.camera.cfg.video.pool}` },
            'stats.iptv': { text: () => (g.iptv.hasFrame ? `${g.iptv.texW}×${g.iptv.texH}` : 'Idle') }
        };
    }

    createActions(g) {
        const links = g.scenario.phone.links;
        return {
            toggleHatch: () => {
                const door = g.world.get(links.door);
                g.world.setDoor(links.door, !door.isOpen, 'DEBUG OVERRIDE');
            },
            showCctvOnTerminal: () => g.world.get(links.terminal).gui.showPage('cctv')
        };
    }
}

return { Bindings };
});
