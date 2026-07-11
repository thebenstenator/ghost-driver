import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    this.load.image('player_car',     'sprites/vehicles/prowler.png');
    this.load.image('cop_patrol',      'sprites/vehicles/cop_patrol.png');
    this.load.image('cop_interceptor', 'sprites/vehicles/cop_interceptor.png');
    this.load.image('cop_heavy',       'sprites/vehicles/cop_heavy.png');
    this.load.image('title_bg',        'ui/title-screen.png');

    // Engine samples — decoded into the WebAudio context GameAudio reuses. Keys are
    // `eng_<car>_<band>`; GameAudio crossfades the bands by speed→RPM. If any are
    // missing the engine voice falls back to the procedural synth (see GameAudio).
    this._loadEngine('prowler');
    this._loadScreech();
  }

  // Tire-screech one-shots, grouped by event. GameAudio plays a random variation per
  // category (brake / handbrake / launch) on the matching slip event.
  _loadScreech() {
    const base = 'audio/tire_screech/';
    this.load.audio('scr_brake_1',     base + 'screech_brake_1.ogg');
    this.load.audio('scr_brake_2',     base + 'screech_brake_2.ogg');
    this.load.audio('scr_handbrake_1', base + 'screech_handbrake_1.ogg');
    this.load.audio('scr_handbrake_2', base + 'screech_handbrake_2.ogg');
    this.load.audio('scr_handbrake_3', base + 'screech_handbrake_3.ogg');
    this.load.audio('scr_launch_1',    base + 'screech_launch_1.ogg');
  }

  // One driveable car's engine bank: idle + the steady on-load RPM bands.
  _loadEngine(car) {
    const base = `audio/engine/${car}/`;
    this.load.audio(`eng_${car}_idle`, base + 'idle.ogg');
    for (const band of ['1500', '2000', '2500', '3000', '3500', '4000', '4500', 'redline']) {
      this.load.audio(`eng_${car}_${band}`, base + `onload_${band}.ogg`);
    }
  }

  async create() {
    this._softenVehicleTextures([
      'player_car', 'cop_patrol', 'cop_interceptor', 'cop_heavy',
    ]);
    await this._loadFonts();
    this.scene.start('MenuScene');
  }

  // Phaser bakes Text objects to a canvas texture at creation time — if the webfont hasn't
  // finished downloading yet, it silently falls back and bakes in the wrong glyphs permanently
  // (no re-render later). Force both noir fonts to resolve before any scene draws text with them.
  async _loadFonts() {
    try {
      await Promise.all([
        document.fonts.load('900 60px "Cinzel"'),
        document.fonts.load('700 32px "Cinzel"'),
        document.fonts.load('600 20px "Oswald"'),
        document.fonts.load('400 16px "Oswald"'),
      ]);
    } catch (e) {
      // Fonts failed to load (offline, blocked, etc.) — fall back to system fonts rather than hang.
    }
  }

  // Moiré fix: the vehicle PNGs are ~128px tall but render at ~59px, so the GPU does a ~2x run-time
  // downscale with no mipmaps (the art is non-power-of-two, so WebGL can't auto-mipmap it) — which
  // shimmers/moirés on the fine body lines as the car rotates. Bake ONE high-quality half-size copy up
  // front (browser canvas downscaling does a proper filtered shrink), giving ~1 texel per screen pixel
  // so the run-time sampling is gentle and the moiré clears. Display size is set explicitly on each
  // sprite, so the on-screen size is unchanged; no visible detail is lost at this render size.
  _softenVehicleTextures(keys) {
    for (const key of keys) {
      if (!this.textures.exists(key)) continue;
      const img = this.textures.get(key).getSourceImage();
      const w = Math.max(1, Math.round(img.width / 2));
      const h = Math.max(1, Math.round(img.height / 2));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      this.textures.remove(key);
      this.textures.addCanvas(key, cv);
    }
  }
}
