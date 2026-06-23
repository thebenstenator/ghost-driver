import Phaser from 'phaser';

// Cheap car lighting — additive glow sprites pinned to a vehicle, no Light2D pipeline.
// A single soft radial-gradient texture is tinted + ADD-blended per light, so the count
// is effectively free and everything is tween/alpha controllable. Each light is authored
// in the car's LOCAL frame (fx = forward/+nose, sx = lateral/+right) and transformed to
// world space every frame from the car's `facing`.
//
// Kinds:
//   'head'      — warm/cool headlight beam (front), suppressed by vehicle.lightsOff
//   'tail'      — red tail lamp (rear), dim normally, bright while braking; off if lightsOff
//   'flashRed'  — cop emergency bar, red half  (double-blink, out of phase with blue)
//   'flashBlue' — cop emergency bar, blue half
//
// A disabled cop (vehicle.disabled) goes fully dark.

const GLOW_KEY = 'gd_glow';

// One soft radial glow, generated once per scene-texture-manager.
export function ensureGlowTexture(scene) {
  if (scene.textures.exists(GLOW_KEY)) return;
  const size = 64, r = size / 2;
  const canvas = scene.textures.createCanvas(GLOW_KEY, size, size);
  const ctx = canvas.getContext();
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  canvas.refresh();
}

// Light component templates per car kind. len/wid are on-screen px; circular lights set
// len == wid. `beam` lights rotate with the car (oriented glow); others stay round.
function componentsFor(kind, v) {
  const halfLen = (v.sprite.displayHeight || 60) / 2;
  const halfWid = (v.sprite.displayWidth || 32) / 2;
  if (kind === 'cop') {
    return [
      // Emergency bar — two bloomy blobs at the roof, double-blinking out of phase.
      { type: 'flashRed',  fx: halfLen * 0.05, sx: -6, len: 34, wid: 34, color: 0xff1530 },
      { type: 'flashBlue', fx: halfLen * 0.05, sx:  6, len: 34, wid: 34, color: 0x1f63ff },
      // Cool-white headlights.
      { type: 'head', fx: halfLen * 0.95 + 6, sx: -halfWid * 0.55, len: 44, wid: 20, color: 0xeaf4ff, beam: true },
      { type: 'head', fx: halfLen * 0.95 + 6, sx:  halfWid * 0.55, len: 44, wid: 20, color: 0xeaf4ff, beam: true },
      // Red tail lamps.
      { type: 'tail', fx: -halfLen * 0.9, sx: -halfWid * 0.55, len: 15, wid: 15, color: 0xff2a2a },
      { type: 'tail', fx: -halfLen * 0.9, sx:  halfWid * 0.55, len: 15, wid: 15, color: 0xff2a2a },
    ];
  }
  // player
  return [
    { type: 'head', fx: halfLen * 0.95 + 6, sx: -halfWid * 0.5, len: 48, wid: 22, color: 0xfff3d0, beam: true },
    { type: 'head', fx: halfLen * 0.95 + 6, sx:  halfWid * 0.5, len: 48, wid: 22, color: 0xfff3d0, beam: true },
    { type: 'tail', fx: -halfLen * 0.9, sx: -halfWid * 0.55, len: 16, wid: 16, color: 0xff2010 },
    { type: 'tail', fx: -halfLen * 0.9, sx:  halfWid * 0.55, len: 16, wid: 16, color: 0xff2010 },
  ];
}

export class CarLights {
  // layer: the world display layer (so the UI camera ignores these like every other world sprite).
  constructor(scene, vehicle, kind, layer) {
    ensureGlowTexture(scene);
    this.scene = scene;
    this.v = vehicle;
    this.kind = kind;
    this.lights = componentsFor(kind, vehicle);
    const depth = (vehicle.sprite.depth || 10) + 1;
    for (const L of this.lights) {
      const spr = scene.add.image(vehicle.sprite.x, vehicle.sprite.y, GLOW_KEY)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(L.color)
        .setDisplaySize(L.len, L.wid)
        .setDepth(L.type.startsWith('flash') ? depth + 1 : depth);
      L.spr = spr;
      if (layer) layer.add(spr);
    }
  }

  update() {
    const v = this.v;
    const f = v.facing;
    const cf = Math.cos(f), sf = Math.sin(f);
    const cx = v.sprite.x, cy = v.sprite.y;
    const dead = !!v.disabled;
    const off = !!v.lightsOff;
    const braking = !!(v.controls && (v.controls.brake || v.controls.down));

    // Emergency-bar timing: classic double-blink, red and blue out of phase.
    const t = (this.scene.time.now % 1000) / 1000;
    const redOn  = t < 0.12 || (t > 0.22 && t < 0.34);
    const blueOn = (t > 0.50 && t < 0.62) || (t > 0.72 && t < 0.84);

    for (const L of this.lights) {
      const s = L.spr;
      // World position from the local (fx, sx) frame: forward (cf,sf), right (-sf,cf).
      s.setPosition(cx + cf * L.fx - sf * L.sx, cy + sf * L.fx + cf * L.sx);
      if (L.beam) s.setRotation(f); // orient headlight beam along travel

      let alpha = 0, scale = 1;
      if (dead) {
        alpha = 0;
      } else if (L.type === 'head') {
        alpha = off ? 0 : 0.9;
      } else if (L.type === 'tail') {
        alpha = off ? 0 : (braking ? 1.0 : 0.32);
        scale = braking ? 1.35 : 1.0;
      } else if (L.type === 'flashRed') {
        alpha = redOn ? 1.0 : 0.08; scale = redOn ? 1.15 : 0.9;
      } else if (L.type === 'flashBlue') {
        alpha = blueOn ? 1.0 : 0.08; scale = blueOn ? 1.15 : 0.9;
      }
      s.setAlpha(alpha);
      s.setDisplaySize(L.len * scale, L.wid * scale);
    }
  }

  destroy() {
    for (const L of this.lights) L.spr.destroy();
    this.lights = [];
  }
}
