import { GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP, WORLD_WIDTH, WORLD_HEIGHT, navLines } from '../config.js';

// The city's building footprints, generated DISTRICT BY DISTRICT on one shared fine lattice
// (see config.js + specs/districts.md). Shared by the game (GameScene draws + collides these) and
// the headless sim, so both run the EXACT same map — which is why generation is DETERMINISTIC (a
// per-plot hash, never Math.random): a random map would desync the sim from the game.
//
// ── HOW DISTRICTS DIFFER ──────────────────────────────────────────────────────────────────
// Districts are VERTICAL COLUMN BANDS (a `DISTRICTS` table). Every building is a rectangle laid
// out FLUSH to the fine BLOCK grid (facades stay aligned — no jittered setbacks). Identity comes
// from two levers, and the edge-aware NavGrid (src/ai/NavGrid.js) derives drivable streets from
// whatever we emit:
//   1. BLOCK PATTERN — how each district's generator merges plots. A merge that spans the road
//      between two plots CAPS that street (the superblock swallows it → dead-end / T-junction);
//      the NavGrid prunes it automatically. Superblocks also prune the nodes they cover.
//   2. STREET WIDTH — each district has a default width; specific lines are overridden into a
//      grand boulevard or narrow alleys. Width changes by moving the FACES of the buildings on
//      BOTH sides equally; the centreline (and the NavGrid line) never moves, so connectivity is
//      untouched and facades stay flush. streetWidthV/H are the source of truth (GameScene also
//      uses them to blank intersections by the crossing road's width).
//
// A vertical road line sits in exactly one district (or on a seam); horizontal roads take the
// width of the column's district, so streets visibly STEP narrower crossing a seam.

const COLS = GRID_COLS, ROWS = GRID_ROWS;

// Deterministic per-plot hash → [0,1). Stable across reloads and identical in game + sim.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const plotX = (c) => MARGIN + c * GRID_STEP;
const plotY = (r) => MARGIN + r * GRID_STEP;
const pidx  = (c, r) => r * COLS + c;
// Centre of road-line k (the NavGrid line): k=1..COLS-1 interior, 0/COLS are the margin lanes.
const lineCoord = (k) => MARGIN + k * GRID_STEP - ROAD / 2;

// ── Street widths ───────────────────────────────────────────────────────────────────────────
const AVENUE_W    = Math.round(ROAD * 3.2); // ~grand boulevard (widest drivable)
const ALLEY_W     = 60;   // service lanes / alleys (narrowest drivable)
const FIN_STREET  = 168;  // Financial: 3 lanes (one each way + centre turn)
const BACK_STREET = ROAD; // Backstreets: tight (claustrophobic)
const NEON_STREET = 132;  // Neon Mile: medium
const IND_STREET  = 200;  // Industrial: very wide service roads for heavy vehicles
const DOCK_STREET = 150;  // Docks: loading lanes

// ── District table (vertical bands, left → right) ─────────────────────────────────────────────
// Financial sits central so the world-centre player spawn lands in it. Generators are function
// declarations (hoisted), so referencing them here before their definition is fine.
const DISTRICTS = [
  { id: 'industrial',  c0: 0,  c1: 5,  street: IND_STREET,  gen: genIndustrial,  alleyP: 0    },
  { id: 'docks',       c0: 5,  c1: 10, street: DOCK_STREET, gen: genDocks,       alleyP: 0.15 },
  { id: 'financial',   c0: 10, c1: 16, street: FIN_STREET,  gen: genFinancial,   alleyP: 0    },
  { id: 'neon',        c0: 16, c1: 21, street: NEON_STREET, gen: genNeon,        alleyP: 0.20 },
  { id: 'backstreets', c0: 21, c1: 26, street: BACK_STREET, gen: genBackstreets, alleyP: 0.45 },
];
function districtOfCol(c) {
  for (const d of DISTRICTS) if (c >= d.c0 && c < d.c1) return d;
  return DISTRICTS[DISTRICTS.length - 1];
}

const AVENUE_COL = 12; // Financial's grand vertical artery (a real through-road between superblocks)
const GARAGE_C = 23, GARAGE_R = 3; // one garage in the Backstreets
const isGarage = (c, r) => c === GARAGE_C && r === GARAGE_R;
const G_WALL = 16, G_DOOR = 96;    // garage wall thickness + entrance gap
const consumed = new Set();        // plot indices already covered by a merge (shared across generators)

// ── Per-line width overrides (beat the district default) ──────────────────────────────────────
const vOverride = new Map([
  [AVENUE_COL, AVENUE_W], // the boulevard
  [14, ALLEY_W],          // a narrow Financial service lane
]);
for (const d of DISTRICTS) { // each district scatters alleys through its interior vertical lines
  if (!d.alleyP) continue;
  for (let k = d.c0 + 1; k < d.c1; k++) if (!vOverride.has(k) && hash(k * 5 + 1) < d.alleyP) vOverride.set(k, ALLEY_W);
}
const hOverride = new Map();
for (let k = 1; k < ROWS; k++) if (hash(k * 13 + 7) < 0.16) hOverride.set(k, ALLEY_W); // shared narrow cross-streets

// Width of vertical road line i (each vertical line is within one district, or on a seam).
export function streetWidthV(i) {
  if (vOverride.has(i)) return vOverride.get(i);
  if (i <= 0 || i >= COLS) return ROAD; // margin lanes
  const left = districtOfCol(i - 1), right = districtOfCol(i);
  return left === right ? left.street : Math.max(left.street, right.street); // seam = the wider side
}
// Width of horizontal road line j at column-line `col` (follows the column's district).
export function streetWidthH(j, col) {
  if (hOverride.has(j)) return hOverride.get(j);
  if (j <= 0 || j >= ROWS) return ROAD; // margin lanes
  return districtOfCol(col).street;
}

// A building spanning cspan×rspan plots, each FACE placed against its road line at that street's
// width. Horizontal faces use the building's own column `c` to pick the district width.
function faceRect(c, r, cspan = 1, rspan = 1) {
  const kL = c, kR = c + cspan, kT = r, kB = r + rspan;
  const x1 = kL === 0    ? MARGIN                : lineCoord(kL) + streetWidthV(kL) / 2;
  const x2 = kR === COLS ? WORLD_WIDTH - MARGIN  : lineCoord(kR) - streetWidthV(kR) / 2;
  const y1 = kT === 0    ? MARGIN                : lineCoord(kT) + streetWidthH(kT, c) / 2;
  const y2 = kB === ROWS ? WORLD_HEIGHT - MARGIN : lineCoord(kB) - streetWidthH(kB, c) / 2;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const BUILDINGS = [];
export const GARAGES = [];
for (const d of DISTRICTS) d.gen(d);

// ── District generators ───────────────────────────────────────────────────────────────────
// Financial — grand regular grid of merged 2×2 superblocks.
function genFinancial(d) {
  for (let r = 0; r < ROWS; r += 2)
    for (let c = d.c0; c < d.c1; c += 2)
      BUILDINGS.push(faceRect(c, r, Math.min(2, d.c1 - c), Math.min(2, ROWS - r)));
}

// Neon Mile — medium: mostly 1×1, ~25% merged right into wider 2×1 blocks. Denser + regular.
function genNeon(d) {
  for (let r = 0; r < ROWS; r++)
    for (let c = d.c0; c < d.c1; c++) {
      const i = pidx(c, r);
      if (consumed.has(i)) continue;
      if (hash(i * 3 + 2) < 0.25 && c + 1 < d.c1 && !consumed.has(pidx(c + 1, r))) {
        BUILDINGS.push(faceRect(c, r, 2, 1)); consumed.add(pidx(c + 1, r));
      } else BUILDINGS.push(faceRect(c, r, 1, 1));
    }
}

// Backstreets — small aligned 1×1 plots with 1×2 merges that cap streets into dead-ends. A maze.
function genBackstreets(d) {
  for (let r = 0; r < ROWS; r++)
    for (let c = d.c0; c < d.c1; c++) {
      const i = pidx(c, r);
      if (consumed.has(i)) continue;
      if (isGarage(c, r)) { buildGarage(c, r); continue; }
      const hh = hash(i * 3 + 1);
      const canRight = c + 1 < d.c1 && !consumed.has(pidx(c + 1, r)) && !isGarage(c + 1, r);
      const canDown  = r + 1 < ROWS && !consumed.has(pidx(c, r + 1)) && !isGarage(c, r + 1);
      if (hh < 0.16 && canRight) { BUILDINGS.push(faceRect(c, r, 2, 1)); consumed.add(pidx(c + 1, r)); }
      else if (hh < 0.32 && canDown) { BUILDINGS.push(faceRect(c, r, 1, 2)); consumed.add(pidx(c, r + 1)); }
      else BUILDINGS.push(faceRect(c, r, 1, 1));
    }
}

// Industrial — huge 3×3 superblocks with the occasional open factory yard (a skipped plot).
function genIndustrial(d) {
  for (let r = 0; r < ROWS; r += 3)
    for (let c = d.c0; c < d.c1; c += 3) {
      if (hash(pidx(c, r) * 5 + 3) < 0.15) continue; // open factory yard (drivable void)
      BUILDINGS.push(faceRect(c, r, Math.min(3, d.c1 - c), Math.min(3, ROWS - r)));
    }
}

// Docks — portrait 2×3 warehouses with many large open loading yards. Open + exposed.
function genDocks(d) {
  for (let r = 0; r < ROWS; r += 3)
    for (let c = d.c0; c < d.c1; c += 2) {
      if (hash(pidx(c, r) * 7 + 4) < 0.35) continue; // open loading yard
      BUILDINGS.push(faceRect(c, r, Math.min(2, d.c1 - c), Math.min(3, ROWS - r)));
    }
}

// --- Parking garage builder ---
// Replaces a plot's building with a HOLLOW enclosure: solid walls on three sides plus two short
// segments flanking a DOOR gap on the road-facing (south) side. Walls join losRects + the wall
// group in GameScene (so they block sight + movement like any building); the hide LOGIC lives in
// GameScene. Kept flush to the plot.
function buildGarage(c, r) {
  const x = plotX(c), y = plotY(r), w = BLOCK, h = BLOCK;
  const doorX = x + (w - G_DOOR) / 2;
  const walls = [
    { x, y, w, h: G_WALL },                                                    // north (back)
    { x, y, w: G_WALL, h },                                                     // west
    { x: x + w - G_WALL, y, w: G_WALL, h },                                     // east
    { x, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL },                   // south-left of door
    { x: doorX + G_DOOR, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL },   // south-right of door
  ];
  GARAGES.push({
    x, y, w, h, walls,
    interior: { x: x + G_WALL, y: y + G_WALL, w: w - 2 * G_WALL, h: h - 2 * G_WALL },
    door: { x: doorX, y: y + h - G_WALL, w: G_DOOR, h: G_WALL },
  });
}

// --- Points of Interest (mission destinations) ---
// Placed on district-seam roads (guaranteed open) and the garage for now — a real per-district
// POI table comes later. Missions reference a POI by id, so coords can move freely.
const { xs: NAV_XS, ys: NAV_YS } = navLines();
const seamNode = (line, row) => ({ x: NAV_XS[line], y: NAV_YS[row] });
export const POIS = [
  { id: 'drop',      name: 'The Drop',      ...seamNode(16, ROWS - 3), r: 80 }, // Financial/Neon seam
  { id: 'safehouse', name: 'The Safehouse', x: plotX(GARAGE_C) + BLOCK / 2, y: plotY(GARAGE_R) + BLOCK / 2, r: 60 },
  { id: 'docks',     name: 'The Docks',     ...seamNode(5, 3),         r: 80 }, // Industrial/Docks seam
];
export const poiById = (id) => POIS.find((p) => p.id === id) || null;
