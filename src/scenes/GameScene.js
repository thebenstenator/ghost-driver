import Phaser from 'phaser';
import GUI from 'lil-gui';
import { PlayerCar } from '../entities/PlayerCar.js';
import { WORLD_WIDTH, WORLD_HEIGHT } from '../config.js';

// City block layout — 4x4 grid of buildings in a 2048x2048 world.
// Block slots: 376×376px, separated by 128px roads.
// Slot origins: x ∈ [80, 584, 1088, 1592], y ∈ [80, 584, 1088, 1592].
// Buildings fill most of each slot, leaving natural road widths of 128–176px.
const BUILDINGS = [
  // Row 0 (y=80)
  { x: 80,   y: 80,   w: 350, h: 340 },
  { x: 584,  y: 80,   w: 340, h: 360 },
  { x: 1088, y: 80,   w: 360, h: 330 },
  { x: 1592, y: 80,   w: 350, h: 350 },
  // Row 1 (y=584)
  { x: 80,   y: 584,  w: 360, h: 330 },
  { x: 584,  y: 584,  w: 330, h: 350 },
  { x: 1088, y: 584,  w: 350, h: 340 },
  { x: 1592, y: 584,  w: 360, h: 350 },
  // Row 2 (y=1088)
  { x: 80,   y: 1088, w: 340, h: 360 },
  { x: 584,  y: 1088, w: 360, h: 340 },
  { x: 1088, y: 1088, w: 350, h: 360 },
  { x: 1592, y: 1088, w: 340, h: 350 },
  // Row 3 (y=1592)
  { x: 80,   y: 1592, w: 360, h: 350 },
  { x: 584,  y: 1592, w: 340, h: 360 },
  { x: 1088, y: 1592, w: 350, h: 340 },
  { x: 1592, y: 1592, w: 360, h: 350 },
];

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    this._buildWorld();

    // Player starts at the center road intersection
    this.car = new PlayerCar(this, WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    this.physics.add.collider(this.car.sprite, this.walls);

    // Camera follows with slight lag for a sense of speed
    this.cameras.main.startFollow(this.car.sprite, true, 0.1, 0.1);
    this.cameras.main.setZoom(1.0);

    this._setupInput();
    this._setupDebugOverlay();
    this._setupTunePanel();
  }

  _buildWorld() {
    // Asphalt ground
    this.add.rectangle(
      WORLD_WIDTH / 2, WORLD_HEIGHT / 2,
      WORLD_WIDTH, WORLD_HEIGHT,
      0x1a1a24
    ).setDepth(0);

    // 1×1 white pixel used as the physics sprite for static bodies
    const px = this.add.graphics();
    px.fillStyle(0xffffff);
    px.fillRect(0, 0, 1, 1);
    px.generateTexture('_px', 1, 1);
    px.destroy();

    this.walls = this.physics.add.staticGroup();

    BUILDINGS.forEach(({ x, y, w, h }) => {
      const cx = x + w / 2;
      const cy = y + h / 2;

      // Visual building
      this.add.rectangle(cx, cy, w, h, 0x2c2c3e)
        .setStrokeStyle(1, 0x40405a)
        .setDepth(2);

      // Physics body — scale the 1px texture to building size
      const body = this.walls.create(cx, cy, '_px');
      body.setDisplaySize(w, h).refreshBody();
      body.setVisible(false);
    });

    // Road lane dashes on the two center roads (visual only)
    this._drawRoadMarkings();
  }

  _drawRoadMarkings() {
    const g = this.add.graphics().setDepth(1);
    g.lineStyle(2, 0x3a3a4a, 0.6);

    // Center vertical road — x ≈ 960–1088, draw dashes along y
    const vRoadX = 1024;
    for (let y = 40; y < WORLD_HEIGHT; y += 60) {
      g.strokeLineShape(new Phaser.Geom.Line(vRoadX, y, vRoadX, y + 30));
    }

    // Center horizontal road — y ≈ 960–1088, draw dashes along x
    const hRoadY = 1024;
    for (let x = 40; x < WORLD_WIDTH; x += 60) {
      g.strokeLineShape(new Phaser.Geom.Line(x, hRoadY, x + 30, hRoadY));
    }
  }

  _setupInput() {
    this.cursors   = this.input.keyboard.createCursorKeys(); // includes .space
    this.wasd      = this.input.keyboard.addKeys('W,A,S,D');
    this.shiftKey  = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
  }

  _setupDebugOverlay() {
    this.debugText = this.add.text(10, 10, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#39ff14',
      backgroundColor: '#00000099',
      padding: { x: 6, y: 4 }
    }).setScrollFactor(0).setDepth(100);
  }

  _setupTunePanel() {
    const car = this.car;
    const gui = new GUI({ title: 'Car Tuning', width: 280 });

    const engine = gui.addFolder('Engine');
    engine.add(car, 'acceleration',    10, 1500, 5).name('Acceleration');
    engine.add(car, 'maxSpeed',        100, 1200, 10).name('Max Speed');
    engine.add(car, 'hardBrakeForce',  50, 2000, 10).name('Hard Brake (Shift)');
    engine.add(car, 'brakeForce',      10, 500, 5).name('S-key Brake Force');
    engine.add(car, 'reverseAccel',    50, 1500, 10).name('Reverse Accel');
    engine.add(car, 'maxReverseSpeed', 30, 600, 5).name('Max Reverse Speed');

    const steering = gui.addFolder('Steering');
    steering.add(car, 'turnSpeed',     0.5, 8.0, 0.05).name('Turn Speed (rad/s)');
    steering.add(car, 'maxDriftAngle', 0.5, Math.PI * 0.95, 0.01).name('Max Drift Angle (rad)');

    const drag = gui.addFolder('Drag');
    drag.add(car, 'accelDragBase',  0.97, 0.9995, 0.0005).name('Accel Drag Base');
    drag.add(car, 'accelDragCurve', 0,    0.05,   0.001 ).name('Accel Drag Curve');
    drag.add(car, 'coastDrag',      0.96, 0.9995, 0.0005).name('Coast Drag');
    drag.add(car, 'handBrakeDrag',  0.97, 0.9995, 0.0005).name('Handbrake Drag');

    const grip = gui.addFolder('Grip');
    grip.add(car, 'gripLow',       0.02, 0.6,  0.01).name('Grip (low speed)');
    grip.add(car, 'gripHigh',      0.005, 0.2, 0.005).name('Grip (high speed)');
    grip.add(car, 'gripHandbrake', 0.001, 0.05, 0.001).name('Grip (handbrake)');
    grip.add(car, 'entryKick',     0, 0.8, 0.01).name('Entry Kick (handbrake)');

    // Dump current values to console so you can paste them back into the constructor
    gui.add({ copyStats: () => {
      const s = car;
      console.log(`// --- Tuned stats ---
this.maxSpeed        = ${s.maxSpeed};
this.maxReverseSpeed = ${s.maxReverseSpeed};
this.acceleration    = ${s.acceleration};
this.hardBrakeForce  = ${s.hardBrakeForce};
this.brakeForce      = ${s.brakeForce};
this.reverseAccel    = ${s.reverseAccel};
this.turnSpeed       = ${s.turnSpeed};
this.maxDriftAngle   = ${s.maxDriftAngle};
this.handBrakeDrag   = ${s.handBrakeDrag};
this.coastDrag       = ${s.coastDrag};
this.accelDragBase   = ${s.accelDragBase};
this.accelDragCurve  = ${s.accelDragCurve};
this.gripLow         = ${s.gripLow};
this.gripHigh        = ${s.gripHigh};
this.gripHandbrake   = ${s.gripHandbrake};
this.entryKick       = ${s.entryKick};`);
    } }, 'copyStats').name('Copy Stats → Console');

    // Anchor panel to top-right
    gui.domElement.style.position = 'fixed';
    gui.domElement.style.top  = '8px';
    gui.domElement.style.right = '8px';
    gui.domElement.style.zIndex = '9999';

    // Clicking the canvas after tweaking restores keyboard focus to the game
    this.game.canvas.addEventListener('mousedown', () => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
    });
  }

  update(_time, delta) {
    const controls = {
      up:        this.cursors.up.isDown    || this.wasd.W.isDown,
      down:      this.cursors.down.isDown  || this.wasd.S.isDown,
      left:      this.cursors.left.isDown  || this.wasd.A.isDown,
      right:     this.cursors.right.isDown || this.wasd.D.isDown,
      handbrake: this.cursors.space.isDown,
      brake:     this.shiftKey.isDown,
    };

    this.car.update(delta, controls);

    // Camera look-ahead: offset toward current velocity so the player
    // sees more of the road ahead at speed
    const lookX = this.car.vx * 0.15;
    const lookY = this.car.vy * 0.15;
    this.cameras.main.setFollowOffset(-lookX, -lookY);

    // Zoom out as speed increases. Reference against natural terminal (~450) rather
    // than the hard cap so the full zoom range is visible during normal driving.
    const speed      = this.car.getSpeed();
    const targetZoom = Phaser.Math.Linear(1.0, 0.62, Math.min(speed / 450, 1));
    this.cameras.main.zoom = Phaser.Math.Linear(
      this.cameras.main.zoom, targetZoom, 0.04
    );


    // Debug overlay
    const lines = [
      `FPS:   ${Math.round(this.game.loop.actualFps)}`,
      `Speed: ${Math.round(speed)} px/s`,
    ];
    if (this.car.isDrifting) lines.push('[HANDBRAKE DRIFT]');
    lines.push('', 'WASD / Arrows — Drive', 'Space — Handbrake', 'Shift — Brake');
    this.debugText.setText(lines);
  }
}
