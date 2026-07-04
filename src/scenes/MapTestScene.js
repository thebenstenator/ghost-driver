import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

// DEV-ONLY Tiled map viewer — a feasibility harness, NOT part of live play (nothing in the real game
// imports it; reachable only via the "🗺 map test" dev-menu entry). It loads the exported Tiled JSON
// (.tmj) + its tileset image and renders the ACTUAL tiles, so you can confirm the whole art pipeline
// (map → tileset → render) is wired end to end. Pan/zoom to inspect; M returns to the menu.
//
// Paths are relative to the served root (vite publicDir = assets/), same as the sprites.
const MAP_KEY = 'mapTest';
const MAP_URL = 'map/test_grid.tmj';
const TILESET_KEY = 'mapTestTileset';
const TILESET_URL = 'map/tileset streets no light_resized.png';

export class MapTestScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MapTestScene' });
  }

  preload() {
    this._failKey = null;
    this.load.tilemapTiledJSON(MAP_KEY, MAP_URL);
    this.load.image(TILESET_KEY, TILESET_URL);
    // Surface a clear message instead of a silent blank screen if an asset 404s.
    this.load.once('loaderror', (file) => { this._failKey = (file && file.key) || 'asset'; });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0a0f');
    if (this._failKey) return this._fail(`Couldn't load "${this._failKey}"\n(check assets/map/)`);

    const map = this.make.tilemap({ key: MAP_KEY });
    // Bind each embedded tileset (by its Tiled name) to the loaded image, then draw every layer.
    const tsName = map.tilesets[0] && map.tilesets[0].name;
    const tiles = map.addTilesetImage(tsName, TILESET_KEY);
    if (!tiles) return this._fail(`tileset "${tsName}" didn't bind to the image`);
    for (let i = 0; i < map.layers.length; i++) map.createLayer(i, tiles, 0, 0);

    const worldW = map.widthInPixels, worldH = map.heightInPixels;
    const cam = this.cameras.main;
    cam.setBounds(-worldW, -worldH, worldW * 3, worldH * 3);
    cam.centerOn(worldW / 2, worldH / 2);
    cam.setZoom(Math.min(GAME_WIDTH / worldW, GAME_HEIGHT / worldH) * 0.92);

    this.add
      .text(10, 10,
        `${MAP_URL} — ${map.width}×${map.height} @ ${map.tileWidth}px  (${worldW}×${worldH}px)\n` +
          `arrows / drag = pan   ·   wheel = zoom   ·   M = menu`,
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

  _fail(msg) {
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, `${msg}\n\npress M for menu`,
        { fontFamily: 'monospace', fontSize: '18px', color: '#ff6b6b', align: 'center' })
      .setOrigin(0.5);
    this.input.keyboard.once('keydown-M', () => this.scene.start('MenuScene'));
  }
}
