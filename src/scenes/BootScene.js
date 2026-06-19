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
  }

  create() {
    this.scene.start('MenuScene');
  }
}
