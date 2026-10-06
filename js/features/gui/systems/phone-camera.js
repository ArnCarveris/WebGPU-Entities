'use strict';
// The phone's camera: renders the view and takes photos.

Features.part('gui', (engine, feature) => {
const { V3, M4, bearingOf, BLIT_SHADER, CLEAR_COLOR, RenderTarget } = GuiKit;
const { MediaLibrary } = feature;

class PhoneCamera {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.library = new MediaLibrary(cfg);
        this.mode = 'photo';            // 'photo' | 'video'
        this.rec = null;                // active recording
        this.captureRequested = false;
        this.lastShot = -1e9;
        this.seeds = [...cfg.seedShots];
        this.shot = null;               // camera rendering this frame
    }

    init(renderer) {
        this.library.init(renderer);
        const [w, h] = this.cfg.photo.size;
        this.target = new RenderTarget(renderer, w, h, { copySrc: true });
        this.target.view.exclude.add('viewfinder');
        renderer.registerMaterial('viewfinder', 'gui', this.target.colorView);

        const module = renderer.device.createShaderModule({ code: BLIT_SHADER });
        this.blitPipeline = renderer.device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: renderer.format }] },
            primitive: { topology: 'triangle-list' }
        });
        this.blitGroup = renderer.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: renderer.sampler }, { binding: 1, resource: this.target.colorView }]
        });
    }

    get recordingSeconds() {
        return this.rec ? this.rec.frames.length / this.cfg.video.fps : 0;
    }

    get freeVideoSeconds() {
        return this.library.freeLayers.length / this.cfg.video.fps;
    }

    // ---- actions ----
    shutter() {
        if (this.mode === 'photo') this.takePhoto();
        else if (this.rec) this.stopRecording();
        else this.startRecording();
    }

    takePhoto() {
        this.captureRequested = true;
        this.lastShot = performance.now();
        this.game.handheld.kick = 1;
        this.game.audio.shutter();
    }

    startRecording() {
        const p = this.game.player;
        this.rec = { frames: [], t0: performance.now(), time: new Date(), x: p.pos[0], z: p.pos[2], hdg: p.heading, label: this.game.world.placeLabel(p.pos[0], p.pos[2]) };
        this.game.audio.chime(true);
    }

    stopRecording() {
        const rec = this.rec;
        if (!rec) return;
        this.rec = null;
        this.game.audio.chime(false);
        if (!rec.frames.length) return;
        this.library.add({ kind: 'video', frames: rec.frames, time: rec.time, x: rec.x, z: rec.z, hdg: rec.hdg, label: rec.label });
    }

    // ---- per frame ----
    // The viewfinder renders while the phone shows the Camera page; otherwise pending startup shots
    prepare(frame) {
        const phone = this.game.handheld;
        this.shot = null;
        if (phone.visible && phone.gui.pagesVisible().includes('camera')) {
            const m = this.game.phoneModel();
            const dir = [-m[8], -m[9], -m[10]];                 // the phone's back faces away from its screen
            this.shot = { pos: V3.add([m[12], m[13], m[14]], V3.scale(dir, 0.012)), dir, up: [m[4], m[5], m[6]], showAvatar: false };
        } else if (this.seeds.length) {
            const s = this.seeds.shift();
            this.shot = { pos: s.pos, dir: V3.normalize(V3.sub(s.target, s.pos)), up: [0, 1, 0], showAvatar: true, label: s.label };
        } else {
            this.captureRequested = false;
        }
        if (this.rec && !(this.shot && !this.shot.label)) this.stopRecording();   // viewfinder closed
        if (this.shot) {
            const s = this.shot;
            this.target.view.update(M4.viewProjection(s.pos, s.dir, s.up, this.cfg.photo.fovY, this.target.aspect, 0.03, 60), s.pos, frame);
        }
    }

    render(now) {
        const s = this.shot;
        if (!s) return;
        const r = this.game.renderer;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: s.showAvatar });
        pass.end();

        const lib = this.library;
        if (s.label || this.captureRequested) {
            const slot = lib.allocPhotoSlot();
            r.encoder.copyTextureToTexture({ texture: this.target.texture }, { texture: lib.photoAtlas, origin: lib.slotOrigin(slot) }, [...this.cfg.photo.size, 1]);
            lib.add({
                kind: 'photo', slot, time: new Date(), x: s.pos[0], z: s.pos[2],
                hdg: bearingOf(s.dir[0], s.dir[2]), label: s.label || this.game.world.placeLabel(s.pos[0], s.pos[2])
            });
            this.captureRequested = false;
        }

        // Video: downscale the viewfinder into the next frame-pool layer at the recording frame rate
        const rec = this.rec, v = this.cfg.video;
        if (rec && !s.label && rec.frames.length < Math.floor(((now - rec.t0) / 1000) * v.fps) + 1) {
            const layer = rec.frames.length < v.maxSeconds * v.fps ? lib.allocVideoLayer() : -1;
            if (layer < 0) {
                this.stopRecording();
            } else {
                const bp = r.encoder.beginRenderPass({
                    colorAttachments: [{ view: lib.layerViews[layer], clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }]
                });
                bp.setPipeline(this.blitPipeline);
                bp.setBindGroup(0, this.blitGroup);
                bp.draw(3);
                bp.end();
                rec.frames.push(layer);
            }
        }
    }
}

return { PhoneCamera };
});
