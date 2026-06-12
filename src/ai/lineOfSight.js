import Phaser from 'phaser';

// True if the straight line between two points is not blocked by any building.
// `rects` is an array of Phaser.Geom.Rectangle (the building footprints).
// A reusable line is mutated each call to avoid per-frame allocation.
const _line = new Phaser.Geom.Line();

export function segmentClear(x1, y1, x2, y2, rects) {
  _line.setTo(x1, y1, x2, y2);
  for (const r of rects) {
    if (Phaser.Geom.Intersects.LineToRectangle(_line, r)) return false;
  }
  return true;
}
