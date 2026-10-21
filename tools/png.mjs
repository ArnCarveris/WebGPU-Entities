// PNG decode / encode for the tools (8-bit RGB / RGBA, non-interlaced: what Chromium's screenshots are), no npm deps.
//
//   decode(buf) -> { width, height, data: Uint8Array RGBA }
//   encode({ width, height, data }) -> Buffer (RGBA)
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decode(buf) {
    if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
    let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
    const idat = [];
    while (o < buf.length) {
        const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
        if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
        else if (kind === 'IDAT') idat.push(body);
        else if (kind === 'IEND') break;
        o += 12 + len;
    }
    if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`PNG: only 8-bit RGB / RGBA, not interlaced (depth ${depth}, type ${type})`);
    const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
    const px = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
            let v = raw[src + x];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            px[dst + x] = v;
        }
    }
    if (bpp === 4) return { width, height, data: px };
    const data = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { data[j] = px[i]; data[j + 1] = px[i + 1]; data[j + 2] = px[i + 2]; data[j + 3] = 255; }
    return { width, height, data };
}

function chunk(kind, body) {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), head = Buffer.from(kind, 'latin1');
    len.writeUInt32BE(body.length);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head, body])) >>> 0);
    return Buffer.concat([len, head, body, crc]);
}

export function encode({ width, height, data }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// two images of the same size: { n (pixels that differ), frac, max, mean (per pixel, max channel delta), box, heat (a
// PNG: the differences in red over the first image, dimmed) }
export function diff(a, b, { heat = false } = {}) {
    if (a.width !== b.width || a.height !== b.height) return { n: a.width * a.height, frac: 1, max: 255, mean: 255, size: [a.width, a.height, b.width, b.height] };
    const { width: w, height: h } = a, A = a.data, B = b.data, out = heat ? new Uint8Array(A.length) : null;
    let n = 0, max = 0, sum = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < A.length; i += 4) {
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
        if (d) {
            n++; sum += d; if (d > max) max = d;
            const p = i >> 2, x = p % w, y = (p - x) / w;
            if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
        if (out) { out[i] = d ? 255 : A[i] * 0.3; out[i + 1] = d ? Math.min(255, d * 4) : A[i + 1] * 0.3; out[i + 2] = A[i + 2] * 0.3; out[i + 3] = 255; }
    }
    const r = { n, frac: n / (w * h), max, mean: n ? sum / n : 0, box: n ? [x0, y0, x1, y1] : null };
    if (out && n) r.heat = encode({ width: w, height: h, data: out });
    return r;
}
