// One-off: the cop sprites (cop_patrol/interceptor/heavy) came in as RGB with an opaque
// white background. This keys the background to transparent (flood-fill from the borders,
// so white CAR parts like the light bar are preserved) and tight-crops to the car, then
// re-encodes as RGBA PNG — so they display like prowler.png. Originals are in _originals/.
import zlib from 'node:zlib';
import fs from 'node:fs';

const SRC = 'scripts/sprite-originals';      // raw RGB-with-white-background exports
const DIR = 'assets/sprites/vehicles';       // processed, transparent, published output

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Decode an 8-bit colorType-2 (RGB) PNG to a flat RGB buffer.
function decodeRGB(p) {
  const b = fs.readFileSync(p);
  let o = 8, w = 0, h = 0; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8);
    if (t === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); }
    else if (t === 'IDAT') idat.push(b.slice(o + 8, o + 8 + len));
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  const ch = 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], ri = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = raw[ri + x];
      const L = x >= ch ? out[y * stride + x - ch] : 0;
      const U = y > 0 ? out[(y - 1) * stride + x] : 0;
      const UL = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0;
      let v;
      if (f === 0) v = a; else if (f === 1) v = a + L; else if (f === 2) v = a + U;
      else if (f === 3) v = a + ((L + U) >> 1);
      else { const pp = L + U - UL, pa = Math.abs(pp - L), pb = Math.abs(pp - U), pc = Math.abs(pp - UL); v = a + (pa <= pb && pa <= pc ? L : pb <= pc ? U : UL); }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, out };
}

function process(name, margin = 10) {
  const { w, h, out } = decodeRGB(`${SRC}/${name}.png`);
  const alpha = new Uint8Array(w * h).fill(255);
  const isBg = (idx) => { const i = idx * 3; return out[i] > 234 && out[i + 1] > 234 && out[i + 2] > 234; };
  const stack = [];
  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (alpha[idx] === 0) return;
    if (isBg(idx)) { alpha[idx] = 0; stack.push(idx); }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const idx = stack.pop(), x = idx % w, y = (idx / w) | 0;
    seed(x - 1, y); seed(x + 1, y); seed(x, y - 1); seed(x, y + 1);
  }
  // Bounding box of what's left (the car), padded by `margin`.
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX = Math.max(0, minX - margin); minY = Math.max(0, minY - margin);
  maxX = Math.min(w - 1, maxX + margin); maxY = Math.min(h - 1, maxY + margin);
  const cw = maxX - minX + 1, ch2 = maxY - minY + 1;
  // Build cropped RGBA scanlines (filter 0).
  const stride = cw * 4;
  const img = Buffer.alloc(ch2 * (stride + 1));
  for (let y = 0; y < ch2; y++) {
    img[y * (stride + 1)] = 0;
    for (let x = 0; x < cw; x++) {
      const sx = minX + x, sy = minY + y, si = (sy * w + sx) * 3, a = alpha[sy * w + sx];
      const di = y * (stride + 1) + 1 + x * 4;
      img[di] = out[si]; img[di + 1] = out[si + 1]; img[di + 2] = out[si + 2]; img[di + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cw, 0); ihdr.writeUInt32BE(ch2, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(img, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(`${DIR}/${name}.png`, png);
  console.log(`${name} -> ${cw}x${ch2}  aspect ${(cw / ch2).toFixed(3)}`);
}

for (const n of ['cop_patrol', 'cop_interceptor', 'cop_heavy']) process(n);
