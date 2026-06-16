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

// --- Perimeter ---
// The outer ring of buildings sits MARGIN px in from the world walls, leaving a
// drivable lane all the way around the edge (you can loop the map). The nav grid
// includes a matching ring of perimeter nodes on that lane (see NavGrid), so cops
// can chase/search along the edge instead of targeting a node through the outer
// buildings and wedging against the wall — which is why this used to be sealed.
// (Nothing to do here now; documented so the seal isn't re-added by reflex.)
