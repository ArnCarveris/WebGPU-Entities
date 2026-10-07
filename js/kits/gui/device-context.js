'use strict';
// GUI models and the device context that fills them.

Features.kit('gui', (engine, kit) => {
const { GUI_STRIDE, FONT_PX, GLYPH } = kit;

// GUI models and the device context that fills them.

// Per-frame triangle list of (x, y, u, v, r, g, b, a) in a GUI's virtual screen space, split into
// surfaces whenever the material changes (like idGuiModel::SetMaterial)
class GuiModel {
    constructor(maxVerts) {
        this.max = maxVerts;
        this.verts = new Float32Array(maxVerts * GUI_STRIDE);
        this.count = 0;
        this.surfaces = [];     // { material, first, count }
        this.buffer = null;
    }

    createBuffer(device) {
        this.buffer = device.createBuffer({ size: this.verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }

    reset() {
        this.count = 0;
        this.surfaces.length = 0;
    }

    // `version` counts uploads: what caches a picture of the model (a render target) redraws when it changes
    upload(renderer) {
        if (this.count) renderer.device.queue.writeBuffer(this.buffer, 0, this.verts, 0, this.count * GUI_STRIDE);
        this.version = (this.version || 0) + 1;
    }

    get quads() {
        return (this.count / 6) | 0;
    }
}

// A minimal idDeviceContext: every drawing call turns into textured, coloured quads
class DeviceContext {
    constructor(atlas) {
        this.atlas = atlas;
        this.model = null;
        this.clip = null;
        this.ox = 0;            // horizontal offset (page slide transitions)
    }

    begin(model) {
        this.model = model;
        model.reset();
        this.clip = null;
        this.ox = 0;
        this.setMaterial('atlas');
    }

    end() {
        const surfs = this.model.surfaces;
        const last = surfs[surfs.length - 1];
        if (!last) return;
        last.count = this.model.count - last.first;
        if (last.count === 0) surfs.pop();
    }

    setMaterial(material) {
        const surfs = this.model.surfaces;
        const last = surfs[surfs.length - 1];
        if (last && last.material === material) return;
        this.end();
        surfs.push({ material, first: this.model.count, count: 0 });
    }

    vert(x, y, u, v, c) {
        const m = this.model;
        if (m.count >= m.max) return;
        const o = m.count * GUI_STRIDE, vs = m.verts;
        vs[o] = x + this.ox; vs[o + 1] = y;
        vs[o + 2] = u; vs[o + 3] = v;
        vs[o + 4] = c[0]; vs[o + 5] = c[1]; vs[o + 6] = c[2]; vs[o + 7] = c[3];
        m.count++;
    }

    setClip(x, y, w, h) { this.clip = [x, y, x + w, y + h]; }
    clearClip() { this.clip = null; }

    quad(p, uv, c) {
        for (const i of [0, 1, 2, 0, 2, 3]) this.vert(p[i][0], p[i][1], uv[i][0], uv[i][1], c);
    }

    // Axis-aligned pictures are clipped against the (absolute) clip rect, adjusting UVs
    // (idDeviceContext::ClippedCoords)
    stretchPic(x, y, w, h, u0, v0, u1, v1, c) {
        if (this.clip) {
            const [cx0, cy0, cx1, cy1] = this.clip;
            let x0 = x + this.ox, y0 = y, x1 = x + this.ox + w, y1 = y + h;
            if (x1 <= cx0 || x0 >= cx1 || y1 <= cy0 || y0 >= cy1 || w <= 0 || h <= 0) return;
            const du = (u1 - u0) / w, dv = (v1 - v0) / h;
            if (x0 < cx0) { u0 += (cx0 - x0) * du; x0 = cx0; }
            if (x1 > cx1) { u1 -= (x1 - cx1) * du; x1 = cx1; }
            if (y0 < cy0) { v0 += (cy0 - y0) * dv; y0 = cy0; }
            if (y1 > cy1) { v1 -= (y1 - cy1) * dv; y1 = cy1; }
            x = x0 - this.ox; y = y0; w = x1 - x0; h = y1 - y0;
        }
        this.quad([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], c);
    }

    // Atlas images by name ('cursor' | 'blob')
    image(name, x, y, w, h, c) {
        const [u0, v0, u1, v1] = this.atlas[name];
        this.stretchPic(x, y, w, h, u0, v0, u1, v1, c);
    }

    fillRect(x, y, w, h, c) {
        const [u, v] = this.atlas.white;
        this.stretchPic(x, y, w, h, u, v, u, v, c);
    }

    rect(x, y, w, h, size, c) {
        this.fillRect(x, y, w, size, c);
        this.fillRect(x, y + h - size, w, size, c);
        this.fillRect(x, y + size, size, h - 2 * size, c);
        this.fillRect(x + w - size, y + size, size, h - 2 * size, c);
    }

    line(x0, y0, x1, y1, width, c) {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * width * 0.5, ny = (dx / len) * width * 0.5;
        const [u, v] = this.atlas.white;
        this.quad([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], [[u, v], [u, v], [u, v], [u, v]], c);
    }

    polyline(pts, width, c, closed = false) {
        const n = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            this.line(a[0], a[1], b[0], b[1], width, c);
        }
    }

    // Fan from pts[0]; fine for convex or star-shaped outlines
    polygon(pts, c) {
        const [u, v] = this.atlas.white;
        for (let i = 1; i < pts.length - 1; i++) {
            this.vert(pts[0][0], pts[0][1], u, v, c);
            this.vert(pts[i][0], pts[i][1], u, v, c);
            this.vert(pts[i + 1][0], pts[i + 1][1], u, v, c);
        }
    }

    arcPts(cx, cy, r, a0, a1, seg) {
        const pts = [];
        for (let i = 0; i <= seg; i++) {
            const a = a0 + ((a1 - a0) * i) / seg;
            pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        return pts;
    }

    circle(cx, cy, r, c, seg = 28) {
        this.polygon(this.arcPts(cx, cy, r, 0, Math.PI * 2, seg), c);
    }

    ring(cx, cy, r, width, c, seg = 48) {
        this.polyline(this.arcPts(cx, cy, r, 0, Math.PI * 2, seg), width, c);
    }

    roundRectPts(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        const H = Math.PI / 2;
        return [
            ...this.arcPts(x + w - r, y + r, r, -H, 0, 5),
            ...this.arcPts(x + w - r, y + h - r, r, 0, H, 5),
            ...this.arcPts(x + r, y + h - r, r, H, 2 * H, 5),
            ...this.arcPts(x + r, y + r, r, 2 * H, 3 * H, 5)
        ];
    }

    roundRect(x, y, w, h, r, c) {
        if (w <= 0 || h <= 0) return;
        this.polygon(this.roundRectPts(x, y, w, h, r), c);
    }

    chamferPts(x, y, w, h, c) {
        return [[x + c, y], [x + w, y], [x + w, y + h - c], [x + w - c, y + h], [x, y + h], [x, y + c]];
    }

    playIcon(cx, cy, r, c) {
        this.polygon([[cx - r * 0.45, cy - r * 0.6], [cx + r * 0.6, cy], [cx - r * 0.45, cy + r * 0.6]], c);
    }

    spinner(cx, cy, r, t) {
        const a = t * 6;
        this.polyline(this.arcPts(cx, cy, r, a, a + 4.4, 18), 3, [1, 1, 1, 0.9]);
    }

    textWidth(str, size, font = 'mono') {
        const f = this.atlas.fonts[font];
        let w = 0;
        for (const ch of str) w += (f.glyphs[ch] || f.glyphs['?']).adv;
        return w * (size / FONT_PX);
    }

    wrapText(str, size, font, maxW) {
        const lines = [];
        let line = '';
        for (const word of str.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && this.textWidth(next, size, font) > maxW) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    // y is the baseline; align: 'left' | 'center' | 'right'. Only the mono font has a glow copy.
    text(str, x, y, size, c, align = 'left', glow = true, font = 'mono') {
        const f = this.atlas.fonts[font];
        const s = size / FONT_PX;
        let pen = x;
        if (align === 'center') pen -= this.textWidth(str, size, font) / 2;
        else if (align === 'right') pen -= this.textWidth(str, size, font);
        const top = y - GLYPH.base * s, w = GLYPH.cellW * s, h = GLYPH.cellH * s;
        if (glow && f.glow) {
            const gc = [c[0], c[1], c[2], c[3] * 0.55];
            let gp = pen;
            for (const ch of str) {
                const g = f.glyphs[ch] || f.glyphs['?'];
                if (ch !== ' ') this.stretchPic(gp - GLYPH.pad * s, top, w, h, g.u0, g.gv0, g.u1, g.gv1, gc);
                gp += g.adv * s;
            }
        }
        for (const ch of str) {
            const g = f.glyphs[ch] || f.glyphs['?'];
            if (ch !== ' ') this.stretchPic(pen - GLYPH.pad * s, top, w, h, g.u0, g.v0, g.u1, g.v1, c);
            pen += g.adv * s;
        }
    }
}

return { GuiModel, DeviceContext };
});
