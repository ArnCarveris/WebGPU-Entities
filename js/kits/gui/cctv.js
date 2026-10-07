'use strict';
// CCTV: security cameras' feeds, for any world that can render a view of itself.

Features.kit('gui', (engine, kit) => {
const { clamp, wrapIndex, ViewTarget } = kit;

// CCTV: renders the selected security camera into a view target, exposed to GUIs as the 'cctv' material. It only
// renders when a screen asked for it this frame (request()).
//   game: the world's app: renderer (the materials contract, views.js), audio ({ emit }), scene (renderView),
//         cameras() (its security cameras: { position, fwd, offline, label, name })
//   cfg:  { resolution: [w, h], fovY, initial, near, far }

const CCTV_DEFAULTS = { resolution: [512, 384], fovY: 1.2, initial: 0, near: 0.05, far: 60 };

class CctvSystem {
    constructor(game, cfg = {}) {
        this.game = game;
        this.cfg = { ...CCTV_DEFAULTS, ...cfg };
        this.selected = this.cfg.initial;
        this.switchTime = 0;
        this.wanted = false;
        this.renderingCamera = null;
        this.onSelect = [];
    }

    init(renderer) {
        const [w, h] = this.cfg.resolution;
        this.target = new ViewTarget(renderer.device, renderer.format, w, h, { material: 'cctv' });
        renderer.registerMaterial('cctv', 'cctv', this.target.colorView);
    }

    get cameras() {
        return this.game.cameras();
    }

    get current() {
        return this.cameras[this.selected] || null;
    }

    get aspect() {
        return this.target.aspect;
    }

    select(i) {
        i = wrapIndex(i, this.cameras.length || 1);
        if (i !== this.selected) {
            this.selected = i;
            this.switchTime = performance.now();
            this.game.audio.emit('cctv');
        }
        for (const fn of this.onSelect) fn(i);
    }

    // Screens showing the feed call this every frame
    request() {
        this.wanted = true;
    }

    // Signal strength for a feed that (re)started at `since`: static fades into the picture
    signal(now, since = this.switchTime) {
        const cam = this.current;
        return !cam || cam.offline ? 0 : clamp((now - Math.max(this.switchTime, since)) / 300, 0, 1);
    }

    // which camera renders this frame (its tally light reads renderingCamera)
    prepare() {
        const cam = this.current;
        this.renderingCamera = this.wanted && cam && !cam.offline ? cam : null;
        this.wanted = false;
    }

    render(enc) {
        const cam = this.renderingCamera, c = this.cfg;
        if (!cam) return;
        this.game.scene.renderView(enc, this.target, {
            eye: cam.position, dir: cam.fwd, up: [0, 1, 0], fovY: c.fovY, near: c.near, far: c.far, showAvatar: true, skip: cam
        });
    }
}

return { CCTV_DEFAULTS, CctvSystem };
});
