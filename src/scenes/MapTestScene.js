import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

// DEV-ONLY Tiled map viewer — a throwaway feasibility harness, NOT part of live play (reachable only
// from the dev menu, and nothing in the real game imports it). It loads an exported Tiled JSON (.tmj)
// and draws each non-empty tile as a filled block, coloured by tile id, so you can confirm the Tiled
// export loads and maps cleanly into world space WITHOUT needing the tileset art. Once a tileset PNG
// lives in assets/map/, this is where we'd swap the block preview for a real StaticTilemapLayer.
//
// The map JSON path is relative to the served root (vite publicDir = assets/), same as the sprites.
const MAP_URL = 'map/test_grid.tmj';
const GID_MASK = 0x1fffffff; // strip Tiled's flip/rotate flags (top 3 bits) to get the raw tile id

export class MapTestScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MapTestScene' });
  }

  preload() {
    this._loadFailed = false;
    this.load.json('mapTest', MAP_URL);
    this.load.once('loaderror', () => { this._loadFailed = true; });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0a0f');
    const m = this.cache.json.get('mapTest');

    // Bail gracefully if the export is missing/broken — a dev harness shouldn't hard-crash.
    if (this._loadFailed || !m || !m.layers) {
      this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2,
          `Couldn't load ${MAP_URL}\n(export a Tiled JSON to assets/map/)\n\npress M for menu`,
          { fontFamily: 'monospace', fontSize: '18px', color: '#ff6b6b', align: 'center' })
        .setOrigin(0.5);
      this.input.keyboard.once('keydown-M', () => this.scene.start('MenuScene'));
      return;
    }

    const tw = m.tilewidth, th = m.tileheight, W = m.width, H = m.height;
    const worldW = W * tw, worldH = H * th;

    const g = this.add.graphics();
    // Backdrop = "road" so painted (non-empty) tiles read as the built layout on top.
    g.fillStyle(0x14161c, 1);
    g.fillRect(0, 0, worldW, worldH);

    let painted = 0;
    for (const layer of m.layers) {
      if (layer.type !== 'tilelayer' || !Array.isArray(layer.data)) continue;
      const lw = layer.width, ox = (layer.x || 0) * tw, oy = (layer.y || 0) * th;
      for (let i = 0; i < layer.data.length; i++) {
        const gid = layer.data[i] & GID_MASK;
        if (!gid) continue;
        painted++;
        const col = i % lw, row = (i / lw) | 0;
        g.fillStyle(this._gidColor(gid), 1);
        g.fillRect(ox + col * tw, oy + row * th, tw, th);
      }
    }

    // Faint tile grid so cell boundaries are visible.
    g.lineStyle(1, 0xffffff, 0.05);
    for (let x = 0; x <= W; x++) g.lineBetween(x * tw, 0, x * tw, worldH);
    for (let y = 0; y <= H; y++) g.lineBetween(0, y * th, worldW, y * th);

    // Camera: frame the whole map, then allow free pan/zoom to inspect it.
    const cam = this.cameras.main;
    cam.setBounds(-worldW, -worldH, worldW * 3, worldH * 3);
    cam.centerOn(worldW / 2, worldH / 2);
    cam.setZoom(Math.min(GAME_WIDTH / worldW, GAME_HEIGHT / worldH) * 0.92);

    this.add
      .text(10, 10,
        `${MAP_URL} — ${W}×${H} tiles @ ${tw}px  (${worldW}×${worldH}px), ${painted} painted\n` +
          `arrows / drag = pan   ·   wheel = zoom   ·   M = menu   ·   layout preview (no tileset art)`,
        { fontFamily: 'monospace', fontSize: '13px', color: '#39ff14', backgroundColor: '#000000aa', padding: { x: 6, y: 4 } })
      .setScrollFactor(0)
      .setDepth(100);

    // --- Controls ---
    this.cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.on('keydown-M', () => this.scene.start('MenuScene'));
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      cam.zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.03, 6);
    });
    this.input.on('pointermove', (p) => {
      if (!p.isDown) return;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });
  }

  update() {
    if (!this.cursors) return;
    const cam = this.cameras.main, step = 14 / cam.zoom;
    if (this.cursors.left.isDown) cam.scrollX -= step;
    if (this.cursors.right.isDown) cam.scrollX += step;
    if (this.cursors.up.isDown) cam.scrollY -= step;
    if (this.cursors.down.isDown) cam.scrollY += step;
  }

  // Deterministic, distinct-ish colour per tile id so different tiles read apart in the preview.
  _gidColor(gid) {
    return Phaser.Display.Color.HSVToRGB(((gid * 47) % 360) / 360, 0.4, 0.8).color;
  }
}
