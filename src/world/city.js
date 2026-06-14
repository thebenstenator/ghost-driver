import {
  GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP,
  WORLD_WIDTH, WORLD_HEIGHT,
} from '../config.js';

// The city's building footprints. Shared by the game (GameScene draws + collides
// these) and the headless chase sim (uses them for line-of-sight + collision) so
// both run on the exact same map.

// Building sizes cycle through slight variations for visual interest
const W_SIZES = [350, 340, 360, 330, 355, 345];
const H_SIZES = [340, 360, 330, 350, 345, 355];

export const BUILDINGS = [];
for (let row = 0; row < GRID_ROWS; row++) {
  for (let col = 0; col < GRID_COLS; col++) {
    const i = row * GRID_COLS + col;
    BUILDINGS.push({
      x: MARGIN + col * GRID_STEP,
      y: MARGIN + row * GRID_STEP,
      w: W_SIZES[i % W_SIZES.length],
      h: H_SIZES[(i * 3 + 1) % H_SIZES.length],
    });
  }
}

// --- Alleys ---
// Narrow two road gaps by expanding the buildings on each side so only
// ALLEY_W px of clearance remains. The rest of the grid stays at 128px roads.
const ALLEY_W = 64;

// N-S alley between col 2 and col 3 (runs full map height)
{
  const cx = MARGIN + 3 * GRID_STEP - ROAD / 2; // road centre x = 1528
  for (let row = 0; row < GRID_ROWS; row++) {
    const l = BUILDINGS[row * GRID_COLS + 2];
    const r = BUILDINGS[row * GRID_COLS + 3];
    l.w = cx - ALLEY_W / 2 - l.x;   // expand col-2 building rightward
    r.x = cx + ALLEY_W / 2;          // shift col-3 building left edge inward
  }
}

// E-W alley between row 3 and row 4 (runs full map width)
{
  const cy = MARGIN + 4 * GRID_STEP - ROAD / 2; // road centre y = 2032
  for (let col = 0; col < GRID_COLS; col++) {
    const t = BUILDINGS[3 * GRID_COLS + col];
    const b = BUILDINGS[4 * GRID_COLS + col];
    t.h = cy - ALLEY_W / 2 - t.y;   // expand row-3 building downward
    b.y = cy + ALLEY_W / 2;          // shift row-4 building top edge inward
  }
}

// --- Seal the perimeter ---
// The nav grid only has nodes on the INTERIOR road lines, so the ~MARGIN-wide
// strip behind the outermost ring of buildings (between them and the world wall)
// is drivable but has NO nav node. A player hiding there makes cops snap their
// target a block inward — through a building — then wedge against the wall. Fix:
// push the outer ring of buildings flush to the world bounds so that dead strip
// isn't drivable. The outermost INTERIOR roads (which do have nodes) become the
// perimeter loop. Runs after the alleys (which only touch interior rows/cols).
for (let row = 0; row < GRID_ROWS; row++) {
  for (let col = 0; col < GRID_COLS; col++) {
    const b = BUILDINGS[row * GRID_COLS + col];
    if (col === 0)              { b.w += b.x; b.x = 0; }              // extend to left wall
    if (col === GRID_COLS - 1)  { b.w = WORLD_WIDTH - b.x; }         // extend to right wall
    if (row === 0)              { b.h += b.y; b.y = 0; }              // extend to top wall
    if (row === GRID_ROWS - 1)  { b.h = WORLD_HEIGHT - b.y; }        // extend to bottom wall
  }
}
