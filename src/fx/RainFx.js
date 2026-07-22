import Phaser from "phaser";

// Cheap, camera-space rain — the noir "always raining in Obsidian Bay" identity without any
// per-drop physics. It's just 2 scrolling TileSprites (near/far parallax streaks) + a subtle
// wet-sheen tint, all screen-fixed. Costs ~3 textured quads per frame (no per-frame tessellation),
// so it's essentially free even on the weak iGPU/battery case.
//
// It renders on the HUD (uiCamera) layer, NOT the world camera — the world camera zooms out at
// speed, which would scale a screen overlay and leave gaps at the edges. Depth is kept BELOW the
// HUD elements (which sit at 100+) so rain falls over the world but under the readouts.
export class RainFx {
  constructor(scene) {
    this.scene = scene;
    this._makeTexture();
    const w = scene.scale.width, h = scene.scale.height;

    // Wet-sheen tint — a faint cool wash to shift the palette toward "wet". Tunable/subtle.
    this.tint = scene.add
      .rectangle(w / 2, h / 2, w, h, 0x0a1626, 0.1)
      .setScrollFactor(0)
      .setDepth(8);

    // Two parallax streak layers: far = fainter + slower + smaller; near = brighter + faster + bigger.
    this.far = scene.add
      .tileSprite(0, 0, w, h, "rain_streak")
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(9)
      .setAlpha(0.32)
      .setTileScale(0.85);
    this.near = scene.add
      .tileSprite(0, 0, w, h, "rain_streak")
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(10)
      .setAlpha(0.55)
      .setTileScale(1.3);

    this._objs = [this.tint, this.far, this.near];
    this.enabled = true;
  }

  // The objects the caller must hand to `cameras.main.ignore(...)` so only the uiCamera draws them
  // (otherwise the zooming world camera renders them too → doubled + scaling gaps).
  objects() { return this._objs; }

  // Procedural streak texture (no asset). Sparse translucent near-vertical streaks with a slight
  // wind lean; the scroll direction below matches the lean so streaks travel along their length.
  _makeTexture() {
    const key = "rain_streak";
    if (this.scene.textures.exists(key)) return;
    const S = 256, lean = 0.18; // lean = x per y (wind)
    const cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    const ctx = cv.getContext("2d");
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const len = 14 + Math.random() * 28;
      ctx.strokeStyle = `rgba(200,220,255,${0.12 + Math.random() * 0.22})`;
      ctx.lineWidth = Math.random() < 0.3 ? 1.4 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + lean * len, y + len);
      ctx.stroke();
    }
    this.scene.textures.addCanvas(key, cv);
  }

  // Scroll down + slightly right (falling with wind). Sign chosen so content moves DOWN.
  update(dt) {
    if (!this.enabled) return;
    this.far.tilePositionY -= 900 * dt;
    this.far.tilePositionX -= 160 * dt;
    this.near.tilePositionY -= 1500 * dt;
    this.near.tilePositionX -= 270 * dt;
  }

  toggle() { this.setEnabled(!this.enabled); }
  setEnabled(on) {
    this.enabled = on;
    for (const o of this._objs) o.setVisible(on);
  }
  destroy() { for (const o of this._objs) o.destroy(); }
}
