'use strict';
// The gui kit's media systems on the island: CCTV, the phone's camera and photos, IPTV.

Features.part('portal', (engine, feature) => {
const { M4, CctvSystem, PhoneCamera, IptvPlayer, mediaApps, mediaPages } = engine.kits.gui;

// What the scenario asks for: CCTV over its security cameras (securityCamera entities; portal.cctv tunes it), the
// phone's camera and photo library (portal.media), IPTV (portal.iptv). This is their `game` (js/kits/gui/views.js):
// the GUI materials of the renderer's GUI pass (render/gui-pass.js), the island as their scene (Game.renderView), the
// engine's handheld, whose Camera, Photos and IPTV pages it lends. A scenario loaded later replaces the systems; the handheld keeps the apps it was
// lent, which read them from here.

class PortalMedia {
    constructor(app) {
        this.app = app;
        this.renderer = app.renderer.ext.gui;        // the materials contract
        this.scene = app;
        this.handheld = app.fx.host.handheld;
        this.audio = { enabled: true, emit: (name, payload = {}) => app.fx.emit(name, payload) };
        this.cctv = this.camera = this.iptv = null;
        this.provided = false;
    }

    load(scn, world) {
        this.iptv?.video?.pause?.();
        this.cctv = world.cameras.length ? new CctvSystem(this, scn.cctv) : null;
        this.camera = scn.media ? new PhoneCamera(this, scn.media) : null;
        this.iptv = scn.iptv ? new IptvPlayer(this, scn.iptv) : null;
        for (const s of [this.cctv, this.camera, this.iptv]) s?.init(this.renderer);
        if (!this.provided && (this.camera || this.iptv)) this.provide();
    }

    provide() {
        this.provided = true;
        const media = this;
        this.handheld.provide({
            id: this.app.fx.id,
            get pages() { return mediaPages(media); },
            apps: mediaApps(this),
            renderer: this.renderer,
            fullscreen: () => !!this.iptv?.fullscreen,
            hidden: () => { if (this.iptv) this.iptv.fullscreen = false; },
        });
    }

    // ---- what the systems ask of their world ----
    cameras() { return this.app.world.cameras; }

    // the phone, held by the player: the handheld's eye-space pose in front of the player's eye
    phoneModel() {
        const P = this.app.player;
        return M4.multiply(M4.facing(P.cam.pos, P.basis().fwd), this.handheld.pose);
    }

    // a photo's caption: the area it was taken in
    placeLabel(x, z) {
        const w = this.app.world, a = w.areas[w.areaAt([x, 1.6, z])];
        return a ? (a.outdoor ? 'Outdoors' : a.name) : '';
    }

    // per frame, after the main view's screens are built: what is shown decides what renders; views submit before
    // the main frame, so screens sample this frame's pictures
    frame(now) {
        const phone = this.handheld, tv = this.iptv;
        if (tv) {
            if (!phone.visible) tv.fullscreen = false;
            tv.update(phone.visible && (tv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        }
        this.cctv?.prepare();
        this.camera?.prepare();
        if (!this.cctv?.renderingCamera && !this.camera?.shot) return;
        const device = this.renderer.device, enc = device.createCommandEncoder();
        this.cctv?.render(enc);
        this.camera?.render(enc, now);
        device.queue.submit([enc.finish()]);
    }
}

return { PortalMedia };
});
