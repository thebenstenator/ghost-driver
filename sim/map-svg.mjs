// Headless snapshot of the generated city + derived nav graph → sim/map.svg. Lets us SEE the
// district layout (and that cops can path it) without deploying. Run: node sim/map-svg.mjs
import { writeFileSync } from 'node:fs';
import { BUILDINGS, GARAGES, POIS } from '../src/world/city.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from '../src/config.js';

const nav = new NavGrid();
const esc = (n) => Math.round(n * 10) / 10;
const parts = [];

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}" width="1200">`);
parts.push(`<rect width="${WORLD_WIDTH}" height="${WORLD_HEIGHT}" fill="#141416"/>`); // road/ground

// Buildings — one noir tone (districts are told apart by block SIZE/PATTERN, not colour).
for (const b of BUILDINGS)
  parts.push(`<rect x="${esc(b.x)}" y="${esc(b.y)}" width="${esc(b.w)}" height="${esc(b.h)}" fill="#2a2a31" stroke="#45454f" stroke-width="2"/>`);

// Nav graph — thin edges + node dots (proof the streets are drivable + connected across the seam).
parts.push('<g stroke="#2f6f7f" stroke-width="1.5" opacity="0.8">');
for (let a = 0; a < nav.cols * nav.rows; a++) {
  const pa = nav.pos(a);
  for (const b of nav.nbr[a]) { if (b < a) continue; const pb = nav.pos(b); parts.push(`<line x1="${esc(pa.x)}" y1="${esc(pa.y)}" x2="${esc(pb.x)}" y2="${esc(pb.y)}"/>`); }
}
parts.push('</g>');
for (let i = 0; i < nav.cols * nav.rows; i++) { if (!nav.valid[i]) continue; const p = nav.pos(i); parts.push(`<circle cx="${esc(p.x)}" cy="${esc(p.y)}" r="3" fill="#39ff14"/>`); }

// Garages (door in yellow), POIs, spawn.
for (const g of GARAGES) {
  for (const w of g.walls) parts.push(`<rect x="${esc(w.x)}" y="${esc(w.y)}" width="${esc(w.w)}" height="${esc(w.h)}" fill="#4a5e74"/>`);
  parts.push(`<rect x="${esc(g.door.x)}" y="${esc(g.door.y)}" width="${esc(g.door.w)}" height="6" fill="#ffd23f"/>`);
}
for (const p of POIS) parts.push(`<circle cx="${esc(p.x)}" cy="${esc(p.y)}" r="16" fill="none" stroke="#ff9f1c" stroke-width="4"/><text x="${esc(p.x + 20)}" y="${esc(p.y)}" fill="#ff9f1c" font-size="34" font-family="monospace">${p.name}</text>`);
const s = nav.pos(nav.nearestNode(WORLD_WIDTH / 2, WORLD_HEIGHT / 2));
parts.push(`<circle cx="${esc(s.x)}" cy="${esc(s.y)}" r="20" fill="#ffffff"/><text x="${esc(s.x + 24)}" y="${esc(s.y)}" fill="#fff" font-size="34" font-family="monospace">spawn</text>`);

parts.push('</svg>');
writeFileSync(new URL('./map.svg', import.meta.url), parts.join('\n'));

// Console summary
const inCols = (b) => Math.round((b.x - 80) / 312);
const fin = BUILDINGS.filter((b) => inCols(b) < 11).length;
const back = BUILDINGS.length - fin;
console.log(`buildings ${BUILDINGS.length}  (financial ${fin}, backstreets ${back})  garages ${GARAGES.length}`);
console.log(`world ${WORLD_WIDTH}×${WORLD_HEIGHT}  nav nodes ${nav.cols * nav.rows} (valid ${nav.valid.reduce((a, v) => a + v, 0)})`);
console.log('wrote sim/map.svg');
