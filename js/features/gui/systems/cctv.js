'use strict';
// CCTV: the security cameras' feeds.

Features.part('gui', (engine, feature) => {
const { M4, clamp, wrapIndex, RenderTarget } = GuiKit;
const { SecurityCamera } = feature;

// CCTV: renders the selected security camera into a render target, exposed to GUIs as the 'cctv'
// material. Like Doom 3 subviews, it only renders when a screen asked for it this frame.

class CctvSystem {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.selected = cfg.initial;
        this.switchTime = 0;
        this.wanted = false;
        this.renderingCamera = null;
        this.onSelect = [];
    }

    init(renderer) {
        const [w, h] = this.cfg.resolution;
        this.target = new RenderTarget(renderer, w, h);
        this.target.view.exclude.add('cctv');   // can't sample the texture it renders into
        renderer.registerMaterial('cctv', 'cctv', this.target.colorView);
    }

    get cameras() {
        return this.game.world.ofType(SecurityCamera);
    }

    get current() {
        return this.cameras[this.selected];
    }

    get aspect() {
        return this.target.aspect;
    }

    select(i) {
        i = wrapIndex(i, this.cameras.length);
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
        return this.current.offline ? 0 : clamp((now - Math.max(this.switchTime, since)) / 300, 0, 1);
    }

    prepare(frame) {
        const cam = this.current;
        this.renderingCamera = this.wanted && !cam.offline ? cam : null;
        this.wanted = false;
        if (!this.renderingCamera) return;
        const p = cam.def.pos;
        this.target.view.update(M4.viewProjection(p, cam.fwd, [0, 1, 0], this.cfg.fovY, this.target.aspect, 0.05, 60), p, frame);
    }

    render() {
        if (!this.renderingCamera) return;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: true, skip: this.renderingCamera });
        pass.end();
    }
}

return { CctvSystem };
});
