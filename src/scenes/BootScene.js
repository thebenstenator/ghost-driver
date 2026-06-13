import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload() {
    this.load.image('player_car', 'sprites/vehicles/prowler.png');
  }

  create() {
    this.scene.start('MenuScene');
  }
}
