'use strict';
// The phone's photo viewer.

Features.part('gui', (engine, feature) => {
const { col, timeText, clipTime, pad3, IOS, PHONE_NAV_H, PhoneApp } = GuiKit;

// Full photo / looping video with newer / older / delete
class ViewerApp extends PhoneApp {
    constructor(phone, game) {
        super(phone, game);
        this.player = null;         // video playback { id, start, paused, pos }
    }

    get library() { return this.game.camera.library; }

    index(pageId) {
        return this.library.indexOf(Number(pageId.slice(6)));
    }

    title(pageId) {
        const idx = this.index(pageId);
        return idx < 0 ? 'Photo' : `${idx + 1} of ${this.library.items.length}`;
    }

    draw(dc, now, id) {
        const phone = this.phone, W = this.W, lib = this.library;
        phone.contentH[id] = 0;
        const idx = this.index(id);
        const item = lib.items[idx];
        dc.fillRect(0, PHONE_NAV_H, W, this.H - PHONE_NAV_H, col([0, 0, 0]));
        if (!item) {
            dc.text('Deleted', W / 2, 300, 14, col(IOS.sub), 'center', false, 'sans');
            return;
        }
        const IY = PHONE_NAV_H + 8, IH = 360;
        let extra = '';
        if (item.kind === 'photo') {
            lib.draw(dc, item, 0, IY, W, IH, false);
        } else {
            // Playback loops; tap the picture to pause / resume
            const dur = lib.duration(item);
            if (!this.player || this.player.id !== item.id) this.player = { id: item.id, start: now, paused: false, pos: 0 };
            const pl = this.player;
            if (!pl.paused) pl.pos = ((now - pl.start) / 1000) % dur;
            lib.draw(dc, item, 0, IY, W, IH, false, Math.min(item.frames.length - 1, Math.floor(pl.pos * lib.cfg.video.fps)));
            phone.hit('pv:toggle', 0, IY, W, IH);
            if (pl.paused) {
                dc.circle(W / 2, IY + IH / 2, 30, [0, 0, 0, 0.5], 32);
                dc.playIcon(W / 2 + 3, IY + IH / 2, 24, [1, 1, 1, 0.95]);
            }
            dc.fillRect(0, IY + IH - 3, W, 3, [1, 1, 1, 0.25]);
            dc.fillRect(0, IY + IH - 3, W * (pl.pos / dur), 3, [1, 1, 1, 0.95]);
            dc.roundRect(8, IY + IH - 28, 80, 18, 9, [0, 0, 0, 0.5]);
            dc.text(`${clipTime(pl.pos)} / ${clipTime(dur)}`, 48, IY + IH - 15, 10.5, col([255, 255, 255]), 'center', false, 'sansBold');
            extra = `  ·  Video ${clipTime(dur)}`;
        }
        const Y = IY + IH;
        dc.text(item.label, 16, Y + 24, 15, col([255, 255, 255]), 'left', false, 'sansBold');
        dc.text(`Today ${timeText(item.time)}${extra}`, 16, Y + 42, 11.5, col(IOS.sub), 'left', false, 'sans');
        dc.text(`HDG ${pad3(item.hdg)}°`, W - 16, Y + 42, 11.5, col(IOS.sub), 'right', false, 'sans');

        const TY = this.H - 40;
        const tool = (hid, x, label, color, enabled) => {
            if (enabled) phone.hit(hid, x - 38, TY - 22, 76, 40);
            dc.text(label, x, TY + 5, 15, col(color, enabled ? (phone.isHover(hid) ? 0.55 : 1) : 0.3), 'center', false, 'sans');
        };
        tool('pv:prev', 48, '‹ Newer', IOS.blue, idx > 0);
        tool('pv:delete', W / 2, 'Delete', IOS.red, true);
        tool('pv:next', W - 48, 'Older ›', IOS.blue, idx < lib.items.length - 1);
    }

    onPress(kind, key) {
        if (kind !== 'pv') return false;
        const phone = this.phone, lib = this.library;
        const idx = this.index(phone.currentPage);
        if (idx < 0) return true;
        if (key === 'toggle') {
            const pl = this.player;
            if (pl) {
                if (pl.paused) pl.start = performance.now() - pl.pos * 1000;
                pl.paused = !pl.paused;
            }
        } else if (key === 'delete') {
            lib.remove(idx);
            this.game.audio.emit('delete');
            if (!lib.items.length) phone.back();
            else phone.replaceTop(`photo:${lib.items[Math.min(idx, lib.items.length - 1)].id}`);
        } else {
            const ni = idx + (key === 'next' ? 1 : -1);
            if (ni >= 0 && ni < lib.items.length) phone.replaceTop(`photo:${lib.items[ni].id}`, key === 'next' ? 1 : -1);
        }
        return true;
    }
}

return { ViewerApp };
});
