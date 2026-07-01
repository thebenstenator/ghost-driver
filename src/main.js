import './style.css';
import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { MenuScene } from './scenes/MenuScene.js';
import { GameScene } from './scenes/GameScene.js';
import { MapTestScene } from './scenes/MapTestScene.js';
import { GAME_WIDTH, GAME_HEIGHT } from './config.js';

new Phaser.Game({
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#0a0a0f',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false
    }
  },
  scale: {
    mode: Phaser.Scale.FIT,
    // The page CSS already centers the canvas with flexbox. Letting Phaser ALSO
    // center it (CENTER_BOTH) double-applies a margin and shifts the canvas off to
    // one side (more black space on the left). Leave centering to the CSS.
    autoCenter: Phaser.Scale.NO_CENTER
  },
  scene: [BootScene, MenuScene, GameScene, MapTestScene]
});
