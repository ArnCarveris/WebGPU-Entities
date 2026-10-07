'use strict';
// The paint easel's screen: an EntityGUI painting into a PaintCanvas (on the kit's Renderer).

Features.kit('gui', (engine, kit) => {
const { clamp, col, EntityGUI } = kit;

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

return { EaselGUI };
});
