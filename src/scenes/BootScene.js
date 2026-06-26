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

    // Engine samples — decoded into the WebAudio context GameAudio reuses. Keys are
    // `eng_<car>_<band>`; GameAudio crossfades the bands by speed→RPM. If any are
    // missing the engine voice falls back to the procedural synth (see GameAudio).
    this._loadEngine('prowler');
  }

  // One driveable car's engine bank: idle + the steady on-load RPM bands.
  _loadEngine(car) {
    const base = `audio/engine/${car}/`;
    this.load.audio(`eng_${car}_idle`, base + 'idle.ogg');
    for (const band of ['1500', '2500', '3500', '4500', '5500', '6500', '7500', 'redline']) {
      this.load.audio(`eng_${car}_${band}`, base + `onload_${band}.ogg`);
    }
  }

  create() {
    this.scene.start('MenuScene');
  }
}
