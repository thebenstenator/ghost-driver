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
    for (const band of ['1500', '2500', '3500', '4500', '5500', '6500', '7500', 'redline']) {
      this.load.audio(`eng_${car}_${band}`, base + `onload_${band}.ogg`);
    }
  }

  create() {
    this.scene.start('MenuScene');
  }
}
