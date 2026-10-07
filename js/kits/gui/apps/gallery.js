'use strict';
// The phone's gallery app.

Features.kit('gui', (engine, kit) => {
const { col, clipTime, IOS, PHONE_NAV_H, PhoneApp } = kit;

// Photo / video grid
class GalleryApp extends PhoneApp {
    draw(dc, now, id) {
        const phone = this.phone, W = this.W, lib = this.game.camera.library, items = lib.items;
        const scroll = phone.scroll[id] || 0;
        const gap = 2, cs = (W - gap * 2) / 3;
        let y = PHONE_NAV_H + 6 - scroll;
        dc.setClip(0, PHONE_NAV_H, W, this.H - PHONE_NAV_H);
        dc.text(lib.summary(), 14, y + 16, 12, col(IOS.sub), 'left', false, 'sans');
        y += 26;
        if (!items.length) {
            dc.text('No photos or videos yet', W / 2, PHONE_NAV_H + 200, 17, col(IOS.text), 'center', false, 'sansBold');
            dc.text('Use the Camera page.', W / 2, PHONE_NAV_H + 222, 12, col(IOS.sub), 'center', false, 'sans');
        }
        const cell = (i) => [(i % 3) * (cs + gap), y + Math.floor(i / 3) * (cs + gap)];
        // Thumbnails grouped per material (photos, then videos) to keep the surface count low
        dc.setMaterial('photos');
        items.forEach((m, i) => {
            if (m.kind !== 'photo') return;
            const [x, ty] = cell(i);
            const [u0, v0, u1, v1] = lib.photoUV(m.slot, true);
            dc.stretchPic(x, ty, cs, cs, u0, v0, u1, v1, [1, 1, 1, 1]);
        });
        dc.setMaterial('video');
        items.forEach((m, i) => {
            if (m.kind !== 'video') return;
            const [x, ty] = cell(i);
            const inset = lib.frameSquareInset;
            dc.stretchPic(x, ty, cs, cs, 0, inset, 1, 1 - inset, [m.frames[lib.frameAt(m, now)], 1, 1, 1]);   // thumbnails play along
        });
        dc.setMaterial('atlas');
        items.forEach((m, i) => {
            const [x, ty] = cell(i);
            const hid = `nav:photo:${m.id}`;
            phone.hit(hid, x, ty, cs, cs);
            if (m.kind === 'video') {
                dc.fillRect(x, ty + cs - 20, cs, 20, [0, 0, 0, 0.35]);
                dc.playIcon(x + 11, ty + cs - 10, 8, [1, 1, 1, 0.95]);
                dc.text(clipTime(lib.duration(m)), x + cs - 6, ty + cs - 5.5, 11, col([255, 255, 255]), 'right', false, 'sansBold');
            }
            const pressed = phone.isPressed(hid, 220);
            if (phone.isHover(hid) || pressed) dc.fillRect(x, ty, cs, cs, [1, 1, 1, pressed ? 0.4 : 0.2]);
        });
        dc.clearClip();
        phone.contentH[id] = 32 + Math.ceil(items.length / 3) * (cs + gap) + 16;
    }
}

return { GalleryApp };
});
