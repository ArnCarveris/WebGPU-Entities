'use strict';
// The GUI atlas: baked fonts, cursor, blob.

Features.kit('gui', (engine, kit) => {
const { rad } = kit;

// GUI atlas: bitmap fonts, cursor, soft blob and a white texel, baked once at startup
// (like Doom 3's pre-rendered font pages and gui images).
//   mono (Share Tech Mono) sharp + blurred glow copy, sans (Inter 500), sansBold (Inter 700)

const FONT_PX = 44;
const GLYPH = { cellW: 56, cellH: 80, pad: 8, base: 58, perRow: 18 };
const GLYPH_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '°', '•', '×', '‹', '›', '·', '²', '³', '→', '…'];

class GuiAtlas {
    static WIDTH = 1024;
    static HEIGHT = 2048;
    static MIPS = 5;
    static MISC_Y = 970;

    constructor() {
        this.fonts = {};
    }

    static async loadFonts(timeoutMs = 3000) {
        // Don't wait forever if the webfonts are blocked; the atlas falls back to system fonts
        await Promise.race([
            Promise.all([
                document.fonts.load(`${FONT_PX}px "Share Tech Mono"`),
                document.fonts.load(`500 ${FONT_PX}px "Inter"`),
                document.fonts.load(`700 ${FONT_PX}px "Inter"`)
            ]),
            new Promise((r) => setTimeout(r, timeoutMs))
        ]);
    }

    bakeFont(c, name, css, y0, glowY0) {
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT;
        c.font = css;
        const font = { glyphs: {}, glow: glowY0 !== undefined };
        GLYPH_CHARS.forEach((ch, i) => {
            const x = (i % GLYPH.perRow) * GLYPH.cellW;
            const y = y0 + Math.floor(i / GLYPH.perRow) * GLYPH.cellH;
            c.fillStyle = '#ffffff';
            c.fillText(ch, x + GLYPH.pad, y + GLYPH.base);
            const g = {
                adv: c.measureText(ch).width,
                u0: x / W, u1: (x + GLYPH.cellW) / W,
                v0: y / H, v1: (y + GLYPH.cellH) / H
            };
            if (font.glow) {
                // Blurred copy: draw off-canvas and let only the shadow land in the glow cell
                const gy = glowY0 + (y - y0);
                c.save();
                c.shadowColor = '#ffffff';
                c.shadowBlur = 9;
                c.shadowOffsetX = 4000;
                c.fillText(ch, x + GLYPH.pad - 4000, gy + GLYPH.base);
                c.restore();
                g.gv0 = gy / H;
                g.gv1 = (gy + GLYPH.cellH) / H;
            }
            font.glyphs[ch] = g;
        });
        this.fonts[name] = font;
    }

    buildCanvas() {
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT, Y = GuiAtlas.MISC_Y;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const c = cv.getContext('2d');

        this.bakeFont(c, 'mono', `${FONT_PX}px "Share Tech Mono", monospace`, 0, 480);
        this.bakeFont(c, 'sans', `500 ${FONT_PX}px "Inter", system-ui, sans-serif`, 1040);
        this.bakeFont(c, 'sansBold', `700 ${FONT_PX}px "Inter", system-ui, sans-serif`, 1520);

        // Cursor arrow
        c.save();
        c.translate(6, Y + 4);
        c.scale(1.5, 1.5);
        c.beginPath();
        c.moveTo(0, 0); c.lineTo(0, 30); c.lineTo(8, 23); c.lineTo(14, 36);
        c.lineTo(19, 34); c.lineTo(13, 21); c.lineTo(23, 21); c.closePath();
        c.lineWidth = 3;
        c.strokeStyle = '#000000';
        c.stroke();
        c.fillStyle = '#ffffff';
        c.fill();
        c.restore();
        this.cursor = [0, Y / H, 64 / W, (Y + 64) / H];

        // Soft round blob
        const grad = c.createRadialGradient(112, Y + 32, 0, 112, Y + 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = grad;
        c.fillRect(80, Y, 64, 64);
        this.blob = [80 / W, Y / H, 144 / W, (Y + 64) / H];

        // Solid white block; sample its centre
        c.fillStyle = '#ffffff';
        c.fillRect(160, Y, 32, 32);
        this.white = [176 / W, (Y + 16) / H];
        return cv;
    }

    // Bake and upload with a downsampled mip chain; returns the texture view
    upload(renderer) {
        const cv = this.buildCanvas();
        const W = GuiAtlas.WIDTH, H = GuiAtlas.HEIGHT;
        const texture = renderer.device.createTexture({
            size: [W, H],
            format: 'rgba8unorm',
            mipLevelCount: GuiAtlas.MIPS,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        for (let level = 0; level < GuiAtlas.MIPS; level++) {
            const w = W >> level, h = H >> level;
            let src = cv;
            if (level > 0) {
                src = document.createElement('canvas');
                src.width = w;
                src.height = h;
                const c = src.getContext('2d');
                c.imageSmoothingQuality = 'high';
                c.drawImage(cv, 0, 0, w, h);
            }
            renderer.device.queue.copyExternalImageToTexture({ source: src }, { texture, mipLevel: level }, [w, h]);
        }
        return texture.createView();
    }
}

return { FONT_PX, GLYPH, GLYPH_CHARS, GuiAtlas };
});
