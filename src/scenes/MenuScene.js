import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';
import { GameScene } from './GameScene.js';

// Playtest menu: choose how many cops to spawn, then launch the chase.
export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  create() {
    this.cameras.main.setBackgroundColor('#0a0a0f');
    const cx = GAME_WIDTH / 2;

    // --- Title ---
    this.add.text(cx, 80, 'GHOST DRIVER', {
      fontFamily: 'monospace', fontSize: '60px', fontStyle: 'bold', color: '#39ff14',
    }).setOrigin(0.5);
    this.add.text(cx, 132, 'playtest — choose your pursuit', {
      fontFamily: 'monospace', fontSize: '18px', color: '#9aa0b5',
    }).setOrigin(0.5);

    // --- Cop-count options (uniform-width buttons) ---
    const options = [
      { label: 'Drive alone', n: 0 },
      { label: '1 Cop',       n: 1 },
      { label: '2 Cops',      n: 2 },
      { label: '3 Cops',      n: 3 },
    ];
    options.forEach((opt, i) => {
      const t = this.add.text(cx, 205 + i * 60, opt.label, {
        fontFamily: 'monospace', fontSize: '26px', color: '#ffffff',
        backgroundColor: '#1a1a24', align: 'center',
        fixedWidth: 240, padding: { x: 0, y: 10 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      t.on('pointerover', () => t.setColor('#ffd23f'));
      t.on('pointerout',  () => t.setColor('#ffffff'));
      t.on('pointerdown', () => this._start(opt.n));
    });

    this.add.text(cx, 205 + 4 * 60 + 4, 'click, or press 0 – 3', {
      fontFamily: 'monospace', fontSize: '15px', color: '#6a6a7a',
    }).setOrigin(0.5);

    // --- Controls reference ---
    this.add.text(cx, 545, 'CONTROLS', {
      fontFamily: 'monospace', fontSize: '18px', fontStyle: 'bold', color: '#ffd23f',
    }).setOrigin(0.5);
    const controls = [
      'WASD / Arrows — Drive        Space — Handbrake',
      'Shift — Brake        P — Pause',
    ].join('\n');
    this.add.text(cx, 605, controls, {
      fontFamily: 'monospace', fontSize: '16px', color: '#c8c8d4',
      align: 'center', lineSpacing: 10,
    }).setOrigin(0.5);

    // --- Dev mode toggle (bottom-left corner) ---
    // Off by default. When on, the chase shows tuning panels + AI overlays; when off,
    // playtesters get a clean screen. Persisted, so it survives restarts.
    this._devOn = GameScene.isDevMode();
    const devBox = this.add.text(16, GAME_HEIGHT - 18, '', {
      fontFamily: 'monospace', fontSize: '15px',
    }).setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    const renderDev = (hover = false) => {
      devBox.setText(`${this._devOn ? '[x]' : '[ ]'} dev mode`);
      devBox.setColor(this._devOn ? (hover ? '#5fff4a' : '#39ff14') : (hover ? '#9aa0b5' : '#6a6a7a'));
    };
    renderDev();
    devBox.on('pointerover', () => renderDev(true));
    devBox.on('pointerout',  () => renderDev(false));
    devBox.on('pointerdown', () => {
      this._devOn = !this._devOn;
      GameScene.setDevMode(this._devOn);
      renderDev(true);
    });

    // --- Keyboard shortcuts ---
    this.input.keyboard.on('keydown-ZERO',  () => this._start(0));
    this.input.keyboard.on('keydown-ONE',   () => this._start(1));
    this.input.keyboard.on('keydown-TWO',   () => this._start(2));
    this.input.keyboard.on('keydown-THREE', () => this._start(3));
  }

  _start(copCount) {
    this.scene.start('GameScene', { copCount, autostart: true });
  }
}
