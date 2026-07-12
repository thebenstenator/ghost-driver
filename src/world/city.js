import { GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP, WORLD_WIDTH, WORLD_HEIGHT, navLines } from '../config.js';

// The city's building footprints, generated DISTRICT BY DISTRICT on one shared fine lattice
// (see config.js). Shared by the game (GameScene draws + collides these) and the headless sim,
// so both run the EXACT same map — which is why generation is DETERMINISTIC (a per-plot hash,
// never Math.random): a random map would desync the sim from the game and make playtests
// irreproducible.
//
// ── HOW DISTRICTS DIFFER ──────────────────────────────────────────────────────────────────
// Every building is a rectangle laid out FLUSH to the fine BLOCK grid (facades stay aligned —
// no jittered setbacks). Identity comes from two aligned levers, and the edge-aware NavGrid
// (src/ai/NavGrid.js) derives drivable streets from whatever we emit:
//
//   1. BLOCK PATTERN — Financial merges plots into big 2×2 superblocks (grand, regular grid);
//      Backstreets uses small 1×1 plots plus 1×2 merges that CAP the perpendicular street
//      (a superblock swallows the road between two plots → dead-ends / T-junctions → maze).
//   2. STREET WIDTH — each district has a default street width (Financial wide/3-lane,
//      Backstreets tight), with specific lines overridden into a grand boulevard or narrow
//      alleys. A road changes width by moving the FACES of the buildings on BOTH sides by the
//      same amount; the road CENTRELINE (and the NavGrid line on it) never moves, so connectivity
//      is untouched. This keeps facades flush while streets vary in size.
//
// This is Phase B (2 districts, split vertically). More districts + a real layout table later.

const COLS = GRID_COLS, ROWS = GRID_ROWS;
const SPLIT = 11; // district seam: Financial = cols [0,SPLIT), Backstreets = [SPLIT,COLS)

// Deterministic per-plot hash → [0,1). Stable across reloads and identical in game + sim.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const plotX = (c) => MARGIN + c * GRID_STEP;
const plotY = (r) => MARGIN + r * GRID_STEP;
// Centre of road-line k (the NavGrid line): k=1..COLS-1 interior, 0/COLS are the margin lanes.
const lineCoord = (k) => MARGIN + k * GRID_STEP - ROAD / 2;

// ── Street-width profile ──────────────────────────────────────────────────────────────────
// Each district has a DEFAULT street width; specific lines are overridden (one grand boulevard,
// a scatter of alleys). A wider street stays aligned because we move the FACES of the buildings
// on BOTH sides equally — the road centreline (and the NavGrid line) never moves.
export const AVENUE_W = Math.round(ROAD * 3.2); // ~grand boulevard (widest)
const ALLEY_W    = 60;   // service lanes / backstreet alleys (narrowest drivable)
const FIN_STREET = 168;  // Financial default: 3 lanes (one each way + a centre turn lane)
const BACK_STREET = ROAD; // Backstreets default: tight (keeps the claustrophobic feel)

const AVENUE_COL = 4; // Financial's grand vertical artery (an even index = a real through-road)

// Per-line width OVERRIDES (beat the district default). A vertical line sits entirely inside one
// district (or the seam), so a single width per line is unambiguous; horizontal lines span the
// whole world, so their default follows the column's district (see streetWidthH) and only the
// shared alleys are overridden.
const vOverride = new Map([
  [AVENUE_COL, AVENUE_W], // the boulevard
  [8, ALLEY_W],           // a narrow Financial service lane
  [SPLIT, FIN_STREET],    // the seam avenue — fixed so Financial's + Backstreets' faces agree
]);
for (let k = SPLIT + 1; k < COLS; k++) if (hash(k * 5 + 1) < 0.45 && !vOverride.has(k)) vOverride.set(k, ALLEY_W);
const hOverride = new Map();
for (let k = 1; k < ROWS; k++) if (hash(k * 13 + 7) < 0.18) hOverride.set(k, ALLEY_W);

// Width of vertical road line i (well-defined per line: each is within one district). Exported so
// GameScene can blank intersections by the crossing road's width.
export function streetWidthV(i) {
  if (vOverride.has(i)) return vOverride.get(i);
  if (i <= 0 || i >= COLS) return ROAD;         // margin lanes
  return i < SPLIT ? FIN_STREET : BACK_STREET;  // i === SPLIT (seam) is handled by the override
}
// Width of horizontal road line j at column-line `col` — horizontal lines span both districts,
// so the width follows the column's district (it steps narrower crossing into the Backstreets).
export function streetWidthH(j, col) {
  if (hOverride.has(j)) return hOverride.get(j);
  if (j <= 0 || j >= ROWS) return ROAD;         // margin lanes
  return col < SPLIT ? FIN_STREET : BACK_STREET;
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

// One garage in the Backstreets (a plot we replace with a hollow enclosure), off the seam.
const GARAGE_C = SPLIT + 2, GARAGE_R = 3;
const isGarage = (c, r) => c === GARAGE_C && r === GARAGE_R;
const G_WALL = 16, G_DOOR = 96; // wall thickness + entrance gap (declared before the loop below)

// ── Financial: merged 2×2 superblocks ─────────────────────────────────────────────────────
for (let r = 0; r < ROWS; r += 2) {
  for (let c = 0; c < SPLIT; c += 2) {
    const cspan = Math.min(2, SPLIT - c); // clamp at the seam so the boundary avenue stays open
    const rspan = Math.min(2, ROWS - r);
    BUILDINGS.push(faceRect(c, r, cspan, rspan));
  }
}

// ── Backstreets: small plots + street-capping merges ──────────────────────────────────────
const consumed = new Set(); // plot indices already covered by a merge
const pidx = (c, r) => r * COLS + c;
const MERGE_R = 0.16; // P(merge right into a 2×1) — caps the vertical street between the pair
const MERGE_D = 0.32; // cumulative; (MERGE_D - MERGE_R) merge down into a 1×2

for (let r = 0; r < ROWS; r++) {
  for (let c = SPLIT; c < COLS; c++) {
    const i = pidx(c, r);
    if (consumed.has(i)) continue;
    if (isGarage(c, r)) { buildGarage(c, r); continue; }

    const hh = hash(i * 3 + 1);
    const canRight = c + 1 < COLS && !consumed.has(pidx(c + 1, r)) && !isGarage(c + 1, r);
    const canDown  = r + 1 < ROWS && !consumed.has(pidx(c, r + 1)) && !isGarage(c, r + 1);

    if (hh < MERGE_R && canRight) { BUILDINGS.push(faceRect(c, r, 2, 1)); consumed.add(pidx(c + 1, r)); }
    else if (hh < MERGE_D && canDown) { BUILDINGS.push(faceRect(c, r, 1, 2)); consumed.add(pidx(c, r + 1)); }
    else BUILDINGS.push(faceRect(c, r, 1, 1));
  }
}

// --- Parking garage builder ---
// Replaces a plot's building with a HOLLOW enclosure: solid walls on three sides plus two short
// segments flanking a DOOR gap on the road-facing (south) side. Walls join losRects + the wall
// group in GameScene (so they block sight + movement like any building); the hide LOGIC lives in
// GameScene. Kept flush to the plot (a garage isn't affected by the street profile).
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

// --- Avenues (for lane striping) ---
// Wide roads GameScene stripes with extra lanes so they read as multi-lane arteries. Just the
// geometry; the drawing lives in GameScene._drawRoadMarkings.
export const AVENUES = [
  { orientation: 'v', x: lineCoord(AVENUE_COL), width: AVENUE_W, a: MARGIN, b: WORLD_HEIGHT - MARGIN },
];

// --- Points of Interest (mission destinations) ---
// Placed on the seam avenue (guaranteed open) and the garage for now — a real per-district POI
// table comes with the full district layout. Missions reference a POI by id, so coords can move.
const { xs: NAV_XS, ys: NAV_YS } = navLines();
const seamNode = (row) => ({ x: NAV_XS[SPLIT], y: NAV_YS[row] });
export const POIS = [
  { id: 'drop',      name: 'The Drop',      ...seamNode(ROWS - 3), r: 80 },
  { id: 'safehouse', name: 'The Safehouse', x: plotX(GARAGE_C) + BLOCK / 2, y: plotY(GARAGE_R) + BLOCK / 2, r: 60 },
  { id: 'docks',     name: 'The Docks',     ...seamNode(3),        r: 80 },
];
export const poiById = (id) => POIS.find((p) => p.id === id) || null;
