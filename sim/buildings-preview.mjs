// Building-art PREVIEW: renders crops of the REAL generated city with the procedural building
// art from src/world/buildingArt.js, next to the current in-game look, so the art can be judged
// as an image before any game code changes.
// Run: node sim/buildings-preview.mjs  → sim/buildings-preview/<crop>-{before,after}.svg
import { writeFileSync, mkdirSync } from 'node:fs';
import { BUILDINGS, GARAGES, districtIdAt } from '../src/world/city.js';
import { hash, MAT } from '../src/world/cityColors.js';
import { buildingArt, garageArt } from '../src/world/buildingArt.js';

const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
const rgb = (c) => `rgb(${cl(c[0])},${cl(c[1])},${cl(c[2])})`;
const f = (n) => n.toFixed(1);
const prim = (p) => {
  const fill = `fill="${rgb(p.c)}"${p.a < 1 ? ` fill-opacity="${p.a}"` : ''}`;
  if (p.t === 'r') return `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${f(p.h)}" ${fill}/>`;
  if (p.t === 'c') return `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}" ${fill}/>`;
  return `<polygon points="${p.pts.map((q) => `${f(q[0])},${f(q[1])}`).join(' ')}" ${fill}/>`;
};
const matOf = (b) => MAT[districtIdAt(b.x + b.w / 2, b.y + b.h / 2)] || MAT.backstreets;

// world-space crops; `px` = output width in pixels
const CROPS = {
  'sea':            { x: 15000, y: 0,    w: 2800, h: 1575, px: 1600 },
  'sea-1to1':       { x: 15900, y: 500,  w: 1280, h: 720,  px: 1280 },
  'safehouse-1to1': { x: 1100, y: 8556, w: 1280, h: 720, px: 1280 },
  'financial':      { x: 6000,  y: 0,    w: 5800, h: 3262, px: 1600 },
};

mkdirSync(new URL('./buildings-preview/', import.meta.url), { recursive: true });
for (const [name, c] of Object.entries(CROPS)) {
  const hit = BUILDINGS.filter((b) => b.x < c.x + c.w + 120 && b.x + b.w > c.x - 120 && b.y < c.y + c.h + 120 && b.y + b.h > c.y - 120);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" width="${c.px}" height="${Math.round(c.px * c.h / c.w)}">`;
  const ground = `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="rgb(20,20,22)"/>`;

  // BEFORE — what cityRender.drawBuildings draws today.
  const before = [];
  for (const b of hit) {
    const mat = matOf(b), j = (hash(b.x * 13 + b.y * 7) - 0.5) * 16, s = (d) => mat.roof.map((v) => v + j + d);
    before.push(prim({ t: 'r', x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16, c: mat.walk, a: 1 }));
    before.push(prim({ t: 'r', x: b.x, y: b.y, w: b.w, h: b.h, c: s(0), a: 1 }));
    before.push(prim({ t: 'r', x: b.x, y: b.y, w: b.w, h: 3, c: s(20), a: 0.85 }));
    before.push(prim({ t: 'r', x: b.x, y: b.y, w: 3, h: b.h, c: s(12), a: 0.7 }));
  }
  writeFileSync(new URL(`./buildings-preview/${name}-before.svg`, import.meta.url), `${head}${ground}${before.join('')}</svg>`);

  // AFTER — sidewalks, one flattened shadow layer, bodies, emissive layer.
  const walk = [], shadow = [], body = [], glow = [], spill = [];
  let n = 0;
  for (const b of hit) {
    const mat = matOf(b);
    walk.push(prim({ t: 'r', x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16, c: mat.walk.map((v) => v + 8), a: 1 }));
    walk.push(prim({ t: 'r', x: b.x - 8, y: b.y - 8, w: b.w + 16, h: 1.5, c: mat.walk.map((v) => v + 26), a: 1 }));
    walk.push(prim({ t: 'r', x: b.x - 8, y: b.y - 8, w: 1.5, h: b.h + 16, c: mat.walk.map((v) => v + 20), a: 1 }));
    const art = buildingArt(b);
    n += art.shadow.length + art.body.length + art.glow.length + art.spill.length;
    spill.push(...art.spill.map(prim));
    shadow.push(...art.shadow.map(prim)); body.push(...art.body.map(prim)); glow.push(...art.glow.map(prim));
  }
  for (const gar of GARAGES) {
    if (gar.x > c.x + c.w || gar.x + gar.w < c.x || gar.y > c.y + c.h || gar.y + gar.h < c.y) continue;
    const art = garageArt(gar);
    shadow.push(...art.shadow.map(prim)); body.push(...art.body.map(prim)); glow.push(...art.glow.map(prim)); spill.push(...art.spill.map(prim));
  }
  const after = `${head}
<defs><filter id="bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5"/></filter>
<filter id="spill" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter></defs>
${ground}${walk.join('')}
<g opacity="0.55">${shadow.join('')}</g>
${body.join('')}
<g filter="url(#spill)" style="mix-blend-mode:screen">${spill.join('')}</g>
<g filter="url(#bloom)" style="mix-blend-mode:screen">${glow.join('')}</g>
</svg>`;
  writeFileSync(new URL(`./buildings-preview/${name}-after.svg`, import.meta.url), after);
  console.log(`${name}: ${hit.length} blocks, ${n} primitives (${Math.round(n / hit.length)}/block)`);
}
