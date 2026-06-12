import Phaser from 'phaser';
import GUI from 'lil-gui';
import { PlayerCar } from '../entities/PlayerCar.js';
import { CopCar } from '../entities/CopCar.js';
import { NavGrid } from '../ai/NavGrid.js';
import { segmentClear } from '../ai/lineOfSight.js';
import { Pursuit, PursuitState } from '../systems/Pursuit.js';
import {
  WORLD_WIDTH, WORLD_HEIGHT,
  GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP,
} from '../config.js';

// Building sizes cycle through slight variations for visual interest
const W_SIZES = [350, 340, 360, 330, 355, 345];
const H_SIZES = [340, 360, 330, 350, 345, 355];

const BUILDINGS = [];
for (let row = 0; row < GRID_ROWS; row++) {
  for (let col = 0; col < GRID_COLS; col++) {
    const i = row * GRID_COLS + col;
    BUILDINGS.push({
      x: MARGIN + col * GRID_STEP,
      y: MARGIN + row * GRID_STEP,
      w: W_SIZES[i % W_SIZES.length],
      h: H_SIZES[(i * 3 + 1) % H_SIZES.length],
    });
  }
}

// --- Alleys ---
// Narrow two road gaps by expanding the buildings on each side so only
// ALLEY_W px of clearance remains. The rest of the grid stays at 128px roads.
const ALLEY_W = 64;

// N-S alley between col 2 and col 3 (runs full map height)
{
  const cx = MARGIN + 3 * GRID_STEP - ROAD / 2; // road centre x = 1528
  for (let row = 0; row < GRID_ROWS; row++) {
    const l = BUILDINGS[row * GRID_COLS + 2];
    const r = BUILDINGS[row * GRID_COLS + 3];
    l.w = cx - ALLEY_W / 2 - l.x;   // expand col-2 building rightward
    r.x = cx + ALLEY_W / 2;          // shift col-3 building left edge inward
  }
}

// E-W alley between row 3 and row 4 (runs full map width)
{
  const cy = MARGIN + 4 * GRID_STEP - ROAD / 2; // road centre y = 2032
  for (let col = 0; col < GRID_COLS; col++) {
    const t = BUILDINGS[3 * GRID_COLS + col];
    const b = BUILDINGS[4 * GRID_COLS + col];
    t.h = cy - ALLEY_W / 2 - t.y;   // expand row-3 building downward
    b.y = cy + ALLEY_W / 2;          // shift row-4 building top edge inward
  }
}

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

    // --- Cops + pursuit ---
    this.navGrid    = new NavGrid();
    this.cops       = [];
    this.sightRange = 650; // px — how far a cop can spot the player in clear line
    this.pursuit    = new Pursuit(10); // seconds out of sight to complete a ditch
    this._spawnCop(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 700);

    // Debug graphics for AI steering targets + line of sight
    this.aiDebug = this.add.graphics().setDepth(50);

    this._setupHud();

    // Camera follows with slight lag for a sense of speed
    this.cameras.main.startFollow(this.car.sprite, true, 0.1, 0.1);
    this.cameras.main.setZoom(1.0);

    this._setupInput();
    this._setupDebugOverlay();
    this._setupTunePanel();
  }

  _spawnCop(x, y) {
    const cop = new CopCar(this, x, y, this.navGrid);
    this.physics.add.collider(cop.sprite, this.walls);
    this.physics.add.collider(cop.sprite, this.car.sprite);
    // Cops bump off each other rather than stacking
    for (const other of this.cops) this.physics.add.collider(cop.sprite, other.sprite);
    this.cops.push(cop);
    return cop;
  }

  // Where a cop should drive during the cooldown phase: first to the last-known
  // position, then sweeping outward through nearby intersections to hunt for the
  // player. Reaching the player's true location while searching re-acquires line
  // of sight elsewhere in the loop and snaps back to ACTIVE.
  _cooldownTarget(cop) {
    const ARRIVE = 70; // px — close enough to count as "reached"
    const lk = this.pursuit.lastKnown;

    if (!cop.searching) {
      const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, lk.x, lk.y);
      if (d > ARRIVE) return lk;          // still en route to last-known
      cop.searching = true;               // arrived — begin the sweep
      this._buildSearchRoute(cop, lk.x, lk.y);
    }

    // Advance through the sweep; rebuild a fresh sweep when the current one runs out
    if (!cop.searchRoute || cop.searchIndex >= cop.searchRoute.length) {
      this._buildSearchRoute(cop, cop.sprite.x, cop.sprite.y);
    }
    const wp = cop.searchRoute[cop.searchIndex];
    if (Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, wp.x, wp.y) < ARRIVE) {
      cop.searchIndex++;
    }
    return cop.searchRoute[Math.min(cop.searchIndex, cop.searchRoute.length - 1)];
  }

  _buildSearchRoute(cop, x, y) {
    const start = this.navGrid.nearestNode(x, y);
    const nodes = this.navGrid.nodesInRange(start, 3); // ~3 intersections outward
    cop.searchRoute = nodes.map(n => this.navGrid.pos(n));
    cop.searchIndex = 0;
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
    this.losRects = []; // building footprints for line-of-sight checks

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

      this.losRects.push(new Phaser.Geom.Rectangle(x, y, w, h));
    });

    // Road lane dashes on the two center roads (visual only)
    this._drawRoadMarkings();
  }

  _drawRoadMarkings() {
    const g = this.add.graphics().setDepth(1);
    g.lineStyle(2, 0x3a3a4a, 0.6);

    // One centre-line per road gap between columns (vertical roads)
    // and per road gap between rows (horizontal roads)
    for (let i = 0; i < GRID_COLS - 1; i++) {
      const roadX = MARGIN + (i + 1) * GRID_STEP - ROAD / 2;
      for (let y = 0; y < WORLD_HEIGHT; y += 60) {
        g.strokeLineShape(new Phaser.Geom.Line(roadX, y, roadX, y + 30));
      }
    }

    for (let i = 0; i < GRID_ROWS - 1; i++) {
      const roadY = MARGIN + (i + 1) * GRID_STEP - ROAD / 2;
      for (let x = 0; x < WORLD_WIDTH; x += 60) {
        g.strokeLineShape(new Phaser.Geom.Line(x, roadY, x + 30, roadY));
      }
    }
  }

  _setupInput() {
    this.cursors   = this.input.keyboard.createCursorKeys(); // includes .space
    this.wasd      = this.input.keyboard.addKeys('W,A,S,D');
    this.shiftKey  = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    // Cop telemetry: press C to toggle throttled console logging of cop state
    this.copLog       = false;
    this._copLogTimer = 0;
    this.input.keyboard.on('keydown-C', () => {
      this.copLog = !this.copLog;
      console.log(`[cop telemetry] ${this.copLog ? 'ON' : 'OFF'}`);
    });
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

  _setupHud() {
    const { width } = this.scale;
    // Pursuit status (top centre)
    this.statusText = this.add.text(width / 2, 24, '', {
      fontFamily: 'monospace',
      fontSize: '22px',
      fontStyle: 'bold',
      color: '#ffffff',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

    // Large cooldown timer, shown only during the cooldown phase
    this.cooldownText = this.add.text(width / 2, 54, '', {
      fontFamily: 'monospace',
      fontSize: '40px',
      fontStyle: 'bold',
      color: '#ffd23f',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

    // Brief "GHOST" flash when a ditch completes
    this.ghostText = this.add.text(width / 2, this.scale.height / 2, 'GHOST', {
      fontFamily: 'monospace',
      fontSize: '96px',
      fontStyle: 'bold',
      color: '#39ff14',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(100).setAlpha(0);
  }

  _flashGhost() {
    this.ghostText.setAlpha(1).setScale(0.8);
    this.tweens.add({ targets: this.ghostText, alpha: 0, scale: 1.4, duration: 1500, ease: 'Cubic.easeOut' });
  }

  _setupTunePanel() {
    const car = this.car;
    const gui = new GUI({ title: 'Car Tuning', width: 280 });
    gui.close();

    const engine = gui.addFolder('Engine');
    engine.add(car, 'acceleration',    10, 1500,  5  ).name('Acceleration');
    engine.add(car, 'maxSpeed',        100, 1200, 10 ).name('Max Speed');
    engine.add(car, 'hardBrakeForce',  50, 2000,  10 ).name('Hard Brake (Shift)');
    engine.add(car, 'brakeForce',      10, 500,   5  ).name('S-key Brake Force');
    engine.add(car, 'reverseAccel',    50, 1500,  10 ).name('Reverse Accel');
    engine.add(car, 'maxReverseSpeed', 30, 600,   5  ).name('Max Reverse Speed');

    const steering = gui.addFolder('Steering');
    steering.add(car, 'turnSpeedLow',  0.5, 8.0,            0.05).name('Turn Speed low (rad/s)');
    steering.add(car, 'turnSpeed',     0.5, 8.0,            0.05).name('Turn Speed high (rad/s)');
    steering.add(car, 'maxDriftAngle', 0.5, Math.PI * 0.95, 0.01).name('Max Drift Angle (rad)');

    const drag = gui.addFolder('Drag');
    drag.add(car, 'accelDragBase',  0.97,  0.9995, 0.0005).name('Accel Drag Base');
    drag.add(car, 'accelDragCurve', 0,     0.05,   0.001 ).name('Accel Drag Curve');
    drag.add(car, 'coastDrag',      0.96,  0.9995, 0.0005).name('Coast Drag');
    drag.add(car, 'handBrakeDrag',  0.97,  0.9995, 0.0005).name('Handbrake Drag');

    const grip = gui.addFolder('Grip');
    grip.add(car, 'gripLow',       0.02,  0.6,   0.01 ).name('Grip (low speed)');
    grip.add(car, 'gripHigh',      0.005, 0.2,   0.005).name('Grip (high speed)');
    grip.add(car, 'gripSpeedRef',  50,    600,   5    ).name('High-speed grip at (px/s)');
    grip.add(car, 'gripHandbrake', 0.001, 0.05,  0.001).name('Grip (handbrake)');
    grip.add(car, 'entryKick',         0,   0.8,  0.01).name('Entry Kick (handbrake)');
    grip.add(car, 'entryKickDuration', 0,   0.5,  0.01).name('Entry Kick Duration (s)');
    grip.add(car, 'entryKickCooldown', 0,   3.0,  0.05).name('Entry Kick Cooldown (s)');

    gui.add({ copyStats: () => {
      const s = car;
      console.log(`// --- Tuned stats ---
this.maxSpeed        = ${s.maxSpeed};
this.maxReverseSpeed = ${s.maxReverseSpeed};
this.acceleration    = ${s.acceleration};
this.hardBrakeForce  = ${s.hardBrakeForce};
this.brakeForce      = ${s.brakeForce};
this.reverseAccel    = ${s.reverseAccel};
this.turnSpeedLow    = ${s.turnSpeedLow};
this.turnSpeed       = ${s.turnSpeed};
this.maxDriftAngle   = ${s.maxDriftAngle};
this.handBrakeDrag   = ${s.handBrakeDrag};
this.coastDrag       = ${s.coastDrag};
this.accelDragBase   = ${s.accelDragBase};
this.accelDragCurve  = ${s.accelDragCurve};
this.gripLow         = ${s.gripLow};
this.gripHigh        = ${s.gripHigh};
this.gripSpeedRef    = ${s.gripSpeedRef};
this.gripHandbrake   = ${s.gripHandbrake};
this.entryKick         = ${s.entryKick};
this.entryKickDuration = ${s.entryKickDuration};
this.entryKickCooldown = ${s.entryKickCooldown};`);
    } }, 'copyStats').name('Copy Stats → Console');

    gui.domElement.style.position = 'fixed';
    gui.domElement.style.top   = '8px';
    gui.domElement.style.right = '8px';
    gui.domElement.style.zIndex = '9999';

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

    // --- Line of sight: can any cop currently see the player? ---
    const px = this.car.sprite.x, py = this.car.sprite.y;
    let anyLOS = false;
    for (const cop of this.cops) {
      const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py);
      cop.hasLOS = d <= this.sightRange && segmentClear(cop.sprite.x, cop.sprite.y, px, py, this.losRects);
      if (cop.hasLOS) anyLOS = true;
    }

    // --- Pursuit state machine ---
    const state = this.pursuit.update(anyLOS, px, py, delta / 1000);
    if (this.pursuit.justDitched) this._flashGhost();

    // On entering cooldown, reset each cop's search so they head to last-known first
    if (state === PursuitState.COOLDOWN && this._prevState !== PursuitState.COOLDOWN) {
      for (const cop of this.cops) { cop.searching = false; cop.searchRoute = null; cop.searchIndex = 0; }
    }
    this._prevState = state;

    // Per-cop target depends on pursuit state:
    //  ACTIVE   → chase the player
    //  COOLDOWN → converge on last-known position, then sweep-search outward
    //  DITCHED / IDLE → stand down
    for (const cop of this.cops) {
      let target = null;
      if (state === PursuitState.ACTIVE)        target = this.car.sprite;
      else if (state === PursuitState.COOLDOWN) target = this._cooldownTarget(cop);
      cop.update(delta, target);
    }

    // Debug: line of sight (green=visible, red=blocked) + steering targets
    this.aiDebug.clear();
    for (const cop of this.cops) {
      this.aiDebug.lineStyle(1, cop.hasLOS ? 0x39ff14 : 0xff3b3b, 0.35);
      this.aiDebug.lineBetween(cop.sprite.x, cop.sprite.y, px, py);
      if (cop.aiTarget) {
        this.aiDebug.lineStyle(1, 0xffaa00, 0.5);
        this.aiDebug.lineBetween(cop.sprite.x, cop.sprite.y, cop.aiTarget.x, cop.aiTarget.y);
        this.aiDebug.fillStyle(0xffaa00, 0.8);
        this.aiDebug.fillCircle(cop.aiTarget.x, cop.aiTarget.y, 5);
      }
    }
    // Last-known marker during cooldown
    if (state === PursuitState.COOLDOWN && this.pursuit.hasLastKnown) {
      this.aiDebug.lineStyle(2, 0xffd23f, 0.8);
      this.aiDebug.strokeCircle(this.pursuit.lastKnown.x, this.pursuit.lastKnown.y, 30);
    }

    // Zoom out as speed increases. Reference against natural terminal (~450) rather
    // than the hard cap so the full zoom range is visible during normal driving.
    const speed      = this.car.getSpeed();

    // Camera look-ahead: offset toward current velocity so the player
    // sees more of the road ahead at speed
    const lookX = this.car.vx * 0.15;
    const lookY = this.car.vy * 0.15;
    this.cameras.main.setFollowOffset(-lookX, -lookY);
    const targetZoom = Phaser.Math.Linear(1.0, 0.62, Math.min(speed / 450, 1));
    this.cameras.main.zoom = Phaser.Math.Linear(
      this.cameras.main.zoom, targetZoom, 0.04
    );


    // --- Pursuit HUD ---
    if (state === PursuitState.ACTIVE) {
      this.statusText.setText('● PURSUIT').setColor('#ff3b3b');
      this.cooldownText.setText('');
    } else if (state === PursuitState.COOLDOWN) {
      this.statusText.setText('EVADING').setColor('#ffd23f');
      this.cooldownText.setText(this.pursuit.cooldown.toFixed(1));
    } else if (state === PursuitState.DITCHED) {
      this.statusText.setText('DITCHED').setColor('#39ff14');
      this.cooldownText.setText('');
    } else {
      this.statusText.setText('');
      this.cooldownText.setText('');
    }

    // Debug overlay
    const lines = [
      `FPS:   ${Math.round(this.game.loop.actualFps)}`,
      `Speed: ${Math.round(speed)} px/s`,
      `Cops:  ${this.cops.length}`,
      `State: ${state}`,
    ];

    // Nearest cop + its AI state
    let nearestCop = null, nearestDist = Infinity;
    for (const c of this.cops) {
      const d = Phaser.Math.Distance.Between(c.sprite.x, c.sprite.y, this.car.sprite.x, this.car.sprite.y);
      if (d < nearestDist) { nearestDist = d; nearestCop = c; }
    }
    if (nearestCop) {
      const d = nearestCop.debug;
      lines.push(`Nearest cop: ${Math.round(nearestDist)} px`);
      if (d) {
        lines.push(
          `  mode:  ${d.mode}`,
          `  speed: ${Math.round(d.speed)}  limit: ${Math.round(d.cornerLimit)}`,
          `  bend:  ${(d.bend * 180 / Math.PI).toFixed(0)}°  err: ${(d.angleErr * 180 / Math.PI).toFixed(0)}°`
        );
      }
    }
    if (this.car.isDrifting) lines.push('[HANDBRAKE DRIFT]');
    lines.push('', 'WASD / Arrows — Drive', 'Space — Handbrake', 'Shift — Brake', 'C — Cop console log');
    this.debugText.setText(lines);

    // Throttled console telemetry for the nearest cop
    if (this.copLog && nearestCop && nearestCop.debug) {
      this._copLogTimer += delta;
      if (this._copLogTimer >= 350) {
        this._copLogTimer = 0;
        const d = nearestCop.debug;
        console.log(
          `[cop] ${d.mode.padEnd(14)} spd=${Math.round(d.speed).toString().padStart(3)} ` +
          `lim=${Math.round(d.cornerLimit).toString().padStart(3)} ` +
          `dist=${Math.round(d.dist).toString().padStart(4)} ` +
          `bend=${(d.bend * 180 / Math.PI).toFixed(0).padStart(3)}° ` +
          `err=${(d.angleErr * 180 / Math.PI).toFixed(0).padStart(4)}°` +
          (d.reverseTime > 0 ? ` rev=${d.reverseTime.toFixed(2)}` : '')
        );
      }
    }
  }
}
