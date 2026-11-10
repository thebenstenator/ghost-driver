// Procedural BUILDING art (prototype — not yet wired into the game; see sim/buildings-preview.mjs).
// Cosmetic ONLY: turns one collision rect from city.js into a list of draw primitives. The
// footprint never changes, so physics / LOS / nav are untouched.
//
// What makes a rect read as a building from above:
//   1. LOT SUBDIVISION — a block is several buildings (party walls, own height + roof each).
//   2. HEIGHT — a south FACADE strip (windows) inside the footprint + SHADOWS cast south-east,
//      onto the street and onto lower neighbours. Light comes from the north-west.
//   3. ROOF VOCABULARY — parapets, AC units, stair heads, water tanks, skylights, sawtooth /
//      gabled sheds, tower setbacks. Which pieces appear is the DISTRICT's identity (STYLE table).
//
// No Phaser dependency. Deterministic (seeded per building). Output:
//   { shadow: [...], body: [...], glow: [...] }  — primitives:
//   {t:'r',x,y,w,h,c,a}  {t:'c',x,y,r,c,a}  {t:'p',pts:[[x,y]..],c,a}   (c = [r,g,b])
// `shadow` is meant to be drawn as ONE flattened layer at a single alpha (so overlaps don't
// double-darken), under `body`; `glow` is the emissive (ADD / bloom) layer on top.
import { districtIdAt } from './city.js';

const SX = 2.6, SY = 1.8;        // shadow px per storey (east, south)
const SHADOW_CAP = 34;           // storeys — longest shadow we draw
const FACADE_PX = 4.2;           // facade px per visible storey
const BLACK = [0, 0, 0];

const WARM = [238, 192, 112], COOL = [176, 208, 236], PINK = [255, 90, 200], CYAN = [60, 230, 215];
const SIGN = [[44, 232, 208], [255, 59, 200], [255, 176, 32], [255, 80, 80], [73, 184, 255], [143, 107, 255]];

// District archetypes. lot = [min,max] lot edge; h = [min,max] storeys; lit = lit-window chance.
const STYLE = {
  backstreets: {
    lot: [62, 118], h: [2, 6], lit: 0.17, win: 9, lights: [WARM, WARM, WARM, COOL],
    roofs: [[32, 32, 34], [42, 41, 40], [52, 49, 46], [48, 41, 35], [38, 34, 31], [60, 56, 52]],
    walls: [[58, 46, 38], [48, 46, 46], [64, 56, 46], [40, 38, 38]],
    kinds: [['flat', 1]],
    props: [['tank', 3], ['bulkhead', 4], ['ac', 4], ['vent', 4], ['skylight', 2], ['well', 1], ['duct', 1]],
    density: 0.8, shop: 0.5, sign: 0.12, edgeSign: 0.05,
  },
  neon: {
    lot: [84, 160], h: [3, 9], lit: 0.3, win: 9, lights: [WARM, PINK, CYAN, COOL],
    roofs: [[42, 38, 50], [50, 44, 58], [36, 34, 44], [56, 46, 52]],
    walls: [[54, 42, 62], [46, 44, 58], [64, 46, 54], [40, 40, 50]],
    kinds: [['flat', 1]],
    props: [['bulkhead', 3], ['ac', 5], ['vent', 3], ['skylight', 2], ['tank', 1], ['duct', 2]],
    density: 0.9, shop: 0.9, sign: 0.8, edgeSign: 0.6,
  },
  financial: {
    lot: [170, 400], h: [3, 5], lit: 0.24, win: 7, lights: [COOL, COOL, WARM],
    roofs: [[56, 56, 62], [48, 50, 56], [62, 60, 60]],
    walls: [[46, 52, 62], [52, 54, 60], [40, 48, 58]],
    kinds: [['tower', 1]],
    props: [['ac', 3], ['skylight', 2], ['vent', 2], ['duct', 1]],
    density: 0.5, shop: 0.2, sign: 0.1,
  },
  industrial: {
    lot: [170, 400], h: [2, 4], lit: 0.07, win: 14, lights: [WARM],
    roofs: [[58, 48, 40], [50, 46, 42], [64, 52, 40], [44, 42, 40]],
    walls: [[62, 46, 36], [52, 48, 44], [48, 40, 34]],
    kinds: [['sawtooth', 3], ['flat', 2], ['gable', 1]],
    props: [['stack', 1], ['silo', 1], ['duct', 5], ['ac', 3], ['vent', 4], ['bulkhead', 1], ['skylight', 3]],
    density: 0.14, shop: 0, sign: 0.05, dock: 0.5,
  },
  docks: {
    lot: [190, 430], h: [2, 3], lit: 0.06, win: 16, lights: [COOL, WARM],
    roofs: [[42, 52, 60], [36, 46, 54], [52, 56, 58], [58, 46, 42]],
    walls: [[40, 50, 58], [48, 52, 54], [56, 44, 40]],
    kinds: [['gable', 4], ['flat', 1]],
    props: [['vent', 4], ['ac', 2], ['duct', 2], ['skylight', 2]],
    density: 0.12, shop: 0, sign: 0.05, dock: 0.8,
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sh = (c, d) => [c[0] + d, c[1] + d, c[2] + d];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const R = (o, x, y, w, h, c, a = 1) => { if (w > 0.2 && h > 0.2) o.push({ t: 'r', x, y, w, h, c, a }); };
const C = (o, x, y, r, c, a = 1) => o.push({ t: 'c', x, y, r, c, a });
const P = (o, pts, c, a = 1) => { if (pts.length >= 3) o.push({ t: 'p', pts, c, a }); };
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
function weighted(rnd, table) {
  let tot = 0; for (const [, w] of table) tot += w;
  let v = rnd() * tot;
  for (const [k, w] of table) { v -= w; if (v <= 0) return k; }
  return table[0][0];
}
const overlap = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

// The area a box of the given height sweeps along the sun vector (convex hexagon, incl. the box).
function sweep(r, storeys) {
  const s = Math.min(storeys, SHADOW_CAP), dx = s * SX, dy = s * SY;
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w + dx, r.y + dy], [r.x + r.w + dx, r.y + r.h + dy],
    [r.x + dx, r.y + r.h + dy], [r.x, r.y + r.h]];
}
// Sutherland–Hodgman clip of a convex polygon to an axis-aligned rect.
function clip(pts, r) {
  const edges = [
    [(p) => p[0] >= r.x, (a, b) => [r.x, a[1] + (b[1] - a[1]) * (r.x - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= r.x + r.w, (a, b) => [r.x + r.w, a[1] + (b[1] - a[1]) * (r.x + r.w - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= r.y, (a, b) => [a[0] + (b[0] - a[0]) * (r.y - a[1]) / (b[1] - a[1]), r.y]],
    [(p) => p[1] <= r.y + r.h, (a, b) => [a[0] + (b[0] - a[0]) * (r.y + r.h - a[1]) / (b[1] - a[1]), r.y + r.h]],
  ];
  let out = pts;
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

// ── lots ────────────────────────────────────────────────────────────────────────────────────
function splitLots(r, S, rnd, out) {
  const [mn, mx] = S.lot;
  const long = Math.max(r.w, r.h);
  const canSplit = long >= mn * 2;
  if (!canSplit || (long <= mx && rnd() < 0.55)) { out.push(r); return; }
  const t = 0.36 + rnd() * 0.28;
  if (r.w >= r.h) {
    const w1 = Math.max(mn, Math.min(r.w - mn, Math.round(r.w * t)));
    splitLots({ x: r.x, y: r.y, w: w1, h: r.h }, S, rnd, out);
    splitLots({ x: r.x + w1, y: r.y, w: r.w - w1, h: r.h }, S, rnd, out);
  } else {
    const h1 = Math.max(mn, Math.min(r.h - mn, Math.round(r.h * t)));
    splitLots({ x: r.x, y: r.y, w: r.w, h: h1 }, S, rnd, out);
    splitLots({ x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 }, S, rnd, out);
  }
}

// ── facades ─────────────────────────────────────────────────────────────────────────────────
// One facade segment [x0,x1) of a tier, `fh` px tall, ending at the tier's south edge.
function facade(o, t, x0, x1, fh, S, rnd, street) {
  const y0 = t.y + t.h - fh, w = x1 - x0;
  R(o.body, x0, y0, w, fh, t.wall);
  R(o.body, x0, y0, w, 1.5, sh(t.wall, 26));          // cornice catching the light
  R(o.body, x0, y0 + fh - 2, w, 2, sh(t.wall, -16));  // base course
  const glass = t.glass;
  const pitchY = glass ? 5 : 7, winH = glass ? 3 : 4;
  const pitchX = S.win, winW = pitchX - (glass ? 1.5 : 4);
  const base = street && !glass ? 8 : 2;              // ground floor reserved for shopfronts/doors
  const rows = Math.floor((fh - 3 - base) / pitchY);
  const cols = Math.floor((w - 4) / pitchX);
  const ox = x0 + (w - cols * pitchX) / 2 + (pitchX - winW) / 2;
  const dark = glass ? [22, 30, 42] : sh(t.wall, -24);
  for (let r = 0; r < rows; r++) {
    const wy = y0 + 3 + r * pitchY;
    if (glass && cols > 0) R(o.body, ox, wy, cols * pitchX - (pitchX - winW), winH, dark); // ribbon glazing
    const floorLit = S.lit * (glass ? (rnd() < 0.22 ? 2.6 : 0.35) : 1); // offices: a few busy floors, most dark
    for (let c = 0; c < cols; c++) {
      const lit = rnd() < floorLit;
      if (!lit && glass) continue;
      const wx = ox + c * pitchX;
      if (!lit) { R(o.body, wx, wy, winW, winH, dark); continue; }
      const col = pick(rnd, S.lights);
      R(o.body, wx, wy, winW, winH, mix(col, [255, 255, 255], 0.15));
      R(o.glow, wx - 2, wy - 2, winW + 4, winH + 4, col, 0.35);
    }
  }
  if (!street || fh < 12) return;
  // Ground floor: shopfronts + neon signage, or loading-bay roller doors.
  const gy = y0 + fh - 8;
  if (S.dock && rnd() < S.dock) {
    const n = Math.max(1, Math.floor(w / 46));
    for (let i = 0; i < n; i++) {
      const dx = x0 + (i + 0.5) * (w / n) - 11;
      R(o.body, dx - 1.5, gy - 3, 25, 11, sh(t.wall, 20));
      R(o.body, dx, gy - 1.5, 22, 9.5, [20, 20, 22]);
      for (let k = 0; k < 3; k++) R(o.body, dx, gy + k * 3, 22, 0.8, [44, 44, 46]);
    }
    return;
  }
  if (rnd() < S.shop) {
    R(o.body, x0 + 3, gy, w - 6, 6, [18, 20, 26]);                    // dark shop glazing
    const col = pick(rnd, SIGN);
    if (rnd() < 0.6) R(o.body, x0 + 3, gy - 2.5, w - 6, 2.5, mix(col, t.wall, 0.72)); // awning
    if (rnd() < S.sign) {
      const sw = Math.min(w - 12, 14 + rnd() * 30), sx = x0 + 6 + rnd() * (w - 12 - sw);
      R(o.glow, sx - 7, gy - 12, sw + 14, 17, col, 0.3);
      R(o.glow, sx, gy - 5.5, sw, 3.5, mix(col, [255, 255, 255], 0.65), 1);
      R(o.body, sx, gy - 5.5, sw, 3.5, mix(col, [255, 255, 255], 0.5));
      spill(o, sx, y0 + fh, sw, 0, 0, 1, col);
    } else if (rnd() < 0.5) {
      R(o.body, x0 + 5 + rnd() * (w - 22), gy + 0.5, 10, 5, mix(WARM, [0, 0, 0], 0.35)); // a lit shop window
    }
  }
}

// ── roofs ───────────────────────────────────────────────────────────────────────────────────
function roofBase(o, t, rh) {
  const { x, y, w, roof } = t;
  if (t.kind === 'sawtooth') {
    R(o.body, x, y, w, rh, sh(roof, -6));
    const alongX = w >= rh, len = alongX ? w : rh, per = 26, n = Math.max(1, Math.floor((len - 8) / per));
    const off = (len - n * per) / 2;
    for (let i = 0; i < n; i++) {
      const p = off + i * per;
      const lit = false;
      const glass = lit ? mix(WARM, [0, 0, 0], 0.45) : [30, 44, 54];
      const seg = (a, b, c) => (alongX ? R(o.body, x + p + a, y + 4, b, rh - 8, c) : R(o.body, x + 4, y + p + a, w - 8, b, c));
      seg(0, 6, glass); seg(6, 9, sh(roof, 12)); seg(15, 9, sh(roof, 2)); seg(24, 2, sh(roof, -22));
      if (lit) (alongX ? R(o.glow, x + p - 2, y + 4, 10, rh - 8, WARM, 0.12) : R(o.glow, x + 4, y + p - 2, w - 8, 10, WARM, 0.12));
    }
  } else if (t.kind === 'gable') {
    const alongX = w >= rh;
    if (alongX) {
      R(o.body, x, y, w, rh / 2, sh(roof, 5)); R(o.body, x, y + rh / 2, w, rh / 2, sh(roof, -5));
      for (let p = 10; p < w - 4; p += 11) R(o.body, x + p, y + 2, 1, rh - 4, BLACK, 0.2);
      R(o.body, x + 3, y + rh / 2 - 1, w - 6, 2, sh(roof, 30));
    } else {
      R(o.body, x, y, w / 2, rh, sh(roof, 5)); R(o.body, x + w / 2, y, w / 2, rh, sh(roof, -5));
      for (let p = 10; p < rh - 4; p += 11) R(o.body, x + 2, y + p, w - 4, 1, BLACK, 0.2);
      R(o.body, x + w / 2 - 1, y + 3, 2, rh - 6, sh(roof, 30));
    }
  } else {
    // Flat roof: parapet rim, sunken deck, and the parapet's own shadow along the N + W inside.
    R(o.body, x, y, w, rh, sh(roof, 16));
    R(o.body, x + 3, y + 3, w - 6, rh - 6, roof);
    R(o.body, x + 3, y + 3, w - 6, 2.5, sh(roof, -16));
    R(o.body, x + 3, y + 3, 2.5, rh - 6, sh(roof, -12));
  }
  R(o.body, x, y, w, 1.5, sh(roof, 34));               // sunlit N + W edges
  R(o.body, x, y, 1.5, rh, sh(roof, 26));
  R(o.body, x + w - 1.5, y, 1.5, rh, sh(roof, -20));   // shaded E edge
}

const PROPS = {
  ac(o, b) {
    R(o.body, b.x + 3, b.y + 2.5, b.w, b.h, BLACK, 0.45);
    R(o.body, b.x, b.y, b.w, b.h, [84, 86, 92]); R(o.body, b.x, b.y, b.w, 1.2, [120, 122, 128]);
    C(o.body, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.3, [40, 42, 46]);
  },
  bulkhead(o, b, t) {
    P(o.body, sweep(b, 2.2), BLACK, 0.45);
    R(o.body, b.x, b.y, b.w, b.h, sh(t.wall, 14)); R(o.body, b.x + 2, b.y + 2, b.w - 4, b.h - 6, sh(t.roof, 10));
    R(o.body, b.x, b.y + b.h - 4, b.w, 4, sh(t.wall, -8)); R(o.body, b.x + b.w / 2 - 2, b.y + b.h - 4, 4, 4, [18, 18, 20]);
  },
  tank(o, b) {
    const r = b.w / 2, cx = b.x + r, cy = b.y + r;
    C(o.body, cx + 6, cy + 4.2, r, BLACK, 0.45);
    C(o.body, cx, cy, r, [70, 56, 44]); C(o.body, cx - r * 0.18, cy - r * 0.18, r * 0.72, [92, 74, 56]);
    C(o.body, cx, cy, 1.4, [40, 32, 26]);
  },
  silo(o, b) {
    const r = b.w / 2, cx = b.x + r, cy = b.y + r;
    C(o.body, cx + 13, cy + 9, r, BLACK, 0.45);
    C(o.body, cx, cy, r, [78, 76, 74]); C(o.body, cx - r * 0.15, cy - r * 0.15, r * 0.78, [98, 96, 92]);
    C(o.body, cx, cy, r * 0.22, [54, 52, 50]);
  },
  stack(o, b) {
    const r = b.w / 2, cx = b.x + r, cy = b.y + r, L = 46;
    P(o.body, [[cx - r * 0.6, cy + r * 0.6], [cx + r * 0.6, cy - r * 0.6], [cx + L + r * 0.6, cy + L * 0.69 - r * 0.6],
      [cx + L - r * 0.6, cy + L * 0.69 + r * 0.6]], BLACK, 0.45);
    C(o.body, cx, cy, r, [90, 70, 58]); C(o.body, cx, cy, r * 0.55, [14, 12, 12]);
    C(o.glow, cx + r * 0.7, cy - r * 0.7, 5, [255, 50, 50], 0.5); C(o.glow, cx + r * 0.7, cy - r * 0.7, 1.3, [255, 210, 210], 1);
  },
  vent(o, b) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    C(o.body, cx + 2, cy + 1.5, 2.6, BLACK, 0.45); C(o.body, cx, cy, 2.6, [96, 98, 102]); C(o.body, cx, cy, 1.1, [36, 36, 40]);
  },
  skylight(o, b, t, S, rnd) {
    const lit = rnd() < 0.3, col = pick(rnd, S.lights);
    R(o.body, b.x, b.y, b.w, b.h, [82, 84, 90]);
    R(o.body, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, lit ? mix(col, [0, 0, 0], 0.3) : [26, 38, 50]);
    for (let p = b.w / 3; p < b.w - 2; p += b.w / 3) R(o.body, b.x + p - 0.5, b.y + 1.5, 1, b.h - 3, [82, 84, 90]);
    if (lit) R(o.glow, b.x - 3, b.y - 3, b.w + 6, b.h + 6, col, 0.22);
  },
  well(o, b) { // light well / air shaft: a hole in the roof
    R(o.body, b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3, [70, 70, 74]);
    R(o.body, b.x, b.y, b.w, b.h, [22, 22, 26]);
    R(o.body, b.x, b.y, b.w, b.h * 0.45, [8, 8, 10]); R(o.body, b.x, b.y, b.w * 0.4, b.h, [8, 8, 10]);
  },
  duct(o, b) {
    R(o.body, b.x + 2.5, b.y + 2, b.w, b.h, BLACK, 0.45);
    R(o.body, b.x, b.y, b.w, b.h, [74, 76, 80]);
    if (b.w >= b.h) { R(o.body, b.x, b.y, b.w, 1.3, [108, 110, 114]); for (let p = 8; p < b.w; p += 12) R(o.body, b.x + p, b.y, 1, b.h, [48, 50, 54]); }
    else { R(o.body, b.x, b.y, 1.3, b.h, [108, 110, 114]); for (let p = 8; p < b.h; p += 12) R(o.body, b.x, b.y + p, b.w, 1, [48, 50, 54]); }
  },
  billboard(o, b, t, S, rnd) { // rooftop sign seen edge-on, throwing colour onto the roof
    const col = pick(rnd, SIGN);
    R(o.body, b.x + 4, b.y + 3, b.w, 4, BLACK, 0.45);
    R(o.glow, b.x - 8, b.y - 10, b.w + 16, 26, col, 0.2);
    R(o.body, b.x, b.y, b.w, 4, mix(col, [255, 255, 255], 0.45));
    R(o.glow, b.x, b.y, b.w, 4, mix(col, [255, 255, 255], 0.6), 1);
    R(o.body, b.x + 2, b.y + 4, 1.5, 5, [70, 70, 74]); R(o.body, b.x + b.w - 3.5, b.y + 4, 1.5, 5, [70, 70, 74]);
  },
};
const PROP_SIZE = {
  ac: (r) => [10 + r() * 7, 8 + r() * 5], bulkhead: (r) => [15 + r() * 9, 14 + r() * 8],
  tank: (r) => { const d = 15 + r() * 6; return [d, d]; }, silo: (r) => { const d = 34 + r() * 16; return [d, d]; },
  stack: (r) => { const d = 18 + r() * 8; return [d, d]; }, vent: () => [6, 6],
  skylight: (r) => (r() < 0.5 ? [18 + r() * 16, 10 + r() * 5] : [10 + r() * 5, 18 + r() * 16]),
  well: (r) => [16 + r() * 16, 16 + r() * 16],
  duct: (r) => (r() < 0.5 ? [28 + r() * 50, 5] : [5, 28 + r() * 50]),
  billboard: (r) => [30 + r() * 34, 9],
};

function roofProps(o, t, rh, S, rnd, avoid) {
  const m = 8, ax = t.x + m, ay = t.y + m, aw = t.w - 2 * m, ah = rh - 2 * m;
  if (aw < 12 || ah < 12 || t.kind === 'sawtooth') { if (t.kind !== 'sawtooth') return; }
  const want = Math.min(16, Math.round((aw * ah) / 1500 * S.density * (0.5 + rnd())));
  const placed = [...avoid];
  for (let i = 0, n = 0; i < want * 5 && n < want; i++) {
    const kind = weighted(rnd, S.props);
    if (t.kind !== 'flat' && !['stack', 'vent', 'silo'].includes(kind)) continue;
    const [w, h] = PROP_SIZE[kind](rnd);
    if (w > aw || h > ah) continue;
    const b = { x: ax + rnd() * (aw - w), y: ay + rnd() * (ah - h), w, h };
    if (placed.some((q) => overlap(b, q, 4))) continue;
    placed.push(b); n++;
    PROPS[kind](o, b, t, S, rnd);
  }
}

function towerTop(o, t, rh, rnd) {
  const cx = t.x + t.w / 2, cy = t.y + rh / 2, r = Math.min(t.w, rh) * 0.3;
  if (r > 16 && rnd() < 0.18) { // helipad
    C(o.body, cx, cy, r, [150, 150, 140]); C(o.body, cx, cy, r - 2.5, sh(t.roof, -4));
    const s = r * 0.42;
    R(o.body, cx - s, cy - s, 3, 2 * s, [170, 170, 160]); R(o.body, cx + s - 3, cy - s, 3, 2 * s, [170, 170, 160]);
    R(o.body, cx - s, cy - 1.5, 2 * s, 3, [170, 170, 160]);
    return [{ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }];
  }
  // mechanical penthouse + mast with beacon
  const w = t.w * 0.4, h = rh * 0.34, b = { x: cx - w / 2, y: cy - h / 2, w, h };
  P(o.body, sweep(b, 3), BLACK, 0.45);
  R(o.body, b.x, b.y, w, h, [78, 80, 86]); R(o.body, b.x + 2, b.y + 2, w - 4, h - 4, [58, 60, 66]);
  for (let p = 5; p < w - 6; p += 6) R(o.body, b.x + p, b.y + 3, 2.5, h - 6, [38, 40, 44]);
  const mx = t.x + t.w * 0.22, my = t.y + rh * 0.24;
  P(o.body, [[mx, my - 0.8], [mx + 34, my + 23], [mx + 34, my + 24.6], [mx, my + 0.8]], BLACK, 0.45);
  C(o.body, mx, my, 2.2, [130, 130, 134]);
  C(o.glow, mx, my, 9, [255, 50, 50], 0.45); C(o.glow, mx, my, 2, [255, 215, 215], 1);
  return [b, { x: mx - 5, y: my - 5, w: 10, h: 10 }];
}

// ── street-facing signage ───────────────────────────────────────────────────────────────────
// Light thrown onto the street from a sign of extent (w,h) at (x,y), outward along (nx,ny).
// Goes to the SPILL layer (heavily blurred / low-res ADD), so the stacked rects read as a pool.
function spill(o, x, y, w, h, nx, ny, col) {
  for (const [d, a, pad] of [[20, 0.3, 6], [48, 0.16, 16], [86, 0.08, 28]]) {
    const ex = Math.abs(nx) * d, ey = Math.abs(ny) * d, px = ny ? pad : 0, py = nx ? pad : 0;
    R(o.spill, x - px - (nx < 0 ? ex : 0), y - py - (ny < 0 ? ey : 0), w + 2 * px + ex, h + 2 * py + ey, col, a);
  }
}
// Signs mounted on the lot's N / E / W edges where they face a street (the south edge gets
// shopfront signs in facade()). Never on the roof interior.
function edgeSigns(o, t, b, S, rnd) {
  const eps = 0.5;
  const edges = [];
  if (Math.abs(t.y - b.y) < eps) edges.push('N');
  if (Math.abs(t.x - b.x) < eps) edges.push('W');
  if (Math.abs(t.x + t.w - b.x - b.w) < eps) edges.push('E');
  for (const e of edges) {
    if (rnd() > S.edgeSign) continue;
    const col = pick(rnd, SIGN), hot = mix(col, [255, 255, 255], 0.6);
    const span = e === 'N' ? t.w : t.h;
    const len = Math.min(span - 16, 22 + rnd() * 40), at = 8 + rnd() * (span - 16 - len);
    if (len < 14) continue;
    let x, y, w, h, nx = 0, ny = 0;
    if (e === 'N') { x = t.x + at; y = t.y - 1; w = len; h = 3.5; ny = -1; }
    else if (e === 'W') { x = t.x - 1; y = t.y + at; w = 3.5; h = len; nx = -1; }
    else { x = t.x + t.w - 2.5; y = t.y + at; w = 3.5; h = len; nx = 1; }
    R(o.body, x - 1, y - 1, w + 2, h + 2, [24, 22, 28]);   // sign box
    R(o.body, x, y, w, h, hot);
    R(o.glow, x - 3, y - 3, w + 6, h + 6, col, 0.55);
    spill(o, x, y, w, h, nx, ny, col);
  }
}

// ── docks: one fenced compound per block ────────────────────────────────────────────────────
// The whole block rect is solid in-game, so it's drawn as a FENCED YARD (the fence is why you
// can't drive in): a central warehouse, container bays laid out in neat rows under a gantry
// crane, a trailer park, floodlight masts.
const CONT = [[112, 54, 40], [46, 70, 96], [122, 98, 50], [70, 78, 82], [52, 88, 80], [96, 96, 92]];
const YARD_SH = 0.42;
function uvRect(z, alongX, u, v, du, dv) {
  return alongX ? { x: z.x + u, y: z.y + v, w: du, h: dv } : { x: z.x + v, y: z.y + u, w: dv, h: du };
}
function containerBay(o, z, rnd, crane) {
  const alongX = z.w >= z.h, U = alongX ? z.w : z.h, V = alongX ? z.h : z.w;
  const L = 30, Wd = 12, m = 12, slots = [];
  let u = m, k = 0, g = 4 + Math.floor(rnd() * 3), gc = pick(rnd, CONT);
  while (u + Wd <= U - m) {
    let v = m, rr = 0;
    while (v + L <= V - m) {
      if (rnd() < 0.88) slots.push({ r: uvRect(z, alongX, u, v, Wd, L), lv: 1 + Math.floor(rnd() * 3), c: rnd() < 0.65 ? gc : pick(rnd, CONT) });
      v += L + 2; if (++rr % 2 === 0) v += 12;
    }
    u += Wd + 1.5;
    if (++k === g) { k = 0; u += 14; g = 4 + Math.floor(rnd() * 3); gc = pick(rnd, CONT); }
  }
  for (const s of slots) R(o.body, s.r.x + s.lv * 3, s.r.y + s.lv * 2.1, s.r.w, s.r.h, BLACK, YARD_SH);
  for (const s of slots) {
    const c = sh(mix(s.c, [34, 36, 40], 0.4), s.lv * 6), r = s.r, vert = r.h > r.w;
    R(o.body, r.x, r.y, r.w, r.h, c);
    R(o.body, r.x, r.y, r.w, 1, sh(c, 22)); R(o.body, r.x, r.y, 1, r.h, sh(c, 14));
    for (const f of [1 / 3, 2 / 3]) (vert ? R(o.body, r.x, r.y + r.h * f, r.w, 0.8, sh(c, -18)) : R(o.body, r.x + r.w * f, r.y, 0.8, r.h, sh(c, -18)));
  }
  if (!crane || V < 80 || U < 90) return;
  // Rail-mounted gantry crane spanning the bay.
  const rail = [72, 76, 80], yel = [158, 124, 44];
  for (const v of [4, V - 6]) { const r = uvRect(z, alongX, 4, v, U - 8, 2); R(o.body, r.x, r.y, r.w, r.h, rail); }
  const u0 = m + rnd() * (U - 2 * m - 12);
  const br = uvRect(z, alongX, u0, 2, 11, V - 4);
  R(o.body, br.x + 17, br.y + 12, br.w, br.h, BLACK, YARD_SH);
  R(o.body, br.x, br.y, br.w, br.h, yel);
  const in1 = uvRect(z, alongX, u0 + 3, 2, 5, V - 4); R(o.body, in1.x, in1.y, in1.w, in1.h, sh(yel, -50));
  for (let q = 10; q < V - 8; q += 9) { const x = uvRect(z, alongX, u0 + 3, q, 5, 1.2); R(o.body, x.x, x.y, x.w, x.h, yel); }
  for (const v of [0, V - 9]) { const e = uvRect(z, alongX, u0 - 4, v, 19, 9); R(o.body, e.x, e.y, e.w, e.h, sh(yel, -24)); R(o.body, e.x, e.y, e.w, 1.2, sh(yel, 20)); }
  const tr = uvRect(z, alongX, u0 - 2, 14 + rnd() * (V - 44), 15, 15);
  R(o.body, tr.x, tr.y, tr.w, tr.h, [56, 58, 62]); R(o.body, tr.x, tr.y, tr.w, 1.2, [110, 112, 116]);
  C(o.glow, tr.x + 7.5, tr.y + 7.5, 5, [255, 60, 50], 0.5); C(o.glow, tr.x + 7.5, tr.y + 7.5, 1.3, [255, 215, 210], 1);
}
function trailerPark(o, z, rnd) {
  const alongX = z.w >= z.h, U = alongX ? z.w : z.h, V = alongX ? z.h : z.w;
  const Wd = 11, L = Math.min(38, V / 2 - 16), m = 12;
  if (L < 22) return;
  const rigs = [];
  for (const [v, cabAtEnd] of [[m, true], [V - m - L, false]])
    for (let u = m + 3; u + Wd <= U - m; u += 17) {
      const line = uvRect(z, alongX, u - 3.5, v, 1, L); R(o.body, line.x, line.y, line.w, line.h, [96, 100, 104], 0.5); // bay marking
      if (rnd() < 0.7) rigs.push({ t: uvRect(z, alongX, u, cabAtEnd ? v : v + 9, Wd, L - 9), cab: uvRect(z, alongX, u + 0.5, cabAtEnd ? v + L - 8 : v, Wd - 1, 8) });
    }
  for (const g of rigs) R(o.body, g.t.x + 3.5, g.t.y + 2.5, g.t.w, g.t.h, BLACK, YARD_SH);
  for (const g of rigs) {
    const c = pick(rnd, [[112, 114, 116], [96, 98, 100], [86, 78, 70], [70, 80, 92]]);
    R(o.body, g.t.x, g.t.y, g.t.w, g.t.h, c); R(o.body, g.t.x, g.t.y, g.t.w, 1, sh(c, 24));
    R(o.body, g.cab.x, g.cab.y, g.cab.w, g.cab.h, [48, 56, 68]); R(o.body, g.cab.x + 1.5, g.cab.y + 1.5, g.cab.w - 3, g.cab.h - 3, [26, 32, 42]);
  }
  for (let i = 0; i < 2; i++) { // forklifts in the lane
    const f = uvRect(z, alongX, m + rnd() * (U - 2 * m - 10), V / 2 - 5 + (rnd() - 0.5) * 8, 10, 8);
    R(o.body, f.x + 2, f.y + 1.5, f.w, f.h, BLACK, YARD_SH); R(o.body, f.x, f.y, f.w, f.h, [168, 132, 42]); R(o.body, f.x + 2, f.y + 2, 4, 4, [40, 40, 44]);
  }
}
function dockYard(o, b, S, rnd) {
  const slab = pick(rnd, [[38, 42, 46], [42, 44, 46], [35, 40, 44]]);
  R(o.body, b.x, b.y, b.w, b.h, slab);
  for (let p = 64; p < b.w - 20; p += 64) R(o.body, b.x + p, b.y + 4, 1, b.h - 8, BLACK, 0.12); // slab joints
  for (let p = 64; p < b.h - 20; p += 64) R(o.body, b.x + 4, b.y + p, b.w - 8, 1, BLACK, 0.12);
  // Perimeter fence: its shadow, the rail, and posts.
  const fc = [98, 104, 108];
  R(o.body, b.x + 3, b.y + 3, b.w - 3, 2.5, BLACK, 0.4); R(o.body, b.x + 3, b.y + 3, 2.5, b.h - 3, BLACK, 0.4);
  R(o.body, b.x, b.y, b.w, 1.6, fc); R(o.body, b.x, b.y + b.h - 1.6, b.w, 1.6, sh(fc, -20));
  R(o.body, b.x, b.y, 1.6, b.h, fc); R(o.body, b.x + b.w - 1.6, b.y, 1.6, b.h, sh(fc, -20));
  for (let p = 0; p <= b.w - 3; p += 22) { R(o.body, b.x + p, b.y - 0.7, 3, 3, sh(fc, 30)); R(o.body, b.x + p, b.y + b.h - 2.3, 3, 3, sh(fc, 10)); }
  for (let p = 0; p <= b.h - 3; p += 22) { R(o.body, b.x - 0.7, b.y + p, 3, 3, sh(fc, 30)); R(o.body, b.x + b.w - 2.3, b.y + p, 3, 3, sh(fc, 10)); }

  const alongY = b.h >= b.w, long = alongY ? b.h : b.w, pad = 8;
  const zone = (a0, a1) => (alongY ? { x: b.x + pad, y: b.y + a0, w: b.w - 2 * pad, h: a1 - a0 } : { x: b.x + a0, y: b.y + pad, w: a1 - a0, h: b.h - 2 * pad });
  const whLen = long < 320 ? long - 2 * pad : long * (0.32 + rnd() * 0.08);
  const rest = long - 2 * pad - whLen, first = long < 320 ? 0 : rest * (0.42 + rnd() * 0.16);
  const zA = zone(pad, pad + first), zW = zone(pad + first, pad + first + whLen), zB = zone(pad + first + whLen, long - pad);
  const craneFirst = rnd() < 0.5, other = rnd() < 0.55 ? 'bay' : 'park';
  const fill = (z, what) => { if (Math.min(z.w, z.h) < 60) return; what === 'park' ? trailerPark(o, z, rnd) : containerBay(o, z, rnd, what === 'crane'); };
  fill(zA, craneFirst ? 'crane' : other); fill(zB, craneFirst ? other : 'crane');

  // Central warehouse.
  const ix = 18 + rnd() * 16, iy = 12;
  const t = { x: zW.x + (alongY ? ix : iy), y: zW.y + (alongY ? iy : ix), kind: 'gable', roof: pick(rnd, S.roofs), wall: pick(rnd, S.walls), rnd };
  t.w = zW.x + zW.w - (alongY ? ix : iy) - t.x; t.h = zW.y + zW.h - (alongY ? iy : ix) - t.y;
  if (t.w > 50 && t.h > 50) {
    P(o.body, sweep(t, 5), BLACK, YARD_SH);
    const fh = Math.min(15, t.h * 0.25), rh = t.h - fh;
    roofBase(o, t, t.h);
    const ridgeX = t.w >= t.h;
    for (let p = 24; p < (ridgeX ? t.w : rh) - 20; p += 44) { // ridge vents
      const v = ridgeX ? { x: t.x + p, y: t.y + t.h / 2 - 3.5, w: 12, h: 7 } : { x: t.x + t.w / 2 - 3.5, y: t.y + p, w: 7, h: 12 };
      R(o.body, v.x + 2, v.y + 1.5, v.w, v.h, BLACK, 0.4); R(o.body, v.x, v.y, v.w, v.h, [92, 96, 100]); R(o.body, v.x + 1.5, v.y + 1.5, v.w - 3, v.h - 3, [50, 54, 58]);
    }
    facade(o, t, t.x, t.x + t.w, fh, { ...S, dock: 1 }, rnd, true);
  }
  // Floodlight masts at the corners, pooling cool light on the slab.
  for (const [fx, fy] of [[b.x + 14, b.y + 14], [b.x + b.w - 14, b.y + 14], [b.x + 14, b.y + b.h - 14], [b.x + b.w - 14, b.y + b.h - 14]]) {
    C(o.spill, fx, fy, 62, COOL, 0.16); C(o.spill, fx, fy, 28, COOL, 0.2);
    C(o.body, fx, fy, 2.4, [150, 154, 158]); C(o.glow, fx, fy, 4, COOL, 0.8); C(o.glow, fx, fy, 1.5, [255, 255, 255], 1);
  }
}

// ── parks (Financial) ───────────────────────────────────────────────────────────────────────
// A park block is SOLID in-game, so it's drawn railed-in (like the dock fence): lawns, gravel
// paths, tree avenues along the paths, clumps on the lawns, a fountain, lamps.
function distSeg(px, py, s) {
  const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / l2)) : 0;
  return Math.hypot(px - s[0] - t * dx, py - s[1] - t * dy);
}
function tree(o, x, y, r, rnd) {
  const base = rnd() < 0.08 ? [58, 44, 26] : pick(rnd, [[18, 44, 26], [16, 38, 28], [24, 50, 28], [20, 42, 34]]);
  C(o.body, x + r * 0.55, y + r * 0.4, r, BLACK, 0.4);
  C(o.body, x, y, r, base);
  C(o.body, x - r * 0.22, y - r * 0.22, r * 0.66, sh(base, 12));
  C(o.body, x - r * 0.36, y - r * 0.36, r * 0.3, sh(base, 26));
}
function parkArt(o, b, rnd) {
  const { x, y, w, h } = b, cx = x + w / 2, cy = y + h / 2, m = Math.min(w, h);
  const grass = [24, 40, 30];
  R(o.body, x, y, w, h, grass);
  for (let i = 0; i < 14; i++) { // mown / worn patches
    const pw = 60 + rnd() * 160, ph = 50 + rnd() * 140;
    R(o.body, x + 8 + rnd() * (w - pw - 16), y + 8 + rnd() * (h - ph - 16), pw, ph, rnd() < 0.5 ? [30, 48, 34] : [20, 34, 27], 0.45);
  }
  // Paths (centre-line segments, drawn as quads).
  const gravel = [70, 66, 58], pw = 15, e = 10;
  const style = Math.floor(rnd() * 3);
  const segs = [];
  if (style !== 1) { segs.push([x + e, cy, x + w - e, cy], [cx, y + e, cx, y + h - e]); }
  if (style !== 0) { segs.push([x + e, y + e, x + w - e, y + h - e], [x + w - e, y + e, x + e, y + h - e]); }
  const ring = m * (0.16 + rnd() * 0.05);
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1], l = Math.hypot(dx, dy), nx = -dy / l * pw / 2, ny = dx / l * pw / 2;
    P(o.body, [[s[0] + nx, s[1] + ny], [s[2] + nx, s[3] + ny], [s[2] - nx, s[3] - ny], [s[0] - nx, s[1] - ny]], gravel);
  }
  // Central circus + fountain.
  C(o.body, cx, cy, ring + pw, gravel);
  C(o.body, cx, cy, ring, sh(grass, 5));
  C(o.body, cx, cy, ring * 0.5 + 5, [104, 104, 98]); C(o.body, cx, cy, ring * 0.5, [26, 50, 64]);
  C(o.body, cx, cy, ring * 0.5 - 6, [34, 64, 80]); C(o.body, cx, cy, 5, [120, 120, 114]);
  C(o.spill, cx, cy, ring * 0.9, COOL, 0.12); C(o.glow, cx, cy, 2.2, [220, 235, 255], 0.9);
  // Flower beds in the circus lawn.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2 + (style === 1 ? Math.PI / 4 : 0), d = ring * 0.76;
    C(o.body, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 7, pick(rnd, [[92, 40, 48], [96, 80, 36], [70, 44, 84]]));
  }
  // Trees: avenues along the paths, then clumps on the lawns.
  const trees = [];
  const clear = (px, py, r) => px - r > x + 6 && px + r < x + w - 6 && py - r > y + 6 && py + r < y + h - 6
    && Math.hypot(px - cx, py - cy) > ring + pw + r && segs.every((s) => distSeg(px, py, s) > pw / 2 + r - 3)
    && trees.every((t) => Math.hypot(px - t[0], py - t[1]) > (r + t[2]) * 0.8);
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l;
    for (let d = 34; d < l - 20; d += 52) for (const side of [-1, 1]) {
      const r = 13 + rnd() * 4, px = s[0] + ux * d - uy * side * (pw / 2 + r + 3), py = s[1] + uy * d + ux * side * (pw / 2 + r + 3);
      if (clear(px, py, r)) trees.push([px, py, r]);
    }
  }
  for (let i = 0, n = Math.round(w * h / 9000); i < n; i++) {
    const r = 12 + rnd() * 11, px = x + rnd() * w, py = y + rnd() * h;
    if (clear(px, py, r)) trees.push([px, py, r]);
  }
  // Lamps + benches along the paths (under the canopy layer).
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l;
    for (let d = 60; d < l - 40; d += 104) {
      const lx = s[0] + ux * d + uy * (pw / 2 + 2), ly = s[1] + uy * d - ux * (pw / 2 + 2);
      if (Math.hypot(lx - cx, ly - cy) < ring + pw) continue;
      C(o.spill, lx, ly, 46, WARM, 0.16); C(o.glow, lx, ly, 3.2, WARM, 0.9); C(o.glow, lx, ly, 1.3, [255, 250, 235], 1);
      const bx = s[0] + ux * (d + 26) - uy * (pw / 2 + 3), by = s[1] + uy * (d + 26) + ux * (pw / 2 + 3);
      R(o.body, bx - 4, by - 2, 8, 4, [92, 70, 44]);
    }
  }
  trees.sort((a, c) => a[1] - c[1]);
  for (const [tx, ty, r] of trees) tree(o, tx, ty, r, rnd);
  // Iron railing on a low stone kerb (why you can't drive in).
  const st = [58, 60, 58], ir = [22, 24, 24];
  for (const [rx, ry, rw, rh2] of [[x, y, w, 4], [x, y + h - 4, w, 4], [x, y, 4, h], [x + w - 4, y, 4, h]]) R(o.body, rx, ry, rw, rh2, st);
  R(o.body, x, y, w, 1.2, sh(st, 26)); R(o.body, x, y, 1.2, h, sh(st, 20));
  R(o.body, x + 4, y + 4, w - 8, 2, BLACK, 0.35); R(o.body, x + 4, y + 4, 2, h - 8, BLACK, 0.35);
  for (let p = 6; p < w - 6; p += 9) { R(o.body, x + p, y + 1, 1.6, 2.2, ir); R(o.body, x + p, y + h - 3.2, 1.6, 2.2, ir); }
  for (let p = 6; p < h - 6; p += 9) { R(o.body, x + 1, y + p, 2.2, 1.6, ir); R(o.body, x + w - 3.2, y + p, 2.2, 1.6, ir); }
}

// ── harbour basins (Docks waterfront) ───────────────────────────────────────────────────────
// A 'water' block is solid in-game: a quay-walled basin with a moored container ship under
// ship-to-shore crane booms, barges, and floodlit quay edges. The roads between basins are piers.
// A moored container ship filling zone z; bow at the top (vertical) or left. Crane booms reach
// over it from the quay on its west / north side.
function ship(o, z, vertical, rnd, booms = true) {
  const L = vertical ? z.h : z.w, B = vertical ? z.w : z.h;
  const pt = (u, v) => (vertical ? [z.x + v, z.y + u] : [z.x + u, z.y + v]); // u along the hull, bow at u=0
  const hull = [pt(0, B / 2), pt(L * 0.1, B * 0.06), pt(L * 0.2, 0), pt(L, 0), pt(L, B), pt(L * 0.2, B), pt(L * 0.1, B * 0.94)];
  const hc = pick(rnd, [[104, 40, 34], [44, 60, 82], [66, 70, 72]]);
  P(o.body, hull.map(([px, py]) => [px + 11, py + 8]), BLACK, 0.45);
  P(o.body, hull, hc);
  const deck = [pt(L * 0.07, B / 2), pt(L * 0.14, B * 0.16), pt(L * 0.22, 5), pt(L - 5, 5), pt(L - 5, B - 5), pt(L * 0.22, B - 5), pt(L * 0.14, B * 0.84)];
  P(o.body, deck, [52, 54, 58]);
  const across = Math.floor((B - 16) / 11.5), v0 = (B - across * 11.5) / 2;
  for (let u = L * 0.25; u + 27 < L * 0.76; u += 29) {
    const gc = pick(rnd, CONT);
    for (let k = 0; k < across; k++) {
      if (rnd() < 0.08) continue;
      const r = uvRect(z, !vertical, u, v0 + k * 11.5, 26, 10.5), c = sh(mix(rnd() < 0.6 ? gc : pick(rnd, CONT), [34, 36, 40], 0.3), Math.floor(rnd() * 3) * 7);
      R(o.body, r.x, r.y, r.w, r.h, c); R(o.body, r.x, r.y, r.w, 1, sh(c, 22));
    }
  }
  const br = uvRect(z, !vertical, L * 0.8, 6, L * 0.11, B - 12);
  R(o.body, br.x + 5, br.y + 3.5, br.w, br.h, BLACK, 0.4);
  R(o.body, br.x, br.y, br.w, br.h, [156, 158, 154]); R(o.body, br.x + 2.5, br.y + 2.5, br.w - 5, br.h - 5, [116, 118, 116]);
  const win = uvRect(z, !vertical, L * 0.8 + 1, 9, 3, B - 18);
  R(o.body, win.x, win.y, win.w, win.h, mix(WARM, [0, 0, 0], 0.2)); R(o.glow, win.x - 2, win.y - 2, win.w + 4, win.h + 4, WARM, 0.5);
  const fn = pt(L * 0.94, B / 2);
  C(o.body, fn[0] + 4, fn[1] + 3, 8, BLACK, 0.4); C(o.body, fn[0], fn[1], 8, sh(hc, 20)); C(o.body, fn[0], fn[1], 4.5, [14, 14, 16]);
  for (const f of booms ? [0.36, 0.6] : []) {
    const boom = uvRect(z, !vertical, L * f, -22, 9, B + 40), yel = [158, 124, 44];
    R(o.body, boom.x + 15, boom.y + 10, boom.w, boom.h, BLACK, 0.4);
    R(o.body, boom.x, boom.y, boom.w, boom.h, yel);
    const core = uvRect(z, !vertical, L * f + 2.5, -22, 4, B + 40); R(o.body, core.x, core.y, core.w, core.h, sh(yel, -54));
    for (let q = -16; q < B + 14; q += 9) { const xb = uvRect(z, !vertical, L * f + 2.5, q, 4, 1.2); R(o.body, xb.x, xb.y, xb.w, xb.h, yel); }
    const tip = pt(L * f + 4.5, B + 16);
    C(o.glow, tip[0], tip[1], 5, [255, 60, 50], 0.5); C(o.glow, tip[0], tip[1], 1.3, [255, 215, 210], 1);
  }
}
function harbourArt(o, b, rnd) {
  // OPEN SEA: only the west side is a quay (plus the south side of the last band). No walls to
  // the north or east — the water carries on past the edge of the world.
  const { x, y, w, h } = b, water = [12, 24, 34];
  R(o.body, x, y, w, h, water);
  for (let i = 0, n = Math.round(w * h / 5200); i < n; i++) { // swell
    const l = 14 + rnd() * 34;
    R(o.body, x + 6 + rnd() * (w - l - 12), y + rnd() * h, l, 1.3, rnd() < 0.5 ? [30, 52, 66] : [6, 14, 22], 0.5);
  }
  // West quay: wall shadow on the water, bollards, floodlights reflecting off the surface.
  R(o.body, x, y, 8, h, [4, 9, 14], 0.75);
  for (let p = 18; p < h; p += 38) C(o.body, x - 3, y + p, 2.4, [130, 132, 128]);
  for (let p = 120; p < h; p += 300) {
    C(o.spill, x + 6, y + p, 80, COOL, 0.14); C(o.spill, x + 6, y + p, 32, COOL, 0.2);
    C(o.glow, x - 3, y + p, 4, COOL, 0.8); C(o.glow, x - 3, y + p, 1.5, [255, 255, 255], 1);
  }
  if (b.southQuay) {
    R(o.body, x, y + h - 2.5, w, 2.5, [50, 60, 66]);
    for (let p = 18; p < w - 10; p += 38) C(o.body, x + p, y + h + 3, 2.4, [110, 112, 110]);
  }
  // Shipping lies AT ANCHOR a block offshore — nothing moored against the quay, nothing enclosed.
  const OFF = 330;
  if (h >= 520 && w > OFF + 200) {
    const L = Math.min(h - 140, 440 + rnd() * 180), B = 92;
    ship(o, { x: x + OFF + rnd() * 110, y: y + 50 + rnd() * (h - L - 100), w: B, h: L }, true, rnd, false);
    if (w > OFF + 700 && rnd() < 0.7) { // a second, smaller vessel further out, lying across the swell
      const l2 = 260 + rnd() * 120;
      ship(o, { x: x + OFF + 380 + rnd() * (w - OFF - 420 - l2), y: y + 60 + rnd() * (h - 200), w: l2, h: 70 }, false, rnd, false);
    }
  }
  // Channel buoys.
  for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
    const bx = x + 160 + rnd() * (w - 220), by = y + 20 + rnd() * (h - 40), col = i % 2 ? [255, 60, 50] : [60, 235, 120];
    C(o.body, bx, by, 3, [150, 150, 146]); C(o.spill, bx, by, 26, col, 0.2); C(o.glow, bx, by, 4.5, col, 0.6); C(o.glow, bx, by, 1.3, [255, 255, 255], 1);
  }
}

// ── safehouse garages ───────────────────────────────────────────────────────────────────────
// g = a GARAGES entry from city.js (hollow enclosure, door south). Open-topped so the car stays
// visible inside: concrete floor with bays, thick walls that cast shadow in and out, a hazard-
// striped threshold, and a green SAFE light over the door so safehouses are recognisable at a glance.
const SAFE = [70, 235, 160];
export function garageArt(g) {
  const o = { shadow: [], body: [], glow: [], spill: [] };
  const I = g.interior, D = g.door, T = D.h, cx = I.x + I.w / 2, cy = I.y + I.h / 2;
  const floor = [42, 46, 52], wall = [74, 78, 86];
  R(o.body, D.x - 14, D.y + T, D.w + 28, 30, [36, 38, 42]);            // apron outside the door
  R(o.body, I.x, I.y, I.w, I.h, floor); R(o.body, D.x, D.y, D.w, T, floor);
  for (let p = 40; p < I.w - 20; p += 46) R(o.body, I.x + 3, I.y + p, I.w - 6, 1, BLACK, 0.14); // slab joints
  for (let i = 0; i <= 5; i++) R(o.body, I.x + 8 + i * (I.w - 18) / 5, I.y + 6, 2, 58, [128, 132, 136], 0.6); // bays
  for (const [fx, fy, r] of [[0.28, 0.3, 7], [0.7, 0.24, 5], [0.55, 0.62, 9]]) C(o.body, I.x + I.w * fx, I.y + I.h * fy, r, BLACK, 0.2); // oil
  R(o.body, I.x, I.y, I.w, 10, BLACK, 0.42); R(o.body, I.x, I.y, 10, I.h, BLACK, 0.42); // N + W walls shade the floor
  C(o.spill, cx, cy, 78, WARM, 0.18); C(o.glow, cx, cy, 3, WARM, 0.7);                // work lamp
  // Threshold hazard stripes.
  for (let p = 0, k = 0; p < D.w; p += 8, k++) R(o.body, D.x + p, D.y + T - 5, Math.min(8, D.w - p), 5, k % 2 ? [22, 22, 24] : [214, 170, 44]);
  for (const r of g.walls) P(o.shadow, sweep(r, 3), BLACK, 1);
  for (const r of g.walls) {
    R(o.body, r.x, r.y, r.w, r.h, wall); R(o.body, r.x + 3, r.y + 3, r.w - 6, r.h - 6, sh(wall, -18));
    R(o.body, r.x, r.y, r.w, 1.5, sh(wall, 30)); R(o.body, r.x, r.y, 1.5, r.h, sh(wall, 22));
    if (r.y === D.y && r.h === T && r.w < g.w) { // the two south wall stubs flanking the door
      R(o.body, r.x, r.y + T - 5, r.w, 5, sh(wall, -34));              // street face
      const sx = r.x + 6, sw = r.w - 12;                               // SAFE light strip + its spill
      R(o.body, sx, r.y + T - 4, sw, 2.5, mix(SAFE, [255, 255, 255], 0.45));
      R(o.glow, sx - 2, r.y + T - 6, sw + 4, 6.5, SAFE, 0.6);
      spill(o, sx, r.y + T, sw, 0, 0, 1, SAFE);
    }
  }
  for (const jx of [D.x - 3, D.x + D.w + 3]) { C(o.glow, jx, D.y + T / 2, 5, SAFE, 0.7); C(o.glow, jx, D.y + T / 2, 1.6, [255, 255, 255], 1); }
  return o;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
export function buildingArt(b) {
  const id = districtIdAt(b.x + b.w / 2, b.y + b.h / 2);
  const S = STYLE[id] || STYLE.backstreets;
  const rnd = rng(Math.imul(b.x | 0, 73856093) ^ Math.imul(b.y | 0, 19349663));
  const o = { shadow: [], body: [], glow: [], spill: [] };
  if (b.kind === 'park') { parkArt(o, b, rnd); return o; }
  if (b.kind === 'water') { harbourArt(o, b, rnd); return o; }
  if (id === 'docks') { dockYard(o, b, S, rnd); return o; }

  // Tiers: every lot is one tier on the ground; towers stack further tiers on a podium.
  const lots = [];
  splitLots({ x: b.x, y: b.y, w: b.w, h: b.h }, S, rnd, lots);
  const tiers = [];
  for (const l of lots) {
    const kind = weighted(rnd, S.kinds);
    const H = S.h[0] + Math.floor(rnd() * (S.h[1] - S.h[0] + 1));
    const base = { ...l, H, below: 0, ground: true, kind: kind === 'tower' ? 'flat' : kind, roof: pick(rnd, S.roofs),
      wall: pick(rnd, S.walls), kids: [], rnd };
    tiers.push(base);
    if (kind !== 'tower') continue;
    let parent = base, n = 1 + Math.floor(rnd() * 3), hgt = H;
    const wall = pick(rnd, S.walls), roof = pick(rnd, S.roofs);
    let fh = H * FACADE_PX; // parent's facade depth — the next tier must sit on the ROOF above it
    for (let i = 0; i < n; i++) {
      const inx = (i === 0 ? 14 + rnd() * 30 : 10 + rnd() * 22), iny = (i === 0 ? 14 + rnd() * 30 : 10 + rnd() * 22);
      const r = { x: parent.x + inx * (0.5 + rnd()), y: parent.y + iny * (0.4 + rnd() * 0.6) };
      r.w = parent.x + parent.w - inx - r.x; r.h = parent.y + parent.h - fh - iny * 0.6 - r.y;
      if (r.w < 60 || r.h < 70) break;
      const rise = i === 0 ? 14 + Math.floor(rnd() * 22) : 4 + Math.floor(rnd() * 9);
      hgt += rise;
      fh = Math.min(r.h * 0.34, Math.max(7, rise * FACADE_PX));
      const tier = { ...r, H: hgt, below: parent.H, kind: 'flat', roof: sh(roof, i * 5), wall, glass: true, kids: [], rnd };
      parent.kids.push(r); tiers.push(tier); parent = tier;
    }
    parent.top = true;
  }

  for (const t of tiers) P(o.shadow, sweep(t, t.H), BLACK, 1);
  tiers.sort((a, c) => a.H - c.H);

  for (const t of tiers) {
    // South facade, per segment: visible height = how far this tier rises above what's south of it.
    const segs = [];
    if (!t.ground) segs.push([t.x, t.x + t.w, t.H - t.below, false]);
    else {
      const south = tiers.filter((q) => q.ground && q !== t && Math.abs(q.y - (t.y + t.h)) < 0.5 && q.x < t.x + t.w && q.x + q.w > t.x);
      const xs = [...new Set([t.x, t.x + t.w, ...south.flatMap((q) => [q.x, q.x + q.w])])]
        .filter((v) => v >= t.x && v <= t.x + t.w).sort((a, c) => a - c);
      for (let i = 0; i + 1 < xs.length; i++) {
        const mid = (xs[i] + xs[i + 1]) / 2, q = south.find((s) => s.x <= mid && s.x + s.w > mid);
        segs.push([xs[i], xs[i + 1], t.H - (q ? q.H : 0), !q]);
      }
    }
    const cap = t.h * (t.glass ? 0.34 : 0.4);
    let maxF = 0;
    for (const s of segs) { s[2] = s[2] > 0 ? Math.min(cap, Math.max(7, s[2] * FACADE_PX)) : 0; maxF = Math.max(maxF, s[2]); }
    const rh = t.h - maxF; // roof depth clear of every facade segment (props stay inside it)

    roofBase(o, { ...t, h: t.h }, t.h);
    const avoid = t.top ? towerTop(o, t, rh, rnd) : [];
    roofProps(o, t, rh, S, rnd, [...t.kids, ...avoid]);
    // Shadows cast onto this tier by everything taller.
    for (const c of tiers) {
      if (c === t || c.H <= t.H) continue;
      const pts = clip(sweep(c, c.H - t.H), t);
      if (pts.length >= 3) P(o.body, pts, BLACK, 0.42);
    }
    for (const [x0, x1, fh, street] of segs) if (fh > 0) facade(o, t, x0, x1, fh, S, rnd, street);
    if (t.ground && S.edgeSign) edgeSigns(o, t, b, S, rnd);
  }
  return o;
}
