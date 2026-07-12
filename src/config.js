export const GAME_WIDTH  = 1280;
export const GAME_HEIGHT = 720;

// --- City fine-grid lattice ---
// The city is generated on ONE uniform fine lattice of BLOCK×BLOCK plots separated by
// ROAD-wide streets, with a MARGIN border. Districts don't change this lattice — they change
// the BLOCK PATTERN on it (merge plots into superblocks, cap streets for dead-ends, vary
// facades), and the edge-aware NavGrid derives drivable connectivity from the result. So a
// "big Financial block" and a "small Backstreets block" both live on the same lattice; the
// difference is how many plots each building spans and which streets are capped.
export const GRID_COLS = 22;   // fine plot columns (spans multiple districts)
export const GRID_ROWS = 16;   // fine plot rows
export const BLOCK     = 200;  // one 1×1 plot footprint
export const ROAD      = 112;  // street width between plots
export const MARGIN    = 80;   // drivable border lane around the world
export const GRID_STEP = BLOCK + ROAD; // 312

export const WORLD_WIDTH  = MARGIN * 2 + GRID_COLS * BLOCK + (GRID_COLS - 1) * ROAD;
export const WORLD_HEIGHT = MARGIN * 2 + GRID_ROWS * BLOCK + (GRID_ROWS - 1) * ROAD;

// The NavGrid lattice lines: interior road centrelines (i = 1..n-1, at MARGIN + i*GRID_STEP -
// ROAD/2) plus a perimeter ring on the drivable margin lane (MARGIN/2 from each wall). Shared
// by NavGrid (connectivity) and city.js (placing street caps exactly on a segment) so the two
// can never drift out of alignment.
export function navLines() {
  const xs = [MARGIN / 2];
  for (let i = 1; i < GRID_COLS; i++) xs.push(MARGIN + i * GRID_STEP - ROAD / 2);
  xs.push(WORLD_WIDTH - MARGIN / 2);

  const ys = [MARGIN / 2];
  for (let j = 1; j < GRID_ROWS; j++) ys.push(MARGIN + j * GRID_STEP - ROAD / 2);
  ys.push(WORLD_HEIGHT - MARGIN / 2);

  return { xs, ys };
}
