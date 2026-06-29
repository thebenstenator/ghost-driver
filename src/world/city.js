import {
  GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP,
  WORLD_WIDTH, WORLD_HEIGHT,
} from '../config.js';

// The city's building footprints. Shared by the game (GameScene draws + collides these)
// and the headless chase sim (line-of-sight + collision), so both run on the EXACT same
// map — which is why generation is DETERMINISTIC (a per-cell hash, never Math.random): a
// random map would desync the sim from the game and make playtests irreproducible.
//
// ── NAV-SAFETY INVARIANT (read before editing) ───────────────────────────────────────
// The cop NavGrid is a uniform lattice whose road centrelines sit ROAD/2 INTO the gaps
// beyond each cell's BLOCK×BLOCK envelope, and it assumes every adjacent node is joined by
// clear road. So every building MUST stay within its cell envelope
//   [cellX, cellX+BLOCK] × [cellY, cellY+BLOCK]
// (vary size + setback offset freely INSIDE it). Then every lattice segment stays clear and
// cops can't be routed through a wall. The ONLY deliberate exception is the alley code,
// which expands buildings a little PAST the envelope to pinch a road — but it keeps the
// centreline clear (≥ ALLEY_W/2 each side). Don't break the invariant elsewhere, or you
// reopen the wall-wedging class of bugs (see CLAUDE.md).
//
// Variation here is all within-lattice: per-building size + setback, open plazas (skipped
// cells), wide boulevards (inset bordering buildings), and extra alleys. Real district
// layouts (dead-ends, T-junctions, superblocks) need an edge-aware NavGrid first.

const COLS = GRID_COLS, ROWS = GRID_ROWS;

// Deterministic per-cell hash → [0,1). Stable across reloads and identical in game + sim.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Open plazas — cells with no building, breaking the grid into the odd square/courtyard.
const PLAZAS = new Set([
  2 * COLS + 8, 5 * COLS + 5, 7 * COLS + 2, 9 * COLS + 9, 4 * COLS + 10, 10 * COLS + 4,
]);

// Wide boulevards — one vertical + one horizontal arterial. Buildings bordering the arterial
// are inset and anchored AWAY from it so the street reads clearly wider than the grid norm.
const WIDE_COL = 6; // road line is between cols WIDE_COL-1 and WIDE_COL
const WIDE_ROW = 8;

// cell[row*COLS+col] = building or null (plaza/open). Kept full-size for index-based alley
// edits; flattened (nulls dropped) into BUILDINGS at the end.
const cell = new Array(ROWS * COLS).fill(null);

for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    if (PLAZAS.has(i)) continue;

    const cellX = MARGIN + col * GRID_STEP;
    const cellY = MARGIN + row * GRID_STEP;

    // Size variation, comfortably within BLOCK (376). Adjacent cells differ, so the drivable
    // gaps — and thus the road widths — vary organically while centrelines stay clear.
    let w = Math.round(248 + hash(i) * 120);          // 248..368
    let h = Math.round(248 + hash(i * 7 + 3) * 120);

    // Boulevards: shrink the dimension facing the arterial so its road is extra wide.
    if (col === WIDE_COL || col === WIDE_COL - 1) w = Math.min(w, 248);
    if (row === WIDE_ROW || row === WIDE_ROW - 1) h = Math.min(h, 248);

    // Setback offset within the [0, BLOCK-size] envelope (varied facades + road widths).
    let ox = Math.round((BLOCK - w) * hash(i * 13 + 5));
    let oy = Math.round((BLOCK - h) * hash(i * 17 + 9));
    // Bias bordering buildings AWAY from the arterial so the slack lands on the boulevard.
    if (col === WIDE_COL)     ox = BLOCK - w; // right cell hugs its right edge
    if (col === WIDE_COL - 1) ox = 0;         // left cell hugs its left edge
    if (row === WIDE_ROW)     oy = BLOCK - h;
    if (row === WIDE_ROW - 1) oy = 0;

    cell[i] = { x: cellX + ox, y: cellY + oy, w, h };
  }
}

// --- Alleys ---
// Pinch a road gap down to ALLEY_W by expanding the buildings on each side into it; the
// centreline stays clear (≥ ALLEY_W/2 each side). Far edges are preserved so the neighbouring
// road isn't disturbed. Plaza (null) cells are skipped.
const ALLEY_W = 64;

function narrowNS(colRoad) { // vertical alley on the road line between cols colRoad-1 and colRoad
  const cx = MARGIN + colRoad * GRID_STEP - ROAD / 2;
  for (let row = 0; row < ROWS; row++) {
    const l = cell[row * COLS + colRoad - 1];
    const r = cell[row * COLS + colRoad];
    if (l) l.w = cx - ALLEY_W / 2 - l.x;        // expand left building rightward to the alley
    if (r) { const right = r.x + r.w; r.x = cx + ALLEY_W / 2; r.w = right - r.x; } // pull left edge in
  }
}

function narrowEW(rowRoad) { // horizontal alley on the road line between rows rowRoad-1 and rowRoad
  const cy = MARGIN + rowRoad * GRID_STEP - ROAD / 2;
  for (let col = 0; col < COLS; col++) {
    const t = cell[(rowRoad - 1) * COLS + col];
    const b = cell[rowRoad * COLS + col];
    if (t) t.h = cy - ALLEY_W / 2 - t.y;        // expand top building downward to the alley
    if (b) { const bottom = b.y + b.h; b.y = cy + ALLEY_W / 2; b.h = bottom - b.y; } // pull top edge in
  }
}

narrowNS(3);  // original N-S alley
narrowEW(4);  // original E-W alley
narrowNS(10); // extra N-S alley
narrowEW(9);  // extra E-W alley

// --- Parking garages ---
// A garage replaces a cell's building with a HOLLOW enclosure: solid walls on three sides
// plus two short segments flanking a DOOR gap on the road-facing side. The walls block sight
// + movement exactly like buildings (GameScene adds them to losRects + the wall group), so
// "cops can't see inside" falls out of the existing LOS system. The hide LOGIC (seen-entering
// rule, converge-and-wait) lives in GameScene; here we only emit geometry. Stays within the
// cell envelope, so the nav lattice is unaffected. (v1: door always faces south / the road
// below the cell. Cells chosen to avoid the boulevard + alley rows/cols.)
const G_WALL = 20;   // wall thickness
const G_DOOR = 104;  // entrance gap width
const GARAGE_CELLS = [
  { row: 2, col: 7 },
  { row: 6, col: 4 },
  { row: 2, col: 2 }, // top-left — doubles as the mission Safehouse (far from the bottom-right Drop)
];
export const GARAGES = [];
for (const { row, col } of GARAGE_CELLS) {
  cell[row * COLS + col] = null; // the garage replaces the normal building here
  const x = MARGIN + col * GRID_STEP, y = MARGIN + row * GRID_STEP, w = BLOCK, h = BLOCK;
  const doorX = x + (w - G_DOOR) / 2;
  const walls = [
    { x, y, w, h: G_WALL },                                              // north (back)
    { x, y, w: G_WALL, h },                                              // west
    { x: x + w - G_WALL, y, w: G_WALL, h },                             // east
    { x, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL },          // south-left of door
    { x: doorX + G_DOOR, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL }, // south-right of door
  ];
  GARAGES.push({
    x, y, w, h, walls,
    interior: { x: x + G_WALL, y: y + G_WALL, w: w - 2 * G_WALL, h: h - 2 * G_WALL },
    door: { x: doorX, y: y + h - G_WALL, w: G_DOOR, h: G_WALL },
  });
}

// --- Points of Interest (mission destinations) ---
// Named, fixed locations a mission can send you to ("reach the Drop"). Placed on ROAD
// INTERSECTIONS so they're always drivable (the gap after cell (col,row) is clear road by
// the nav-safety invariant above). This is the lightweight stand-in for an authored map:
// missions reference a POI by id, and a real Tiled map can later replace these coords
// without touching mission logic. Player spawns at world centre, so these sit a few blocks
// out for a real drive. `roadXY` returns the centre of the intersection past cell (col,row).
const roadXY = (col, row) => ({
  x: MARGIN + col * GRID_STEP + BLOCK + ROAD / 2,
  y: MARGIN + row * GRID_STEP + BLOCK + ROAD / 2,
});
// Centre of cell (col,row) — used to drop a POI INSIDE a garage (an "actual safehouse" you pull into,
// reusing the garage hide structure) rather than on open road.
const cellCenter = (col, row) => ({
  x: MARGIN + col * GRID_STEP + BLOCK / 2,
  y: MARGIN + row * GRID_STEP + BLOCK / 2,
});
export const POIS = [
  // The Drop sits on an OPEN intersection (you secure it in the open). The Safehouse is the
  // top-left GARAGE — you pull in to finish — placed at the opposite corner from the Drop so the
  // two legs span the map. r kept small there so the trigger only fires once you're inside.
  { id: 'drop',      name: 'The Drop',      ...roadXY(9, 9),    r: 80 },
  { id: 'safehouse', name: 'The Safehouse', ...cellCenter(2, 2), r: 64 },
  { id: 'docks',     name: 'The Docks',     ...roadXY(9, 1),    r: 80 },
];
export const poiById = (id) => POIS.find((p) => p.id === id) || null;

// --- Perimeter ---
// The outer ring of buildings sits MARGIN px in from the world walls, leaving a drivable lane
// all the way around the edge (you can loop the map). The NavGrid includes a matching ring of
// perimeter nodes on that lane, so cops chase/search along the edge instead of wedging against
// the wall. (Nothing to do here; documented so the seal isn't re-added by reflex.)

export const BUILDINGS = cell.filter(Boolean);
