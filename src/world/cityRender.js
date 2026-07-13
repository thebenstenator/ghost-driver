// Procedural noir art pass for the generated city (see specs/districts.md). Cosmetic ONLY — draws
// the SAME building/road geometry the physics/LOS/nav use, so it's safe to iterate without touching
// gameplay. Everything is DETERMINISTIC (per-building hash) and batched into a few Graphics objects
// (the map has 800+ buildings; individual GameObjects tank the frame rate). The look:
//   • per-district MATERIALS (subtle tint + value — all dark/desaturated, noir intact)
//   • per-building value jitter + rooftop DETAIL (parapet, fixtures, water tanks, height cues)
//   • wet-street PUDDLES with faint neon reflections
//   • EMISSIVE neon signage + rooftop beacons on an ADD-blend layer (bloomed by the camera post-FX)
import Phaser from "phaser";
import { WORLD_WIDTH, WORLD_HEIGHT } from "../config.js";
import { districtIdAt } from "./city.js";

export const GROUND_COLOR = 0x141416;

// Per-district materials [r,g,b] — dark + desaturated; identity is subtle tint + value, not colour.
const MAT = {
  financial:   { roof: [47, 46, 51], walk: [38, 38, 43] }, // warm marble-grey
  neon:        { roof: [42, 38, 48], walk: [34, 31, 39] }, // faint violet-dark
  industrial:  { roof: [48, 42, 36], walk: [38, 33, 25] }, // rust/brown-dark
  docks:       { roof: [36, 43, 49], walk: [28, 35, 40] }, // cold blue-grey
  backstreets: { roof: [42, 42, 44], walk: [32, 32, 34] }, // neutral
};
const NEON = [0x2ce8d0, 0xff3bc8, 0xffb020, 0xff5050, 0x49b8ff, 0x8f6bff];
const NEON_DENSITY = { neon: 0.62, backstreets: 0.30, docks: 0.18, industrial: 0.12, financial: 0.22 };

const clampC = (v) => Math.max(0, Math.min(255, Math.round(v)));
const toHex = (r, g, b) => (clampC(r) << 16) | (clampC(g) << 8) | clampC(b);
const arrHex = (a) => toHex(a[0], a[1], a[2]);
const shade = (base, d) => toHex(base[0] + d, base[1] + d, base[2] + d);
const whiteMix = (hex, t) => toHex(((hex >> 16) & 255) + (255 - ((hex >> 16) & 255)) * t,
  ((hex >> 8) & 255) + (255 - ((hex >> 8) & 255)) * t, (hex & 255) + (255 - (hex & 255)) * t);
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const matOf = (b) => MAT[districtIdAt(b.x + b.w / 2, b.y + b.h / 2)] || MAT.backstreets;
const inB = (x, y, b) => x >= b.x && x < b.right && y >= b.y && y < b.bottom;

// All of these draw INTO a passed Graphics, culled to `bounds` (a chunk rect {x,y,right,bottom}).
// GameScene builds one set of Graphics per world chunk and only shows the chunks near the camera,
// so the whole ~800-building city is never re-tessellated at once (see _buildChunks).

// Wet-street puddles (dark water + a faint neon reflection). Low smoothness keeps them cheap.
export function drawPuddles(g, bounds) {
  for (let i = 0; i < 170; i++) { // fewer, and just the dark water (the translucent reflection was overdraw)
    const px = hash(i * 13 + 1) * WORLD_WIDTH, py = hash(i * 29 + 3) * WORLD_HEIGHT;
    if (!inB(px, py, bounds)) continue;
    const rw = 16 + hash(i * 7) * 46, rh = 6 + hash(i * 11) * 16;
    g.fillStyle(0x0a0a0d, 0.6).fillEllipse(px, py, rw * 2, rh * 2, 10);
  }
}

// Buildings whose CENTRE falls in bounds: material tint + value jitter + height cues + rooftop detail.
export function drawBuildings(g, buildings, bounds) {
  for (const b of buildings) {
    if (!inB(b.x + b.w / 2, b.y + b.h / 2, bounds)) continue;
    const mat = matOf(b);
    const j = (hash(b.x * 13 + b.y * 7) - 0.5) * 16; // per-building brightness jitter
    const roof = shade(mat.roof, j);

    // (No drop shadow: the old full-building-size translucent one was drawn UNDER the opaque
    // sidewalk halo → fully covered, pure hidden overdraw. Separation comes from the halo + the lit
    // edges + parapet.)
    g.fillStyle(arrHex(mat.walk), 1).fillRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16); // sidewalk halo
    g.fillStyle(roof, 1).fillRect(b.x, b.y, b.w, b.h);                        // roof
    g.fillStyle(shade(mat.roof, j + 20), 0.85).fillRect(b.x, b.y, b.w, 3);    // lit top edge
    g.fillStyle(shade(mat.roof, j + 12), 0.7).fillRect(b.x, b.y, 3, b.h);     // lit left edge
    // Parapet + rooftop fixtures (only where there's room).
    if (b.w > 55 && b.h > 55) {
      g.lineStyle(1.5, shade(mat.roof, j - 12), 0.6).strokeRect(b.x + 9, b.y + 9, b.w - 18, b.h - 18);
      const nF = 1 + Math.floor(hash(b.x * 3 + b.y) * 3);
      g.fillStyle(shade(mat.roof, j - 22), 0.92);
      for (let k = 0; k < nF; k++) {
        const fw = 12 + hash(b.x + k * 5) * 26, fh = 12 + hash(b.y + k * 7) * 26;
        const fx = b.x + 16 + hash(b.x + k * 11) * (b.w - 32 - fw), fy = b.y + 16 + hash(b.y + k * 17) * (b.h - 32 - fh);
        if (fw > 0 && fh > 0 && fx > b.x && fy > b.y) g.fillRect(fx, fy, fw, fh);
      }
      if (hash(b.x + b.y * 3) > 0.72) g.fillStyle(shade(mat.roof, j - 26), 0.9).fillCircle(b.x + b.w * 0.7, b.y + b.h * 0.3, 9);
    }
  }
}

// Emissive layer (draw into an ADD-blend Graphics): neon signage (bright tube + colour bloom) +
// red rooftop beacons. ADD makes light ACCUMULATE against the dark city; the camera Bloom post-FX
// then bleeds it outward. Culled to bounds by building centre.
export function drawNeonInto(g, buildings, bounds) {
  for (const b of buildings) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (!inB(cx, cy, bounds)) continue;
    const dist = districtIdAt(cx, cy);
    if (hash(b.x * 7 + b.y * 3) > (NEON_DENSITY[dist] ?? 0.15)) continue;
    const col = NEON[Math.floor(hash(b.x + b.y) * NEON.length)];
    const vert = hash(b.x * 3 + b.y) > 0.6;
    const len = 16 + hash(b.x + b.y * 5) * 26, th = 4;
    const sx = b.x + b.w * (0.18 + hash(b.x) * 0.64), sy = b.y + b.h - 4;
    const w = vert ? th : len, h = vert ? len : th, x = sx - w / 2, y = sy - h;
    // One soft ADD glow + a hot near-white core. (Was 3 stacked glow rects — the widest translucent
    // fills are the priciest thing on an iGPU, and one reads nearly the same.)
    g.fillStyle(col, 0.28).fillRect(x - 12, y - 12, w + 24, h + 24);
    g.fillStyle(whiteMix(col, 0.7), 1).fillRect(x, y, w, h); // hot near-white tube
  }
  for (const b of buildings) {
    if (b.w < 90 || b.h < 90 || hash(b.x + b.y * 9) < 0.82) continue; // sparse rooftop beacons
    if (!inB(b.x + b.w / 2, b.y + b.h / 2, bounds)) continue;
    const x = b.x + b.w * 0.3, y = b.y + b.h * 0.6;
    g.fillStyle(0xff3c3c, 0.5).fillCircle(x, y, 9);
    g.fillStyle(0xffc8c8, 1).fillCircle(x, y, 2.2);
  }
}
