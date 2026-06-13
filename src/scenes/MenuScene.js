import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

// Playtest menu: choose how many cops to spawn, then launch the chase.
export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0a0f');
    const cx = GAME_WIDTH / 2;

    this.add.text(cx, 130, 'GHOST DRIVER', {
      fontFamily: 'monospace', fontSize: '64px', fontStyle: 'bold', color: '#39ff14',
    }).setOrigin(0.5);
    this.add.text(cx, 200, 'playtest — choose your pursuit', {
      fontFamily: 'monospace', fontSize: '20px', color: '#9aa0b5',
    }).setOrigin(0.5);

    const options = [
      { label: 'Drive alone', n: 0 },
      { label: '1 Cop',       n: 1 },
      { label: '2 Cops',      n: 2 },
      { label: '3 Cops',      n: 3 },
    ];
    options.forEach((opt, i) => {
      const t = this.add.text(cx, 310 + i * 68, opt.label, {
        fontFamily: 'monospace', fontSize: '30px', color: '#ffffff',
        backgroundColor: '#1a1a24', padding: { x: 24, y: 10 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      t.on('pointerover', () => t.setColor('#ffd23f'));
      t.on('pointerout',  () => t.setColor('#ffffff'));
      t.on('pointerdown', () => this._start(opt.n));
    });

    this.add.text(cx, GAME_HEIGHT - 48, 'click, or press 0 – 3', {
      fontFamily: 'monospace', fontSize: '16px', color: '#6a6a7a',
    }).setOrigin(0.5);

    this.input.keyboard.on('keydown-ZERO',  () => this._start(0));
    this.input.keyboard.on('keydown-ONE',   () => this._start(1));
    this.input.keyboard.on('keydown-TWO',   () => this._start(2));
    this.input.keyboard.on('keydown-THREE', () => this._start(3));
  }

  _start(copCount) {
    this.scene.start('GameScene', { copCount, autostart: true });
  }
}
