'use strict';
// The phone's TV app.

Features.kit('gui', (engine, kit) => {
const { col, fitRect, timeText, clipTime, IOS, PHONE_NAV_H, PhoneApp } = kit;

// IPTV: player, transport controls and the channel list
class TvApp extends PhoneApp {
    static PLAYER_H = 152;

    get iptv() { return this.game.iptv; }
    get listTop() { return PHONE_NAV_H + TvApp.PLAYER_H + 50; }

    drawTestCard(dc, R) {
        const bars = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192]];
        const rev = [[0, 0, 192], [19, 19, 19], [192, 0, 192], [19, 19, 19], [0, 192, 192], [19, 19, 19], [192, 192, 192]];
        const bw = R.w / 7, h1 = R.h * 0.67, h2 = R.h * 0.08;
        bars.forEach((c, i) => dc.fillRect(R.x + i * bw, R.y, bw + 0.5, h1, col(c)));
        rev.forEach((c, i) => dc.fillRect(R.x + i * bw, R.y + h1, bw + 0.5, h2, col(c)));
        const y3 = R.y + h1 + h2, h3 = R.h - h1 - h2;
        [[0, 33, 76], [255, 255, 255], [50, 0, 106]].forEach((c, i) => dc.fillRect(R.x + i * bw * 1.25, y3, bw * 1.25 + 0.5, h3, col(c)));
        dc.fillRect(R.x + bw * 3.75, y3, R.w - bw * 3.75, h3, col([19, 19, 19]));
        const cx = R.x + R.w / 2, cy = R.y + R.h * 0.42;
        dc.ring(cx, cy, R.h * 0.3, 1.5, [1, 1, 1, 0.8], 48);
        dc.roundRect(cx - 48, cy - 12, 96, 24, 4, [0, 0, 0, 0.8]);
        dc.text(timeText(new Date()), cx, cy + 5, 13, col([255, 255, 255]), 'center', false, 'sansBold');
        dc.text(this.iptv.cfg.cardTitle, cx, R.y + 16, 9.5, [1, 1, 1, 0.9], 'center', false, 'sansBold');
    }

    // The current channel's picture in rect R (letterboxed)
    drawPicture(dc, R, now) {
        const tv = this.iptv, ch = tv.current, cctv = this.game.cctv;
        dc.fillRect(R.x, R.y, R.w, R.h, col([0, 0, 0]));
        if (ch.kind === 'card') {
            this.drawTestCard(dc, R);
        } else if (ch.kind === 'cctv') {
            const cam = cctv.current;
            const r = fitRect(R, cctv.aspect);
            dc.setMaterial('cctv');
            dc.stretchPic(r.x, r.y, r.w, r.h, 0, 0, 1, 1, [cctv.signal(now, tv.switchTime), 1, 1, 1]);
            dc.setMaterial('atlas');
            dc.text(`${cam.label} ${cam.name}`, r.x + 8, r.y + r.h - 8, 9.5, [1, 1, 1, 0.9], 'left', false, 'sansBold');
        } else {
            if (tv.hasFrame) {
                const r = fitRect(R, tv.aspect);
                dc.setMaterial('tv');
                dc.stretchPic(r.x, r.y, r.w, r.h, 0, 0, 1, 1, [1, 1, 1, 1]);
                dc.setMaterial('atlas');
            }
            const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
            if (tv.status === 'error') {
                dc.fillRect(R.x, R.y, R.w, R.h, [0, 0, 0, 0.7]);
                dc.text('Stream unavailable', cx, cy - 2, 14, col([255, 255, 255]), 'center', false, 'sansBold');
                dc.text(`${tv.error} · tap to retry`, cx, cy + 16, 10.5, col(IOS.sub), 'center', false, 'sans');
            } else if (tv.status === 'loading' || tv.status === 'buffering' || !tv.hasFrame) {
                dc.spinner(cx, cy, 13, now / 1000);
            } else if (!tv.playing) {
                dc.circle(cx, cy, 22, [0, 0, 0, 0.5], 28);
                dc.playIcon(cx + 2, cy, 18, [1, 1, 1, 0.95]);
            }
        }
    }

    iconButton(dc, id, cx, cy, enabled, draw) {
        const phone = this.phone;
        if (enabled) phone.hit(id, cx - 22, cy - 20, 44, 40);
        const pressed = phone.isPressed(id, 180);
        if (phone.isHover(id) || pressed) dc.circle(cx, cy, 18, col(IOS.text, pressed ? 0.12 : 0.06), 24);
        draw(col(IOS.text, enabled ? 1 : 0.25));
    }

    draw(dc, now, id) {
        const t = now / 1000, phone = this.phone, W = this.W, tv = this.iptv, ch = tv.current, v = tv.video;
        const P = { x: 0, y: PHONE_NAV_H, w: W, h: TvApp.PLAYER_H };
        const listTop = this.listTop;

        // ---- Channel list (scrolls under the player) ----
        const scroll = phone.scroll[id] || 0;
        const rowH = 52;
        let y = listTop - scroll;
        dc.setClip(0, listTop, W, this.H - listTop);
        dc.text('CHANNELS', 28, y + 20, 11.5, col(IOS.sub), 'left', false, 'sans');
        y += 28;
        dc.roundRect(12, y, 246, tv.channels.length * rowH, 10, col(IOS.cell));
        tv.channels.forEach((c, i) => {
            const ry = y + i * rowH;
            const hid = `tv:ch:${i}`;
            phone.hit(hid, 12, ry, 246, rowH, listTop);
            const pressed = phone.isPressed(hid, 220);
            if (phone.isHover(hid) || pressed) dc.roundRect(14, ry + 2, 242, rowH - 4, 8, col(pressed ? IOS.press : IOS.bg));
            dc.roundRect(24, ry + 12, 28, 28, 7, col(c.color));
            dc.text(String(i + 1), 38, ry + 31, 14, col(IOS.cell), 'center', false, 'sansBold');
            const cur = i === tv.channel;
            dc.text(c.name, 62, ry + 23, 14.5, col(cur ? IOS.blue : IOS.text), 'left', false, cur ? 'sansBold' : 'sans');
            dc.text(c.sub, 62, ry + 39, 11, col(IOS.sub), 'left', false, 'sans');
            if (cur && tv.status !== 'error') {
                for (let k = 0; k < 3; k++) {
                    const bh = tv.playing ? 4 + 10 * Math.abs(Math.sin(t * 6 + k * 1.3)) : 4;
                    dc.fillRect(228 + k * 6, ry + 33 - bh, 4, bh, col(IOS.blue));
                }
            } else if (tv.failed[i]) {
                dc.text('Offline', 244, ry + 30, 11.5, col(IOS.red), 'right', false, 'sans');
            }
            if (i < tv.channels.length - 1) dc.fillRect(62, ry + rowH - 1.5, 196, 1.5, col(IOS.sep, 0.55));
        });
        dc.clearClip();
        // The phone clamps scroll to contentH - (H - NAV_H); only the list below the player scrolls
        phone.contentH[id] = 28 + tv.channels.length * rowH + 16 + (listTop - PHONE_NAV_H);

        // ---- Player (drawn over the list's top edge) ----
        dc.fillRect(0, PHONE_NAV_H, W, listTop - PHONE_NAV_H, col(IOS.bg));
        this.drawPicture(dc, P, now);
        phone.hit('tv:toggle', P.x, P.y, P.w, P.h);
        dc.roundRect(8, P.y + 8, 22 + dc.textWidth(ch.name, 10.5, 'sansBold'), 18, 9, [0, 0, 0, 0.55]);
        dc.text(`${tv.channel + 1}`, 15, P.y + 21, 10.5, col([255, 214, 10]), 'left', false, 'sansBold');
        dc.text(ch.name, 26, P.y + 21, 10.5, col([255, 255, 255]), 'left', false, 'sansBold');
        const vod = ch.url && !ch.live && v && Number.isFinite(v.duration) && v.duration > 0;
        if (!vod) {
            dc.roundRect(W - 44, P.y + 8, 36, 18, 4, col(IOS.red));
            dc.text('LIVE', W - 26, P.y + 21, 10, col([255, 255, 255]), 'center', false, 'sansBold');
        } else {
            dc.fillRect(0, P.y + P.h - 3, W, 3, [1, 1, 1, 0.25]);
            dc.fillRect(0, P.y + P.h - 3, W * (v.currentTime / v.duration), 3, col(IOS.red));
            dc.roundRect(W - 84, P.y + 8, 76, 18, 9, [0, 0, 0, 0.55]);
            dc.text(`${clipTime(v.currentTime)} / ${clipTime(v.duration)}`, W - 46, P.y + 21, 10, col([255, 255, 255]), 'center', false, 'sansBold');
        }

        // ---- Transport controls ----
        const CY = P.y + P.h + 24;
        this.iconButton(dc, 'tv:prev', 36, CY, true, (c) => dc.text('‹', 36, CY + 9, 28, c, 'center', false, 'sans'));
        this.iconButton(dc, 'tv:toggle', 90, CY, !!ch.url, (c) => {
            if (tv.playing && ch.url) {
                dc.fillRect(83, CY - 8, 5, 16, c);
                dc.fillRect(92, CY - 8, 5, 16, c);
            } else dc.playIcon(92, CY, 14, c);
        });
        this.iconButton(dc, 'tv:next', 144, CY, true, (c) => dc.text('›', 144, CY + 9, 28, c, 'center', false, 'sans'));
        this.iconButton(dc, 'tv:mute', 196, CY, !!ch.url, (c) => {
            dc.fillRect(186, CY - 4, 5, 8, c);
            dc.polygon([[190, CY - 4], [196, CY - 9], [196, CY + 9], [190, CY + 4]], c);
            if (tv.muted || !this.game.audio.enabled) {
                dc.line(200, CY - 5, 209, CY + 5, 2, c);
                dc.line(209, CY - 5, 200, CY + 5, 2, c);
            } else {
                dc.polyline(dc.arcPts(197, CY, 6, -0.9, 0.9, 6), 1.8, c);
                dc.polyline(dc.arcPts(197, CY, 11, -0.9, 0.9, 8), 1.8, c);
            }
        });
        this.iconButton(dc, 'tv:full', 244, CY, tv.canFullscreen, (c) => {
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                const x = 244 + sx * 8, yy = CY + sy * 7;
                dc.line(x, yy, x - sx * 5, yy, 2, c);
                dc.line(x, yy, x, yy - sy * 5, 2, c);
            }
        });
    }

    // Full screen: the phone turns to landscape and the picture is drawn rotated 90 degrees in the
    // (portrait) GUI space, so it appears upright to the viewer
    drawFullscreen(dc, now) {
        const tv = this.iptv, ch = tv.current, W = this.W, H = this.H;
        dc.fillRect(0, 0, W, H, col([0, 0, 0]));
        const aspect = tv.aspect;
        // In landscape, GUI y runs left -> right (H long) and GUI x runs bottom -> top (W tall)
        let dw = H, dh = H / aspect;
        if (dh > W) { dh = W; dw = W * aspect; }
        const x0 = (W - dh) / 2, x1 = x0 + dh, y0 = (H - dw) / 2, y1 = y0 + dw;
        const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const uvs = [[0, 1], [0, 0], [1, 0], [1, 1]];
        if (ch.kind === 'cctv') {
            dc.setMaterial('cctv');
            dc.quad(pts, uvs, [this.game.cctv.current.offline ? 0 : 1, 1, 1, 1]);
        } else if (tv.hasFrame) {
            dc.setMaterial('tv');
            dc.quad(pts, uvs, [1, 1, 1, 1]);
        }
        dc.setMaterial('atlas');
        if (ch.url && (tv.status === 'buffering' || tv.status === 'loading')) dc.spinner(W / 2, H / 2, 16, now / 1000);
        this.phone.hit('tv:full', 0, 0, W, H, 0);   // tap anywhere to leave full screen
    }

    onPress(kind, key, idx) {
        if (kind !== 'tv') return false;
        const tv = this.iptv;
        if (key === 'ch') tv.tune(Number(idx));
        else if (key === 'prev') tv.tune(tv.channel - 1);
        else if (key === 'next') tv.tune(tv.channel + 1);
        else if (key === 'mute') tv.muted = !tv.muted;
        else if (key === 'toggle') tv.togglePlay();
        else if (key === 'full' && tv.canFullscreen) tv.fullscreen = !tv.fullscreen;
        return true;
    }
}

return { TvApp };
});
