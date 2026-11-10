// Bakes the procedural building art (buildingArt.js) into per-chunk textures.
//
// WHY BAKE: the art is 200–1800 primitives per block. A Phaser Graphics replays every command
// every frame, which is what forced the old rooftop detail to be stripped for iGPU performance.
// Drawn ONCE into a RenderTexture, a chunk costs one textured quad per frame however detailed it is.
//
// Nothing is saved to disk: chunks are baked lazily from the generator as the camera approaches
// and the farthest ones are freed, so tuning the art is still "edit buildingArt.js → reload".
//
// Per chunk, three textures:
//   body  (full res)  sidewalks → ONE flattened shadow layer → roofs / facades / props
//   glow  (1/2 res, ADD)  lit windows, signs, beacons — the upscale softens them like bloom
//   spill (1/8 res, ADD)  light thrown on the street — the upscale IS the blur
import Phaser from 'phaser';
import { districtIdAt } from './city.js';
import { MAT } from './cityColors.js';
import { buildingArt, garageArt } from './buildingArt.js';

const CH = 1024;        // chunk edge (world px = body texels)
const OVERFLOW = 140;   // how far a block's art can reach past its footprint (shadows, light spill)
const PREBAKE = 360;    // bake this far beyond the view, a chunk per frame, so driving never hitches
const MAX_BAKED = 26;   // texture budget (~5 MB per chunk)
const GLOW_S = 0.5, SPILL_S = 0.125, SHADOW_A = 0.55;

const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const hex = (c) => (cl(c[0]) << 16) | (cl(c[1]) << 8) | cl(c[2]);

function replay(g, prims) {
  for (const p of prims) {
    g.fillStyle(hex(p.c), p.a);
    if (p.t === 'r') g.fillRect(p.x, p.y, p.w, p.h);
    else if (p.t === 'c') g.fillCircle(p.x, p.y, p.r);
    else g.fillPoints(p.pts.map((q) => ({ x: q[0], y: q[1] })), true);
  }
}

function sidewalk(g, b) {
  const walk = (MAT[districtIdAt(b.x + b.w / 2, b.y + b.h / 2)] || MAT.backstreets).walk;
  g.fillStyle(hex(walk.map((v) => v + 8)), 1).fillRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16);
  g.fillStyle(hex(walk.map((v) => v + 26)), 1).fillRect(b.x - 8, b.y - 8, b.w + 16, 1.5); // lit kerb
  g.fillStyle(hex(walk.map((v) => v + 20)), 1).fillRect(b.x - 8, b.y - 8, 1.5, b.h + 16);
}

export class CityBake {
  constructor(scene, layer, buildings, garages, worldW, worldH) {
    this.scene = scene; this.layer = layer;
    this.cols = Math.ceil(worldW / CH); this.rows = Math.ceil(worldH / CH);
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    // Garages bake alongside the blocks (no sidewalk halo — they stand in an open forecourt).
    for (const b of [...buildings, ...garages.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, garage: g }))]) {
      const c0 = Math.max(0, Math.floor((b.x - OVERFLOW) / CH)), c1 = Math.min(this.cols - 1, Math.floor((b.x + b.w + OVERFLOW) / CH));
      const r0 = Math.max(0, Math.floor((b.y - OVERFLOW) / CH)), r1 = Math.min(this.rows - 1, Math.floor((b.y + b.h + OVERFLOW) / CH));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c].push(b);
    }
    this.baked = new Map();
    this.show = [true, true]; // [buildings, emissive]
    this.tick = 0;
    // Scratch objects (never on a display list).
    this.g = scene.make.graphics({}, false);
    this.tmp = scene.make.renderTexture({ x: 0, y: 0, width: CH, height: CH }, false).setOrigin(0, 0);
    scene.events.once('shutdown', () => { this.g.destroy(); this.tmp.destroy(); });
  }

  setShow(i, on) {
    this.show[i] = on;
    for (const ch of this.baked.values()) this._applyVis(ch);
  }

  _applyVis(ch) {
    if (!ch.body) return;
    ch.body.setVisible(ch.vis && this.show[0]);
    ch.glow.setVisible(ch.vis && this.show[1]);
    ch.spill.setVisible(ch.vis && this.show[1]);
  }

  // Call every frame with the camera's worldView.
  update(view) {
    this.tick++;
    const c0 = Math.max(0, Math.floor((view.x - PREBAKE) / CH)), c1 = Math.min(this.cols - 1, Math.floor((view.right + PREBAKE) / CH));
    const r0 = Math.max(0, Math.floor((view.y - PREBAKE) / CH)), r1 = Math.min(this.rows - 1, Math.floor((view.bottom + PREBAKE) / CH));
    let budget = 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * this.cols + c;
        let ch = this.baked.get(key);
        if (!ch) {
          const x = c * CH, y = r * CH;
          const onScreen = x < view.right + 48 && x + CH > view.x - 48 && y < view.bottom + 48 && y + CH > view.y - 48;
          if (!onScreen && budget <= 0) continue; // on-screen chunks always bake now; the ring is paced
          if (!onScreen) budget--;
          ch = this._bake(c, r, key);
        }
        ch.seen = this.tick;
      }
    }
    for (const ch of this.baked.values()) {
      const vis = ch.seen === this.tick;
      if (ch.vis !== vis) { ch.vis = vis; this._applyVis(ch); }
    }
    if (this.baked.size > MAX_BAKED) {
      const old = [...this.baked.values()].filter((ch) => ch.seen !== this.tick).sort((a, b) => a.seen - b.seen);
      for (const ch of old) {
        if (this.baked.size <= MAX_BAKED) break;
        if (ch.body) { ch.body.destroy(); ch.glow.destroy(); ch.spill.destroy(); }
        this.baked.delete(ch.key);
      }
    }
  }

  _bake(c, r, key) {
    const ch = { key, seen: this.tick, vis: undefined };
    this.baked.set(key, ch);
    const list = this.buckets[key];
    if (!list.length) return ch;
    const { scene, g, tmp } = this, x = c * CH, y = r * CH;
    const arts = list.map((b) => (b.garage ? garageArt(b.garage) : buildingArt(b)));
    const mk = (s, depth, add) => {
      const rt = scene.add.renderTexture(x, y, Math.ceil(CH * s), Math.ceil(CH * s)).setOrigin(0, 0).setScale(1 / s).setDepth(depth);
      if (add) rt.setBlendMode(Phaser.BlendModes.ADD);
      this.layer.add(rt);
      return rt;
    };
    const pass = (rt, s, fill) => { g.clear(); fill(); g.setScale(s); rt.draw(g, -x * s, -y * s); g.setScale(1); };

    ch.body = mk(1, 2, false);
    pass(ch.body, 1, () => { for (const b of list) if (!b.garage) sidewalk(g, b); });
    // Shadows: drawn opaque into a scratch texture, then composited at ONE alpha, so the many
    // overlapping shadow shapes never double-darken.
    tmp.clear();
    pass(tmp, 1, () => { for (const a of arts) replay(g, a.shadow); });
    tmp.setAlpha(SHADOW_A);
    ch.body.draw(tmp, 0, 0);
    pass(ch.body, 1, () => { for (const a of arts) replay(g, a.body); });

    ch.spill = mk(SPILL_S, 4.8, true);
    pass(ch.spill, SPILL_S, () => { for (const a of arts) replay(g, a.spill); });
    ch.glow = mk(GLOW_S, 5, true);
    pass(ch.glow, GLOW_S, () => { for (const a of arts) replay(g, a.glow); });
    return ch;
  }
}
