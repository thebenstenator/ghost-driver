import { GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP, WORLD_WIDTH, WORLD_HEIGHT, navLines } from '../config.js';

// The city's building footprints, generated DISTRICT BY DISTRICT on one shared fine lattice
// (see config.js + specs/districts.md). Shared by the game (GameScene draws + collides these) and
// the headless sim, so both run the EXACT same map — which is why generation is DETERMINISTIC (a
// per-plot hash, never Math.random): a random map would desync the sim from the game.
//
// ── HOW DISTRICTS DIFFER ──────────────────────────────────────────────────────────────────
// Districts are RECTANGULAR REGIONS on the plot grid (a `DISTRICTS` table with col+row ranges —
// a 2-D layout, so districts are big and roughly square rather than full-height strips). Every
// building is a rectangle laid out FLUSH to the grid (facades stay aligned). Identity comes from:
//   1. BLOCK PATTERN — each district's generator merges plots its own way. A merge that spans the
//      road between two plots CAPS that street (the block swallows it → dead-end/T-junction); the
//      edge-aware NavGrid prunes it. Superblocks also prune the nodes they cover; skipped plots
//      are drivable open yards.
//   2. STREET WIDTH — each district has a default width; some lines are boulevards or alleys. A
//      road changes width by moving the FACES of the buildings on BOTH sides equally; the
//      centreline (and the NavGrid line) never moves, so connectivity is untouched and facades
//      stay flush. streetWidthV/H are the source of truth (GameScene uses them for lane markings
//      and to blank intersections by the crossing road's width).

const COLS = GRID_COLS, ROWS = GRID_ROWS;

function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

const plotX = (c) => MARGIN + c * GRID_STEP;
const plotY = (r) => MARGIN + r * GRID_STEP;
const pidx  = (c, r) => r * COLS + c;
const lineCoord = (k) => MARGIN + k * GRID_STEP - ROAD / 2; // centre of road-line k (a NavGrid line)

// ── Street widths ───────────────────────────────────────────────────────────────────────────
const AVENUE_W    = Math.round(ROAD * 3.2); // grand boulevard (widest)
const ALLEY_W     = 60;   // alleys / service lanes (narrowest)
const FIN_STREET  = 168;  // Financial: 3 lanes (one each way + centre turn)
const BACK_STREET = ROAD; // Backstreets: tight
const NEON_STREET = 132;  // Neon Mile: medium
const IND_STREET  = 200;  // Industrial: very wide service roads
const DOCK_STREET = 150;  // Docks: loading lanes

// ── District table (2-D regions) ──────────────────────────────────────────────────────────────
// A 3×2 arrangement with Financial spanning the whole centre column, so the world-centre player
// spawn lands in it. Regions tile the grid exactly (no gaps/overlaps). Generators are function
// declarations (hoisted), referenced here before definition.
const HB = ROWS >> 1; // horizontal band split (row)
const CB1 = Math.round(COLS / 3), CB2 = COLS - CB1; // vertical band splits (cols)
const DISTRICTS = [
  { id: 'industrial',  c0: 0,   c1: CB1,  r0: 0,  r1: HB,   street: IND_STREET,  gen: genIndustrial,  alleyP: 0    },
  { id: 'neon',        c0: 0,   c1: CB1,  r0: HB, r1: ROWS, street: NEON_STREET, gen: genNeon,        alleyP: 0.20 },
  { id: 'financial',   c0: CB1, c1: CB2,  r0: 0,  r1: ROWS, street: FIN_STREET,  gen: genFinancial,   alleyP: 0    },
  { id: 'docks',       c0: CB2, c1: COLS, r0: 0,  r1: HB,   street: DOCK_STREET, gen: genDocks,       alleyP: 0.10 },
  { id: 'backstreets', c0: CB2, c1: COLS, r0: HB, r1: ROWS, street: BACK_STREET, gen: genBackstreets, alleyP: 0.45 },
];
const financial = DISTRICTS.find((d) => d.id === 'financial');
function districtAtPlot(c, r) {
  for (const d of DISTRICTS) if (c >= d.c0 && c < d.c1 && r >= d.r0 && r < d.r1) return d;
  return DISTRICTS[0];
}

// Per-district alleys (scattered through interior lines) + Financial's boulevard/service alley.
for (const d of DISTRICTS) {
  d.vAlleys = new Set(); d.hAlleys = new Set(); d.avenue = -1; d.avenueW = AVENUE_W;
  if (!d.alleyP) continue;
  for (let k = d.c0 + 1; k < d.c1; k++) if (hash(k * 5 + 1) < d.alleyP) d.vAlleys.add(k);
  for (let j = d.r0 + 1; j < d.r1; j++) if (hash(j * 13 + 7) < d.alleyP) d.hAlleys.add(j);
}
financial.avenue = CB1 + (((CB2 - CB1) >> 1) | 1); // an odd-ish central Financial line = a through-road
financial.vAlleys.add(financial.avenue + 4);       // one narrow Financial service lane

// One garage per district (a hide spot + a mission safehouse). Each replaces a plot with a hollow
// enclosure; in the big-block districts the generator skips the whole containing superblock, so the
// garage sits in a small open forecourt (a natural approach).
const GARAGE_PLOTS = [
  { id: 'safe_industrial',  name: 'Ironworks Garage',   c: 6,  r: 6  },
  { id: 'safe_neon',        name: 'Neon Mile Garage',   c: 5,  r: 28 },
  { id: 'safe_financial',   name: 'Exchange Garage',    c: 21, r: 10 },
  { id: 'safe_docks',       name: 'Dockside Garage',    c: 42, r: 6  },
  { id: 'safe_backstreets', name: 'Backstreet Garage',  c: 44, r: 25 },
];
const isGaragePlot  = (c, r) => GARAGE_PLOTS.some((g) => g.c === c && g.r === r);
const spanHasGarage = (c, r, cs, rs) => GARAGE_PLOTS.some((g) => g.c >= c && g.c < c + cs && g.r >= r && g.r < r + rs);
const G_WALL = 16, G_DOOR = 96;
const consumed = new Set();

// Width of vertical road line k at plot-row r (the district on each side decides; a seam takes
// the wider side). Exported so GameScene can size lane markings + blank intersections.
export function streetWidthV(k, r) {
  if (k <= 0 || k >= COLS) return ROAD; // margin lanes
  const rr = Math.min(ROWS - 1, Math.max(0, r));
  const dl = districtAtPlot(k - 1, rr), dr = districtAtPlot(k, rr);
  if (dl === dr) return dl.avenue === k ? dl.avenueW : dl.vAlleys.has(k) ? ALLEY_W : dl.street;
  return Math.max(dl.street, dr.street); // seam
}
export function streetWidthH(j, c) {
  if (j <= 0 || j >= ROWS) return ROAD;
  const cc = Math.min(COLS - 1, Math.max(0, c));
  const dt = districtAtPlot(cc, j - 1), db = districtAtPlot(cc, j);
  if (dt === db) return dt.hAlleys.has(j) ? ALLEY_W : dt.street;
  return Math.max(dt.street, db.street);
}

// A building spanning cspan×rspan plots, each FACE placed against its road line at that street's
// width. Vertical faces use the building's top row `r`, horizontal faces its left column `c`.
function faceRect(c, r, cspan = 1, rspan = 1) {
  const kL = c, kR = c + cspan, kT = r, kB = r + rspan;
  const x1 = kL === 0    ? MARGIN                : lineCoord(kL) + streetWidthV(kL, r) / 2;
  const x2 = kR === COLS ? WORLD_WIDTH - MARGIN  : lineCoord(kR) - streetWidthV(kR, r) / 2;
  const y1 = kT === 0    ? MARGIN                : lineCoord(kT) + streetWidthH(kT, c) / 2;
  const y2 = kB === ROWS ? WORLD_HEIGHT - MARGIN : lineCoord(kB) - streetWidthH(kB, c) / 2;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const BUILDINGS = [];
export const GARAGES = [];
for (const d of DISTRICTS) d.gen(d);
for (const gp of GARAGE_PLOTS) buildGarage(gp.c, gp.r); // after generation (which left the plots clear)

// ── District generators (each stays within its region [c0,c1) × [r0,r1)) ───────────────────
function genFinancial(d) {
  for (let r = d.r0; r < d.r1; r += 2)
    for (let c = d.c0; c < d.c1; c += 2) {
      const cs = Math.min(2, d.c1 - c), rs = Math.min(2, d.r1 - r);
      if (spanHasGarage(c, r, cs, rs)) continue; // leave a forecourt for the garage
      BUILDINGS.push(faceRect(c, r, cs, rs));
    }
}
function genNeon(d) {
  for (let r = d.r0; r < d.r1; r++)
    for (let c = d.c0; c < d.c1; c++) {
      const i = pidx(c, r);
      if (consumed.has(i) || isGaragePlot(c, r)) continue;
      if (hash(i * 3 + 2) < 0.25 && c + 1 < d.c1 && !consumed.has(pidx(c + 1, r)) && !isGaragePlot(c + 1, r)) {
        BUILDINGS.push(faceRect(c, r, 2, 1)); consumed.add(pidx(c + 1, r));
      } else BUILDINGS.push(faceRect(c, r, 1, 1));
    }
}
function genBackstreets(d) {
  for (let r = d.r0; r < d.r1; r++)
    for (let c = d.c0; c < d.c1; c++) {
      const i = pidx(c, r);
      if (consumed.has(i) || isGaragePlot(c, r)) continue;
      const hh = hash(i * 3 + 1);
      const canRight = c + 1 < d.c1 && !consumed.has(pidx(c + 1, r)) && !isGaragePlot(c + 1, r);
      const canDown  = r + 1 < d.r1 && !consumed.has(pidx(c, r + 1)) && !isGaragePlot(c, r + 1);
      if (hh < 0.16 && canRight) { BUILDINGS.push(faceRect(c, r, 2, 1)); consumed.add(pidx(c + 1, r)); }
      else if (hh < 0.32 && canDown) { BUILDINGS.push(faceRect(c, r, 1, 2)); consumed.add(pidx(c, r + 1)); }
      else BUILDINGS.push(faceRect(c, r, 1, 1));
    }
}
function genIndustrial(d) {
  for (let r = d.r0; r < d.r1; r += 3)
    for (let c = d.c0; c < d.c1; c += 3) {
      const cs = Math.min(3, d.c1 - c), rs = Math.min(3, d.r1 - r);
      if (spanHasGarage(c, r, cs, rs)) continue;
      if (hash(pidx(c, r) * 5 + 3) < 0.15) continue; // open factory yard
      BUILDINGS.push(faceRect(c, r, cs, rs));
    }
}
function genDocks(d) {
  for (let r = d.r0; r < d.r1; r += 3)
    for (let c = d.c0; c < d.c1; c += 2) {
      const cs = Math.min(2, d.c1 - c), rs = Math.min(3, d.r1 - r);
      if (spanHasGarage(c, r, cs, rs)) continue;
      if (hash(pidx(c, r) * 7 + 4) < 0.35) continue; // open loading yard
      BUILDINGS.push(faceRect(c, r, cs, rs));
    }
}

// --- Parking garage builder --- (see previous notes: hollow enclosure, door faces south).
function buildGarage(c, r) {
  const x = plotX(c), y = plotY(r), w = BLOCK, h = BLOCK;
  const doorX = x + (w - G_DOOR) / 2;
  const walls = [
    { x, y, w, h: G_WALL },
    { x, y, w: G_WALL, h },
    { x: x + w - G_WALL, y, w: G_WALL, h },
    { x, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL },
    { x: doorX + G_DOOR, y: y + h - G_WALL, w: (w - G_DOOR) / 2, h: G_WALL },
  ];
  GARAGES.push({
    x, y, w, h, walls,
    interior: { x: x + G_WALL, y: y + G_WALL, w: w - 2 * G_WALL, h: h - 2 * G_WALL },
    door: { x: doorX, y: y + h - G_WALL, w: G_DOOR, h: G_WALL },
  });
}

// --- Safehouses (one per district) ---
// Each garage doubles as a safehouse POI (centre of its plot). GameScene renders the garages;
// missions can target any of these. (GameScene may snap OPEN objectives to a road node, but a
// safehouse is entered through its garage door, so its POI stays at the interior centre.)
export const SAFEHOUSES = GARAGE_PLOTS.map((g) => ({
  id: g.id, name: g.name, x: plotX(g.c) + BLOCK / 2, y: plotY(g.r) + BLOCK / 2, r: 60,
}));

// --- Points of Interest (mission destinations) ---
// The Drop sits far out in the Docks (NE); the spawn is central (Financial), and Mission 1's
// safehouse is in the Neon Mile (SW) — so the two legs cross most of the city. GameScene snaps the
// Drop to the nearest road node so it's always reachable.
const { xs: NAV_XS, ys: NAV_YS } = navLines();
const node = (line, row) => ({ x: NAV_XS[line], y: NAV_YS[row] });
export const POIS = [
  { id: 'drop', name: 'The Drop', ...node(CB2 + 12, 4), r: 80 },
  ...SAFEHOUSES,
];
export const poiById = (id) => POIS.find((p) => p.id === id) || null;
