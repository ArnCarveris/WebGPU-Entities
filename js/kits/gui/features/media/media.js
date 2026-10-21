'use strict';
// The media kit's systems in the facility: CCTV over its security cameras (and the scenario's cctv), the phone's camera and
// gallery (media), IPTV (iptv), and their phone apps. The facility is their scene (Game.renderView), its security
// cameras their cameras (Game.cameras); the game reads them as game.cctv, game.camera, game.iptv.

Features.feature('gui/gui/media', (engine, kit) => {
const M = engine.kits.media;

// the game's (game.ext.media)
class MediaGame {
    static key = 'media';
    constructor(game) { this.game = game; }

    // the systems, on the renderer (before the world's instances are final)
    start(r) {
        const g = this.game, s = g.scenario;
        this.cctv = s.cctv || g.cameras().length ? new M.CctvSystem(g, s.cctv) : null;
        this.camera = s.media ? new M.PhoneCamera(g, s.media) : null;
        this.iptv = s.iptv ? new M.IptvPlayer(g, s.iptv) : null;
        for (const m of [this.cctv, this.camera, this.iptv]) m?.init(r);
    }

    apps(phone) { return M.mediaApps(this.game)(phone); }

    // what is shown decides what renders
    prepare() {
        const tv = this.iptv, phone = this.game.handheld;
        if (tv) {
            if (!phone.visible) tv.fullscreen = false;
            tv.update(phone.visible && (tv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        }
        this.cctv?.prepare();
        this.camera?.prepare();
    }

    // the views they render this frame, before the GUIs' targets and the player's view
    passes(r, now) {
        this.cctv?.render(r.encoder);
        this.camera?.render(r.encoder, now);
    }

    get fullscreen() { return !!this.iptv?.fullscreen; }
    hidden() { if (this.iptv) this.iptv.fullscreen = false; }
}

return { extensions: { app: MediaGame } };
});
