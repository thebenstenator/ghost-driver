// Noir art-pass PREVIEW. Renders a high-detail crop of the REAL generated city with the richer
// look I'd port into the in-game renderer — per-district materials, rooftop detail (parapet,
// fixtures, height cues), neon signage glow, wet-street puddles. Everything here is achievable in
// Phaser Graphics (solid fills, alpha, layered translucent circles for glow), so the preview is
// faithful. Run: node sim/art-preview.mjs  → sim/art-preview.svg
import { writeFileSync } from 'node:fs';
import { BUILDINGS, districtIdAt } from '../src/world/city.js';
import { hash, MAT, NEON, NEON_DENSITY } from '../src/world/cityColors.js';

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const shade = ([r, g, b], d) => `rgb(${clamp(r + d)},${clamp(g + d)},${clamp(b + d)})`;
const rgb = ([r, g, b]) => `rgb(${r},${g},${b})`;

const P = []; // primitive list → SVG
const rect  = (x, y, w, h, c, a = 1) => P.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${c}" fill-opacity="${a}"/>`);
const srect = (x, y, w, h, c, lw, a = 1) => P.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${c}" stroke-width="${lw}" stroke-opacity="${a}"/>`);
const circ  = (x, y, r, c, a = 1) => P.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" fill-opacity="${a}"/>`);
const elli  = (x, y, rx, ry, c, a = 1) => P.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${c}" fill-opacity="${a}"/>`);

// ── Crop: a slice of the Neon Mile (richest look) + its seam toward Financial ──
const X0 = 1500, Y0 = 6900, X1 = 4700, Y1 = 9200;
const inCrop = (b) => b.x < X1 && b.x + b.w > X0 && b.y < Y1 && b.y + b.h > Y0;

// Ground base + wet-street puddles (drawn first; buildings cover any that overlap).
rect(X0, Y0, X1 - X0, Y1 - Y0, 'rgb(17,17,20)');
for (let i = 0; i < 90; i++) {
  const px = X0 + hash(i * 13 + 1) * (X1 - X0), py = Y0 + hash(i * 29 + 3) * (Y1 - Y0);
  const rw = 16 + hash(i * 7) * 46, rh = 6 + hash(i * 11) * 16;
  elli(px, py, rw, rh, 'rgb(10,10,13)', 0.7);                              // dark water
  const col = NEON[Math.floor(hash(i * 5) * NEON.length)];
  elli(px + rw * 0.2, py, rw * 0.5, rh * 0.35, rgb(col), 0.07);           // faint neon reflection
}

// Buildings — material tint + height cues + rooftop detail.
for (const b of BUILDINGS) {
  if (!inCrop(b)) continue;
  const mat = MAT[districtIdAt(b.x + b.w / 2, b.y + b.h / 2)] || MAT.backstreets;
  const j = (hash(b.x * 13 + b.y * 7) - 0.5) * 16; // per-building brightness jitter
  const roof = shade(mat.roof, j);

  rect(b.x + 6, b.y + 7, b.w, b.h, 'rgb(0,0,0)', 0.38);          // drop shadow (down-right)
  rect(b.x - 8, b.y - 8, b.w + 16, b.h + 16, rgb(mat.walk));      // sidewalk halo
  rect(b.x, b.y, b.w, b.h, roof);                                 // roof
  // Height cues: lit top/left, shaded bottom/right.
  rect(b.x, b.y, b.w, 3, shade(mat.roof, j + 20), 0.85);
  rect(b.x, b.y, 3, b.h, shade(mat.roof, j + 12), 0.7);
  rect(b.x, b.y + b.h - 3, b.w, 3, shade(mat.roof, j - 18), 0.7);
  rect(b.x + b.w - 3, b.y, 3, b.h, shade(mat.roof, j - 12), 0.7);
  // Parapet (raised roof edge) + rooftop fixtures.
  if (b.w > 55 && b.h > 55) {
    srect(b.x + 9, b.y + 9, b.w - 18, b.h - 18, shade(mat.roof, j - 12), 1.5, 0.6);
    const nF = 1 + Math.floor(hash(b.x * 3 + b.y) * 3);
    for (let k = 0; k < nF; k++) {
      const fw = 12 + hash(b.x + k * 5) * 26, fh = 12 + hash(b.y + k * 7) * 26;
      const fx = b.x + 16 + hash(b.x + k * 11) * (b.w - 32 - fw), fy = b.y + 16 + hash(b.y + k * 17) * (b.h - 32 - fh);
      if (fw > 0 && fh > 0 && fx > b.x && fy > b.y) rect(fx, fy, fw, fh, shade(mat.roof, j - 22), 0.92);
    }
    if (hash(b.x + b.y * 3) > 0.72) circ(b.x + b.w * 0.7, b.y + b.h * 0.3, 9, shade(mat.roof, j - 26), 0.9); // water tank
  }
}

// Rooftop beacon lights — tiny emissive red points on taller blocks (air-safety lights). Cheap
// atmosphere; collected into the emissive (screen-blend) layer below.
const GLOW = []; // blurred colored bloom (screen-blended → adds like additive)
const CORE = []; // hot near-white cores (the "tube" itself)
const g_bar = (arr, x, y, w, h, c, a = 1) => arr.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(w, h) / 2}" fill="${c}" fill-opacity="${a}"/>`);
const g_dot = (arr, x, y, r, c, a = 1) => arr.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" fill-opacity="${a}"/>`);
const white = ([r, g, b], t) => `rgb(${clamp(r + (255 - r) * t)},${clamp(g + (255 - g) * t)},${clamp(b + (255 - b) * t)})`;

// Neon signage — an emissive TUBE on a street-facing edge, district-weighted. In-game this is an
// ADD-blend layer + a bloom post-FX; here we fake the emission with a blurred colored bloom on a
// screen blend plus a hot, near-white core (real neon reads white-hot at the tube, coloured in the
// bloom).
for (const b of BUILDINGS) {
  if (!inCrop(b)) continue;
  const dist = districtIdAt(b.x + b.w / 2, b.y + b.h / 2);
  if (hash(b.x * 7 + b.y * 3) > (NEON_DENSITY[dist] ?? 0.15)) continue;
  const col = NEON[Math.floor(hash(b.x + b.y) * NEON.length)], c = rgb(col);
  const vert = hash(b.x * 3 + b.y) > 0.6;
  const len = 16 + hash(b.x + b.y * 5) * 26, th = 4;
  const sx = b.x + b.w * (0.18 + hash(b.x) * 0.64), sy = b.y + b.h - 4;
  const w = vert ? th : len, h = vert ? len : th, x = sx - w / 2, y = sy - h;
  g_bar(GLOW, x - 10, y - 10, w + 20, h + 20, c, 0.5);  // wide soft bloom
  g_bar(GLOW, x - 4, y - 4, w + 8, h + 8, c, 0.8);      // tight bloom
  g_bar(CORE, x, y, w, h, white(col, 0.7), 1);          // hot near-white tube
}
// A few rooftop beacons.
for (const b of BUILDINGS) {
  if (!inCrop(b) || b.w < 90 || b.h < 90 || hash(b.x + b.y * 9) < 0.82) continue;
  const x = b.x + b.w * 0.3, y = b.y + b.h * 0.6;
  g_dot(GLOW, x, y, 9, 'rgb(255,60,60)', 0.7); g_dot(CORE, x, y, 2.2, 'rgb(255,200,200)', 1);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${X0} ${Y0} ${X1 - X0} ${Y1 - Y0}" width="1300">
<defs><filter id="bloom" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="6"/></filter></defs>
${P.join('\n')}
<g filter="url(#bloom)" style="mix-blend-mode:screen">${GLOW.join('')}</g>
<g>${CORE.join('')}</g>
</svg>`;
writeFileSync(new URL('./art-preview.svg', import.meta.url), svg);
console.log(`wrote sim/art-preview.svg  (crop ${X1 - X0}x${Y1 - Y0} of the Neon Mile, ${P.length} primitives)`);
