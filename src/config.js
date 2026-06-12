export const GAME_WIDTH  = 1280;
export const GAME_HEIGHT = 720;

// --- City grid layout ---
// BLOCK×BLOCK buildings separated by ROAD-wide streets, with a MARGIN border.
export const GRID_COLS = 12;
export const GRID_ROWS = 12;
export const BLOCK     = 376;
export const ROAD      = 128;
export const MARGIN    = 80;
export const GRID_STEP = BLOCK + ROAD; // 504

export const WORLD_WIDTH  = MARGIN * 2 + GRID_COLS * BLOCK + (GRID_COLS - 1) * ROAD; // 3056
export const WORLD_HEIGHT = MARGIN * 2 + GRID_ROWS * BLOCK + (GRID_ROWS - 1) * ROAD;
