// Generates a placeholder 64px noir city tileset PNG with ZERO dependencies
// (built-in zlib only). Flat noir palette — replace with real art later; the
// Tiled map keeps working because tile IDs stay the same.
//
//   node scripts/gen-tileset.mjs
//
// Output: map/city-tiles.png  (320x128 = 5 cols x 2 rows, 10 tiles @ 64px)
//
// Tile order (left->right, top->bottom), import into Tiled as
// "Based on Tileset Image", tile size 64:
//   0 road           5 alley
//   1 road_dashed     6 building_a
//   2 sidewalk_edge   7 building_b
//   3 sidewalk_corner 8 plaza
//   4 crosswalk       9 water
//
// In Tiled, press X/Y to flip and Z to rotate while painting, so the single
// sidewalk_edge / sidewalk_corner tiles cover all four road edges & corners.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TILE = 64;
const COLS = 5, ROWS = 2;
const W = COLS * TILE, H = ROWS * TILE;

// ── noir palette ────────────────────────────────────────────────────────────
const C = {
  asphalt:   [38, 41, 48],
  asphaltDk: [26, 28, 33],   // alley
  curb:      [200, 148, 60], // amber
  walk:      [82, 86, 95],
  walkHi:    [104, 108, 118],
  lane:      [150, 120, 70], // dashed centreline
  zebra:     [212, 214, 222],
  roofA:     [58, 53, 80],
  roofARim:  [84, 78, 112],
  roofB:     [72, 58, 78],
  roofBRim:  [100, 84, 106],
  vent:      [40, 38, 52],
  plaza:     [77, 74, 68],
  plazaLn:   [94, 91, 84],
  water:     [13, 27, 42],
  waterHi:   [26, 46, 66],
};

// RGBA canvas, transparent by default
const img = Buffer.alloc(W * H * 4);

function px(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
}

// deterministic value noise for subtle grain (no flat-color look)
function noise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// fill a rect (tile-local coords) with color + grain
function rect(ox, oy, x, y, w, h, color, amp = 6) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const gx = ox + x + xx, gy = oy + y + yy;
      const d = (noise(gx, gy) - 0.5) * amp;
      px(gx, gy, [clamp(color[0] + d), clamp(color[1] + d), clamp(color[2] + d)]);
    }
  }
}
function line(ox, oy, x0, y0, x1, y1, color) { // axis-aligned only
  if (y0 === y1) for (let x = x0; x <= x1; x++) px(ox + x, oy + y0, color);
  else for (let y = y0; y <= y1; y++) px(ox + x0, oy + y, color);
}

// ── tile painters (each gets the tile's top-left pixel ox,oy) ────────────────
function road(ox, oy)      { rect(ox, oy, 0, 0, TILE, TILE, C.asphalt); }

function roadDashed(ox, oy) {
  road(ox, oy);
  for (let y = 4; y < TILE; y += 14)            // dashed vertical centreline
    rect(ox, oy, TILE / 2 - 1, y, 2, 8, C.lane, 0);
}

function sidewalkEdge(ox, oy) { // sidewalk strip on the WEST edge
  road(ox, oy);
  rect(ox, oy, 0, 0, 10, TILE, C.walk, 4);      // 10px walkway
  line(ox, oy, 0, 0, 0, TILE - 1, C.walkHi);    // outer highlight
  line(ox, oy, 10, 0, 10, TILE - 1, C.curb);    // amber curb
}

function sidewalkCorner(ox, oy) { // sidewalk on WEST + NORTH
  road(ox, oy);
  rect(ox, oy, 0, 0, TILE, 10, C.walk, 4);
  rect(ox, oy, 0, 0, 10, TILE, C.walk, 4);
  line(ox, oy, 10, 10, TILE - 1, 10, C.curb);
  line(ox, oy, 10, 10, 10, TILE - 1, C.curb);
}

function crosswalk(ox, oy) {
  road(ox, oy);
  for (let x = 6; x < TILE - 4; x += 12)        // zebra stripes
    rect(ox, oy, x, 8, 6, TILE - 16, C.zebra, 0);
}

function alley(ox, oy) {
  rect(ox, oy, 0, 0, TILE, TILE, C.asphaltDk, 8);
  rect(ox, oy, 0, 0, 2, TILE, C.asphalt, 0);    // faint wall shadow each side
  rect(ox, oy, TILE - 2, 0, 2, TILE, C.asphalt, 0);
}

function building(ox, oy, fill, rim) {
  rect(ox, oy, 0, 0, TILE, TILE, fill, 5);
  // rim border
  line(ox, oy, 0, 0, TILE - 1, 0, rim);
  line(ox, oy, 0, TILE - 1, TILE - 1, TILE - 1, rim);
  line(ox, oy, 0, 0, 0, TILE - 1, rim);
  line(ox, oy, TILE - 1, 0, TILE - 1, TILE - 1, rim);
  rect(ox, oy, 22, 22, 20, 20, C.vent, 4);      // rooftop vent block
  line(ox, oy, 22, 22, 41, 22, rim);
}

function plaza(ox, oy) {
  rect(ox, oy, 0, 0, TILE, TILE, C.plaza, 5);
  for (let x = 0; x <= TILE; x += 16) line(ox, oy, x === TILE ? TILE - 1 : x, 0, x === TILE ? TILE - 1 : x, TILE - 1, C.plazaLn);
  for (let y = 0; y <= TILE; y += 16) line(ox, oy, 0, y === TILE ? TILE - 1 : y, TILE - 1, y === TILE ? TILE - 1 : y, C.plazaLn);
}

function water(ox, oy) {
  rect(ox, oy, 0, 0, TILE, TILE, C.water, 4);
  for (let y = 10; y < TILE; y += 18)           // ripple highlights
    for (let x = (y % 36 ? 6 : 18); x < TILE - 6; x += 22)
      rect(ox, oy, x, y, 10, 2, C.waterHi, 0);
}

const TILES = [
  road, roadDashed, sidewalkEdge, sidewalkCorner, crosswalk,
  alley, (o, y) => building(o, y, C.roofA, C.roofARim),
  (o, y) => building(o, y, C.roofB, C.roofBRim), plaza, water,
];
TILES.forEach((paint, idx) => {
  const ox = (idx % COLS) * TILE, oy = ((idx / COLS) | 0) * TILE;
  paint(ox, oy);
});

// ── encode PNG (RGBA, no deps) ───────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
// filtered scanlines (filter byte 0 per row)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'map', 'city-tiles.png');
writeFileSync(out, png);
console.log(`wrote ${out}  (${W}x${H}, ${TILES.length} tiles @ ${TILE}px)`);
