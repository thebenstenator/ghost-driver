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
const CONE_KEY = 'gd_cone';
// Headlight cones render just BELOW the building depth (2) so opaque buildings draw over
// them — the beam is a wash on the road, not over rooftops. Above background (0)/markings (1).
const CONE_DEPTH = 1.5;
// Live-tunable multipliers (shared object from the car panel). Defaults = no change.
const DEFAULT_TUNING = { head: 1, headLen: 1, headWid: 1, brake: 1, flash: 1 };

// Generate both reusable light textures once per scene-texture-manager:
//   gd_glow — soft radial blob (tail lamps, cop flashers)
//   gd_cone — a headlight cone: emitter at the LEFT edge, fanning right, bright at the
//             emitter and fading to transparent with distance (the falloff) + soft edges.
export function ensureGlowTexture(scene) {
  if (!scene.textures.exists(GLOW_KEY)) {
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

  if (!scene.textures.exists(CONE_KEY)) {
    const W = 180, H = 130;
    const canvas = scene.textures.createCanvas(CONE_KEY, W, H);
    const ctx = canvas.getContext();
    const ex = 8, ey = H / 2; // emitter point (left-center) — the headlight itself
    // Radial gradient from the emitter gives the distance falloff (dim farther away).
    const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, W - ex);
    g.addColorStop(0.0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    // Blur (where supported) feathers the cone's edges so it's a soft wash, not a wedge.
    if ('filter' in ctx) ctx.filter = 'blur(9px)';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(ex, ey);     // apex at the emitter
    ctx.lineTo(W, 8);       // fan out to the far edge…
    ctx.lineTo(W, H - 8);   // …wide spread
    ctx.closePath();
    ctx.fill();
    if ('filter' in ctx) ctx.filter = 'none';
    canvas.refresh();
  }
}

// Light component templates per car kind. len/wid are on-screen px; circular lights set
// len == wid. `beam` lights use the cone texture (emitter at the local fx,sx point, fanning
// forward), so `len` = cone length and `wid` = cone far-end spread; others stay round.
// `alpha` overrides the per-type default. Headlights are cool, wide and faint (the cone's
// own gradient supplies the falloff); brake lamps are small and bright-on-brake.
function componentsFor(kind, v) {
  const halfLen = (v.sprite.displayHeight || 60) / 2;
  const halfWid = (v.sprite.displayWidth || 32) / 2;
  if (kind === 'cop') {
    return [
      // Emergency bar — two bloomy blobs at the roof, double-blinking out of phase.
      { type: 'flashRed',  fx: halfLen * 0.05, sx: -6, len: 34, wid: 34, color: 0xff1530 },
      { type: 'flashBlue', fx: halfLen * 0.05, sx:  6, len: 34, wid: 34, color: 0x1f63ff },
      // Cool, wide headlight cones with distance falloff (baked: bright 1.75, len 1.5, spread 1.25).
      { type: 'head', fx: halfLen * 0.6, sx: -7, len: 150, wid: 105, color: 0xcfe0ff, alpha: 0.7, beam: true },
      { type: 'head', fx: halfLen * 0.6, sx:  7, len: 150, wid: 105, color: 0xcfe0ff, alpha: 0.7, beam: true },
      // Red tail lamps (−30% size).
      { type: 'tail', fx: -halfLen * 0.9, sx: -halfWid * 0.55, len: 10.5, wid: 10.5, color: 0xff2a2a },
      { type: 'tail', fx: -halfLen * 0.9, sx:  halfWid * 0.55, len: 10.5, wid: 10.5, color: 0xff2a2a },
    ];
  }
  // player (baked: bright 1.75, len 1.5, spread 1.25)
  return [
    { type: 'head', fx: halfLen * 0.6, sx: -7, len: 172, wid: 119, color: 0xcfe0ff, alpha: 0.74, beam: true },
    { type: 'head', fx: halfLen * 0.6, sx:  7, len: 172, wid: 119, color: 0xcfe0ff, alpha: 0.74, beam: true },
    { type: 'tail', fx: -halfLen * 0.9, sx: -halfWid * 0.55, len: 11.2, wid: 11.2, color: 0xff2010 },
    { type: 'tail', fx: -halfLen * 0.9, sx:  halfWid * 0.55, len: 11.2, wid: 11.2, color: 0xff2010 },
  ];
}

export class CarLights {
  // layer: the world display layer (so the UI camera ignores these like every other world sprite).
  // tuning: shared multiplier object from the car panel (brightness/size), live-read each frame.
  constructor(scene, vehicle, kind, layer, tuning = null) {
    ensureGlowTexture(scene);
    this.scene = scene;
    this.v = vehicle;
    this.kind = kind;
    this.tuning = tuning || DEFAULT_TUNING;
    this.lights = componentsFor(kind, vehicle);
    const depth = (vehicle.sprite.depth || 10) + 1;
    for (const L of this.lights) {
      const spr = scene.add.image(vehicle.sprite.x, vehicle.sprite.y, L.beam ? CONE_KEY : GLOW_KEY)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(L.color)
        .setDisplaySize(L.len, L.wid)
        // Cones under the buildings (road wash); lamps/flashers above the car.
        .setDepth(L.beam ? CONE_DEPTH : (L.type.startsWith('flash') ? depth + 1 : depth));
      // Cone texture's emitter is its left-center → anchor there so it fans forward from (fx,sx).
      if (L.beam) spr.setOrigin(0, 0.5);
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
    // Kill-lights is a hard on/off: head/tail lamps are fully on, or fully dark while v.lightsOff.
    // (GameScene snaps lightsOff back to false at speed, so there's no fade to do here.)
    const lit = v.lightsOff ? 0 : 1;
    const braking = !!(v.controls && (v.controls.brake || v.controls.down));

    // Emergency-bar timing: classic double-blink, red and blue out of phase.
    const t = (this.scene.time.now % 1000) / 1000;
    const redOn  = t < 0.12 || (t > 0.22 && t < 0.34);
    const blueOn = (t > 0.50 && t < 0.62) || (t > 0.72 && t < 0.84);

    const T = this.tuning;
    for (const L of this.lights) {
      const s = L.spr;
      // World position from the local (fx, sx) frame: forward (cf,sf), right (-sf,cf).
      s.setPosition(cx + cf * L.fx - sf * L.sx, cy + sf * L.fx + cf * L.sx);
      if (L.beam) s.setRotation(f); // orient headlight beam along travel

      let alpha = 0, sx2 = L.len, sy2 = L.wid;
      if (dead) {
        alpha = 0;
      } else if (L.type === 'head') {
        alpha = (L.alpha ?? 0.9) * T.head * lit;
        sx2 = L.len * T.headLen; sy2 = L.wid * T.headWid;
      } else if (L.type === 'tail') {
        alpha = (braking ? 1.0 : 0.32) * T.brake * lit;
        const sc = braking ? 1.35 : 1.0;
        sx2 = L.len * sc; sy2 = L.wid * sc;
      } else if (L.type === 'flashRed') {
        const on = redOn; alpha = (on ? 1.0 : 0.08) * T.flash;
        const sc = on ? 1.15 : 0.9; sx2 = L.len * sc; sy2 = L.wid * sc;
      } else if (L.type === 'flashBlue') {
        const on = blueOn; alpha = (on ? 1.0 : 0.08) * T.flash;
        const sc = on ? 1.15 : 0.9; sx2 = L.len * sc; sy2 = L.wid * sc;
      }
      s.setAlpha(alpha);
      s.setDisplaySize(sx2, sy2);
    }
  }

  destroy() {
    for (const L of this.lights) L.spr.destroy();
    this.lights = [];
  }
}
