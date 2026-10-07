'use strict';
// The phone's camera: renders the view and takes photos, in any world that can render a view of itself.

Features.kit('gui', (engine, kit) => {
const { V3, bearingOf, BLIT_SHADER, CLEAR_COLOR, MediaLibrary, ViewTarget } = kit;

// game: the world's app: renderer (the materials contract, views.js), audio ({ emit }), scene (renderView), handheld
//       (the engine's), phoneModel() (the phone's world matrix, held by the player), placeLabel(x, z) (optional)
// cfg:  { photo: { size, atlas, capacity, fovY }, video: { size, fps, pool, maxSeconds }, seedShots, near, far }

const MEDIA_DEFAULTS = {
    photo: { size: [384, 512], atlas: 2048, capacity: 20, fovY: 0.95 },
    video: { size: [192, 256], fps: 12, pool: 180, maxSeconds: 10 },
    seedShots: [], near: 0.03, far: 60,
};

class PhoneCamera {
    constructor(game, cfg = {}) {
        this.game = game;
        this.cfg = cfg = {
            ...MEDIA_DEFAULTS, ...cfg,
            photo: { ...MEDIA_DEFAULTS.photo, ...cfg.photo }, video: { ...MEDIA_DEFAULTS.video, ...cfg.video },
        };
        this.library = new MediaLibrary(cfg);
        this.mode = 'photo';            // 'photo' | 'video'
        this.rec = null;                // active recording
        this.captureRequested = false;
        this.lastShot = -1e9;
        this.seeds = [...cfg.seedShots];
        this.shot = null;               // camera rendering this frame
        this.heading = 0;               // where the phone points (compass degrees)
    }

    init(renderer) {
        const device = renderer.device;
        this.library.init(renderer);
        const [w, h] = this.cfg.photo.size;
        this.target = new ViewTarget(device, renderer.format, w, h, { material: 'viewfinder', copySrc: true });
        renderer.registerMaterial('viewfinder', 'gui', this.target.colorView);

        const module = device.createShaderModule({ code: BLIT_SHADER });
        this.blitPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: renderer.format }] },
            primitive: { topology: 'triangle-list' }
        });
        this.blitGroup = device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
                { binding: 1, resource: this.target.colorView }
            ]
        });
    }

    get recordingSeconds() {
        return this.rec ? this.rec.frames.length / this.cfg.video.fps : 0;
    }

    get freeVideoSeconds() {
        return this.library.freeLayers.length / this.cfg.video.fps;
    }

    placeLabel(x, z) {
        return this.game.placeLabel?.(x, z) || `${x.toFixed(0)}, ${z.toFixed(0)}`;
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
        this.game.audio.emit('shutter');
    }

    startRecording() {
        const m = this.game.phoneModel(), x = m[12], z = m[14];
        this.rec = { frames: [], t0: performance.now(), time: new Date(), x, z, hdg: this.heading, label: this.placeLabel(x, z) };
        this.game.audio.emit('chime', { up: true });
    }

    stopRecording() {
        const rec = this.rec;
        if (!rec) return;
        this.rec = null;
        this.game.audio.emit('chime', { up: false });
        if (!rec.frames.length) return;
        this.library.add({ kind: 'video', frames: rec.frames, time: rec.time, x: rec.x, z: rec.z, hdg: rec.hdg, label: rec.label });
    }

    // ---- per frame ----
    // The viewfinder renders while the phone shows the Camera page; otherwise pending startup shots
    prepare() {
        const phone = this.game.handheld;
        this.shot = null;
        if (phone.visible && phone.gui.pagesVisible().includes('camera')) {
            const m = this.game.phoneModel();
            const dir = [-m[8], -m[9], -m[10]];                 // the phone's back faces away from its screen
            this.shot = { pos: V3.add([m[12], m[13], m[14]], V3.scale(dir, 0.012)), dir, up: [m[4], m[5], m[6]], showAvatar: false };
            this.heading = bearingOf(dir[0], dir[2]);
        } else if (this.seeds.length) {
            const s = this.seeds.shift();
            this.shot = { pos: s.pos, dir: V3.normalize(V3.sub(s.target, s.pos)), up: [0, 1, 0], showAvatar: true, label: s.label };
        } else {
            this.captureRequested = false;
        }
        if (this.rec && !(this.shot && !this.shot.label)) this.stopRecording();   // viewfinder closed
    }

    render(enc, now) {
        const s = this.shot, c = this.cfg;
        if (!s) return;
        this.game.scene.renderView(enc, this.target, {
            eye: s.pos, dir: s.dir, up: s.up, fovY: c.photo.fovY, near: c.near, far: c.far, showAvatar: s.showAvatar
        });

        const lib = this.library;
        if (s.label || this.captureRequested) {
            const slot = lib.allocPhotoSlot();
            enc.copyTextureToTexture({ texture: this.target.texture }, { texture: lib.photoAtlas, origin: lib.slotOrigin(slot) }, [...c.photo.size, 1]);
            lib.add({
                kind: 'photo', slot, time: new Date(), x: s.pos[0], z: s.pos[2],
                hdg: bearingOf(s.dir[0], s.dir[2]), label: s.label || this.placeLabel(s.pos[0], s.pos[2])
            });
            this.captureRequested = false;
        }

        // Video: downscale the viewfinder into the next frame-pool layer at the recording frame rate
        const rec = this.rec, v = c.video;
        if (rec && !s.label && rec.frames.length < Math.floor(((now - rec.t0) / 1000) * v.fps) + 1) {
            const layer = rec.frames.length < v.maxSeconds * v.fps ? lib.allocVideoLayer() : -1;
            if (layer < 0) {
                this.stopRecording();
            } else {
                const bp = enc.beginRenderPass({
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

return { MEDIA_DEFAULTS, PhoneCamera };
});
