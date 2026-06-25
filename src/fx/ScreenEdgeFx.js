import Phaser from "phaser";

// Screen-edge pursuit glow. A light bar that hugs all four edges of the screen — brightest at
// the very edge, fading to nothing `thickness` px inward — whose COLOUR and THICKNESS are driven
// by the pursuit state. This class owns only the look + the easing; GameScene tells it which MODE
// the pursuit is in each frame (setMode) and the class animates the flash → retreat and the
// colour cross-fade. Rendered on the UI camera so it ignores world scroll/zoom.
//
// Mode → behaviour (mirrors the heat-bar phases):
//   PURSUE   red, thin (holdThickness). FLASHES out to flashThickness on entry UNLESS it came
//            from HOLD — re-acquiring during the brief pre-ditch hold isn't a "new" chase, so no
//            flash; (re)starting a pursuit or being re-spotted AFTER a ditch DOES flash.
//   HOLD     blue, thin, no flash — cops lost sight (pre-ditch). Same blue as the heat-bar hold.
//   COOLDOWN blue. FLASHES out on entry (the ditch lands), retreats — slower — to holdThickness
//            and sits there through the hot/cooling window.
//   WITHDRAW white. FLASHES out then retreats all the way to nothing — the "they're gone"
//            punctuation as the cops peel off home.
//   OFF      nothing.
//
// The flash is purely a THICKNESS pop: the band snaps out to flashThickness then shrinks back at a
// per-mode px/s retreat speed. The gradient depth IS the current thickness, so a thin band is a
// tight edge line and a fat one is a deep wash.
export class ScreenEdgeFx {
  // Mode names as constants so callers can't typo a mode string.
  static OFF = "OFF";
  static PURSUE = "PURSUE";
  static HOLD = "HOLD";
  static COOLDOWN = "COOLDOWN";
  static WITHDRAW = "WITHDRAW";

  constructor(scene) {
    this.scene = scene;
    // Drawn at absolute screen coords; the UI camera (scroll 0,0, fixed zoom) renders it and the
    // main camera ignores it (GameScene adds gfx to its HUD-ignore list). Under the HUD text (100).
    this.gfx = scene.add.graphics().setDepth(90).setScrollFactor(0);

    // --- Tunables (live-bound by the "Pursuit Screen FX" dev panel) ---
    this.intensity = 0.55; // peak alpha at the very edge (0..1)
    this.holdThickness = 10; // px the band settles to during a sustained chase / hold
    this.flashThickness = 50; // px the band snaps out to on a flash (= the gradient depth then)
    this.growSpeed = 600; // px/s the band may GROW when a target rises without a flash
    this.redRetreatSpeed = 120; // px/s the red pursuit flash shrinks back to holdThickness (fast)
    this.blueRetreatSpeed = 45; // px/s the blue cooldown flash shrinks back (slower)
    this.whiteRetreatSpeed = 70; // px/s the white withdraw flash shrinks to nothing (then OFF)
    this.colorLerp = 0.12; // 0..1 per-60fps-frame cross-fade rate between mode colours
    this.pursueColor = 0xff2b2b; // red — active chase (cops have sight)
    this.holdColor = 0x4a90ff; // blue — lost sight, pre-ditch hold (matches the heat bar)
    this.cooldownColor = 0x4a90ff; // blue — ditched, area cooling
    this.withdrawColor = 0xffffff; // white — cops withdrawing (gone)

    // --- Runtime state ---
    this.mode = ScreenEdgeFx.OFF;
    this.thickness = 0; // current band thickness (px), eased toward targetThickness
    this.targetThickness = 0; // where it's retreating/growing toward
    this.retreatSpeed = this.redRetreatSpeed; // active shrink rate (set per flash)
    this._col = this._rgb(this.holdColor); // current eased colour {r,g,b}
  }

  _rgb(hex) {
    return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
  }

  // The target colour for the current mode (re-read each frame so live panel edits show at once).
  _modeColor() {
    switch (this.mode) {
      case ScreenEdgeFx.PURSUE:
        return this.pursueColor;
      case ScreenEdgeFx.HOLD:
        return this.holdColor;
      case ScreenEdgeFx.COOLDOWN:
        return this.cooldownColor;
      case ScreenEdgeFx.WITHDRAW:
        return this.withdrawColor;
      default:
        return this.holdColor;
    }
  }

  // Snap the band out to flashThickness, then retreat toward `hold` at `speed` px/s.
  _flash(hold, speed) {
    this.thickness = this.flashThickness;
    this.targetThickness = hold;
    this.retreatSpeed = speed;
  }

  // Called every frame by GameScene with the pursuit's current mode. Idempotent: re-passing the
  // same mode is a no-op (so per-frame calls don't re-trigger a flash). Only TRANSITIONS act.
  setMode(mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    switch (mode) {
      case ScreenEdgeFx.PURSUE:
        // Flash on a NEW chase (from off / a ditch-cooldown / withdraw), but NOT when merely
        // re-acquiring out of the pre-ditch HOLD (that wasn't a real loss → no "found you" pop).
        if (prev === ScreenEdgeFx.HOLD) this.targetThickness = this.holdThickness;
        else this._flash(this.holdThickness, this.redRetreatSpeed);
        break;
      case ScreenEdgeFx.HOLD:
        this.targetThickness = this.holdThickness; // no flash — just a colour cross-fade to blue
        break;
      case ScreenEdgeFx.COOLDOWN:
        this._flash(this.holdThickness, this.blueRetreatSpeed);
        break;
      case ScreenEdgeFx.WITHDRAW:
        this._flash(0, this.whiteRetreatSpeed); // retreat all the way to nothing
        break;
      case ScreenEdgeFx.OFF:
      default:
        this.targetThickness = 0;
        break;
    }
  }

  update(dt) {
    // Ease thickness toward its target (linear px/s; a flash sets it high, this shrinks it; a
    // rising hold target grows it at growSpeed).
    if (this.thickness > this.targetThickness)
      this.thickness = Math.max(
        this.targetThickness,
        this.thickness - this.retreatSpeed * dt,
      );
    else
      this.thickness = Math.min(
        this.targetThickness,
        this.thickness + this.growSpeed * dt,
      );

    // Cross-fade colour toward the current mode's colour (frame-rate independent).
    const target = this._rgb(this._modeColor());
    const k = 1 - Math.pow(1 - this.colorLerp, dt * 60);
    this._col.r = Phaser.Math.Linear(this._col.r, target.r, k);
    this._col.g = Phaser.Math.Linear(this._col.g, target.g, k);
    this._col.b = Phaser.Math.Linear(this._col.b, target.b, k);

    this._draw();
  }

  _draw() {
    const g = this.gfx;
    g.clear();
    const t = this.thickness;
    const peak = this.intensity;
    if (t < 0.5 || peak <= 0.001) return;
    const W = this.scene.scale.width,
      H = this.scene.scale.height;
    const col =
      (Math.round(this._col.r) << 16) |
      (Math.round(this._col.g) << 8) |
      Math.round(this._col.b);
    // Each edge: a band `t` px deep, full alpha at the screen edge fading to 0 alpha `t` px inward.
    // (Per-corner alphas on fillGradientStyle give the inward fade; corners where two edges meet
    // overlap and read slightly brighter — a natural vignette emphasis.)
    g.fillGradientStyle(col, col, col, col, peak, peak, 0, 0); // top
    g.fillRect(0, 0, W, t);
    g.fillGradientStyle(col, col, col, col, 0, 0, peak, peak); // bottom
    g.fillRect(0, H - t, W, t);
    g.fillGradientStyle(col, col, col, col, peak, 0, peak, 0); // left
    g.fillRect(0, 0, t, H);
    g.fillGradientStyle(col, col, col, col, 0, peak, 0, peak); // right
    g.fillRect(W - t, 0, t, H);
  }

  destroy() {
    this.gfx.destroy();
  }
}
