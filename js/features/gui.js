'use strict';
// Entity GUI, as a feature of WebGPU Entities: Doom 3-style world-space GUIs (an airlock terminal with CCTV, a paint
// easel) in a facility built from data. The engine is the one from the WebGPU-EntityGUI demo (its js/ files, in load
// order); the host (js/engine/host.js) gives it its device, canvas target and input, and builds its scenario from
// entities ("gui.*", see js/engine/scenario-format.js). Its GUI toolkit is the engine's (js/engine/gui-kit.js), and its
// phone is the engine's handheld (js/engine/handheld.js): the facility lends it pages, bindings and apps (radar,
// camera, gallery, IPTV) and its render targets.

Features.define('gui', (engine) => {
const { GpuChoice } = engine;
const {
    V3, M4, clamp, lerp, smooth01, easeOutBack, easeOutCubic, wrapIndex,
    deg, rad, col, mixRGB, fitRect, timeText, clipTime, pad3,
    cardinal, bearingOf, hitIn, MATERIAL_PATTERNS, MATERIAL_SIGNALS, MATERIAL_FLOATS, MaterialTable, MeshBuilder,
    GuiSurface, SCENE_SHADER, VIDEO_SHADER, BLIT_SHADER, UNIFORM_FLOATS, MAX_LIGHTS, INSTANCE_FLOATS, GUI_STRIDE,
    DEPTH_FORMAT, CLEAR_COLOR, WORLD_VERTEX_LAYOUT, GUI_VERTEX_LAYOUT, ALPHA_BLEND, Renderer, RenderView, RenderTarget,
    ScenePass, FONT_PX, GLYPH, GLYPH_CHARS, GuiAtlas, GuiModel, DeviceContext, EntityGUI,
    IOS, PHONE_NAV_H, PHONE_TRANSITION_MS, TEXT_CELL, PhoneGUI, PhoneApp
} = GuiKit;

// ------------------------------------------------------------------------------------------------ js/core/audio.js
// Sound effects as events of this world (door, step, shutter, chime, key, tap...): what each one sounds like is
// scenario data (sound.cue entities, synthesised by the engine's AudioEngine).

class AudioSystem {
    constructor(fx) {
        this.fx = fx;
        this.enabled = true;            // the phone's sound switch
        this.stepVolume = 0.7;
    }

    emit(name, payload = {}) { if (this.enabled) this.fx.emit(name, payload); }
    later(ms, fn) { setTimeout(fn, ms); }

    door() { this.emit('door'); }
    step(run) { if (this.stepVolume > 0) this.emit('step', { run, vol: this.stepVolume }); }
    shutter() { this.emit('shutter'); }
    chime(up) { this.emit('chime', { up }); }
}

// ------------------------------------------------------------------------------- js/render/shaders.js (paint)
// Brush stamping: every dab is an instanced quad drawn into the paint render target. The brush type
// picks the dab's shape; flow is how much paint one dab lays down.
const stampShader = (width, height) => /* wgsl */`
    struct Dab {
        @location(0) a : vec4f,     // x, y (paint px), radius (px), brush type
        @location(1) col : vec4f,
        @location(2) b : vec4f,     // seed, angle, flow, -
    };
    struct O {
        @builtin(position) pos : vec4f,
        @location(0) local : vec2f,
        @location(1) px : vec2f,
        @location(2) col : vec4f,
        @location(3) @interpolate(flat) info : vec4f,   // type, seed, angle, flow
    };
    const SIZE = vec2f(${width}.0, ${height}.0);

    fn hash(p : vec2f) -> f32 {
        return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
    }

    @vertex
    fn vs_stamp(@builtin(vertex_index) vi : u32, d : Dab) -> O {
        var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                                      vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
        let c = corners[vi];
        let px = d.a.xy + c * d.a.z;
        var o : O;
        o.pos = vec4f(px.x / SIZE.x * 2.0 - 1.0, 1.0 - px.y / SIZE.y * 2.0, 0.0, 1.0);
        o.local = c;
        o.px = px;
        o.col = d.col;
        o.info = vec4f(d.a.w, d.b.x, d.b.y, d.b.z);
        return o;
    }

    @fragment
    fn fs_stamp(i : O) -> @location(0) vec4f {
        let dist = length(i.local);
        let flow = i.info.w;
        var a = 0.0;
        switch u32(i.info.x + 0.5) {
            case 0u: { a = (1.0 - smoothstep(0.3, 1.0, dist)) * flow; }             // round brush: soft edge
            case 1u: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // ink pen: hard, opaque
            case 2u: {                                                               // airbrush: speckled spray
                let n = hash(floor(i.px) + i.info.y);
                a = pow(max(1.0 - dist, 0.0), 2.0) * flow * step(0.55, n);
            }
            case 3u: {                                                               // marker: fixed chisel tip
                let cs = cos(i.info.z);
                let sn = sin(i.info.z);
                let q = vec2f(cs * i.local.x + sn * i.local.y, -sn * i.local.x + cs * i.local.y);
                a = step(abs(q.x), 1.0) * step(abs(q.y), 0.32) * flow;
            }
            case 4u: {                                                               // charcoal: grain fixed to the paper
                let n = hash(floor(i.px * 0.8));
                a = (1.0 - smoothstep(0.55, 1.0, dist)) * step(0.3 + 0.45 * dist, n) * flow;
            }
            default: { a = 1.0 - smoothstep(0.8, 1.0, dist); }                       // eraser (paper colour)
        }
        if (a <= 0.002) { discard; }
        return vec4f(i.col.rgb, a * i.col.a);
    }
`;

// ------------------------------------------------------------------------------------------ js/gui/terminal-gui.js
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

// --------------------------------------------------------------------------------------------- js/gui/easel-gui.js
// Paint easel GUI (640x480): brushes, palette, size, undo / clear, and the painting itself, which is
// a surface whose material is the easel's PaintCanvas render target.

const EASEL_LIGHT = [240, 236, 228];

class EaselGUI extends EntityGUI {
    constructor(def, paint, canvas) {
        super(def);
        this.paint = paint;                 // scenario paint config: brushes, palette, area, size range...
        this.canvas = canvas;
        this.area = paint.area;             // painting rect in GUI space
        this.tool = 0;
        this.color = paint.initialColor;
        this.size = paint.size.initial;
        this.painting = false;
        this.last = null;                   // last stamped point (paint px)
        this.carry = 0;                     // distance already travelled towards the next dab
        this.sizeDrag = false;
        this.strokes = 0;
    }

    get brush() { return this.paint.brushes[this.tool]; }
    get brushRadius() { return this.size * this.brush.sizeMul; }

    inPaint(c) {
        const A = this.area;
        return c.x >= A.x && c.x <= A.x + A.w && c.y >= A.y && c.y <= A.y + A.h;
    }

    toPaintPx(c) {
        const A = this.area;
        return [((c.x - A.x) / A.w) * this.canvas.width, ((c.y - A.y) / A.h) * this.canvas.height];
    }

    // ---- painting ----
    dab(x, y) {
        const b = this.brush;
        const color = b.eraser ? this.paint.paper : this.paint.palette[this.color].map((v) => v / 255);
        this.canvas.pushDab(x, y, this.brushRadius, b, color);
    }

    // Evenly spaced dabs from the last point to the cursor, so fast strokes stay continuous
    strokeTo(cursor) {
        const [x, y] = this.toPaintPx(cursor);
        const spacing = Math.max(0.75, this.brushRadius * this.brush.spacing);
        if (!this.last) {
            this.dab(x, y);
            this.last = [x, y];
            this.carry = 0;
            return;
        }
        const [lx, ly] = this.last;
        const dx = x - lx, dy = y - ly, dist = Math.hypot(dx, dy);
        if (dist < 1e-3) return;
        let s = spacing - this.carry;
        while (s <= dist) {
            this.dab(lx + (dx * s) / dist, ly + (dy * s) / dist);
            s += spacing;
        }
        this.carry = dist - (s - spacing);
        this.last = [x, y];
    }

    sizeFromCursor() {
        const { min, max } = this.paint.size;
        this.size = min + clamp((this.cursor.x - 14) / 88, 0, 1) * (max - min);
    }

    // ---- input ----
    onPress(b) {
        if (this.inPaint(this.cursor)) {
            this.painting = true;
            this.last = null;
            this.strokes++;
            this.canvas.beginStroke();                 // one level of undo per stroke
            this.strokeTo(this.cursor);
            return true;
        }
        if (!b) return;
        this.audio.emit('easel');
        const [kind, v] = b.id.split(':');
        if (kind === 'tool') this.tool = Number(v);
        else if (kind === 'color') { this.color = Number(v); if (this.brush.eraser) this.tool = 0; }
        else if (kind === 'size') { this.sizeDrag = true; this.sizeFromCursor(); return true; }
        else if (kind === 'undo') this.canvas.undo();
        else if (kind === 'clear') this.canvas.clear();
    }

    // Every frame while held: extend the stroke under the cursor
    pointerDrag() {
        if (this.sizeDrag && this.active) this.sizeFromCursor();
        if (!this.painting) return;
        if (!this.active || !this.inPaint(this.cursor)) { this.last = null; return; }
        this.strokeTo(this.cursor);
        if (this.brush.spray) {                                // the airbrush keeps spraying while held still
            const [x, y] = this.toPaintPx(this.cursor);
            const r = this.brushRadius * 0.3;
            this.dab(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r);
        }
    }

    pointerUp() {
        this.painting = false;
        this.sizeDrag = false;
    }

    wheel(dy) {
        this.size = clamp(this.size - dy * 0.02, this.paint.size.min, this.paint.size.max);
        return true;
    }

    // ---- drawing ----
    brushPreview(dc, brush, cx, cy, selected) {
        const ink = selected ? col([40, 36, 34]) : col([225, 220, 212]);
        const a = (alpha) => [ink[0], ink[1], ink[2], alpha];
        switch (brush.preview) {
            case 'soft': dc.image('blob', cx - 14, cy - 14, 28, 28, ink); break;
            case 'zigzag': dc.polyline([[cx - 12, cy + 6], [cx - 4, cy - 6], [cx + 4, cy + 6], [cx + 12, cy - 6]], 1.6, ink); break;
            case 'spray':
                for (let k = 0; k < 28; k++) {
                    const ang = k * 2.39996, r = 12 * Math.sqrt(((k * 37) % 28) / 28);
                    dc.fillRect(cx + Math.cos(ang) * r - 0.8, cy + Math.sin(ang) * r - 0.8, 1.6, 1.6, ink);
                }
                break;
            case 'chisel': dc.line(cx - 11, cy + 7, cx + 11, cy - 7, 8, a(0.55)); break;
            case 'grain':
                for (let k = 0; k < 7; k++) {
                    const x0 = cx - 12 + k * 3.5, y0 = cy + 6 - k * 2;
                    dc.line(x0, y0 + ((k * 5) % 3) - 1, x0 + 3, y0 - 2 + ((k * 7) % 3) - 1, 3, a(0.75));
                }
                break;
            default:
                dc.roundRect(cx - 12, cy - 7, 24, 14, 3, col([245, 160, 170]));
                dc.fillRect(cx - 4, cy - 7, 2, 14, col([200, 110, 125]));
        }
    }

    smallButton(dc, id, x, y, w, h, label, enabled) {
        if (enabled) this.addButton(id, x, y, w, h);
        const hov = enabled && this.isHover(id);
        const pressed = this.isPressed(id);
        dc.roundRect(x, y, w, h, 6, col(pressed ? EASEL_LIGHT : hov ? [74, 70, 66] : [58, 54, 51]));
        dc.text(label, x + w / 2, y + h / 2 + 3.5, 10, pressed ? col([40, 36, 34]) : col(EASEL_LIGHT, enabled ? 1 : 0.3), 'center', false, 'sansBold');
    }

    draw(dc) {
        const P = this.paint, A = this.area;
        dc.fillRect(0, 0, this.vw, this.vh, col([30, 26, 24]));

        // ---- Tool panel ----
        dc.roundRect(6, 6, 104, this.vh - 12, 8, col([44, 40, 38]));
        dc.text('PAINT', 58, 28, 15, col(EASEL_LIGHT), 'center', false, 'sansBold');
        P.brushes.forEach((b, i) => {
            const x = 12 + (i % 2) * 48, y = 38 + Math.floor(i / 2) * 50;
            const id = `tool:${i}`;
            this.addButton(id, x, y, 44, 46);
            const sel = this.tool === i;
            dc.roundRect(x, y, 44, 46, 6, col(sel ? EASEL_LIGHT : this.isHover(id) ? [74, 70, 66] : [58, 54, 51]));
            this.brushPreview(dc, b, x + 22, y + 23, sel);
        });
        dc.text(this.brush.name, 58, 200, 9.5, col(EASEL_LIGHT, 0.85), 'center', false, 'sansBold');
        P.palette.forEach((c, i) => {
            const x = 14 + (i % 3) * 32, y = 210 + Math.floor(i / 3) * 32;
            const id = `color:${i}`;
            this.addButton(id, x - 2, y - 2, 30, 30);
            dc.circle(x + 13, y + 13, 12, col(c), 20);
            if (this.color === i) dc.ring(x + 13, y + 13, 15, 2, col(EASEL_LIGHT), 24);
            else if (this.isHover(id)) dc.ring(x + 13, y + 13, 15, 1.5, col(EASEL_LIGHT, 0.4), 24);
        });

        // Size slider
        const SL = { x: 14, y: 366, w: 88 };
        const { min, max } = P.size;
        dc.text(`SIZE ${Math.round(this.size)}`, SL.x, 356, 10, col(EASEL_LIGHT, 0.85), 'left', false, 'sansBold');
        this.addButton('size', SL.x - 6, SL.y - 11, SL.w + 12, 22);
        const f = (this.size - min) / (max - min);
        const swatch = P.palette[this.color];
        dc.roundRect(SL.x, SL.y - 2, SL.w, 4, 2, col([90, 86, 82]));
        dc.roundRect(SL.x, SL.y - 2, SL.w * f, 4, 2, col(swatch[0] + swatch[1] + swatch[2] > 700 ? [200, 196, 188] : swatch));
        dc.circle(SL.x + SL.w * f, SL.y, this.sizeDrag ? 8 : 7, col(EASEL_LIGHT), 16);
        this.smallButton(dc, 'undo', 12, 386, 44, 28, 'UNDO', this.canvas.canUndo);
        this.smallButton(dc, 'clear', 60, 386, 44, 28, 'CLEAR', true);
        dc.text(`${this.strokes} STROKE${this.strokes === 1 ? '' : 'S'}`, 58, 446, 9, col(EASEL_LIGHT, 0.5), 'center', false, 'sansBold');

        // ---- Painting: a surface whose material is the paint render target ----
        dc.fillRect(A.x - 6, A.y - 6, A.w + 12, A.h + 12, col([96, 62, 34]));
        dc.setMaterial(this.canvas.material);
        dc.stretchPic(A.x, A.y, A.w, A.h, 0, 0, 1, 1, [1, 1, 1, 1]);
        dc.setMaterial('atlas');
    }

    drawRangeHint(dc, now) {
        const pulse = 0.75 + 0.25 * Math.sin((now / 1000) * 6);
        dc.roundRect(180, 196, 400, 80, 10, [0, 0, 0, 0.75]);
        dc.text('MOVE CLOSER TO PAINT', 380, 245, 24, col([255, 214, 10], pulse), 'center', false, 'sansBold');
    }

    // Brush outline over the painting, arrow over the tools
    drawCursor(dc) {
        const c = this.cursor;
        if (!this.inPaint(c)) return super.drawCursor(dc);
        const r = Math.max(2, (this.brushRadius * this.area.w) / this.canvas.width);
        dc.ring(c.x, c.y, r, 1.2, [0, 0, 0, 0.6], 32);
        dc.ring(c.x, c.y, r + 1.2, 1, [1, 1, 1, 0.6], 32);
        dc.fillRect(c.x - 0.75, c.y - 0.75, 1.5, 1.5, [0, 0, 0, 0.8]);
    }
}

// -------------------------------------------------------------------------------------------- js/gui/phone-apps.js
// The facility's phone apps (PhoneApp, see js/engine/gui-kit.js): pages the gui world adds to the engine's handheld.

// Far Cry-style radar: heading-up, rotating compass ring, tracked objects and sound waves
class RadarApp extends PhoneApp {
    static DISC = { x: 135, y: 254, R: 92 };

    get cfg() { return this.game.scenario.radar; }

    point(wx, wz) {
        const p = this.game.player, D = RadarApp.DISC;
        const dx = wx - p.pos[0], dz = wz - p.pos[2];
        const dist = Math.hypot(dx, dz);
        const a = Math.atan2(dx, -dz) - p.yaw;
        const r = (dist / this.cfg.range) * D.R;
        return { x: D.x + Math.sin(a) * r, y: D.y - Math.cos(a) * r, r, dist, a, bearingDeg: bearingOf(dx, dz) };
    }

    // Scenario-listed objects, resolved to current positions
    tracked() {
        const { world, player } = this.game;
        return this.cfg.tracked.map((t) => {
            if (t.nearest) {
                const pick = world.ofType(ENTITY_TYPES[t.nearest])
                    .map((e) => ({ e, d: Math.hypot(e.position[0] - player.pos[0], e.position[2] - player.pos[2]) }))
                    .sort((a, b) => a.d - b.d)[0].e;
                return { ...t, name: `${t.prefix}${pick.label}`, x: pick.position[0], z: pick.position[2] };
            }
            const e = world.get(t.entity);
            return { ...t, x: e.position[0], z: e.position[2] };
        });
    }

    draw(dc, now) {
        const t = now / 1000, G = [120, 255, 150];
        const { x: cx, y: cy, R } = RadarApp.DISC;
        const { player, world, cctv } = this.game;
        const range = this.cfg.range;
        const top = PHONE_NAV_H;

        dc.roundRect(12, top + 8, 246, 304, 14, col([8, 16, 10]));

        // Noise meter + heading readout
        dc.text('NOISE', 26, top + 28, 11, col(G), 'left', false, 'sansBold');
        dc.roundRect(70, top + 20, 100, 8, 4, col(G, 0.15));
        const n = clamp(player.noise, 0, 1);
        const nc = n < 0.4 ? G : n < 0.75 ? [255, 214, 10] : [255, 69, 58];
        if (n > 0.01) dc.roundRect(70, top + 20, 100 * n, 8, 4, col(nc));
        dc.text(`HDG ${pad3(player.heading)}°`, 246, top + 28, 12, col(G), 'right', false, 'sansBold');

        // Disc, range rings, crosshair
        dc.circle(cx, cy, R, col([12, 42, 20]), 48);
        for (const k of [1, 2]) dc.ring(cx, cy, (R * k) / 3, 1, col(G, 0.22));
        dc.ring(cx, cy, R, 1.5, col(G, 0.6));
        dc.fillRect(cx - R, cy - 0.5, R * 2, 1, col(G, 0.15));
        dc.fillRect(cx - 0.5, cy - R, 1, R * 2, col(G, 0.15));
        dc.text(`${range / 3}m`, cx + 3, cy - R / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');
        dc.text(`${(range * 2) / 3}m`, cx + 3, cy - (R * 2) / 3 - 3, 9, col(G, 0.5), 'left', false, 'sans');

        // Sweep
        const sw = t * 2.2;
        dc.polygon([[cx, cy], ...dc.arcPts(cx, cy, R - 1, sw - 0.6, sw, 10)], col(G, 0.08));
        dc.line(cx, cy, cx + Math.cos(sw) * (R - 1), cy + Math.sin(sw) * (R - 1), 1.2, col(G, 0.45));

        // Rotating compass ring
        for (let d = 0; d < 360; d += 15) {
            const a = rad(d) - player.yaw;
            const len = d % 90 === 0 ? 10 : d % 45 === 0 ? 7 : 4;
            const s = Math.sin(a), c = -Math.cos(a);
            dc.line(cx + s * (R + 3), cy + c * (R + 3), cx + s * (R + 3 + len), cy + c * (R + 3 + len), d % 90 === 0 ? 2 : 1, col(G, d % 45 === 0 ? 0.9 : 0.45));
        }
        for (const [d, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
            const a = rad(d) - player.yaw;
            dc.text(label, cx + Math.sin(a) * (R + 22), cy - Math.cos(a) * (R + 22) + 4.5, 13, col(label === 'N' ? [255, 69, 58] : G), 'center', false, 'sansBold');
        }

        // Sound waves (world-anchored rings), clipped to the disc
        for (const w of world.waves.list) {
            const age = t - w.t0;
            if (age < 0 || age > w.life) continue;
            const c = this.point(w.x, w.z);
            const rr = ((w.speed * age) / range) * R;
            const alpha = w.alpha * (1 - age / w.life);
            const pts = dc.arcPts(c.x, c.y, rr, 0, Math.PI * 2, 40);
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i], p1 = pts[i + 1];
                if (Math.hypot(p0[0] - cx, p0[1] - cy) > R - 1 || Math.hypot(p1[0] - cx, p1[1] - cy) > R - 1) continue;
                dc.line(p0[0], p0[1], p1[0], p1[1], 1.6, col(w.color, alpha));
            }
        }

        // Cameras as small squares
        for (const cam of cctv.cameras) {
            const p = this.point(cam.position[0], cam.position[2]);
            if (p.r > R - 3) continue;
            dc.fillRect(p.x - 2.5, p.y - 2.5, 5, 5, col([255, 214, 10], cam.offline ? 0.35 : 0.85));
        }
        // Tracked objects (clamped to the rim when out of range)
        const tracked = this.tracked();
        for (const o of tracked) {
            if (o.shape === 'camera') continue;
            const p = this.point(o.x, o.z);
            const out = p.r > R - 6;
            const bx = out ? cx + Math.sin(p.a) * (R - 6) : p.x;
            const by = out ? cy - Math.cos(p.a) * (R - 6) : p.y;
            const alpha = out ? 0.5 : 1;
            if (o.shape === 'pulse') {
                const pulse = (t * 1.5) % 1;
                if (!out) dc.ring(bx, by, 5 + pulse * 10, 1.2, col(o.color, 0.8 * (1 - pulse)), 24);
                dc.circle(bx, by, 5, col(o.color, alpha), 16);
            } else if (o.shape === 'diamond') {
                dc.polygon([[bx, by - 6], [bx + 6, by], [bx, by + 6], [bx - 6, by]], col(o.color, alpha));
            } else {
                dc.fillRect(bx - 6, by - 3, 12, 6, col(o.color, alpha));
            }
        }

        // Player
        dc.polygon([[cx, cy - 10], [cx + 7, cy + 7], [cx, cy + 3], [cx - 7, cy + 7]], col([255, 255, 255]));

        // Tracking list
        dc.text('TRACKING', 28, top + 338, 11.5, col(IOS.sub), 'left', false, 'sans');
        const listTop = top + 346;
        dc.roundRect(12, listTop, 246, tracked.length * 32, 10, col(IOS.cell));
        tracked.forEach((o, i) => {
            const y = listTop + i * 32;
            const p = this.point(o.x, o.z);
            dc.circle(30, y + 16, 5, col(o.color), 14);
            dc.text(o.name, 44, y + 21, 13.5, col(IOS.text), 'left', false, 'sans');
            dc.text(`${p.dist.toFixed(1)} m  ${pad3(p.bearingDeg)}°`, 244, y + 21, 12, col(IOS.sub), 'right', false, 'sans');
            if (i < tracked.length - 1) dc.fillRect(44, y + 30.5, 214, 1.5, col(IOS.sep, 0.55));
        });
    }
}

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
        dc.text(`HDG ${pad3(this.game.player.heading)}°`, 44, V.y + 22, 11, col([255, 255, 255]), 'center', false, 'sansBold');
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

// -------------------------------------------------------------------------------------- js/systems/paint-canvas.js
// GPU paint canvas: brush dabs are stamped into a render target, which GUIs show through a material.
// One level of undo is a GPU copy taken at the start of each stroke.

const DAB_FLOATS = 12;      // x y radius type | r g b a | seed angle flow -

class PaintCanvas {
    constructor(material, cfg) {
        this.material = material;
        this.cfg = cfg;
        [this.width, this.height] = cfg.resolution;
        this.dabs = new Float32Array(cfg.maxDabs * DAB_FLOATS);
        this.dabCount = 0;
        this.pendingClear = true;       // start with blank paper
        this.pendingSnapshot = false;
        this.pendingUndo = false;
        this.canUndo = false;
    }

    init(renderer) {
        const device = renderer.device;
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
        this.texture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.undoTexture = device.createTexture({ size: [this.width, this.height], format: 'rgba8unorm', usage });
        this.view = this.texture.createView();
        this.dabBuffer = renderer.createBuffer(this.dabs.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        renderer.registerMaterial(this.material, 'gui', this.view);

        const module = device.createShaderModule({ code: stampShader(this.width, this.height) });
        this.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module,
                entryPoint: 'vs_stamp',
                buffers: [{
                    arrayStride: DAB_FLOATS * 4,
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x4' },
                        { shaderLocation: 1, offset: 16, format: 'float32x4' },
                        { shaderLocation: 2, offset: 32, format: 'float32x4' }
                    ]
                }]
            },
            fragment: { module, entryPoint: 'fs_stamp', targets: [{ format: 'rgba8unorm', blend: ALPHA_BLEND }] },
            primitive: { topology: 'triangle-list' }
        });
    }

    // color: 0..1 RGB
    pushDab(x, y, radius, brush, color) {
        if (this.dabCount >= this.cfg.maxDabs) return;
        this.dabs.set([x, y, radius, brush.type, color[0], color[1], color[2], 1, Math.random() * 1000, brush.angle || 0, brush.flow, 0], this.dabCount * DAB_FLOATS);
        this.dabCount++;
    }

    beginStroke() {
        this.pendingSnapshot = true;
        this.canUndo = true;
    }

    undo() {
        if (!this.canUndo) return;
        this.pendingUndo = true;
        this.canUndo = false;
    }

    clear() {
        this.pendingSnapshot = true;
        this.pendingClear = true;
        this.canUndo = true;
    }

    // Record pending work into the frame's encoder (before any view samples the painting)
    flush(renderer) {
        const enc = renderer.encoder, size = [this.width, this.height];
        if (this.pendingSnapshot) {
            enc.copyTextureToTexture({ texture: this.texture }, { texture: this.undoTexture }, size);
            this.pendingSnapshot = false;
        }
        if (this.pendingUndo) {
            enc.copyTextureToTexture({ texture: this.undoTexture }, { texture: this.texture }, size);
            this.pendingUndo = false;
        }
        if (!this.pendingClear && !this.dabCount) return;
        if (this.dabCount) renderer.device.queue.writeBuffer(this.dabBuffer, 0, this.dabs, 0, this.dabCount * DAB_FLOATS);
        const [r, g, b] = this.cfg.paper;
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: this.view, loadOp: this.pendingClear ? 'clear' : 'load', clearValue: { r, g, b, a: 1 }, storeOp: 'store' }]
        });
        if (this.dabCount) {
            pass.setPipeline(this.pipeline);
            pass.setVertexBuffer(0, this.dabBuffer);
            pass.draw(6, this.dabCount);
        }
        pass.end();
        this.pendingClear = false;
        this.dabCount = 0;
    }
}

// ---------------------------------------------------------------------------------------------- js/systems/cctv.js
// CCTV: renders the selected security camera into a render target, exposed to GUIs as the 'cctv'
// material. Like Doom 3 subviews, it only renders when a screen asked for it this frame.

class CctvSystem {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.selected = cfg.initial;
        this.switchTime = 0;
        this.wanted = false;
        this.renderingCamera = null;
        this.onSelect = [];
    }

    init(renderer) {
        const [w, h] = this.cfg.resolution;
        this.target = new RenderTarget(renderer, w, h);
        this.target.view.exclude.add('cctv');   // can't sample the texture it renders into
        renderer.registerMaterial('cctv', 'cctv', this.target.colorView);
    }

    get cameras() {
        return this.game.world.ofType(SecurityCamera);
    }

    get current() {
        return this.cameras[this.selected];
    }

    get aspect() {
        return this.target.aspect;
    }

    select(i) {
        i = wrapIndex(i, this.cameras.length);
        if (i !== this.selected) {
            this.selected = i;
            this.switchTime = performance.now();
            this.game.audio.emit('cctv');
        }
        for (const fn of this.onSelect) fn(i);
    }

    // Screens showing the feed call this every frame
    request() {
        this.wanted = true;
    }

    // Signal strength for a feed that (re)started at `since`: static fades into the picture
    signal(now, since = this.switchTime) {
        return this.current.offline ? 0 : clamp((now - Math.max(this.switchTime, since)) / 300, 0, 1);
    }

    prepare(frame) {
        const cam = this.current;
        this.renderingCamera = this.wanted && !cam.offline ? cam : null;
        this.wanted = false;
        if (!this.renderingCamera) return;
        const p = cam.def.pos;
        this.target.view.update(M4.viewProjection(p, cam.fwd, [0, 1, 0], this.cfg.fovY, this.target.aspect, 0.05, 60), p, frame);
    }

    render() {
        if (!this.renderingCamera) return;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: true, skip: this.renderingCamera });
        pass.end();
    }
}

// --------------------------------------------------------------------------------------------- js/systems/media.js
// Phone camera and the media library it fills.
//
// Photos: the viewfinder render target is copied into a slot of a photo atlas ('photos' material).
// Videos: each recorded frame is downscaled into one layer of a texture-array frame pool ('video'
// material; the GUI vertex colour's red channel picks the layer). Everything stays on the GPU.

class MediaLibrary {
    constructor(cfg) {
        this.cfg = cfg;
        this.items = [];            // newest first: { id, kind: 'photo' | 'video', slot | frames, time, x, z, hdg, label }
        this.nextId = 1;
        const pool = cfg.video.pool;
        this.freeLayers = Array.from({ length: pool }, (_, i) => pool - 1 - i);
        const [pw, ph] = cfg.photo.size;
        const [vw, vh] = cfg.video.size;
        this.photoSquareInset = (ph - pw) / 2;
        this.frameSquareInset = (vh - vw) / 2 / vh;
    }

    init(renderer) {
        const { photo, video } = this.cfg;
        this.photoAtlas = renderer.device.createTexture({
            size: [photo.atlas, photo.atlas],
            format: renderer.format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        renderer.registerMaterial('photos', 'gui', this.photoAtlas.createView());

        const [vw, vh] = video.size;
        this.framePool = renderer.device.createTexture({
            size: [vw, vh, video.pool],
            format: renderer.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.layerViews = Array.from({ length: video.pool }, (_, i) =>
            this.framePool.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
        renderer.registerMaterial('video', 'video', this.framePool.createView({ dimension: '2d-array' }));
    }

    get photoCols() {
        return Math.floor(this.cfg.photo.atlas / this.cfg.photo.size[0]);
    }

    slotOrigin(slot) {
        const [pw, ph] = this.cfg.photo.size;
        return [(slot % this.photoCols) * pw, Math.floor(slot / this.photoCols) * ph, 0];
    }

    photoUV(slot, square = false) {
        const [pw, ph] = this.cfg.photo.size;
        const A = this.cfg.photo.atlas;
        const [x, y] = this.slotOrigin(slot);
        const inset = square ? this.photoSquareInset : 0;   // centre crop for square thumbnails
        return [x / A, (y + inset) / A, (x + pw) / A, (y + ph - inset) / A];
    }

    // Draw an item's picture: photos with the 'photos' material, video frames with 'video'
    draw(dc, item, x, y, w, h, square, frame = 0) {
        if (item.kind === 'photo') {
            const [u0, v0, u1, v1] = this.photoUV(item.slot, square);
            dc.setMaterial('photos');
            dc.stretchPic(x, y, w, h, u0, v0, u1, v1, [1, 1, 1, 1]);
        } else {
            const inset = square ? this.frameSquareInset : 0;
            dc.setMaterial('video');
            dc.stretchPic(x, y, w, h, 0, inset, 1, 1 - inset, [item.frames[frame], 1, 1, 1]);
        }
        dc.setMaterial('atlas');
    }

    frameAt(item, now) {
        return Math.floor(((now / 1000) * this.cfg.video.fps) % item.frames.length);
    }

    duration(item) {
        return item.frames.length / this.cfg.video.fps;
    }

    counts() {
        const videos = this.items.filter((m) => m.kind === 'video').length;
        return { photos: this.items.length - videos, videos };
    }

    summary() {
        const c = this.counts();
        return `${c.photos} photo${c.photos === 1 ? '' : 's'}, ${c.videos} video${c.videos === 1 ? '' : 's'}`;
    }

    indexOf(id) {
        return this.items.findIndex((m) => m.id === id);
    }

    remove(idx) {
        const [item] = this.items.splice(idx, 1);
        if (item.kind === 'video') this.freeLayers.push(...item.frames);
        return item;
    }

    add(item) {
        item.id = this.nextId++;
        this.items.unshift(item);
        return item;
    }

    allocPhotoSlot() {
        const used = new Set(this.items.filter((m) => m.kind === 'photo').map((m) => m.slot));
        for (let i = 0; i < this.cfg.photo.capacity; i++) if (!used.has(i)) return i;
        for (let i = this.items.length - 1; i >= 0; i--) {                 // full: recycle the oldest photo
            if (this.items[i].kind === 'photo') return this.remove(i).slot;
        }
        return 0;
    }

    // A free frame-pool layer; when the pool is full the oldest finished video is dropped
    allocVideoLayer() {
        if (!this.freeLayers.length) {
            for (let i = this.items.length - 1; i >= 0; i--) {
                if (this.items[i].kind === 'video') { this.remove(i); break; }
            }
        }
        return this.freeLayers.length ? this.freeLayers.pop() : -1;
    }
}

class PhoneCamera {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.library = new MediaLibrary(cfg);
        this.mode = 'photo';            // 'photo' | 'video'
        this.rec = null;                // active recording
        this.captureRequested = false;
        this.lastShot = -1e9;
        this.seeds = [...cfg.seedShots];
        this.shot = null;               // camera rendering this frame
    }

    init(renderer) {
        this.library.init(renderer);
        const [w, h] = this.cfg.photo.size;
        this.target = new RenderTarget(renderer, w, h, { copySrc: true });
        this.target.view.exclude.add('viewfinder');
        renderer.registerMaterial('viewfinder', 'gui', this.target.colorView);

        const module = renderer.device.createShaderModule({ code: BLIT_SHADER });
        this.blitPipeline = renderer.device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: renderer.format }] },
            primitive: { topology: 'triangle-list' }
        });
        this.blitGroup = renderer.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: renderer.sampler }, { binding: 1, resource: this.target.colorView }]
        });
    }

    get recordingSeconds() {
        return this.rec ? this.rec.frames.length / this.cfg.video.fps : 0;
    }

    get freeVideoSeconds() {
        return this.library.freeLayers.length / this.cfg.video.fps;
    }

    // ---- actions ----
    shutter() {
        if (this.mode === 'photo') this.takePhoto();
        else if (this.rec) this.stopRecording();
        else this.startRecording();
    }

    takePhoto() {
        this.captureRequested = true;
        this.lastShot = performance.now();
        this.game.handheld.kick = 1;
        this.game.audio.shutter();
    }

    startRecording() {
        const p = this.game.player;
        this.rec = { frames: [], t0: performance.now(), time: new Date(), x: p.pos[0], z: p.pos[2], hdg: p.heading, label: this.game.world.placeLabel(p.pos[0], p.pos[2]) };
        this.game.audio.chime(true);
    }

    stopRecording() {
        const rec = this.rec;
        if (!rec) return;
        this.rec = null;
        this.game.audio.chime(false);
        if (!rec.frames.length) return;
        this.library.add({ kind: 'video', frames: rec.frames, time: rec.time, x: rec.x, z: rec.z, hdg: rec.hdg, label: rec.label });
    }

    // ---- per frame ----
    // The viewfinder renders while the phone shows the Camera page; otherwise pending startup shots
    prepare(frame) {
        const phone = this.game.handheld;
        this.shot = null;
        if (phone.visible && phone.gui.pagesVisible().includes('camera')) {
            const m = this.game.phoneModel();
            const dir = [-m[8], -m[9], -m[10]];                 // the phone's back faces away from its screen
            this.shot = { pos: V3.add([m[12], m[13], m[14]], V3.scale(dir, 0.012)), dir, up: [m[4], m[5], m[6]], showAvatar: false };
        } else if (this.seeds.length) {
            const s = this.seeds.shift();
            this.shot = { pos: s.pos, dir: V3.normalize(V3.sub(s.target, s.pos)), up: [0, 1, 0], showAvatar: true, label: s.label };
        } else {
            this.captureRequested = false;
        }
        if (this.rec && !(this.shot && !this.shot.label)) this.stopRecording();   // viewfinder closed
        if (this.shot) {
            const s = this.shot;
            this.target.view.update(M4.viewProjection(s.pos, s.dir, s.up, this.cfg.photo.fovY, this.target.aspect, 0.03, 60), s.pos, frame);
        }
    }

    render(now) {
        const s = this.shot;
        if (!s) return;
        const r = this.game.renderer;
        const pass = this.target.beginScene();
        this.game.world.render(pass, { showAvatar: s.showAvatar });
        pass.end();

        const lib = this.library;
        if (s.label || this.captureRequested) {
            const slot = lib.allocPhotoSlot();
            r.encoder.copyTextureToTexture({ texture: this.target.texture }, { texture: lib.photoAtlas, origin: lib.slotOrigin(slot) }, [...this.cfg.photo.size, 1]);
            lib.add({
                kind: 'photo', slot, time: new Date(), x: s.pos[0], z: s.pos[2],
                hdg: bearingOf(s.dir[0], s.dir[2]), label: s.label || this.game.world.placeLabel(s.pos[0], s.pos[2])
            });
            this.captureRequested = false;
        }

        // Video: downscale the viewfinder into the next frame-pool layer at the recording frame rate
        const rec = this.rec, v = this.cfg.video;
        if (rec && !s.label && rec.frames.length < Math.floor(((now - rec.t0) / 1000) * v.fps) + 1) {
            const layer = rec.frames.length < v.maxSeconds * v.fps ? lib.allocVideoLayer() : -1;
            if (layer < 0) {
                this.stopRecording();
            } else {
                const bp = r.encoder.beginRenderPass({
                    colorAttachments: [{ view: lib.layerViews[layer], clearValue: CLEAR_COLOR, loadOp: 'clear', storeOp: 'store' }]
                });
                bp.setPipeline(this.blitPipeline);
                bp.setBindGroup(0, this.blitGroup);
                bp.draw(3);
                bp.end();
                rec.frames.push(layer);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------- js/systems/iptv.js
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
            } catch (e) {
                this.fail(this.channel, 'Blocked (no CORS)');
            }
        }
    }
}

// -------------------------------------------------------------------------------------------- js/world/entities.js
// World entities. Each is constructed from a scenario definition ({ type, id, ... }).

class Entity {
    constructor(def, world) {
        this.def = def;
        this.id = def.id;
        this.world = world;
    }

    get game() { return this.world.game; }
    get position() { return this.def.pos; }
    get guis() { return []; }

    init(renderer) {}
    update(dt, t) {}
    writeInstances(renderer) {}
    render(pass, ctx) {}        // ctx: { showAvatar, skip }
    lights(out) {}              // push [x, y, z, intensity, r, g, b, 0]
    collide(p) {}               // push the player's [x, y, z] out of the entity
}

// One model placed at pos / yaw
class ModelEntity extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(1);
        this.matrix = M4.placement(this.def.pos || [0, 0, 0], this.def.yaw || 0);
        this.tint = null;
    }

    visibleTo(ctx) { return true; }

    writeInstances(renderer) {
        renderer.setInstance(this.instance, this.matrix, this.tint);
    }

    render(pass, ctx) {
        if (this !== ctx.skip && this.visibleTo(ctx)) pass.mesh(this.mesh, this.instance);
    }
}

// Door whose panels slide apart along their `slide` directions
class SlidingDoor extends Entity {
    init(renderer) {
        this.mesh = this.world.mesh(this.def.model);
        this.instance = renderer.allocInstances(this.def.panels.length);
        this.target = 0;
        this.progress = 0;
        this.lastWave = 0;
    }

    get name() { return this.def.name; }
    get isOpen() { return this.target === 1; }
    get passable() { return this.progress > 0.95; }
    get openAmount() { return smooth01(this.progress); }
    get status() {
        if (this.isOpen) return this.progress > 0.99 ? 'open' : 'opening';
        return this.progress < 0.01 ? 'sealed' : 'closing';
    }

    setOpen(open) {
        if (this.isOpen === open) return false;
        this.target = open ? 1 : 0;
        return true;
    }

    update(dt, t) {
        const d = this.target - this.progress;
        this.progress += Math.sign(d) * Math.min(Math.abs(d), dt * this.def.speed);
        if (Math.abs(d) > 0.001 && t - this.lastWave > 0.5) {
            this.lastWave = t;
            this.world.waves.emit('door', this.position[0], this.position[2]);
        }
    }

    writeInstances(renderer) {
        const o = this.openAmount * this.def.travel;
        this.def.panels.forEach((p, i) => {
            renderer.setInstance(this.instance + i, M4.translation(...V3.add(p.pos, V3.scale(p.slide, o))));
        });
    }

    render(pass) {
        pass.mesh(this.mesh, this.instance, this.def.panels.length);
    }
}

// Lamp hanging from a pivot, swinging around Z; its bulb is the scene's first light
class SwingingLamp extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.swing = 0;
        this.flicker = 1;
    }

    get position() { return this.def.pivot; }

    update(dt, t) {
        const s = this.def.swing;
        this.swing = s.amp * Math.sin(t * s.freq) + s.amp2 * Math.sin(t * s.freq2);
        this.flicker = Math.sin(t * 13.1) * Math.sin(t * 3.7 + 1) > 0.92 ? 0.2 + 0.3 * Math.random() : 1;
        this.matrix = M4.multiply(M4.translation(...this.def.pivot), M4.rotationZ(this.swing));
    }

    lights(out) {
        const p = this.def.pivot, L = this.def.bulbLength;
        const on = this.world.lightsOn ? this.def.intensity * this.flicker * this.world.lampScale : 0;
        out.push([p[0] + Math.sin(this.swing) * L, p[1] - Math.cos(this.swing) * L, p[2], on, ...this.def.color, 0]);
    }
}

// Rotating alarm beacon: siren, radar waves and a pulsing red light while the alarm is on
class AlarmBeacon extends Entity {
    init() {
        this.lastTone = 0;
        this.lastWave = 0;
        this.high = false;
    }

    update(dt, t) {
        if (!this.world.alarm) return;
        const d = this.def;
        if (t - this.lastTone > d.toneEvery) {
            this.lastTone = t;
            this.high = !this.high;
            this.game.audio.emit('alarm', { freq: this.high ? d.tones[0] : d.tones[1] });
        }
        if (t - this.lastWave > d.waveEvery) {
            this.lastWave = t;
            this.world.waves.emit('alarm', d.wave[0], d.wave[1]);
        }
    }

    lights(out) {
        out.push([...this.def.pos, this.world.alarmPulse * this.def.intensity, ...this.def.color, 0]);
    }
}

// Point light, optionally tied to the room lights, a door's opening or the alarm colour
class PointLight extends Entity {
    lights(out) {
        const d = this.def, w = this.world;
        let intensity = d.intensity;
        if (d.roomLights && !w.lightsOn) intensity = 0;
        if (d.door) intensity *= lerp(d.door.min, 1, w.get(d.door.id).openAmount);
        const color = w.alarm && d.alarmColor ? d.alarmColor : d.color;
        out.push([...d.pos, intensity, ...color, 0]);
    }
}

// Drone flying an elliptical patrol loop, pinging the radar and lighting its surroundings red
class PatrolDrone extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.angle = 0;
        this.pos = [...this.def.center];
        this.fwd = [0, 0, -1];
        this.lastPing = 0;
        this.tint = [1, 0, 0, 0];   // blinking eye
    }

    get position() { return this.pos; }

    update(dt, t) {
        const d = this.def;
        this.angle += dt * d.speed;
        const [rx, rz] = d.radius;
        this.pos = [d.center[0] + rx * Math.cos(this.angle), d.center[1] + d.bob.amp * Math.sin(t * d.bob.freq), d.center[2] + rz * Math.sin(this.angle)];
        this.fwd = V3.normalize([-rx * Math.sin(this.angle), 0, rz * Math.cos(this.angle)]);
        this.matrix = M4.facing(this.pos, this.fwd);
        if (t - this.lastPing > d.pingEvery) {
            this.lastPing = t;
            this.world.waves.emit('drone', this.pos[0], this.pos[2]);
        }
    }

    lights(out) {
        const e = this.def.eyeLight;
        out.push([...V3.add(this.pos, V3.scale(this.fwd, e.ahead)), e.intensity, ...e.color, 0]);
    }
}

// Security camera that pans; the CCTV system renders through the selected one
class SecurityCamera extends ModelEntity {
    init(renderer) {
        super.init(renderer);
        this.fwd = V3.normalize(V3.sub(this.def.target, this.def.pos));
        this.panDeg = 0;
    }

    get label() { return this.def.label; }
    get name() { return this.def.name; }
    get location() { return this.def.loc; }
    get offline() { return !!this.def.offline; }

    update(dt, t) {
        const d = this.def;
        const base = V3.normalize(V3.sub(d.target, d.pos));
        const pan = d.sweep * Math.sin(t * d.speed + d.pos[0]);
        this.panDeg = Math.round(deg(pan));
        const c = Math.cos(pan), s = Math.sin(pan);
        this.fwd = [base[0] * c + base[2] * s, base[1], -base[0] * s + base[2] * c];
        this.matrix = M4.facing(d.pos, this.fwd);
        this.tint = [this.game.cctv.renderingCamera === this ? 1 : 0, 0, 0, 0];   // tally light
    }
}

// The player's body, only seen from other cameras
class Avatar extends ModelEntity {
    update() {
        const p = this.game.player;
        this.matrix = M4.multiply(M4.translation(p.pos[0], 0, p.pos[2]), M4.rotationY(-p.yaw));
    }

    get position() { return this.game.player.pos; }

    visibleTo(ctx) { return !!ctx.showAvatar; }
}

// Wall terminal: housing model + the terminal GUI on its screen
class Terminal extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.gui = new TerminalGUI(def.gui, def.content, world);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.gui.setTransform(this.matrix);
    }
}

// Painting easel: wooden model, a paint render target and the easel GUI
class Easel extends ModelEntity {
    constructor(def, world) {
        super(def, world);
        this.canvas = new PaintCanvas(`paint:${def.id}`, def.paint);
        this.gui = new EaselGUI(def.gui, def.paint, this.canvas);
    }

    get guis() { return [this.gui]; }

    init(renderer) {
        super.init(renderer);
        this.canvas.init(renderer);
        this.gui.setTransform(this.matrix);
    }

    collide(p) {
        const r = this.def.collider;
        const ex = p[0] - this.def.pos[0], ez = p[2] - this.def.pos[2], d = Math.hypot(ex, ez);
        if (d < r) {
            p[0] = this.def.pos[0] + (ex / (d || 1)) * r;
            p[2] = this.def.pos[2] + (ez / (d || 1)) * r;
        }
    }
}

const ENTITY_TYPES = {
    static: ModelEntity,
    door: SlidingDoor,
    lamp: SwingingLamp,
    alarmBeacon: AlarmBeacon,
    light: PointLight,
    drone: PatrolDrone,
    securityCamera: SecurityCamera,
    avatar: Avatar,
    terminal: Terminal,
    easel: Easel
};

// ----------------------------------------------------------------------------------------------- js/world/world.js
// The facility: entities built from scenario data, shared facility state and actions.

// Expanding rings for the phone radar (footsteps, drone pings, alarm, doors)
class SoundWaves {
    constructor(kinds) {
        this.kinds = kinds;         // kind -> { speed, life, color }
        this.list = [];
    }

    emit(kind, x, z, strength = 1) {
        const k = this.kinds[kind];
        this.list.push({
            kind, x, z, t0: performance.now() / 1000, life: k.life, color: k.color,
            speed: k.speed * (kind === 'step' ? strength : 1),
            alpha: kind === 'step' ? clamp(0.5 + strength * 0.35, 0, 1) : 0.8
        });
    }

    prune(t) {
        this.list = this.list.filter((w) => t - w.t0 < w.life);
    }
}

class World {
    constructor(game, scenario) {
        this.game = game;
        this.scenario = scenario;
        this.lightsOn = true;
        this.alarm = false;
        this.alarmPulse = 0;
        this.lampScale = 1;
        this.log = [...scenario.facility.log];
        this.waves = new SoundWaves(scenario.waves);
        this.entities = [];
        this.byId = new Map();
        this.meshes = new Map();
        this.guis = [];

        for (const def of scenario.entities) {
            const Type = ENTITY_TYPES[def.type];
            if (!Type) throw new Error(`Unknown entity type "${def.type}"`);
            const e = new Type(def, this);
            this.entities.push(e);
            if (def.id) this.byId.set(def.id, e);
        }
        this.guis = this.entities.flatMap((e) => e.guis);
    }

    init(renderer) {
        for (const e of this.entities) e.init(renderer);
        for (const g of this.guis) g.attach(this.game);
    }

    get(id) {
        const e = this.byId.get(id);
        if (!e) throw new Error(`No entity "${id}"`);
        return e;
    }

    ofType(Type) {
        return this.entities.filter((e) => e instanceof Type);
    }

    // Model meshes are shared between entities that use the same model
    mesh(name) {
        if (!this.meshes.has(name)) {
            const parts = this.scenario.models[name];
            if (!parts) throw new Error(`No model "${name}"`);
            this.meshes.set(name, this.game.renderer.createMesh(new MeshBuilder(this.game.renderer.worldMaterials).parts(parts)));
        }
        return this.meshes.get(name);
    }

    // ---- facility actions (terminal, phone) ----
    pushLog(text) {
        this.log.push(text);
        if (this.log.length > 20) this.log.shift();
    }

    setDoor(id, open, source) {
        const door = this.get(id);
        if (!door.setOpen(open)) return;
        const name = door.name.toUpperCase();
        this.pushLog(open ? `${source} - ${name} OPENING` : `${name} SEALING...`);
        this.game.audio.door();
        this.waves.emit('door', door.position[0], door.position[2]);
    }

    setLights(on) {
        this.lightsOn = on;
        this.pushLog(on ? 'ILLUMINATION RESTORED' : 'ILLUMINATION CUT - AUX POWER ONLY');
    }

    setAlarm(on) {
        this.alarm = on;
        this.pushLog(on ? '!! EMERGENCY ALARM ENGAGED !!' : 'ALARM RESET BY OPERATOR');
    }

    // Named place nearest to a position (photo / video captions)
    placeLabel(x, z) {
        const { zones, spots } = this.scenario.places;
        const zone = zones.find((zn) => z < zn.zBelow);
        if (zone) return zone.name;
        return spots.reduce((best, sp) => (Math.hypot(sp.at[0] - x, sp.at[1] - z) < Math.hypot(best.at[0] - x, best.at[1] - z) ? sp : best)).name;
    }

    // ---- per frame ----
    update(dt, t) {
        this.alarmPulse = this.alarm ? Math.pow(0.5 + 0.5 * Math.sin(t * 7), 3) : 0;
        for (const e of this.entities) e.update(dt, t);
        this.waves.prune(t);
    }

    // Uniform inputs shared by every view this frame
    frameState(t) {
        const lights = [];
        for (const e of this.entities) e.lights(lights);
        while (lights.length < MAX_LIGHTS) lights.push([0, 0, 0, 0, 0, 0, 0, 0]);
        const f = this.game.scenario.facility || {};
        return { time: t, lightsOn: this.lightsOn, alarmPulse: this.alarmPulse, lights, fog: f.fog ?? 0.05, ambient: f.ambient ?? 0 };
    }

    writeInstances(renderer) {
        for (const e of this.entities) e.writeInstances(renderer);
        for (const g of this.guis) g.writeInstances(renderer);
    }

    // Draw the world into a scene pass: entity meshes, then every GUI surface (anchor + GUI)
    render(pass, ctx) {
        for (const e of this.entities) e.render(pass, ctx);
        for (const g of this.guis) g.render(pass);
    }

    collide(p) {
        for (const e of this.entities) e.collide(p);
    }
}

// ----------------------------------------------------------------------------------------------- js/game/player.js
// First-person player: movement, collision, footsteps and noise.

class PlayerController {
    constructor(game, cfg) {
        this.game = game;
        this.cfg = cfg;
        this.pos = [...cfg.start.pos];
        this.yaw = cfg.start.yaw;
        this.pitch = cfg.start.pitch;
        this.fovDeg = cfg.fovDeg;
        this.stepAccum = 0;
        this.stepPhase = 0;
        this.moving = false;
        this.running = false;
        this.noise = 0;
    }

    get eye() { return this.pos; }
    get fovy() { return rad(this.fovDeg); }
    get heading() { return wrapIndex(Math.round(deg(this.yaw)) % 360, 360); }

    basis() {
        const cp = Math.cos(this.pitch);
        const fwd = [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
        const right = V3.normalize([-fwd[2], 0, fwd[0]]);
        return { fwd, right, up: V3.cross(right, fwd) };
    }

    viewMatrix() {
        return M4.lookAt(this.pos, V3.add(this.pos, this.basis().fwd), [0, 1, 0]);
    }

    // Ray through the mouse position for a projection with vertical fov `fovy`
    viewRay(mouse, fovy) {
        const { fwd, right, up } = this.basis();
        const nx = (mouse.x / window.innerWidth) * 2 - 1;
        const ny = 1 - (mouse.y / window.innerHeight) * 2;
        const th = Math.tan(fovy / 2);
        const aspect = window.innerWidth / window.innerHeight;
        return [0, 1, 2].map((k) => fwd[k] + right[k] * nx * th * aspect + up[k] * ny * th);
    }

    look(dx, dy) {
        this.yaw += dx * 0.004;
        this.pitch = clamp(this.pitch - dy * 0.004, -1.3, 1.3);
    }

    stepForward(dist) {
        this.step(Math.sin(this.yaw) * dist, -Math.cos(this.yaw) * dist);
    }

    update(dt, keys) {
        this.noise *= Math.exp(-dt * 0.7);
        const k = keys;
        const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        this.running = k.has('ShiftLeft') || k.has('ShiftRight');
        this.moving = false;
        if (!f && !s) {
            this.stepAccum = Math.min(this.stepAccum, 0.35);
            return;
        }
        const speed = (this.running ? this.cfg.runSpeed : this.cfg.walkSpeed) * dt;
        const len = Math.hypot(f, s);
        const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const before = [this.pos[0], this.pos[2]];
        this.step(((fx * f - fz * s) / len) * speed, ((fz * f + fx * s) / len) * speed);
        const moved = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[1]);
        if (moved < 1e-5) return;
        this.moving = true;

        // Footsteps: one per stride; running is louder and makes bigger radar waves
        const stride = this.running ? this.cfg.stride.run : this.cfg.stride.walk;
        this.stepPhase += (moved / stride) * Math.PI;
        this.stepAccum += moved;
        if (this.stepAccum >= stride) {
            this.stepAccum -= stride;
            this.game.audio.step(this.running);
            this.game.world.waves.emit('step', this.pos[0], this.pos[2], this.running ? 1.4 : 0.8);
            this.noise = clamp(this.noise + (this.running ? 0.3 : 0.14), 0, 1);
        }
    }

    // Move with collision: room bounds, a doorway that opens with its door, entity colliders
    step(dx, dz) {
        const p = this.pos, { bounds, doorway } = this.cfg;
        let x = p[0] + dx;
        const z = p[2] + dz;
        const [dx0, dx1] = doorway.x;
        if (p[2] < doorway.enterZ) x = clamp(x, dx0, dx1);            // inside the doorway / corridor
        const canPass = this.game.world.get(doorway.door).passable && x > dx0 && x < dx1;
        p[0] = clamp(x, bounds.x[0], bounds.x[1]);
        p[2] = clamp(z, canPass ? doorway.minZ : bounds.z[0], bounds.z[1]);
        this.game.world.collide(p);
    }
}

// ------------------------------------------------------------------------------------------------ js/game/input.js
// Mouse / keyboard. Presses go to the GUI under the cursor first; otherwise dragging looks around.

class InputSystem {
    constructor(game, io) {
        this.game = game;
        this.io = io;
        this.canvas = io.canvas;
        this.mouse = { x: 0, y: 0, inside: false };
        this.keys = new Set();
        this.looking = false;       // dragging to look around
    }

    attach() {
        const { canvas, game, io } = this;
        const track = (e) => {
            this.mouse.x = e.clientX;
            this.mouse.y = e.clientY;
            this.mouse.inside = true;
        };
        io.listen(canvas, 'pointermove', (e) => {
            track(e);
            if (this.looking && !game.fx.cameraLocked) game.player.look(e.movementX, e.movementY);
        });
        io.listen(canvas, 'pointerleave', () => { this.mouse.inside = false; });
        io.listen(canvas, 'pointerdown', (e) => {
            track(e);
            const taken = game.interaction.pointerDown();
            if (!taken) this.looking = true;
            if (taken !== 'gui') canvas.setPointerCapture(e.pointerId);
        });
        const release = () => {
            this.looking = false;
            game.interaction.pointerUp();
        };
        io.listen(canvas, 'pointerup', release);
        io.listen(canvas, 'pointercancel', release);
        io.listen(window, 'pointerup', release);
        io.listen(canvas, 'wheel', (e) => {
            e.preventDefault();
            // Wheel over a GUI (lists, brush size...) goes to it; otherwise it steps the player
            if (!game.interaction.wheel(e.deltaY) && !game.fx.cameraLocked) game.player.stepForward(-e.deltaY * 0.003);
        }, { passive: false });

        io.listen(window, 'keydown', (e) => {
            if (e.code === 'Tab') return;           // the engine's handheld
            this.keys.add(e.code);
            if (e.code.startsWith('Arrow')) e.preventDefault();
        });
        io.listen(window, 'keyup', (e) => this.keys.delete(e.code));
        io.listen(window, 'blur', () => this.keys.clear());
    }

    get cursorStyle() {
        if (this.game.interaction.focus) return 'none';    // the GUI draws its own cursor
        return this.looking ? 'grabbing' : 'crosshair';
    }
}

// ------------------------------------------------------------------------------------------ js/game/interaction.js
// Routes the mouse to EntityGUIs, like Doom 3 tracing the view against gui surfaces.
// The engine's handheld is in front of everything (while it has the cursor, no world GUI does); otherwise the nearest
// world GUI under the cursor gets it, as long as the player is within its use range.

class InteractionSystem {
    constructor(game) {
        this.game = game;
        this.focus = null;      // GUI under the cursor
        this.capture = null;    // GUI holding the pointer during a drag
    }

    get guis() {
        return this.game.world.guis;
    }

    hover() {
        const { input, player, world, handheld } = this.game;
        for (const g of this.guis) {
            g.active = false;
            g.outOfRange = false;
        }
        this.focus = null;
        if (!input.mouse.inside || input.looking || handheld.hasCursor) return;

        const dir = player.viewRay(input.mouse, player.fovy);
        let best = null;
        for (const g of world.guis) {
            const pt = g.trace(player.eye, dir);
            if (pt && (!best || pt.t < best.pt.t)) best = { gui: g, pt };
        }
        if (!best) return;
        if (!best.gui.inRange(player.eye)) {
            best.gui.outOfRange = true;
            return;
        }
        this.setFocus(best.gui, best.pt);
    }

    setFocus(gui, pt) {
        gui.active = true;
        gui.cursor.x = pt.x;
        gui.cursor.y = pt.y;
        this.focus = gui;
    }

    // Called every frame after hover
    drag() {
        if (this.capture) this.capture.pointerDrag();
    }

    // Returns 'capture' (a GUI took the press and wants drags), 'gui' (a GUI took it) or null
    pointerDown() {
        this.hover();
        if (!this.focus) return null;
        if (this.focus.pointerDown()) {
            this.capture = this.focus;
            return 'capture';
        }
        return 'gui';
    }

    pointerUp() {
        if (this.capture) this.capture.pointerUp();
        this.capture = null;
    }

    wheel(dy) {
        return !!(this.focus && this.focus.wheel(dy));
    }
}

// --------------------------------------------------------------------------------------------- js/game/bindings.js
// Named bindings between data-driven GUI pages and game state.
//   value:  { get, set?, min?, max?, fmt?, label?, options? }  (switch / slider / picker / option cells)
//   text:   { text }                                         (label values, dynamic titles and footers)
// Actions are named commands for 'action' cells.

class Bindings {
    constructor(game) {
        this.game = game;
        this.specs = this.createSpecs(game);
        this.actions = this.createActions(game);
    }

    spec(key) {
        const s = this.specs[key];
        if (!s) throw new Error(`No binding "${key}"`);
        return s;
    }

    text(key) {
        const s = this.spec(key);
        return s.text ? s.text() : String(s.get());
    }

    action(name) {
        const fn = this.actions[name];
        if (!fn) throw new Error(`No action "${name}"`);
        fn();
    }

    createSpecs(g) {
        const links = g.scenario.phone.links;
        const door = () => g.world.get(links.door);
        const pct = (v) => `${Math.round(v)}%`;
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        return {
            // settings
            lights: { get: () => g.world.lightsOn, set: (v) => g.world.setLights(v) },
            alarm: { get: () => g.world.alarm, set: (v) => g.world.setAlarm(v) },
            stencil: { get: () => g.renderer.useStencil, set: (v) => { g.renderer.useStencil = v; } },
            sound: { get: () => g.audio.enabled, set: (v) => { g.audio.enabled = v; } },
            fov: { get: () => g.player.fovDeg, set: (v) => { g.player.fovDeg = v; }, min: 45, max: 95, fmt: (v) => `${Math.round(v)}°` },
            lamp: { get: () => g.world.lampScale * 100, set: (v) => { g.world.lampScale = v / 100; }, min: 0, max: 200, fmt: pct },
            stepVolume: { get: () => g.audio.stepVolume * 100, set: (v) => { g.audio.stepVolume = v / 100; }, min: 0, max: 100, fmt: pct },
            cctv: {
                get: () => g.cctv.selected,
                set: (i) => g.cctv.select(i),
                label: (i) => g.cctv.cameras[i].label,
                options: () => g.cctv.cameras.map((c) => ({ title: c.label, sub: c.offline ? `${c.name} (offline)` : c.name }))
            },

            // read-only text
            'player.position': { text: () => `${g.player.pos[0].toFixed(1)}, ${g.player.pos[2].toFixed(1)}` },
            'player.heading': { text: () => `${pad3(g.player.heading)}° ${cardinal(g.player.heading)}` },
            'player.noise': { text: () => pct(g.player.noise * 100) },
            'hatch.status': { text: () => cap(door().status) },
            'hatch.code': { text: () => g.world.get(links.terminal).gui.content.hatchCode },
            'hatch.action': { text: () => (door().isOpen ? 'Seal hatch' : 'Open hatch (override)') },
            'media.summary': { text: () => g.camera.library.summary() },
            'iptv.summary': { text: () => `${g.iptv.channels.length} channels · ${g.iptv.current.name}` },
            'stencil.description': {
                text: () => (g.renderer.useStencil
                    ? 'Each GUI surface writes its own stencil value where it wins the depth test. GUI quads draw with depth ALWAYS + stencil EQUAL in painter\'s order: no z-fighting, and the swinging lamp still occludes them.'
                    : 'Depth test only: GUI quads test LEQUAL against the co-planar screen. They reach the wall through a different matrix path than the screen, so their depth rounds differently and the terminal z-fights.')
            },
            'stats.fps': { text: () => `${g.stats.fps} fps` },
            'stats.resolution': { text: () => `${g.renderer.width} × ${g.renderer.height}` },
            'stats.guiMask': { text: () => (g.renderer.useStencil ? 'Stencil' : 'Depth only') },
            'stats.guiSurfaces': { text: () => String(g.interaction.guis.length) },
            'stats.terminal': { text: () => g.stats.gui(g.world.get(links.terminal).gui) },
            'stats.easel': { text: () => g.stats.gui(g.world.get(links.easel).gui) },
            'stats.phone': { text: () => g.stats.gui(g.handheld.gui) },
            'stats.cctv': { text: () => (g.cctv.renderingCamera ? `${g.cctv.renderingCamera.label} rendering` : 'Idle') },
            'stats.camera': { text: () => (g.camera.shot ? 'Rendering' : 'Idle') },
            'stats.photos': { text: () => `${g.camera.library.counts().photos} / ${g.camera.cfg.photo.capacity}` },
            'stats.videoFrames': { text: () => `${g.camera.cfg.video.pool - g.camera.library.freeLayers.length} / ${g.camera.cfg.video.pool}` },
            'stats.iptv': { text: () => (g.iptv.hasFrame ? `${g.iptv.texW}×${g.iptv.texH}` : 'Idle') }
        };
    }

    createActions(g) {
        const links = g.scenario.phone.links;
        return {
            toggleHatch: () => {
                const door = g.world.get(links.door);
                g.world.setDoor(links.door, !door.isOpen, 'DEBUG OVERRIDE');
            },
            showCctvOnTerminal: () => g.world.get(links.terminal).gui.showPage('cctv')
        };
    }
}

// ------------------------------------------------------------------------------------------------- js/game/game.js
// Game: builds every system from the scenario and runs the frame.
//
// Frame order:
//   simulate (player, world) -> route the cursor -> update + rebuild GUI models
//   -> decide which render targets are needed -> write instances -> encode passes:
//      paint canvases, CCTV, phone camera, player view -> submit
// (the phone itself is the engine's handheld, drawn over the finished frame)

class FrameStats {
    constructor() {
        this.fps = '--';
        this.acc = 0;
        this.frames = 0;
    }

    tick(dt) {
        this.acc += dt;
        this.frames++;
        if (this.acc > 0.5) {
            this.fps = String(Math.round(this.frames / this.acc));
            this.acc = 0;
            this.frames = 0;
        }
    }

    gui(g) {
        return `${g.model.quads} quads, ${g.model.surfaces.length} surf.`;
    }
}

class Game {
    constructor(fx) {
        this.fx = fx;
        this.scenario = fx.native;
        this.canvas = fx.canvas;
        this.renderer = new Renderer(fx);
        this.audio = new AudioSystem(fx);
        this.far = fx.native.player.far || 100;
        this.input = new InputSystem(this, fx.io);
        this.stats = new FrameStats();
        this.lastTime = performance.now();
    }

    async start() {
        const r = this.renderer;
        await r.init();
        await GuiAtlas.loadFonts();
        await r.createPipelines();
        r.setWorldMaterials(new MaterialTable(this.scenario.materials));

        this.atlas = new GuiAtlas();
        r.registerMaterial('atlas', 'gui', this.atlas.upload(r));
        this.dc = new DeviceContext(this.atlas);

        const s = this.scenario;
        this.world = new World(this, s);
        this.player = new PlayerController(this, s.player);
        this.cctv = new CctvSystem(this, s.cctv);
        this.camera = new PhoneCamera(this, s.media);
        this.iptv = new IptvPlayer(this, s.iptv);
        this.handheld = this.fx.host.handheld;
        this.interaction = new InteractionSystem(this);
        this.bindings = new Bindings(this);

        this.cctv.init(r);
        this.camera.init(r);
        this.iptv.init(r);
        this.world.init(r);
        r.finalizeInstances();
        this.mainView = r.createView();

        this.input.attach();
        this.lendHandheld(r);
    }

    // The engine's handheld carries this facility's phone pages: its bindings, apps and render targets
    lendHandheld(r) {
        const fx = this.fx, player = this.player;
        this.handheld.provide({
            id: fx.id,
            pages: this.scenario.phone.pages,
            bindings: this.bindings,
            apps: (phone) => ({
                radar: new RadarApp(phone, this), camera: new CameraApp(phone, this), photos: new GalleryApp(phone, this),
                viewer: new ViewerApp(phone, this), tv: new TvApp(phone, this)
            }),
            renderer: r,
            fullscreen: () => this.iptv.fullscreen,
            hidden: () => { this.iptv.fullscreen = false; },
            // while this world's player is the camera: its stride sways the phone, its lights light it (in eye space)
            motion: () => (fx.cameraLocked ? null : { moving: player.moving, stepPhase: player.stepPhase }),
            lighting: (t) => {
                if (fx.cameraLocked) return null;
                const f = this.world.frameState(t), v = player.viewMatrix();
                return { ...f, lights: f.lights.map((l) => [...M4.transformPoint(v, l), ...l.slice(3)]) };
            },
        });
    }

    // the phone in this world: the handheld's eye-space pose, held by the player
    phoneModel() {
        return M4.multiply(M4.facing(this.player.eye, this.player.basis().fwd), this.handheld.pose);
    }

    get guis() {
        return this.world.guis;
    }

    // update: player, world, GUIs; render: views, render targets, passes. The host runs both, or (in a
    // composition) the camera's world updates before the others render
    frame(now, dt, { update = true, render = true } = {}) {
        dt = Math.min(0.05, dt);
        const t = now / 1000;
        if (update) this.update(now, dt, t);
        if (render) this.render(now, dt, t);
    }

    update(now, dt, t) {
        const { world, player, interaction, dc } = this;
        // Simulation
        if (!this.fx.cameraLocked) player.update(dt, this.input.keys);
        world.update(dt, t);

        // GUIs: cursor routing, logic, then rebuild their models
        interaction.hover();
        interaction.drag();
        this.canvas.style.cursor = this.input.cursorStyle;
        for (const g of this.guis) g.update(dt, now);
        for (const g of world.guis) g.build(dc, now);
    }

    render(now, dt, t) {
        const { renderer: r, world, player, handheld: phone } = this;
        r.resize();
        // Views and render targets for this frame
        const frame = world.frameState(t);
        const view = player.viewMatrix();
        this.mainView.update(M4.multiply(M4.perspective(player.fovy, r.aspect, 0.02, this.far), view), player.eye, frame);
        if (!phone.visible) this.iptv.fullscreen = false;
        this.iptv.update(phone.visible && (this.iptv.fullscreen || phone.gui.pagesVisible().includes('tv')));
        this.cctv.prepare(frame);
        this.camera.prepare(frame);

        world.writeInstances(r);

        // Passes
        r.beginFrame();
        for (const easel of world.ofType(Easel)) easel.canvas.flush(r);
        this.cctv.render();
        this.camera.render(now);
        const pass = r.beginScenePass(r.swapView, r.depthView, this.mainView);
        world.render(pass, { showAvatar: false });
        pass.end();
        r.endFrame();

        this.stats.tick(dt);
    }
}

// ------------------------------------------------------------------------------------- feature world
// This demo as one world of the engine (js/engine/host.js calls these). All of its UI is in the 3D scene (and on the
// engine's handheld).
class FeatureWorld {
    constructor(fx) {
        this.fx = fx;
        this.hudHtml = '';
    }

    async init() {
        this.game = new Game(this.fx);
        await this.game.start();
    }

    frame(now, dt, opts) { this.game.frame(now, dt, opts); }

    // classic 0..1 depth, near 0.02, far 100 or the scenario's player.far (depth-stencil, the depth aspect)
    depth() {
        const r = this.game.renderer;
        return r.depthSample && { view: r.depthSample, kind: 'standard', near: 0.02, far: this.game.far };
    }

    get view() {
        const P = this.game.player, { fwd, up } = P.basis();
        return { pos: [...P.pos], fwd, up, fov: P.fovy };
    }

    setView(v) {
        const P = this.game.player;
        P.pos[0] = v.pos[0]; P.pos[1] = v.pos[1]; P.pos[2] = v.pos[2];
        P.yaw = Math.atan2(v.fwd[0], -v.fwd[2]);
        P.pitch = Math.asin(Math.max(-1, Math.min(1, v.fwd[1])));
        if (v.fov) P.fovDeg = v.fov * 180 / Math.PI;
    }

    stats() {
        const g = this.game, w = g.world, P = g.player;
        return {
            fps: Number(g.stats.fps) || 0, lightsOn: w.lightsOn, alarm: w.alarm, phone: g.handheld.visible, moving: P.moving, running: P.running,
            noise: P.noise, gui: g.interaction.focus ? g.interaction.focus.name || 'gui' : '', sound: g.audio.enabled,
        };
    }

    set(key, v) {
        const w = this.game.world;
        if (key === 'lights' && !!v !== w.lightsOn) w.setLights(!!v);
        else if (key === 'alarm' && !!v !== w.alarm) w.setAlarm(!!v);
        else if (key === 'phone') this.game.handheld.setShown(!!v);
    }
}

return { create: ctx => new FeatureWorld(ctx) };
});
