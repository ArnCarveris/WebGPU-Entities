'use strict';
// The phone's camera app.

Features.kit('gui', (engine, kit) => {
const { col, clipTime, pad3, IOS, PHONE_NAV_H, PhoneApp } = kit;

// Camera: live viewfinder (the phone camera's render target), photo / video modes
class CameraApp extends PhoneApp {
    draw(dc, now, id) {
        const t = now / 1000, W = this.W, H = this.H, phone = this.phone;
        const cam = this.game.camera, lib = cam.library;
        phone.contentH[id] = 0;
        dc.fillRect(0, PHONE_NAV_H, W, H - PHONE_NAV_H, col([0, 0, 0]));
        const video = cam.mode === 'video';
        const rec = cam.rec;

        // Live viewfinder: a surface whose material is the phone camera's render target
        const V = { x: 0, y: PHONE_NAV_H + 6, w: W, h: 360 };
        dc.setMaterial('viewfinder');
        dc.stretchPic(V.x, V.y, V.w, V.h, 0, 0, 1, 1, [1, 1, 1, 1]);
        dc.setMaterial('atlas');
        for (const k of [1, 2]) {
            dc.fillRect(V.x + (V.w * k) / 3, V.y, 1, V.h, [1, 1, 1, 0.22]);
            dc.fillRect(V.x, V.y + (V.h * k) / 3, V.w, 1, [1, 1, 1, 0.22]);
        }
        const fs = 42 + Math.sin(t * 3) * 2;
        dc.rect(W / 2 - fs / 2, V.y + V.h / 2 - fs / 2, fs, fs, 1.5, col([255, 214, 10]));
        dc.roundRect(8, V.y + 8, 72, 20, 10, [0, 0, 0, 0.45]);
        dc.text(`HDG ${pad3(this.game.camera.heading)}°`, 44, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
        const right = video ? `${clipTime(cam.freeVideoSeconds)} free` : `${lib.counts().photos}/${cam.cfg.photo.capacity}`;
        dc.roundRect(W - 72, V.y + 8, 64, 20, 10, [0, 0, 0, 0.45]);
        dc.text(right, W - 40, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
        if (rec) {
            // Recording timer + progress along the bottom of the viewfinder
            const secs = cam.recordingSeconds, max = cam.cfg.video.maxSeconds;
            dc.roundRect(W / 2 - 46, V.y + 8, 92, 20, 10, col(IOS.red, 0.92));
            if (Math.floor(t * 2) % 2) dc.circle(W / 2 - 33, V.y + 18, 3.5, [1, 1, 1, 1], 12);
            dc.text(`${clipTime(secs)} / ${clipTime(max)}`, W / 2 + 6, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
            dc.fillRect(V.x, V.y + V.h - 3, V.w * Math.min(1, secs / max), 3, col(IOS.red));
        }
        const since = now - cam.lastShot;
        if (since < 280) dc.fillRect(V.x, V.y, V.w, V.h, [1, 1, 1, 1 - since / 280]);

        // Mode switch (locked while recording)
        const MY = V.y + V.h + 20;
        for (const [mode, x] of [['video', W / 2 - 38], ['photo', W / 2 + 38]]) {
            if (!rec) phone.hit(`mode:${mode}`, x - 32, MY - 14, 64, 24);
            const color = cam.mode === mode ? col([255, 214, 10]) : [1, 1, 1, rec ? 0.3 : phone.isHover(`mode:${mode}`) ? 1 : 0.7];
            dc.text(mode.toUpperCase(), x, MY + 4, 12, color, 'center', false, 'sansBold');
        }

        // Shutter: white for photos, red record / square stop for video
        const CY = H - 54;
        const hover = phone.isHover('shutter');
        const pressed = phone.isPressed('shutter', 180);
        phone.hit('shutter', W / 2 - 32, CY - 32, 64, 64);
        dc.ring(W / 2, CY, 30, 3, [1, 1, 1, 1], 40);
        if (!video) dc.circle(W / 2, CY, pressed ? 21 : 25, [1, 1, 1, hover ? 0.8 : 1], 36);
        else if (rec) dc.roundRect(W / 2 - 11, CY - 11, 22, 22, 5, col(IOS.red, hover ? 0.8 : 1));
        else dc.circle(W / 2, CY, pressed ? 21 : 24, col(IOS.red, hover ? 0.8 : 1), 36);

        // Newest item (opens the gallery)
        if (lib.items.length) {
            const item = lib.items[0];
            phone.hit('nav:photos', 18, CY - 22, 44, 44);
            lib.draw(dc, item, 18, CY - 22, 44, 44, true, item.kind === 'video' ? lib.frameAt(item, now) : 0);
            dc.rect(18, CY - 22, 44, 44, 1.5, [1, 1, 1, phone.isHover('nav:photos') ? 1 : 0.7]);
        } else {
            dc.roundRect(18, CY - 22, 44, 44, 6, [1, 1, 1, 0.12]);
        }
    }

    onPress(kind, key) {
        const cam = this.game.camera;
        if (kind === 'shutter') cam.shutter();
        else if (kind === 'mode') cam.mode = key;
        else return false;
        return true;
    }
}

return { CameraApp };
});
