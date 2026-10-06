'use strict';
// Procedural textures, drawn with Canvas 2D and uploaded with their mip chains.

Features.part('imposter', (engine, feature) => {
const { rng } = feature;

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];
// draw fn at (x, y) and at its wrapped copies near the edges, so patterns tile
function wrap9(S, x, y, m, fn) {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const px = x + ox, py = y + oy;
        if (px > -m && px < S + m && py > -m && py < S + m) fn(px, py);
    }
}

const PATTERNS = {
    flat(g, S, c) { g.fillStyle = c[0]; g.fillRect(0, 0, S, S); },
    checker(g, S, c) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = c[(x + y) % 2] || '#fff'; g.fillRect(x * S / 8, y * S / 8, S / 8, S / 8); }
    },
    grass(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S); g.lineWidth = 1.2;
        for (let i = 0; i < 2600; i++) {
            const x = r() * S, y = r() * S, dx = (r() - 0.5) * 4, dy = -3 - r() * 6;
            g.strokeStyle = pick(c, r); g.globalAlpha = 0.35 + r() * 0.4;
            wrap9(S, x, y, 10, (px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + dx, py + dy); g.stroke(); });
        }
        g.globalAlpha = 1;
    },
    bark(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 90; i++) {
            const x0 = r() * S, k = 1 + Math.floor(r() * 3), ph = r() * 6.28, A = 2 + r() * 5;
            g.strokeStyle = r() < 0.65 ? c[1] : (c[2] || c[0]); g.globalAlpha = 0.45 + r() * 0.45; g.lineWidth = 1 + r() * 3.5;
            for (const ox of [-S, 0, S]) {
                g.beginPath();
                for (let y = 0; y <= S; y += 4) { const x = x0 + ox + Math.sin(y / S * Math.PI * 2 * k + ph) * A; if (y) g.lineTo(x, y); else g.moveTo(x, y); }
                g.stroke();
            }
        }
        g.globalAlpha = 1;
    },
    birch(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 70; i++) {
            const x = r() * S, y = r() * S, w = 6 + r() * 30, h = 1.5 + r() * 3.5;
            g.fillStyle = r() < 0.7 ? c[1] : (c[2] || c[1]); g.globalAlpha = 0.55 + r() * 0.4;
            wrap9(S, x, y, 40, (px, py) => g.fillRect(px, py, w, h));
        }
        g.globalAlpha = 1;
    },
    needles(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S); g.lineWidth = 1.3;
        for (let i = 0; i < 3500; i++) {
            const x = r() * S, y = r() * S, a = Math.PI / 2 + (r() - 0.5) * 1.6, L = 4 + r() * 8;
            g.strokeStyle = pick(c, r); g.globalAlpha = 0.5 + r() * 0.4;
            wrap9(S, x, y, 12, (px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); g.stroke(); });
        }
        g.globalAlpha = 1;
    },
    leaves(g, S, c, r) {
        g.clearRect(0, 0, S, S);
        for (let i = 0; i < 26; i++) {
            const x = S * (0.16 + r() * 0.68), y = S * (0.16 + r() * 0.68), L = S * (0.14 + r() * 0.1), a = r() * 6.28;
            g.save(); g.translate(x, y); g.rotate(a);
            g.fillStyle = pick(c, r);
            g.beginPath(); g.moveTo(-L / 2, 0); g.quadraticCurveTo(0, -L * 0.4, L / 2, 0); g.quadraticCurveTo(0, L * 0.4, -L / 2, 0); g.fill();
            g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-L / 2, 0); g.lineTo(L / 2, 0); g.stroke();
            g.restore();
        }
    },
    rock(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 500; i++) {
            const x = r() * S, y = r() * S, rad = 2 + r() * 14;
            g.fillStyle = pick(c, r); g.globalAlpha = 0.12 + r() * 0.14;
            wrap9(S, x, y, rad, (px, py) => { g.beginPath(); g.arc(px, py, rad, 0, 6.283); g.fill(); });
        }
        g.strokeStyle = '#000'; g.lineWidth = 1;
        for (let i = 0; i < 24; i++) {
            let x = r() * S, y = r() * S; g.globalAlpha = 0.15 + r() * 0.15; g.beginPath(); g.moveTo(x, y);
            for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 18; y += (r() - 0.5) * 18; g.lineTo(x, y); }
            g.stroke();
        }
        g.globalAlpha = 1;
    },
    plaster(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 3000; i++) { g.fillStyle = pick(c, r); g.globalAlpha = 0.25; g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2); }
        g.globalAlpha = 1;
    },
    bricks(g, S, c, r) {
        g.fillStyle = c[2] || '#ccc'; g.fillRect(0, 0, S, S);
        const rows = 8, bw = S / 4, bh = S / rows;
        for (let row = 0; row < rows; row++) {
            const off = row % 2 ? bw / 2 : 0;
            for (let k = -1; k < 5; k++) { g.fillStyle = r() < 0.5 ? c[0] : c[1]; g.fillRect(k * bw + off + 2, row * bh + 2, bw - 4, bh - 4); }
        }
    },
    tiles(g, S, c, r) {
        g.fillStyle = c[1]; g.fillRect(0, 0, S, S);
        const rows = 8, tw = S / 6, th = S / rows;
        for (let row = 0; row < rows; row++) {
            const off = row % 2 ? tw / 2 : 0;
            for (let k = -1; k < 7; k++) {
                const x0 = k * tw + off + 1, y0 = row * th;
                g.fillStyle = pick(c, r);
                g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + tw - 2, y0); g.lineTo(x0 + tw - 2, y0 + th * 0.6);
                g.quadraticCurveTo(x0 + (tw - 2) / 2, y0 + th * 1.15, x0, y0 + th * 0.6); g.fill();
                g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x0, y0, tw - 2, 2);
            }
        }
    },
    planks(g, S, c, r) {
        const n = 5, pw = S / n;
        for (let k = 0; k < n; k++) {
            g.fillStyle = pick(c, r); g.fillRect(k * pw, 0, pw, S);
            g.strokeStyle = '#000'; g.globalAlpha = 0.12;
            for (let l = 0; l < 7; l++) { const x = k * pw + r() * pw; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (r() - 0.5) * 6, S); g.stroke(); }
            g.globalAlpha = 0.5; g.fillStyle = '#000'; g.fillRect(k * pw, 0, 2, S); g.globalAlpha = 1;
        }
    },
    window(g, S, c) {
        g.fillStyle = c[1]; g.fillRect(0, 0, S, S);
        const m = S * 0.1, gap = S * 0.06, p = (S - 2 * m - gap) / 2;
        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const x = m + i * (p + gap), y = m + j * (p + gap), gr = g.createLinearGradient(x, y, x + p, y + p);
            gr.addColorStop(0, c[0]); gr.addColorStop(0.55, '#0e1820'); gr.addColorStop(1, c[0]);
            g.fillStyle = gr; g.fillRect(x, y, p, p);
        }
    },
    metal(g, S, c, r) {
        g.fillStyle = c[0]; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 260; i++) {
            const y = r() * S, x = r() * S, w = 20 + r() * 80; g.fillStyle = pick(c, r); g.globalAlpha = 0.12 + r() * 0.15;
            wrap9(S, x, y, w, (px, py) => g.fillRect(px, py, w, 1 + r() * 2));
        }
        g.globalAlpha = 1;
    },
};

const TextureFactory = {
    canvas(def) {
        const S = def.size || 256, c = makeCanvas(S, S), g = c.getContext('2d');
        (PATTERNS[def.pattern] || PATTERNS.flat)(g, S, (def.colors || ['#ffffff']).map(x => (Array.isArray(x) ? `rgb(${x.map(v => v * 255).join(',')})` : x)), rng(def.seed ?? 7));
        return c;
    },
};

// fraction of pixels at or above the alpha cutoff
function coverageOf(g, w, h, cutoff) {
    const d = g.getImageData(0, 0, w, h).data, t = cutoff * 255;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] >= t) n++;
    return n / (w * h);
}
// scale a mip level's alpha so the alpha test keeps the coverage of level 0 (else foliage thins out with distance)
function keepCoverage(g, w, h, cutoff, target) {
    const img = g.getImageData(0, 0, w, h), d = img.data, a = [];
    for (let i = 3; i < d.length; i += 4) a.push(d[i]);
    a.sort((x, y) => y - x);
    const thr = a[Math.min(a.length - 1, Math.floor(target * a.length))];
    if (!thr) return;
    const s = cutoff * 255 / thr;
    for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * s);
    g.putImageData(img, 0, 0);
}
// canvas / ImageBitmap -> sRGB texture with a full mip chain (drawn on the CPU)
function uploadImage(device, src, cutoff = 0) {
    const scale = Math.min(1, 2048 / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
    let base = src, target = 0;
    if (scale < 1 || cutoff > 0) {
        base = makeCanvas(w, h);
        const g = base.getContext('2d', { willReadFrequently: cutoff > 0 });
        g.drawImage(src, 0, 0, w, h);
        if (cutoff > 0) target = coverageOf(g, w, h, cutoff);
    }
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1, U = GPUTextureUsage;
    const tex = device.createTexture({ size: [w, h], format: 'rgba8unorm-srgb', mipLevelCount: levels, usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
    let prev = base;
    for (let l = 0; l < levels; l++) {
        const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
        let cur = prev;
        if (l > 0) {
            cur = makeCanvas(lw, lh);
            const g = cur.getContext('2d', { willReadFrequently: cutoff > 0 });
            g.imageSmoothingQuality = 'high';
            g.drawImage(prev, 0, 0, lw, lh);
            if (cutoff > 0) keepCoverage(g, lw, lh, cutoff, target);
        }
        device.queue.copyExternalImageToTexture({ source: cur }, { texture: tex, mipLevel: l }, [lw, lh]);
        prev = cur;
    }
    return tex;
}

return { TextureFactory, uploadImage };
});
