// Rendering constants shared by cityRender.js (live game) and sim/art-preview.mjs (headless preview).
// No Phaser dependency — safe to import in Node.js.
export const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export const MAT = {
  financial:   { roof: [47, 46, 51], walk: [38, 38, 43] }, // warm marble-grey
  neon:        { roof: [42, 38, 48], walk: [34, 31, 39] }, // faint violet-dark
  industrial:  { roof: [48, 42, 36], walk: [38, 33, 25] }, // rust/brown-dark
  docks:       { roof: [36, 43, 49], walk: [28, 35, 40] }, // cold blue-grey
  backstreets: { roof: [42, 42, 44], walk: [32, 32, 34] }, // neutral
};
// Stored as [r,g,b] arrays. cityRender.js converts to Phaser hex via arrHex(); art-preview.mjs uses rgb() directly.
export const NEON = [[44, 232, 208], [255, 59, 200], [255, 176, 32], [255, 80, 80], [73, 184, 255], [143, 107, 255]];
export const NEON_DENSITY = { neon: 0.62, backstreets: 0.30, docks: 0.18, industrial: 0.12, financial: 0.22 };
