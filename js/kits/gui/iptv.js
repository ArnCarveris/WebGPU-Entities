'use strict';
// IPTV: channels and playback.

Features.kit('gui', (engine, kit) => {
const { wrapIndex } = kit;

// IPTV player. Internet channels are HLS streams (hls.js is loaded on first use); each new video frame
// is copied into a GPU texture exposed as the 'tv' material. Local channels need no network.

class IptvPlayer {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.channels = cfg.channels;
        this.channel = 0;
        this.video = null;
        this.hls = null;
        this.hlsReady = null;       // promise for the hls.js script
        this.status = 'ready';      // 'ready' | 'loading' | 'buffering' | 'error'
        this.error = '';
        this.playing = true;
        this.muted = false;
        this.texW = 0;
        this.texH = 0;
        this.hasFrame = false;
        this.newFrame = false;
        this.fullscreen = false;
        this.switchTime = 0;
        this.failed = {};           // channel index -> last error
    }

    init(renderer) {
        this.renderer = renderer;
        this.tex = this.createTexture(16, 16);
        renderer.registerMaterial('tv', 'gui', this.tex.createView());
    }

    createTexture(w, h) {
        return this.renderer.device.createTexture({
            size: [w, h],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
    }

    get current() {
        return this.channels[this.channel];
    }

    get canFullscreen() {
        const ch = this.current;
        return ch.kind === 'cctv' || !!(ch.url && this.hasFrame && this.status !== 'error');
    }

    get aspect() {
        return this.current.kind === 'cctv' ? this.game.cctv.aspect : this.texW / this.texH;
    }

    videoElement() {
        if (this.video) return this.video;
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';   // needed to upload frames to WebGPU
        v.playsInline = true;
        v.preload = 'auto';
        v.addEventListener('playing', () => { if (this.status !== 'error') this.status = 'ready'; });
        v.addEventListener('waiting', () => { if (this.status !== 'error') this.status = 'buffering'; });
        // hls.js reports its own (fatal) errors; the element's error only matters for native HLS.
        // Stream teardown on a channel switch also fires one, which must not hit the new channel.
        v.addEventListener('error', () => {
            const ch = this.current;
            if (!this.hls && this.status !== 'ready' && ch.url && v.getAttribute('src') === ch.url) this.fail(this.channel, 'Media error');
        });
        if ('requestVideoFrameCallback' in v) {
            const onFrame = () => { this.newFrame = true; v.requestVideoFrameCallback(onFrame); };
            v.requestVideoFrameCallback(onFrame);
        }
        this.video = v;
        return v;
    }

    loadHls() {
        if (window.Hls) return Promise.resolve();
        if (!this.hlsReady) {
            this.hlsReady = new Promise((resolve, reject) => {
                const sc = document.createElement('script');
                sc.src = this.cfg.hlsScript;
                sc.onload = resolve;
                sc.onerror = () => { this.hlsReady = null; reject(new Error('hls.js failed to load')); };
                document.head.appendChild(sc);
            });
        }
        return this.hlsReady;
    }

    stopStream() {
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        const v = this.video;
        if (v && v.getAttribute('src')) {
            v.pause();
            v.removeAttribute('src');
            v.load();
        }
    }

    fail(index, msg) {
        if (index !== this.channel) return;
        this.status = 'error';
        this.error = msg;
        this.failed[index] = msg;
        this.fullscreen = false;
        this.stopStream();
    }

    tune(i) {
        i = wrapIndex(i, this.channels.length);
        this.stopStream();
        this.channel = i;
        this.error = '';
        this.hasFrame = false;
        this.playing = true;
        this.switchTime = performance.now();
        const ch = this.current;
        if (!ch.url) {
            this.status = 'ready';
            if (ch.kind === 'card') this.fullscreen = false;
            return;
        }
        this.status = 'loading';
        delete this.failed[i];
        const v = this.videoElement();
        const start = () => {
            if (this.channel !== i) return;
            v.muted = this.muted || !this.game.audio.enabled;
            v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
        };
        // Prefer hls.js (MSE) everywhere it works; native HLS is the fallback (e.g. iOS Safari)
        const playNative = () => {
            if (this.channel !== i) return;
            if (!v.canPlayType('application/vnd.apple.mpegurl')) { this.fail(i, 'HLS not supported'); return; }
            v.src = ch.url;
            start();
        };
        this.loadHls().then(() => {
            if (this.channel !== i) return;
            if (!window.Hls || !window.Hls.isSupported()) { playNative(); return; }
            const hls = new window.Hls({ maxBufferLength: 12 });
            this.hls = hls;
            hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) this.fail(i, d.details || d.type); });
            hls.on(window.Hls.Events.MANIFEST_PARSED, start);
            hls.loadSource(ch.url);
            hls.attachMedia(v);
        }).catch(playNative);
    }

    togglePlay() {
        const v = this.video;
        if (!this.current.url || !v) return;
        if (this.status === 'error') { this.tune(this.channel); return; }   // tap to retry
        this.playing = !this.playing;
        if (this.playing) v.play().catch(() => {}); else v.pause();
    }

    // Every frame: pause when the app isn't on screen; upload new frames when it is
    update(visible) {
        if (visible && this.current.kind === 'cctv') this.game.cctv.request();
        const v = this.video;
        if (!v || !this.current.url) return;
        v.muted = this.muted || !this.game.audio.enabled;
        const active = !!(this.hls || v.getAttribute('src'));
        if (!visible) {
            if (!v.paused) v.pause();
            return;
        }
        if (this.playing && v.paused && active && this.status !== 'error' && v.readyState >= 2) v.play().catch(() => {});
        if (v.readyState >= 2 && v.videoWidth && (this.newFrame || !this.hasFrame || !('requestVideoFrameCallback' in v))) {
            if (v.videoWidth !== this.texW || v.videoHeight !== this.texH) {
                this.tex.destroy();
                this.texW = v.videoWidth;
                this.texH = v.videoHeight;
                this.tex = this.createTexture(this.texW, this.texH);
                this.renderer.setMaterialTexture('tv', this.tex.createView());
            }
            try {
                this.renderer.device.queue.copyExternalImageToTexture({ source: v }, { texture: this.tex }, [this.texW, this.texH]);
                this.hasFrame = true;
                this.newFrame = false;
            } catch {
                this.fail(this.channel, 'Blocked (no CORS)');
            }
        }
    }
}

return { IptvPlayer };
});
