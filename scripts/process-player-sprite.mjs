// Process scripts/sprite-originals/prowler2.png (1024×1536 RGBA, already transparent) into
// the player texture assets/sprites/vehicles/prowler.png: crop to the car + box-filter
// downscale to ~128px (kills the moiré of crushing a 1024px source to ~74px at render).
import zlib from 'node:zlib';
import fs from 'node:fs';

const SRC = 'scripts/sprite-originals/prowler2.png';
const OUT = 'assets/sprites/vehicles/prowler.png';
const MAX = 128, MARGIN = 10;

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

// Decode an 8-bit colorType-6 (RGBA) PNG.
function decode(p) {
  const b = fs.readFileSync(p); let o = 8, w = 0, h = 0; const idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8);
    if (t === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); }
    else if (t === 'IDAT') idat.push(b.slice(o + 8, o + 8 + len)); else if (t === 'IEND') break; o += 12 + len; }
  const ch = 4, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], ri = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) { const a = raw[ri + x], L = x >= ch ? out[y * stride + x - ch] : 0, U = y > 0 ? out[(y - 1) * stride + x] : 0, UL = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0; let v;
      if (f === 0) v = a; else if (f === 1) v = a + L; else if (f === 2) v = a + U; else if (f === 3) v = a + ((L + U) >> 1);
      else { const pp = L + U - UL, pa = Math.abs(pp - L), pb = Math.abs(pp - U), pc = Math.abs(pp - UL); v = a + (pa <= pb && pa <= pc ? L : pb <= pc ? U : UL); }
      out[y * stride + x] = v & 255; } }
  return { w, h, out };
}

const { w, h, out } = decode(SRC);
let minX = w, minY = h, maxX = 0, maxY = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[(y * w + x) * 4 + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
minX = Math.max(0, minX - MARGIN); minY = Math.max(0, minY - MARGIN); maxX = Math.min(w - 1, maxX + MARGIN); maxY = Math.min(h - 1, maxY + MARGIN);
const cw = maxX - minX + 1, ch2 = maxY - minY + 1;
const crop = new Float32Array(cw * ch2 * 4);
for (let y = 0; y < ch2; y++) for (let x = 0; x < cw; x++) { const si = ((minY + y) * w + (minX + x)) * 4, di = (y * cw + x) * 4; for (let k = 0; k < 4; k++) crop[di + k] = out[si + k]; }
// box-filter downscale (alpha-weighted RGB)
const sc = Math.min(1, MAX / Math.max(cw, ch2)), dw = Math.max(1, Math.round(cw * sc)), dh = Math.max(1, Math.round(ch2 * sc));
const small = Buffer.alloc(dw * dh * 4);
for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
  const x0 = Math.floor(x * cw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * cw / dw)), y0 = Math.floor(y * ch2 / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ch2 / dh));
  let r = 0, g = 0, bl = 0, aw = 0, asum = 0, n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * cw + xx) * 4, a = crop[i + 3]; r += crop[i] * a; g += crop[i + 1] * a; bl += crop[i + 2] * a; aw += a; asum += a; n++; }
  const di = (y * dw + x) * 4; small[di] = aw ? Math.round(r / aw) : 0; small[di + 1] = aw ? Math.round(g / aw) : 0; small[di + 2] = aw ? Math.round(bl / aw) : 0; small[di + 3] = Math.round(asum / n);
}
const stride = dw * 4, img = Buffer.alloc(dh * (stride + 1));
for (let y = 0; y < dh; y++) { img[y * (stride + 1)] = 0; small.copy(img, y * (stride + 1) + 1, y * stride, y * stride + stride); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dw, 0); ihdr.writeUInt32BE(dh, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(img, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`prowler -> ${dw}x${dh}  aspect ${(cw / ch2).toFixed(3)}`);
