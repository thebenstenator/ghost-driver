// Cosmetic-only "flat-shaded noir" rendering for the procedural city grid defined in city.js.
// Draws the SAME building/road geometry GameScene already uses for collision/LOS — this only
// decides what color pixels land where a building sits, so it's safe to iterate on without
// touching physics, collision, or the NavGrid.
import { GRID_STEP, MARGIN, ROAD, WORLD_WIDTH, WORLD_HEIGHT } from "../config.js";

export const GROUND_COLOR = 0x181818;

const PALETTE = {
  sidewalk: 0x242424,
  curb: 0x404040,
  laneMark: 0xcccccc,
  median: 0x161616,
  building: 0x262626,
  roofHi: 0x5a5a5a,
  shadow: 0x000000,
};

// Same wide-arterial line index as city.js's WIDE_COL/WIDE_ROW — kept in sync manually since
// they only matter here for cosmetic lane striping.
const WIDE_COL = 6, WIDE_ROW = 8;

// One building: a sidewalk halo (always perfectly aligned since it's generated FROM the
// footprint, not a separate curb tile), a drop shadow (upper-left light source), and the
// flat-shaded roof — this is a top-down orthographic view, so the roof is ALL you'd ever see
// of a building; no windows/facade detail belongs here.
export function drawBuilding(scene, worldLayer, b) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const pad = 8;

  worldLayer.add(
    scene.add
      .rectangle(cx, cy, b.w + pad * 2, b.h + pad * 2, PALETTE.sidewalk)
      .setStrokeStyle(2, PALETTE.curb, 0.8)
      .setDepth(1.4),
  );
  worldLayer.add(
    scene.add.rectangle(cx + 5, cy + 5, b.w, b.h, PALETTE.shadow, 0.3).setDepth(1.8),
  );
  worldLayer.add(
    scene.add
      .rectangle(cx, cy, b.w, b.h, PALETTE.building)
      .setStrokeStyle(1, PALETTE.roofHi, 0.8)
      .setDepth(2),
  );
}

// Extra lane striping across the two wide arterials (the boulevard gap city.js already
// generates is ~3x a normal road's width — this just paints enough lanes to make that width
// legible: a solid median + two dashed lane dividers on each side).
export function drawArterialLanes(scene, worldLayer) {
  const g = scene.add.graphics().setDepth(1.05);
  const dash = 26, gap = 22, lineW = 3;

  const vX = MARGIN + WIDE_COL * GRID_STEP - ROAD / 2;
  const hY = MARGIN + WIDE_ROW * GRID_STEP - ROAD / 2;

  g.fillStyle(PALETTE.laneMark, 0.85);
  for (const off of [-110, -40, 40, 110]) {
    for (let y = MARGIN; y < WORLD_HEIGHT - MARGIN; y += dash + gap) {
      g.fillRect(vX + off - lineW / 2, y, lineW, Math.min(dash, WORLD_HEIGHT - MARGIN - y));
    }
    for (let x = MARGIN; x < WORLD_WIDTH - MARGIN; x += dash + gap) {
      g.fillRect(x, hY + off - lineW / 2, Math.min(dash, WORLD_WIDTH - MARGIN - x), lineW);
    }
  }

  g.fillStyle(PALETTE.median, 0.9);
  g.fillRect(vX - 10, MARGIN, 20, WORLD_HEIGHT - MARGIN * 2);
  g.fillRect(MARGIN, hY - 10, WORLD_WIDTH - MARGIN * 2, 20);

  worldLayer.add(g);
}
