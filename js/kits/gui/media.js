'use strict';
// The media library: photos and their thumbnails.

Features.kit('gui', (engine, kit) => {
// Phone camera and the media library it fills.
//
// Photos: the viewfinder render target is copied into a slot of a photo atlas ('photos' material).
// Videos: each recorded frame is downscaled into one layer of a texture-array frame pool ('video'
// material; the GUI vertex colour's red channel picks the layer). Everything stays on the GPU.

class MediaLibrary {
    constructor(cfg) {
        this.cfg = cfg;
        this.items = [];            // newest first: { id, kind: 'photo' | 'video', slot | frames, time, x, z, hdg, label }
        this.nextId = 1;
        const pool = cfg.video.pool;
        this.freeLayers = Array.from({ length: pool }, (_, i) => pool - 1 - i);
        const [pw, ph] = cfg.photo.size;
        const [vw, vh] = cfg.video.size;
        this.photoSquareInset = (ph - pw) / 2;
        this.frameSquareInset = (vh - vw) / 2 / vh;
    }

    init(renderer) {
        const { photo, video } = this.cfg;
        this.photoAtlas = renderer.device.createTexture({
            size: [photo.atlas, photo.atlas],
            format: renderer.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        renderer.registerMaterial('photos', 'gui', this.photoAtlas.createView());

        const [vw, vh] = video.size;
        this.framePool = renderer.device.createTexture({
            size: [vw, vh, video.pool],
            format: renderer.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.layerViews = Array.from({ length: video.pool }, (_, i) =>
            this.framePool.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
        renderer.registerMaterial('video', 'video', this.framePool.createView({ dimension: '2d-array' }));
    }

    get photoCols() {
        return Math.floor(this.cfg.photo.atlas / this.cfg.photo.size[0]);
    }

    slotOrigin(slot) {
        const [pw, ph] = this.cfg.photo.size;
        return [(slot % this.photoCols) * pw, Math.floor(slot / this.photoCols) * ph, 0];
    }

    photoUV(slot, square = false) {
        const [pw, ph] = this.cfg.photo.size;
        const A = this.cfg.photo.atlas;
        const [x, y] = this.slotOrigin(slot);
        const inset = square ? this.photoSquareInset : 0;   // centre crop for square thumbnails
        return [x / A, (y + inset) / A, (x + pw) / A, (y + ph - inset) / A];
    }

    // Draw an item's picture: photos with the 'photos' material, video frames with 'video'
    draw(dc, item, x, y, w, h, square, frame = 0) {
        if (item.kind === 'photo') {
            const [u0, v0, u1, v1] = this.photoUV(item.slot, square);
            dc.setMaterial('photos');
            dc.stretchPic(x, y, w, h, u0, v0, u1, v1, [1, 1, 1, 1]);
        } else {
            const inset = square ? this.frameSquareInset : 0;
            dc.setMaterial('video');
            dc.stretchPic(x, y, w, h, 0, inset, 1, 1 - inset, [item.frames[frame], 1, 1, 1]);
        }
        dc.setMaterial('atlas');
    }

    frameAt(item, now) {
        return Math.floor(((now / 1000) * this.cfg.video.fps) % item.frames.length);
    }

    duration(item) {
        return item.frames.length / this.cfg.video.fps;
    }

    counts() {
        const videos = this.items.filter((m) => m.kind === 'video').length;
        return { photos: this.items.length - videos, videos };
    }

    summary() {
        const c = this.counts();
        return `${c.photos} photo${c.photos === 1 ? '' : 's'}, ${c.videos} video${c.videos === 1 ? '' : 's'}`;
    }

    indexOf(id) {
        return this.items.findIndex((m) => m.id === id);
    }

    remove(idx) {
        const [item] = this.items.splice(idx, 1);
        if (item.kind === 'video') this.freeLayers.push(...item.frames);
        return item;
    }

    add(item) {
        item.id = this.nextId++;
        this.items.unshift(item);
        return item;
    }

    allocPhotoSlot() {
        const used = new Set(this.items.filter((m) => m.kind === 'photo').map((m) => m.slot));
        for (let i = 0; i < this.cfg.photo.capacity; i++) if (!used.has(i)) return i;
        for (let i = this.items.length - 1; i >= 0; i--) {                 // full: recycle the oldest photo
            if (this.items[i].kind === 'photo') return this.remove(i).slot;
        }
        return 0;
    }

    // A free frame-pool layer; when the pool is full the oldest finished video is dropped
    allocVideoLayer() {
        if (!this.freeLayers.length) {
            for (let i = this.items.length - 1; i >= 0; i--) {
                if (this.items[i].kind === 'video') { this.remove(i); break; }
            }
        }
        return this.freeLayers.length ? this.freeLayers.pop() : -1;
    }
}

return { MediaLibrary };
});
