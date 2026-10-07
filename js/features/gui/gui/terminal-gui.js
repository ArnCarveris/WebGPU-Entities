'use strict';
// The airlock terminal's screen.

Features.part('gui', (engine, feature) => {
const { clamp, deg, col, timeText, EntityGUI } = engine.kits.gui;

// Wall terminal GUI (640x480): airlock controls, access keypad and the CCTV window.

const TERM_COLORS = {
    cyan: [110, 220, 255],
    orange: [255, 154, 46],
    red: [255, 70, 55],
    green: [90, 255, 140],
    white: [235, 245, 255],
    ink: [3, 16, 22]
};

class TerminalGUI extends EntityGUI {
    // CCTV window layout
    static CAM_LIST = { x: 22, y: 78, w: 166, h: 340 };
    static CAM_ROW_H = 62;
    static CAM_TRACK = { x: 192, y: 78, w: 6, h: 340 };
    static FEED = { x: 226, y: 78, w: 388, h: 291 };

    constructor(def, content, world) {
        super(def);
        this.content = content;
        this.world = world;
        this.page = 'main';             // 'main' | 'keypad' | 'cctv'
        this.code = '';
        this.keyMsg = null;
        this.boot = performance.now();
        this.feedSince = 0;
        this.scroll = 0;
        this.scrollTarget = 0;
        this.thumbDrag = null;
        this.scrollInfo = { maxScroll: 0, travel: 1, thumbH: 0 };
    }

    attach(game) {
        super.attach(game);
        game.cctv.onSelect.push((i) => this.revealCamera(i));
    }

    get cctv() { return this.game.cctv; }
    get door() { return this.world.get(this.content.door); }
    get accent() { return this.world.alarm ? TERM_COLORS.red : TERM_COLORS.cyan; }

    showPage(page) {
        this.page = page;
        if (page === 'cctv') this.feedSince = performance.now();
        if (page === 'keypad') { this.code = ''; this.keyMsg = null; }
    }

    // Keep a camera's row inside the list viewport
    revealCamera(i) {
        const { CAM_ROW_H, CAM_LIST } = TerminalGUI;
        const top = i * CAM_ROW_H;
        if (top < this.scrollTarget) this.scrollTarget = top;
        if (top + CAM_ROW_H > this.scrollTarget + CAM_LIST.h) this.scrollTarget = top + CAM_ROW_H - CAM_LIST.h;
    }

    update() {
        if (this.page === 'cctv') this.cctv.request();
    }

    // ---- widgets ----
    panel(dc, x, y, w, h, title) {
        const accent = this.accent;
        const pts = dc.chamferPts(x, y, w, h, 9);
        dc.polygon(pts, col([10, 40, 52], 0.45));
        dc.polyline(pts, 1.5, col(accent, 0.8), true);
        if (title) {
            const tw = dc.textWidth(title, 11) + 14;
            dc.fillRect(x + 9, y, tw, 16, col(accent, 0.85));
            dc.text(title, x + 16, y + 12, 11, col(TERM_COLORS.ink), 'left', false);
        }
    }

    button(dc, id, x, y, w, h, label, color, sub) {
        const C = TERM_COLORS;
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id);
        const pressed = this.isPressed(id);
        const pts = dc.chamferPts(x, y, w, h, Math.min(8, h / 4));
        if (hover) dc.image('blob', x - 16, y - 16, w + 32, h + 32, col(color, 0.22));
        dc.polygon(pts, col(color, pressed ? 0.95 : hover ? 0.32 : 0.1));
        dc.polyline(pts, hover ? 2 : 1.5, col(color, hover ? 1 : 0.75), true);
        if (h > 36) dc.polyline(dc.chamferPts(x + 4, y + 4, w - 8, h - 8, 5), 0.75, col(color, 0.3), true);
        const size = Math.min(22, Math.max(11, Math.floor(h * 0.32)));
        const textCol = pressed ? col(C.ink) : hover ? col(C.white) : col(color);
        dc.text(label, x + w / 2, y + h / 2 + size * 0.35 + (sub ? -6 : 0), size, textCol, 'center', !pressed);
        if (sub) dc.text(sub, x + w / 2, y + h / 2 + 18, 10, pressed ? col(C.ink) : col(color, 0.7), 'center', false);
    }

    tab(dc, id, x, y, w, h, label, selected) {
        const accent = this.accent;
        this.addButton(id, x, y, w, h);
        const hover = this.isHover(id);
        dc.fillRect(x, y, w, h, col(accent, selected ? 0.85 : hover ? 0.3 : 0.08));
        dc.rect(x, y, w, h, 1, col(accent, selected || hover ? 1 : 0.5));
        dc.text(label, x + w / 2, y + h / 2 + 4.5, 12, selected ? col(TERM_COLORS.ink) : col(hover ? TERM_COLORS.white : accent), 'center', !selected);
    }

    // ---- pages ----
    draw(dc, now) {
        const t = now / 1000, C = TERM_COLORS, accent = this.accent, W = this.vw, H = this.vh;

        // Background & grid
        dc.fillRect(0, 0, W, H, col([3, 12, 18], 0.94));
        for (let x = 20; x < W; x += 20) dc.fillRect(x, 0, 0.75, H, col(accent, 0.06));
        for (let y = 20; y < H; y += 20) dc.fillRect(0, y, W, 0.75, col(accent, 0.06));

        // Header
        const flash = this.world.alarm && Math.sin(t * 8) > 0;
        dc.fillRect(0, 0, W, 40, col(accent, flash ? 0.45 : 0.18));
        dc.fillRect(0, 39, W, 2, col(accent));
        const a = t * 0.8;
        dc.polyline([0, 1, 2, 3].map((k) => [22 + Math.cos(a + (k * Math.PI) / 2) * 10, 20 + Math.sin(a + (k * Math.PI) / 2) * 10]), 2, col(accent), true);
        dc.text(this.content.titles[this.page], 44, 27, 19, col(C.white));
        if (this.page !== 'keypad') {
            this.tab(dc, 'tab:main', 322, 8, 100, 24, 'CONTROL', this.page === 'main');
            this.tab(dc, 'tab:cctv', 428, 8, 100, 24, 'CCTV', this.page === 'cctv');
        }
        const el = Math.floor((now - this.boot) / 1000);
        const clock = [Math.floor(el / 3600), Math.floor(el / 60) % 60, el % 60].map((n) => String(n).padStart(2, '0')).join(':');
        dc.text(`T+ ${clock}`, W - 14, 26, 13, col(accent), 'right');

        if (this.page === 'main') this.drawMain(dc, t);
        else if (this.page === 'cctv') this.drawCctv(dc, t, now);
        else this.drawKeypad(dc, t, now);

        if (this.world.alarm) dc.rect(2, 2, W - 4, H - 4, 4, col(C.red, flash ? 1 : 0.35));
    }

    drawMain(dc, t) {
        const C = TERM_COLORS, accent = this.accent, door = this.door, world = this.world;
        this.panel(dc, 14, 56, 296, 300, 'ENVIRONMENT');
        const hatch = { open: ['OPEN', C.green], opening: ['CYCLING', C.orange], closing: ['CYCLING', C.orange], sealed: ['SEALED', C.orange] }[door.status];
        const rows = [
            [door.name.toUpperCase(), hatch[0], hatch[1]],
            ['PRESSURE', `${(101.3 - door.progress * 2.4 + Math.sin(t * 1.3) * 0.06).toFixed(1)} kPa`, C.white],
            ['O2 LEVEL', `${(20.9 - door.progress * 0.6).toFixed(1)} %`, C.white],
            ['LIGHTING', world.lightsOn ? 'ONLINE' : 'OFFLINE', world.lightsOn ? C.green : C.red]
        ];
        rows.forEach(([label, val, c], i) => {
            const y = 98 + i * 32;
            dc.text(label, 28, y, 13, col(accent, 0.7), 'left', false);
            dc.text(val, 296, y, 16, col(c), 'right');
            dc.fillRect(28, y + 8, 268, 1, col(accent, 0.15));
        });

        // Oscilloscope
        const sx = 28, sy = 232, sw = 268, sh = 110;
        dc.rect(sx, sy, sw, sh, 1, col(accent, 0.35));
        dc.fillRect(sx, sy + sh / 2, sw, 1, col(accent, 0.12));
        const amp = world.alarm ? 1.8 : 1;
        const pts = [];
        for (let i = 0; i <= sw; i += 3) {
            pts.push([sx + i, sy + sh / 2 + Math.sin(i * 0.07 + t * 4) * 22 * amp + Math.sin(i * 0.27 - t * 9) * 6 + (Math.random() - 0.5) * 2]);
        }
        dc.polyline(pts, 1.5, col(accent));
        dc.text(this.content.scopeLabel, sx + 6, sy + 14, 10, col(accent, 0.6), 'left', false);

        this.panel(dc, 330, 56, 296, 300, 'CONTROLS');
        const open = door.isOpen;
        this.button(dc, 'door', 348, 84, 260, 74, open ? 'SEAL HATCH' : 'OPEN HATCH', open ? C.orange : C.green,
            open ? 'CYCLE AIRLOCK CLOSED' : 'AUTHORIZATION REQUIRED');
        this.button(dc, 'lights', 348, 172, 260, 74, world.lightsOn ? 'LIGHTS OFF' : 'LIGHTS ON', C.cyan, 'ROOM ILLUMINATION');
        this.button(dc, 'alarm', 348, 260, 260, 74, world.alarm ? 'RESET ALARM' : 'SOUND ALARM', C.red,
            world.alarm ? 'ALERT IN PROGRESS' : 'EMERGENCY BEACON');

        this.panel(dc, 14, 368, 612, 98, 'SYSTEM LOG');
        const lines = world.log.slice(-3);
        lines.forEach((line, i) => {
            const newest = i === lines.length - 1;
            const text = '> ' + line + (newest && Math.floor(t * 2) % 2 ? '_' : '');
            dc.text(text, 28, 406 + i * 20, 13, newest ? col(C.white) : col(accent, 0.55), 'left', newest);
        });
    }

    drawKeypad(dc, t, now) {
        const C = TERM_COLORS, accent = this.accent, digits = this.content.hatchCode.length;
        this.panel(dc, 14, 56, 296, 410, 'ACCESS TERMINAL');
        dc.text(`RESTRICTED: ${this.door.name.toUpperCase()}`, 28, 100, 18, col(C.orange));
        dc.text(`ENTER ${digits}-DIGIT ACCESS CODE`, 28, 124, 12, col(accent, 0.75), 'left', false);

        const box = dc.chamferPts(28, 138, 268, 90, 8);
        dc.polygon(box, [0, 0, 0, 0.35]);
        dc.polyline(box, 1.5, col(accent), true);
        for (let i = 0; i < digits; i++) {
            const ch = this.code[i] ?? (i === this.code.length && Math.floor(t * 3) % 2 ? '_' : '.');
            dc.text(ch, 28 + 60 + i * 74, 202, 54, col(C.white), 'center');
        }

        const msg = this.keyMsg && now < this.keyMsg.until ? this.keyMsg : null;
        dc.text(msg ? msg.text : 'AWAITING INPUT', 28, 262, 18, msg ? col(msg.color, Math.floor(t * 6) % 2 ? 1 : 0.6) : col(accent, 0.5));
        this.content.memo.forEach((line, i) => dc.text(line, 28, 300 + i * 16, 11, col(accent, 0.55), 'left', false));

        this.button(dc, 'back', 28, 392, 130, 56, '< BACK', accent);

        this.panel(dc, 330, 56, 296, 410, 'KEYPAD');
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'ENT'].forEach((k, i) => {
            const c = k === 'CLR' ? C.orange : k === 'ENT' ? C.green : accent;
            this.button(dc, 'key:' + k, 346 + (i % 3) * 92, 84 + Math.floor(i / 3) * 92, 80, 80, k, c);
        });
    }

    drawCctv(dc, t, now) {
        const C = TERM_COLORS, accent = this.accent, cctv = this.cctv, cams = cctv.cameras;
        const { CAM_LIST: L, CAM_ROW_H, CAM_TRACK: T, FEED: F } = TerminalGUI;

        // ---- Camera list (scrollable, clipped) ----
        this.panel(dc, 14, 56, 190, 410, 'CAMERAS');
        const content = cams.length * CAM_ROW_H;
        const maxScroll = Math.max(0, content - L.h);
        this.scrollTarget = clamp(this.scrollTarget, 0, maxScroll);
        this.scroll += (this.scrollTarget - this.scroll) * 0.3;
        if (Math.abs(this.scrollTarget - this.scroll) < 0.05) this.scroll = this.scrollTarget;

        dc.setClip(L.x, L.y, L.w, L.h);
        cams.forEach((cam, i) => {
            const ry = L.y + i * CAM_ROW_H - this.scroll + 3, rh = CAM_ROW_H - 6;
            if (ry + rh < L.y || ry > L.y + L.h) return;
            const id = 'cam:' + i;
            const y0 = Math.max(ry, L.y), y1 = Math.min(ry + rh, L.y + L.h);   // only the visible part is clickable
            if (y1 > y0) this.addButton(id, L.x, y0, L.w, y1 - y0);
            const sel = i === cctv.selected;
            const hover = this.isHover(id);
            dc.fillRect(L.x, ry, L.w, rh, col(accent, sel ? 0.28 : hover ? 0.14 : 0.05));
            dc.rect(L.x, ry, L.w, rh, 1, col(accent, sel ? 0.9 : hover ? 0.6 : 0.3));
            if (sel) dc.fillRect(L.x, ry, 3, rh, col(accent));
            dc.text(cam.label, L.x + 10, ry + 22, 14, col(sel || hover ? C.white : accent), 'left', sel);
            dc.text(cam.name, L.x + 10, ry + 40, 10, col(accent, 0.65), 'left', false);
            dc.text(cam.offline ? 'NO SIG' : 'LIVE', L.x + L.w - 8, ry + 22, 10, col(cam.offline ? C.red : C.green), 'right', false);
        });
        dc.clearClip();

        // Scrollbar: the thumb is registered before the track so it wins the hit test
        const thumbH = Math.max(24, (T.h * L.h) / content);
        const travel = T.h - thumbH;
        const thumbY = T.y + (maxScroll ? this.scroll / maxScroll : 0) * travel;
        this.scrollInfo = { maxScroll, travel, thumbH };
        this.addButton('thumb', T.x - 3, thumbY, T.w + 6, thumbH);
        this.addButton('track', T.x - 3, T.y, T.w + 6, T.h);
        dc.fillRect(T.x, T.y, T.w, T.h, col(accent, 0.12));
        dc.fillRect(T.x, thumbY, T.w, thumbH, col(accent, this.thumbDrag || this.isHover('thumb') ? 1 : 0.6));

        this.button(dc, 'up', 22, 426, 80, 32, 'UP', accent);
        this.button(dc, 'down', 108, 426, 80, 32, 'DOWN', accent);

        // ---- Live feed: a surface whose material is the CCTV render target ----
        this.panel(dc, 214, 56, 412, 410, 'LIVE FEED');
        const cam = cctv.current;
        dc.fillRect(F.x - 2, F.y - 2, F.w + 4, F.h + 4, col(accent, 0.5));
        dc.setMaterial('cctv');
        dc.stretchPic(F.x, F.y, F.w, F.h, 0, 0, 1, 1, [cctv.signal(now, this.feedSince), 1, 1, 1]);
        dc.setMaterial('atlas');

        const bracket = (x, y, sx, sy) => {
            dc.fillRect(sx > 0 ? x : x - 14, y, 14, 2, col(C.white, 0.7));
            dc.fillRect(x, sy > 0 ? y : y - 14, 2, 14, col(C.white, 0.7));
        };
        bracket(F.x + 8, F.y + 8, 1, 1);
        bracket(F.x + F.w - 10, F.y + 8, -1, 1);
        bracket(F.x + 8, F.y + F.h - 10, 1, -1);
        bracket(F.x + F.w - 10, F.y + F.h - 10, -1, -1);
        dc.text(cam.label, F.x + 16, F.y + 26, 13, col(C.white, 0.9));
        dc.text(timeText(new Date()), F.x + F.w - 16, F.y + 26, 12, col(C.white, 0.85), 'right');
        if (cam.offline) {
            if (Math.floor(t * 2) % 2) dc.text('NO SIGNAL', F.x + F.w / 2, F.y + F.h / 2 + 10, 28, col(C.red), 'center');
        } else {
            const cx = F.x + F.w / 2, cy = F.y + F.h / 2;
            dc.fillRect(cx - 9, cy, 18, 1, col(C.white, 0.45));
            dc.fillRect(cx, cy - 9, 1, 18, col(C.white, 0.45));
            if (Math.floor(t * 1.5) % 2) {
                dc.image('blob', F.x + 14, F.y + F.h - 30, 14, 14, col(C.red));
                dc.text('REC', F.x + 32, F.y + F.h - 18, 12, col(C.red));
            }
        }

        const [rw, rh] = cctv.cfg.resolution;
        dc.text(`${cam.label}  ${cam.name}`, 226, 394, 15, col(C.white));
        dc.text(cam.location, 226, 412, 10, col(accent, 0.7), 'left', false);
        dc.text(cam.offline ? 'LINK DOWN - CHECK DUCT RELAY' : `PAN ${cam.panDeg >= 0 ? '+' : ''}${cam.panDeg} DEG  FOV ${Math.round(deg(cctv.cfg.fovY))}  ${rw}x${rh}`,
            226, 428, 10, col(cam.offline ? C.red : accent, 0.7), 'left', false);
        this.button(dc, 'prev', 432, 400, 86, 40, '< PREV', accent);
        this.button(dc, 'next', 526, 400, 86, 40, 'NEXT >', accent);
    }

    // Out of use range: say so on the screen itself instead of with a HUD prompt
    drawRangeHint(dc, now) {
        const C = TERM_COLORS, pulse = 0.75 + 0.25 * Math.sin((now / 1000) * 6);
        dc.fillRect(90, 196, 460, 88, col([3, 12, 18], 0.92));
        dc.rect(90, 196, 460, 88, 3, col(C.orange, pulse));
        dc.text('MOVE CLOSER TO USE', this.vw / 2, 238, 30, col(C.orange, pulse), 'center');
        dc.text(`TERMINAL RANGE ${this.range} M`, this.vw / 2, 266, 14, col(C.orange, 0.7), 'center', false);
    }

    // ---- input ----
    onHover(id) {
        if (!id.startsWith('track')) this.audio.emit('hover');
    }

    onPress(b) {
        const audio = this.audio, world = this.world, cctv = this.cctv;
        if (!b) {
            audio.emit('miss');
            return;
        }
        if (b.id !== 'thumb' && b.id !== 'track') audio.emit('press');
        const [kind, arg] = b.id.split(':');

        switch (kind) {
            case 'door':
                if (this.door.isOpen) world.setDoor(this.content.door, false);
                else this.showPage('keypad');
                break;
            case 'lights': world.setLights(!world.lightsOn); break;
            case 'alarm': world.setAlarm(!world.alarm); break;
            case 'back': this.showPage('main'); break;
            case 'tab': this.showPage(arg); break;
            case 'cam': cctv.select(Number(arg)); break;
            case 'prev': cctv.select(cctv.selected - 1); break;
            case 'next': cctv.select(cctv.selected + 1); break;
            case 'up': this.scrollTarget -= TerminalGUI.CAM_ROW_H; break;
            case 'down': this.scrollTarget += TerminalGUI.CAM_ROW_H; break;
            case 'thumb':
                this.thumbDrag = { y0: this.cursor.y, s0: this.scrollTarget };
                return true;                                            // capture for dragging
            case 'track': {
                const { maxScroll, travel, thumbH } = this.scrollInfo;
                this.scrollTarget = ((this.cursor.y - TerminalGUI.CAM_TRACK.y - thumbH / 2) / Math.max(1, travel)) * maxScroll;
                break;
            }
            case 'key': this.keyPressed(arg); break;
        }
    }

    keyPressed(k) {
        const C = TERM_COLORS, audio = this.audio, now = performance.now();
        if (k === 'CLR') {
            this.code = '';
        } else if (k === 'ENT') {
            if (this.code === this.content.hatchCode) {
                this.keyMsg = { text: 'ACCESS GRANTED', color: C.green, until: now + 1500 };
                audio.emit('granted');
                audio.later(900, () => {
                    this.showPage('main');
                    this.world.setDoor(this.content.door, true, 'ACCESS GRANTED');
                });
            } else {
                this.keyMsg = { text: 'ACCESS DENIED', color: C.red, until: now + 1500 };
                audio.emit('denied');
                this.world.pushLog(`ACCESS DENIED - INVALID CODE "${this.code || '---'}"`);
                this.code = '';
            }
        } else if (this.code.length < this.content.hatchCode.length) {
            this.code += k;
        }
    }

    pointerDrag() {
        if (!this.thumbDrag || !this.active) return;
        const { maxScroll, travel } = this.scrollInfo;
        this.scrollTarget = this.thumbDrag.s0 + (this.cursor.y - this.thumbDrag.y0) * (maxScroll / Math.max(1, travel));
    }

    pointerUp() {
        this.thumbDrag = null;
    }

    // Wheel over the camera list scrolls it
    wheel(dy) {
        const { CAM_LIST: L, CAM_TRACK: T } = TerminalGUI;
        const { x, y } = this.cursor;
        if (this.page !== 'cctv' || x < L.x || x > T.x + T.w + 3 || y < L.y || y > L.y + L.h) return false;
        this.scrollTarget += dy * 0.4;
        return true;
    }
}

return { TerminalGUI };
});
