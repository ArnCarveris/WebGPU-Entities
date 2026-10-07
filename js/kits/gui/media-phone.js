'use strict';
// The media apps on the engine's handheld, for any world that has the media systems.

Features.kit('gui', (engine, kit) => {
const { CameraApp, GalleryApp, ViewerApp, TvApp } = kit;

// What a world lends the handheld (handheld.provide) for its media systems: the Camera and Photos apps over its
// PhoneCamera (game.camera), the IPTV app over its IptvPlayer (game.iptv; its CCTV channel over game.cctv), their
// pages and a root section that leads to them. The gui feature's facility lists these pages in its own scenario data;
// a world without its own phone pages (the portal feature's island) uses mediaPages().

function mediaApps(game) {
    return (phone) => ({
        ...(game.camera && { camera: new CameraApp(phone, game), photos: new GalleryApp(phone, game), viewer: new ViewerApp(phone, game) }),
        ...(game.iptv && { tv: new TvApp(phone, game) }),
    });
}

function mediaPages(game, header = 'MEDIA') {
    const cells = [], pages = {};
    if (game.camera) {
        cells.push({ type: 'nav', page: 'camera', title: 'Camera', sub: 'Photos & video', icon: [[142, 142, 147], 'C'] });
        cells.push({ type: 'nav', page: 'photos', title: 'Photos', sub: 'Library', icon: [[175, 82, 222], 'P'] });
        pages.camera = { title: 'Camera', app: 'camera' };
        pages.photos = { title: 'Photos', app: 'photos' };
    }
    if (game.iptv) {
        cells.push({ type: 'nav', page: 'tv', title: 'IPTV', sub: `${game.iptv.channels.length} channels`, icon: [[255, 59, 48], 'TV'] });
        pages.tv = { title: 'IPTV', app: 'tv' };
    }
    return cells.length ? { root: { sections: [{ header, cells }] }, ...pages } : {};
}

return { mediaApps, mediaPages };
});
