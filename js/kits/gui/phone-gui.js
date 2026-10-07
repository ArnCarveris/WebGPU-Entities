'use strict';
// The handheld's screen: a data-driven debug sheet.

Features.kit('gui', (engine, kit) => {
const { clamp, lerp, easeOutCubic, col, mixRGB, EntityGUI } = kit;

// Phone GUI (270x570): a debug sheet in the style of UnityDebugSheet, the screen of the engine's handheld.
// List pages are pure scenario data; their cells read and write state through named bindings, or show `expr` templates
// read against the host's frame scope. Pages with an `app` are drawn by a PhoneApp (radar, camera, gallery, IPTV...)
// that a world lends the handheld. `this.game` is the handheld (js/engine/handheld.js): renderer, dc, audio, bindings,
// scope, setShown, fullscreen.

const IOS = {
    bg: [242, 242, 247], cell: [255, 255, 255], sep: [198, 198, 200], text: [0, 0, 0], sub: [142, 142, 147],
    blue: [0, 122, 255], green: [52, 199, 89], red: [255, 59, 48], orange: [255, 149, 0], pink: [255, 45, 85],
    press: [209, 209, 214], track: [233, 233, 234], chevron: [196, 196, 199]
};
const PHONE_NAV_H = 82;             // status bar + navigation bar
const PHONE_TRANSITION_MS = 300;
const TEXT_CELL = { size: 13, lead: 18, width: 214 };

class PhoneGUI extends EntityGUI {
    constructor(cfg, pages) {
        super({ id: 'phone', size: cfg.screen, virtual: cfg.virtual, zOffset: cfg.zOffset, anchorMaterial: 'glass', maxVerts: 24000 });
        this.cfg = cfg;
        this.pages = pages;
        this.templates = new Map();
        this.stack = ['root'];
        this.trans = null;          // { from, to, dir, t0 }
        this.scroll = {};
        this.scrollTarget = {};
        this.contentH = {};
        this.drag = null;           // slider binding being dragged
        this.knobs = {};            // animated switch knobs
        this.rects = {};            // image cells' rects, for the (u, v) of a press
        this.apps = {};             // name -> PhoneApp, lent by worlds
    }

    get bindings() { return this.game.bindings; }
    get currentPage() { return this.stack[this.stack.length - 1]; }

    pagesVisible() {
        return this.trans ? [this.trans.from, this.trans.to] : [this.currentPage];
    }

    // Page definition: data from the scenario, or an app
    pageDef(id) {
        if (id.startsWith('photo:') && this.apps.viewer) return { title: this.apps.viewer.title(id), app: this.apps.viewer };
        const d = this.pages[id];
        if (!d || (d.app && !this.apps[d.app])) return { title: d?.title || id, sections: [] };
        const title = d.titleBind ? this.bindings.text(d.titleBind) : d.title;
        return d.app ? { title, app: this.apps[d.app] } : { ...d, title };
    }

    // ---- navigation ----
    navigate(to) {
        const from = this.currentPage;
        this.stack.push(to);
        this.scrollTarget[to] = 0;
        this.scroll[to] = 0;
        this.trans = { from, to, dir: 1, t0: performance.now() };
    }

    back() {
        if (this.stack.length < 2) return;
        const from = this.stack.pop();
        this.trans = { from, to: this.currentPage, dir: -1, t0: performance.now() };
    }

    // Swap the top page (e.g. the photo viewer's newer / older), optionally sliding
    replaceTop(to, dir = 0) {
        const from = this.currentPage;
        this.stack[this.stack.length - 1] = to;
        if (dir) this.trans = { from, to, dir, t0: performance.now() };
    }

    // Hit region in absolute phone coordinates, clipped to the scrolling content area
    hit(id, x, y, w, h, clipTop = PHONE_NAV_H) {
        if (this.trans) return;
        const y0 = Math.max(y, clipTop), y1 = Math.min(y + h, this.vh);
        if (y1 > y0) this.addButton(id, x + this.game.dc.ox, y0, w, y1 - y0);
    }

    // ---- input ----
    canHover() {
        return this.active && !this.trans;
    }

    pointerDown() {
        return this.trans ? false : super.pointerDown();
    }

    onPress(b) {
        if (!b) return;
        this.audio.emit('tap');
        const [kind, key, idx] = b.id.split(':');
        const B = this.bindings;
        switch (kind) {
            case 'back': this.back(); return;
            case 'close': this.game.setShown(false); return;
            case 'nav': this.navigate(b.id.slice(4)); return;
            case 'switch': B.spec(key).set(!B.spec(key).get()); return;
            case 'slider': this.drag = key; this.sliderFromCursor(key); return true;
            case 'opt': B.spec(key).set(Number(idx)); this.audio.later(120, () => this.back()); return;
            case 'action': B.action(key); return;
            case 'img': {
                const r = this.rects[key], spec = B.spec(key);
                if (r && spec.click) spec.click(clamp((this.cursor.x - r.x) / r.w, 0, 1), clamp((this.cursor.y - r.y) / r.h, 0, 1));
                return;
            }
        }
        for (const app of Object.values(this.apps)) {
            if (app.onPress(kind, key, idx)) return;
        }
    }

    sliderFromCursor(key) {
        const s = this.bindings.spec(key);
        s.set(s.min + clamp((this.cursor.x - 28) / 214, 0, 1) * (s.max - s.min));
    }

    pointerDrag() {
        if (this.drag && this.active) this.sliderFromCursor(this.drag);
    }

    pointerUp() {
        this.drag = null;
    }

    wheel(dy) {
        const cur = this.currentPage;
        this.scrollTarget[cur] = (this.scrollTarget[cur] || 0) + dy * 0.35;
        return true;
    }

    // ---- drawing ----
    draw(dc, now) {
        const W = this.vw, H = this.vh;
        if (this.game.fullscreen && this.apps.tv) {
            this.apps.tv.drawFullscreen(dc, now);
            this.drawDisplayCorners(dc);
            return;
        }

        // Smooth scrolling for the current page
        const cur = this.currentPage;
        const maxScroll = Math.max(0, (this.contentH[cur] || 0) - (H - PHONE_NAV_H));
        this.scrollTarget[cur] = clamp(this.scrollTarget[cur] || 0, 0, maxScroll);
        this.scroll[cur] = lerp(this.scroll[cur] || 0, this.scrollTarget[cur], 0.3);

        // Pages, with an iOS-style push / pop slide
        if (this.trans) {
            const p = clamp((now - this.trans.t0) / PHONE_TRANSITION_MS, 0, 1);
            const e = easeOutCubic(p);
            const { from, to, dir } = this.trans;
            const under = dir > 0 ? from : to, over = dir > 0 ? to : from;
            const k = dir > 0 ? e : 1 - e;           // how far "over" has slid in
            dc.ox = -k * W * 0.3;
            this.drawPage(dc, under, now, under !== 'root');
            dc.ox = 0;
            dc.fillRect(0, 0, W, H, [0, 0, 0, 0.12 * k]);
            dc.ox = (1 - k) * W;
            this.drawPage(dc, over, now, true);
            dc.ox = 0;
            if (p >= 1) this.trans = null;
        } else {
            this.drawPage(dc, cur, now, this.stack.length > 1);
        }

        // Status bar
        const d = new Date();
        dc.text(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 34, 27, 14, col(IOS.text), 'left', false, 'sansBold');
        dc.roundRect(98, 10, 74, 22, 11, col([0, 0, 0]));
        for (let i = 0; i < 4; i++) dc.fillRect(196 + i * 5, 25 - (4 + i * 2.5), 3.2, 4 + i * 2.5, col(IOS.text));
        dc.rect(220, 15, 24, 12, 1.2, col(IOS.text, 0.45));
        dc.fillRect(244.5, 18.5, 1.8, 5, col(IOS.text, 0.45));
        dc.fillRect(222, 17, 17, 8, col(IOS.text));
        // Home indicator & rounded display corners
        dc.roundRect(W / 2 - 50, H - 10, 100, 4.5, 2.25, col(IOS.text, 0.85));
        this.drawDisplayCorners(dc);
    }

    drawDisplayCorners(dc) {
        const W = this.vw, H = this.vh, R = 30;
        for (const [x, y, a0] of [[0, 0, Math.PI], [W, 0, -Math.PI / 2], [W, H, 0], [0, H, Math.PI / 2]]) {
            const ccx = x === 0 ? R : W - R, ccy = y === 0 ? R : H - R;
            dc.polygon([[x, y], ...dc.arcPts(ccx, ccy, R, a0, a0 + Math.PI / 2, 8)], col([6, 6, 7]));
        }
    }

    // Touch pointer instead of an arrow
    drawCursor(dc) {
        dc.circle(this.cursor.x, this.cursor.y, 9, [0.2, 0.2, 0.25, this.drag ? 0.45 : 0.3], 20);
        dc.ring(this.cursor.x, this.cursor.y, 9, 1, [1, 1, 1, 0.6], 20);
    }

    drawPage(dc, id, now, canBack) {
        const def = this.pageDef(id);
        dc.fillRect(0, 0, this.vw, this.vh, col(IOS.bg));
        if (def.app) def.app.draw(dc, now, id);
        else this.drawListPage(dc, id, def, now);
        this.drawNavBar(dc, def.title, canBack);
    }

    drawNavBar(dc, title, canBack) {
        const W = this.vw;
        dc.fillRect(0, 0, W, PHONE_NAV_H, col([249, 249, 249], 0.97));
        dc.fillRect(0, PHONE_NAV_H - 1.5, W, 1.5, col(IOS.sep, 0.55));
        const size = Math.min(17, (17 * 120) / Math.max(1, dc.textWidth(title, 17, 'sansBold')));    // clear of Back / close
        dc.text(title, W / 2, 69, size, col(IOS.text), 'center', false, 'sansBold');
        if (canBack) {
            this.hit('back', 2, 44, 84, 38, 0);
            const c = col(IOS.blue, this.isHover('back') ? 0.55 : 1);
            dc.polyline([[21, 56], [13.5, 63.5], [21, 71]], 2.6, c);
            dc.text('Back', 26, 69, 16, c, 'left', false, 'sans');
        }
        this.hit('close', W - 48, 44, 46, 38, 0);
        const cc = col(IOS.blue, this.isHover('close') ? 0.55 : 1);
        dc.line(W - 27, 57, W - 15, 69, 2.2, cc);
        dc.line(W - 15, 57, W - 27, 69, 2.2, cc);
    }

    // ---- data-driven list pages ----
    sectionCells(sec) {
        const B = this.bindings;
        if (sec.optionsBind) {
            return B.spec(sec.optionsBind).options().map((o, i) => ({ type: 'option', bind: sec.optionsBind, index: i, title: o.title, sub: o.sub }));
        }
        return sec.cells.map((cell) => {
            const c = { ...cell };
            if (cell.titleBind) c.title = B.text(cell.titleBind);
            if (cell.subBind) c.sub = B.text(cell.subBind);
            if (cell.type === 'label' && cell.bind) c.value = B.text(cell.bind);
            // `expr`: a template ({expr|format}, see js/engine/expr.js) read against the host's frame scope, i.e. what
            // the scenario's HUD panels read: every world's stats, focus, fps...
            if (cell.expr) c[cell.type === 'text' ? 'text' : 'value'] = this.exprText(cell.expr);
            if (cell.subExpr) c.sub = this.exprText(cell.subExpr);
            return c;
        });
    }

    exprText(src) {
        let fn = this.templates.get(src);
        if (!fn) this.templates.set(src, fn = Expr.template(src));
        try {
            return fn(this.game.scope).replace(/<[^>]*>/g, '');
        } catch (err) {
            return err.message;
        }
    }

    cellHeight(dc, c) {
        if (c.type === 'text') return 16 + dc.wrapText(c.text, TEXT_CELL.size, 'sans', TEXT_CELL.width).length * TEXT_CELL.lead;
        if (c.type === 'slider') return 64;
        if (c.type === 'image') return Math.round(246 / (c.aspect || 1));
        if (c.type === 'label') {
            // a value too long for beside its title goes under it, wrapped
            const tw = c.title ? dc.textWidth(c.title, 15, 'sans') + 14 : 0;
            c.wrap = c.value && tw + dc.textWidth(c.value, 14, 'sans') > 216 ? dc.wrapText(c.value, 13, 'sans', 214) : null;
            if (c.wrap) return (c.title ? 34 : 14) + c.wrap.length * 17;
        }
        return (c.type === 'nav' || c.type === 'option') && c.sub ? 54 : 44;
    }

    drawListPage(dc, id, def, now) {
        const B = this.bindings;
        const scroll = this.scroll[id] || 0;
        let y = PHONE_NAV_H + 4 - scroll;
        dc.setClip(0, PHONE_NAV_H, this.vw, this.vh - PHONE_NAV_H);
        for (const sec of def.sections) {
            if (sec.header) {
                dc.text(sec.header, 28, y + 26, 11.5, col(IOS.sub), 'left', false, 'sans');
                y += 34;
            } else {
                y += 16;
            }
            const cells = this.sectionCells(sec);
            const heights = cells.map((c) => this.cellHeight(dc, c));
            const total = heights.reduce((a, b) => a + b, 0);
            dc.roundRect(12, y, 246, total, 10, col(IOS.cell));
            let cy = y;
            cells.forEach((cell, i) => {
                this.drawCell(dc, cell, cy, heights[i], i === cells.length - 1, now);
                cy += heights[i];
            });
            y += total;
            const footer = sec.footerBind ? B.text(sec.footerBind) : sec.footer;
            if (footer) {
                const lines = dc.wrapText(footer, 11, 'sans', 214);
                lines.forEach((ln, i) => dc.text(ln, 28, y + 18 + i * 14, 11, col(IOS.sub), 'left', false, 'sans'));
                y += 10 + lines.length * 14;
            }
        }
        dc.clearClip();
        this.contentH[id] = y + scroll + 24 - PHONE_NAV_H;
    }

    chevron(dc, x, cy) {
        dc.polyline([[x - 3, cy - 5.5], [x + 2.5, cy], [x - 3, cy + 5.5]], 2, col(IOS.chevron));
    }

    drawSwitch(dc, key, x, y) {
        const on = this.bindings.spec(key).get() ? 1 : 0;
        const k = this.knobs[key] ?? on;
        const nk = Math.abs(on - k) < 0.01 ? on : lerp(k, on, 0.3);
        this.knobs[key] = nk;
        dc.roundRect(x, y, 46, 28, 14, col(mixRGB(IOS.track, IOS.green, nk)));
        const kx = x + 14 + nk * 18;
        dc.image('blob', kx - 16, y - 1, 32, 32, [0, 0, 0, 0.18]);
        dc.circle(kx, y + 14, 12, col(IOS.cell));
    }

    // `str` cut to `maxW` (an ellipsis at the end)
    static fit(dc, str, size, maxW, font = 'sans') {
        str = String(str ?? '');
        if (dc.textWidth(str, size, font) <= maxW) return str;
        while (str.length > 1 && dc.textWidth(`${str}…`, size, font) > maxW) str = str.slice(0, -1);
        return `${str.trimEnd()}…`;
    }

    static hitId(cell) {
        switch (cell.type) {
            case 'image': return cell.click ? `img:${cell.bind}` : null;
            case 'nav': case 'picker': return `nav:${cell.page}`;
            case 'switch': return `switch:${cell.bind}`;
            case 'slider': return `slider:${cell.bind}`;
            case 'action': return `action:${cell.action}`;
            case 'option': return `opt:${cell.bind}:${cell.index}`;
        }
        return null;
    }

    drawCell(dc, cell, cy, h, isLast, now) {
        const B = this.bindings;
        const x0 = 12, w = 246;
        const hitId = PhoneGUI.hitId(cell);
        if (hitId) this.hit(hitId, x0, cy, w, h);
        const hover = hitId && this.isHover(hitId) && !this.trans;
        const pressed = hitId && this.isPressed(hitId, 220);
        if ((hover || pressed) && cell.type !== 'slider' && cell.type !== 'switch' && cell.type !== 'image') {
            dc.roundRect(x0 + 2, cy + 2, w - 4, h - 4, 8, col(pressed ? IOS.press : IOS.bg));
        }

        let tx = 28;
        if (cell.icon) {
            dc.roundRect(24, cy + (h - 28) / 2, 28, 28, 7, col(cell.icon[0]));
            dc.text(cell.icon[1], 38, cy + h / 2 + 5.5, 15, col(IOS.cell), 'center', false, 'sansBold');
            tx = 62;
        }
        const mid = cy + h / 2 + 5.5;
        const title = (color = IOS.text) => dc.text(cell.title, tx, mid, 15, col(color), 'left', false, 'sans');
        switch (cell.type) {
            case 'nav':
            case 'option':
                if (cell.sub) {
                    dc.text(PhoneGUI.fit(dc, cell.title, 15, 222 - tx), tx, cy + 23, 15, col(IOS.text), 'left', false, 'sans');
                    dc.text(PhoneGUI.fit(dc, cell.sub, 11.5, 222 - tx), tx, cy + 40, 11.5, col(IOS.sub), 'left', false, 'sans');
                } else {
                    title();
                }
                if (cell.type === 'nav') this.chevron(dc, 240, cy + h / 2);
                else if (B.spec(cell.bind).get() === cell.index) {
                    dc.polyline([[230, cy + h / 2], [235, cy + h / 2 + 5], [244, cy + h / 2 - 6]], 2.2, col(IOS.blue));
                }
                break;
            case 'text':
                dc.wrapText(cell.text, TEXT_CELL.size, 'sans', TEXT_CELL.width).forEach((ln, i) => {
                    dc.text(ln, tx, cy + 22 + i * TEXT_CELL.lead, TEXT_CELL.size, col(IOS.text), 'left', false, 'sans');
                });
                break;
            case 'label':
                if (cell.wrap) {
                    let ly = cy + 22;
                    if (cell.title) { dc.text(cell.title, tx, ly, 15, col(IOS.text), 'left', false, 'sans'); ly += 20; }
                    cell.wrap.forEach((ln, i) => dc.text(ln, tx, ly + i * 17, 13, col(IOS.sub), 'left', false, 'sans'));
                } else {
                    title();
                    dc.text(cell.value, 244, mid, 14, col(IOS.sub), 'right', false, 'sans');
                }
                break;
            case 'image': {
                const spec = B.spec(cell.bind);
                this.rects[cell.bind] = { x: x0 + dc.ox, y: cy, w, h };
                dc.roundRect(x0, cy, w, h, 10, col([14, 18, 22]));
                dc.setMaterial(spec.material);
                dc.stretchPic(x0, cy, w, h, 0, 0, 1, 1, [1, 1, 1, 1]);
                dc.setMaterial('atlas');
                break;
            }
            case 'action':
                title(IOS.blue);
                break;
            case 'picker': {
                title();
                const s = B.spec(cell.bind);
                const room = 218 - tx - dc.textWidth(cell.title, 15, 'sans');
                dc.text(PhoneGUI.fit(dc, s.label(s.get()), 14, room), 230, mid, 14, col(IOS.sub), 'right', false, 'sans');
                this.chevron(dc, 240, cy + h / 2);
                break;
            }
            case 'switch':
                title();
                this.drawSwitch(dc, cell.bind, 198, cy + (h - 28) / 2);
                break;
            case 'slider': {
                const s = B.spec(cell.bind);
                const v = s.get();
                const f = clamp((v - s.min) / (s.max - s.min), 0, 1);
                const dragging = this.drag === cell.bind;
                dc.text(cell.title, tx, cy + 24, 15, col(IOS.text), 'left', false, 'sans');
                dc.text(s.fmt(v), 244, cy + 24, 14, col(IOS.sub), 'right', false, 'sans');
                const ty = cy + 45, tw = 214;
                dc.roundRect(28, ty - 2, tw, 4, 2, col(IOS.track));
                dc.roundRect(28, ty - 2, tw * f, 4, 2, col(IOS.blue));
                const kx = 28 + tw * f;
                dc.image('blob', kx - 15, ty - 13, 30, 30, [0, 0, 0, dragging ? 0.3 : 0.18]);
                dc.circle(kx, ty, dragging ? 12 : 11, col(IOS.cell));
                break;
            }
        }
        if (!isLast) dc.fillRect(tx, cy + h - 1.5, 258 - tx, 1.5, col(IOS.sep, 0.55));
    }
}

return { IOS, PHONE_NAV_H, PHONE_TRANSITION_MS, TEXT_CELL, PhoneGUI };
});
