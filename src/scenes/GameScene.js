import Phaser from 'phaser';
import GUI from 'lil-gui';
import { PlayerCar } from '../entities/PlayerCar.js';
import { CopCar } from '../entities/CopCar.js';
import { NavGrid } from '../ai/NavGrid.js';
import { segmentClear } from '../ai/lineOfSight.js';
import { PursuitDirector } from '../ai/PursuitDirector.js';
import { Pursuit, PursuitState } from '../systems/Pursuit.js';
import { BustMeter } from '../systems/BustMeter.js';
import {
  WORLD_WIDTH, WORLD_HEIGHT,
  GRID_COLS, GRID_ROWS, BLOCK, ROAD, MARGIN, GRID_STEP,
} from '../config.js';
import { BUILDINGS } from '../world/city.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  init(data) {
    // Cop count chosen in the menu (default 3 if launched directly)
    this.copCount = (data && Number.isInteger(data.copCount)) ? data.copCount : 3;
    // First load starts paused; restarts (R) pass autostart so they drop into play
    this._autostart = !!(data && data.autostart);
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
    this.director   = new PursuitDirector(this.navGrid);
    this.cops       = [];
    this.sightRange = 900;             // px — cop spotting range in clear line
    this.proximityRange = 250;         // px — sensed regardless of line of sight (can't lose someone beside you)
    this.awareGrace = 0.6;             // s — stay aware this long after last perceiving (memory)
    this.sepRadius  = 80;              // separation: how close before cops repel
    this.sepStrength = 150;            // separation: aim push strength
    this.searchSpeed = 250;            // cop speed cap while searching (clean corners)
    this.pursuit    = new Pursuit(20, 30); // 20s to ditch, then 30s of hot search
    // Station the cops withdraw to once the heat cools (SE corner, for testing)
    this.station    = this.navGrid.pos(this.navGrid.index(this.navGrid.cols - 1, this.navGrid.rows - 1));

    // Spawn the chosen number of cops, approaching from different sides
    const cx = WORLD_WIDTH / 2, cy = WORLD_HEIGHT / 2;
    const spawnPts = [
      { x: cx - 504, y: cy },         // west
      { x: cx + 504, y: cy },         // east
      { x: cx,        y: cy + 1008 }, // south
    ];
    for (let i = 0; i < this.copCount && i < spawnPts.length; i++) {
      this._spawnCop(spawnPts[i].x, spawnPts[i].y);
    }

    // The chase is already underway when the mission starts (if there are cops)
    if (this.cops.length) this.pursuit.begin(this.car.sprite.x, this.car.sprite.y);

    // Lose condition
    this.bust   = new BustMeter();
    this.busted = false;

    // Debug graphics for AI steering targets + line of sight
    this.aiDebug = this.add.graphics().setDepth(50);

    this._setupHud();

    // Camera follows with slight lag for a sense of speed
    this.cameras.main.startFollow(this.car.sprite, true, 0.1, 0.1);
    this.cameras.main.setZoom(1.0);

    this._setupInput();
    this._setupDebugOverlay();
    this._setupTunePanel();
    this._setupCopTunePanel();

    // Tear down the DOM tuning panels when the scene restarts / returns to menu,
    // otherwise they stack up duplicates on every R / menu cycle.
    this.events.once('shutdown', () => {
      if (this.gui)    this.gui.destroy();
      if (this.copGui) this.copGui.destroy();
    });

    // Start paused on first load; launching from the menu (autostart) plays now.
    this.paused = false;
    if (!this._autostart) this._togglePause();
  }

  _spawnCop(x, y) {
    const cop = new CopCar(this, x, y, this.navGrid, this.losRects);
    cop.searchSlot = this.cops.length; // 0,1,2… — its angular sector when searching
    // Floating debug label so each cop's AI state is visible in the world
    cop.modeLabel = this.add.text(x, y, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#ffffff',
      backgroundColor: '#000000aa', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(60);
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
    const ARRIVE = 120; // px — "general area" is close enough; no need to hit the exact point
    const lk = this.pursuit.lastKnown;

    if (!cop.searching) {
      const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, lk.x, lk.y);
      // Only head back to the last-known if we're more than ~a block away; if
      // we're already in the area, start searching right here.
      if (d > GRID_STEP) return lk;
      cop.searching = true;
      this._startSearch(cop);
    }

    // Rebuild a fresh sweep from the current spot/heading when the route runs out.
    if (!cop.searchRoute || cop.searchIndex >= cop.searchRoute.length) {
      this._startSearch(cop);
    }
    const wp = cop.searchRoute[cop.searchIndex];
    if (Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, wp.x, wp.y) < ARRIVE) {
      cop.searchIndex++;
    }
    return cop.searchRoute[Math.min(cop.searchIndex, cop.searchRoute.length - 1)];
  }

  _buildSearchRoute(cop, x, y, baseAngle = null) {
    const start = this.navGrid.nearestNode(x, y);
    const nodes = this.navGrid.nodesInRange(start, 2); // nearby intersections

    // Order the nodes into a CIRCULAR sweep by angle around the centre, starting
    // at baseAngle (the cop's current heading when searching from where it is) or,
    // failing that, its sector so different cops spread.
    const n    = Math.max(1, this.cops.length);
    const base = (baseAngle !== null) ? baseAngle : (cop.searchSlot || 0) * (2 * Math.PI / n);
    const pts = nodes.map(idx => {
      const p   = this.navGrid.pos(idx);
      const rel = Phaser.Math.Angle.Wrap(Math.atan2(p.y - y, p.x - x) - base);
      return { p, key: rel < 0 ? rel + 2 * Math.PI : rel }; // 0..2π sweeping from base
    });
    pts.sort((a, b) => a.key - b.key);

    cop.searchRoute = pts.map(s => s.p);
    cop.searchIndex = 0;
  }

  // Begin (or rebuild) a search from the cop's CURRENT position: slot-0 follows
  // the player's escape vector; the rest sweep outward starting in their heading.
  _startSearch(cop) {
    const sx = cop.sprite.x, sy = cop.sprite.y;
    if (cop.searchSlot === 0 && this.pursuit.hasLastKnown) {
      this._buildTrackRoute(cop, sx, sy, this.pursuit.lastKnownDir);
    } else {
      this._buildSearchRoute(cop, sx, sy, cop.facing);
    }
  }

  // Route that follows the player's last-known travel vector: a line of nodes
  // marching in `dir` from the start position, as if chasing where they fled.
  _buildTrackRoute(cop, x, y, dir) {
    const pts = [];
    for (let d = 1; d <= 4; d++) {
      const n = this.navGrid.nearestNode(x + Math.cos(dir) * d * GRID_STEP,
                                         y + Math.sin(dir) * d * GRID_STEP);
      pts.push(this.navGrid.pos(n));
    }
    cop.searchRoute = pts;
    cop.searchIndex = 0;
  }

  // Keep a cop's target inside the navigable interior so nothing pins it on the edge.
  _clampWorld(t) {
    const M = 110;
    return {
      x: Phaser.Math.Clamp(t.x, M, WORLD_WIDTH - M),
      y: Phaser.Math.Clamp(t.y, M, WORLD_HEIGHT - M),
    };
  }

  // Boids-style separation: nudge a cop's aim point away from nearby cops so
  // they spread out and surround the target instead of piling onto one point
  // and jamming each other.
  _separate(cop, target) {
    const R = this.sepRadius, STRENGTH = this.sepStrength;
    let sx = 0, sy = 0;
    for (const other of this.cops) {
      if (other === cop) continue;
      const dx = cop.sprite.x - other.sprite.x;
      const dy = cop.sprite.y - other.sprite.y;
      const d  = Math.hypot(dx, dy);
      if (d > 0.001 && d < R) {
        const w = (R - d) / R; // stronger the closer they are
        sx += (dx / d) * w;
        sy += (dy / d) * w;
      }
    }
    if (sx === 0 && sy === 0) return target;
    return { x: target.x + sx * STRENGTH, y: target.y + sy * STRENGTH };
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

    // Restart any time (same cop count); new run drops straight into play
    this.input.keyboard.on('keydown-R', () => this.scene.restart({ copCount: this.copCount, autostart: true }));
    // Back to the menu
    this.input.keyboard.on('keydown-M', () => this.scene.start('MenuScene'));
    // Pause toggle
    this.input.keyboard.on('keydown-P', () => this._togglePause());

    // Cop telemetry: press C to toggle throttled console logging of cop state
    this.copLog       = false;
    this._copLogTimer = 0;
    this.input.keyboard.on('keydown-C', () => {
      this.copLog = !this.copLog;
      console.log(`[cop telemetry] ${this.copLog ? 'ON' : 'OFF'}`);
    });

    // Spectate: press V to cycle the camera through player → each cop. While
    // viewing a cop, the car is frozen so you can watch a search without driving.
    this.camFocusIndex = 0; // 0 = player, 1..N = cop index + 1
    this.input.keyboard.on('keydown-V', () => {
      this.camFocusIndex = (this.camFocusIndex + 1) % (1 + this.cops.length);
      const sprite = this.camFocusIndex === 0
        ? this.car.sprite
        : this.cops[this.camFocusIndex - 1].sprite;
      this.cameras.main.startFollow(sprite, true, 0.1, 0.1);
    });
  }

  _setupDebugOverlay() {
    this.debugText = this.add.text(10, 46, '', {
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

    // Bust meter bar (bottom centre) + its label
    this.bustGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.bustLabel = this.add.text(width / 2, this.scale.height - 52, 'BUST', {
      fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(100).setAlpha(0);

    // BUSTED overlay
    this.bustedText = this.add.text(width / 2, this.scale.height / 2,
      'BUSTED\n\npress R to restart', {
        fontFamily: 'monospace', fontSize: '56px', fontStyle: 'bold',
        color: '#ff3b3b', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(101).setAlpha(0);

    // PAUSED overlay
    this.pausedText = this.add.text(width / 2, this.scale.height / 2,
      'PAUSED\n\npress P to play', {
        fontFamily: 'monospace', fontSize: '56px', fontStyle: 'bold',
        color: '#ffffff', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(101).setAlpha(0);
  }

  _togglePause() {
    if (this.busted) return;
    this.paused = !this.paused;
    if (this.paused) { this.physics.pause(); this.pausedText.setAlpha(1); }
    else             { this.physics.resume(); this.pausedText.setAlpha(0); }
  }

  _drawBustBar() {
    const g = this.bustGfx;
    g.clear();
    const v = this.bust.value;
    if (v <= 0) { this.bustLabel.setAlpha(0); return; }

    const { width, height } = this.scale;
    const w = 300, h = 16, x = (width - w) / 2, y = height - 40;
    const frac = v / 100;
    const col = frac < 0.5 ? 0xffd23f : frac < 0.8 ? 0xff8c1a : 0xff3b3b;

    g.fillStyle(0x000000, 0.5); g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle(col, 0.9);      g.fillRect(x, y, w * frac, h);
    g.lineStyle(1, 0xffffff, 0.4); g.strokeRect(x, y, w, h);
    this.bustLabel.setAlpha(0.9);
  }

  _flashGhost() {
    this.ghostText.setAlpha(1).setScale(0.8);
    this.tweens.add({ targets: this.ghostText, alpha: 0, scale: 1.4, duration: 1500, ease: 'Cubic.easeOut' });
  }

  _setupTunePanel() {
    const car = this.car;
    const gui = new GUI({ title: 'Car Tuning', width: 280 });
    this.gui = gui;
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

    // Persist across refresh (binds directly to the car, so load sets car fields).
    this._persistPanel(gui, 'gd_carTuning');

    gui.domElement.style.position = 'fixed';
    gui.domElement.style.top   = '8px';
    gui.domElement.style.right = '8px';
    gui.domElement.style.zIndex = '9999';

    this.game.canvas.addEventListener('mousedown', () => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
    });
  }

  _setupCopTunePanel() {
    if (!this.cops.length) return;
    const c = this.cops[0], a = c.ai;

    // Single source of truth for the panel; changes are pushed to every cop.
    // (Cops are kinematic now — grip/turn/accel no longer apply.)
    this.copTuning = {
      maxSpeed: c.baseMaxSpeed,
      motionAccel: c.accel, motionBrake: c.brakeDecel,
      turnRadius: c.turnRadius, maxTurnRate: c.maxTurnRate,
      cornerMinSpeed: a.cornerMinSpeed, maxApproachSpeed: a.baseApproach,
      brakeDecel: a.brakeDecel, arriveRadius: a.arriveRadius,
      senseDist: a.senseDist, directRange: a.directRange,
      sepRadius: this.sepRadius, sepStrength: this.sepStrength,
      searchSpeed: this.searchSpeed,
      flankDist: this.director.flankDist, interceptLead: this.director.interceptLead,
    };

    const gui = new GUI({ title: 'Cop Tuning', width: 300 });
    this.copGui = gui;
    gui.close();
    const apply = () => this._applyCopTuning();

    const motion = gui.addFolder('Motion (accel & turning)');
    motion.add(this.copTuning, 'motionAccel', 50, 3000, 10).name('Acceleration (px/s²)').onChange(apply);
    motion.add(this.copTuning, 'motionBrake', 50, 3000, 10).name('Deceleration (px/s²)').onChange(apply);
    motion.add(this.copTuning, 'turnRadius',  20, 200,  2).name('Turn radius (px)').onChange(apply);
    motion.add(this.copTuning, 'maxTurnRate', 1.0, 8.0, 0.1).name('Max turn rate (rad/s)').onChange(apply);

    const corner = gui.addFolder('Driving');
    corner.add(this.copTuning, 'maxSpeed',         100, 1200, 10).name('Max Speed').onChange(apply);
    corner.add(this.copTuning, 'maxApproachSpeed', 200, 800, 10).name('Straight speed').onChange(apply);
    corner.add(this.copTuning, 'cornerMinSpeed',   80,  500, 5).name('Corner min speed').onChange(apply);
    corner.add(this.copTuning, 'brakeDecel',       100, 800, 10).name('Brake planning').onChange(apply);
    corner.add(this.copTuning, 'arriveRadius',     30,  150, 5).name('Node arrive radius').onChange(apply);
    corner.add(this.copTuning, 'senseDist',        200, 1000, 20).name('Corner sense ahead').onChange(apply);
    corner.add(this.copTuning, 'directRange',      50,  400, 10).name('Direct-aim range').onChange(apply);

    const pack = gui.addFolder('Pack & Search');
    pack.add(this.copTuning, 'flankDist',     50,  400, 10).name('Flank distance').onChange(apply);
    pack.add(this.copTuning, 'interceptLead', 0.2, 3.0, 0.1).name('Intercept lead (s)').onChange(apply);
    pack.add(this.copTuning, 'sepRadius',     0,   250, 5).name('Separation radius').onChange(apply);
    pack.add(this.copTuning, 'sepStrength',   0,   400, 5).name('Separation strength').onChange(apply);
    pack.add(this.copTuning, 'searchSpeed',   80,  600, 10).name('Search speed cap').onChange(apply);

    gui.add({ copyStats: () => {
      const t = this.copTuning;
      console.log(`// --- Cop driving (CopCar / CopAI) ---
maxSpeed: ${t.maxSpeed}, maxApproachSpeed: ${t.maxApproachSpeed}, cornerMinSpeed: ${t.cornerMinSpeed},
brakeDecel: ${t.brakeDecel}, arriveRadius: ${t.arriveRadius}, senseDist: ${t.senseDist}, directRange: ${t.directRange},
// --- Formation (PursuitDirector) ---
flankDist: ${t.flankDist}, interceptLead: ${t.interceptLead},
// --- Separation + search (GameScene) ---
sepRadius: ${t.sepRadius}, sepStrength: ${t.sepStrength}, searchSpeed: ${t.searchSpeed}`);
    } }, 'copyStats').name('Copy Cop Stats → Console');

    // Persist across refresh: load saved values (which re-applies them to the cops
    // via each controller's onChange), then save on every change.
    this._persistPanel(gui, 'gd_copTuning');

    gui.domElement.style.position = 'fixed';
    gui.domElement.style.top  = '8px';
    gui.domElement.style.left = '8px';
    gui.domElement.style.zIndex = '9999';
  }

  // Wire a lil-gui panel to localStorage: restore on open, save on change.
  _persistPanel(gui, key) {
    try {
      const saved = localStorage.getItem(key);
      if (saved) gui.load(JSON.parse(saved));
    } catch (e) { /* corrupt/unavailable storage — ignore, use defaults */ }
    gui.onChange(() => {
      try { localStorage.setItem(key, JSON.stringify(gui.save())); } catch (e) { /* ignore */ }
    });
  }

  _applyCopTuning() {
    const t = this.copTuning;
    for (const cop of this.cops) {
      // baseMaxSpeed is the panel's source of truth; mirror onto the live cap too.
      cop.baseMaxSpeed = t.maxSpeed;
      cop.maxSpeed   = t.maxSpeed;
      cop.accel      = t.motionAccel;
      cop.brakeDecel = t.motionBrake;
      cop.turnRadius = t.turnRadius;
      cop.maxTurnRate = t.maxTurnRate;
      const a = cop.ai;
      a.cornerMinSpeed = t.cornerMinSpeed; a.baseApproach = t.maxApproachSpeed;
      a.maxApproachSpeed = t.maxApproachSpeed;
      a.brakeDecel = t.brakeDecel; a.arriveRadius = t.arriveRadius;
      a.senseDist = t.senseDist; a.directRange = t.directRange;
    }
    this.sepRadius = t.sepRadius;
    this.sepStrength = t.sepStrength;
    this.searchSpeed = t.searchSpeed;
    this.director.flankDist = t.flankDist;
    this.director.interceptLead = t.interceptLead;
  }

  update(_time, delta) {
    // Frozen after a bust (R restarts) or while paused (P resumes) — both keys
    // are handled by their keydown listeners, so just hold here.
    if (this.busted || this.paused) return;

    // While spectating a cop (camera not on the player), freeze the car so the
    // observer can't accidentally drive or re-trigger anything.
    const spectating = this.camFocusIndex !== 0;
    const controls = spectating
      ? { up: false, down: false, left: false, right: false, handbrake: false, brake: false }
      : {
          up:        this.cursors.up.isDown    || this.wasd.W.isDown,
          down:      this.cursors.down.isDown  || this.wasd.S.isDown,
          left:      this.cursors.left.isDown  || this.wasd.A.isDown,
          right:     this.cursors.right.isDown || this.wasd.D.isDown,
          handbrake: this.cursors.space.isDown,
          brake:     this.shiftKey.isDown,
        };

    this.car.update(delta, controls);

    // --- Perception: a cop is AWARE of the player if it has a clear sight line
    // within range, OR the player is within close proximity (omnidirectional —
    // you can't lose someone beside you). Awareness persists for awareGrace after
    // the last perception, so a momentary ray break (corner clip, spin-out) does
    // not drop the chase. ---
    const px = this.car.sprite.x, py = this.car.sprite.y;
    const dt = delta / 1000;
    let anyAware = false;
    let nearestCopDist = Infinity;
    for (const cop of this.cops) {
      const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py);
      if (d < nearestCopDist) nearestCopDist = d;
      const sees = d <= this.proximityRange ||
        (d <= this.sightRange && segmentClear(cop.sprite.x, cop.sprite.y, px, py, this.losRects));
      cop.awareTimer = sees ? this.awareGrace : Math.max(0, (cop.awareTimer || 0) - dt);
      cop.hasLOS = sees;                  // instantaneous, for debug colouring
      cop.aware  = cop.awareTimer > 0;    // includes the memory grace
      if (cop.aware) anyAware = true;
    }

    // --- Pursuit state machine (driven by awareness, not a single-frame ray) ---
    const state = this.pursuit.update(anyAware, px, py, dt);
    if (this.pursuit.justDitched) this._flashGhost();
    // Remember how the player was moving when last seen (for hunt prediction + search vector)
    if (anyAware) {
      this.pursuit.lastKnownDir = this.car.getSpeed() > 40
        ? Math.atan2(this.car.vy, this.car.vx)
        : this.car.facing;
      this.pursuit.lastKnownSpeed = this.car.getSpeed();
    }

    // On entering SEARCH, reset each cop's search so they head to last-known first
    if (state === PursuitState.SEARCH && this._prevState !== PursuitState.SEARCH) {
      for (const cop of this.cops) { cop.searching = false; cop.searchRoute = null; cop.searchIndex = 0; }
    }
    this._prevState = state;

    // Per-cop target depends on pursuit state:
    //  ACTIVE    → chase the player
    //  SEARCH    → converge on last-known, then sweep-search outward (area stays hot)
    //  RETURNING → drive back to the station
    //  IDLE      → parked at the station (stand down)
    // ACTIVE: the Director assigns each cop a role + target (chase/flank/intercept)
    // around the real player. While searching, cops just head to the last-known
    // position and sweep (slot-0 follows the escape direction) — the only thing
    // HUNT changes is that they do it at full speed instead of the slow cap.
    const hunting = state === PursuitState.SEARCH && this.pursuit.hunting;
    if (state === PursuitState.ACTIVE) {
      this.director.update(this.cops, this.car, delta / 1000);
    }

    for (const cop of this.cops) {
      let target = null;
      if      (state === PursuitState.ACTIVE)    target = cop.dirTarget;
      else if (state === PursuitState.SEARCH)    target = this._cooldownTarget(cop);
      else if (state === PursuitState.RETURNING) target = this.station;
      if (target) target = this._clampWorld(this._separate(cop, target));
      // Full speed while chasing OR hunting; capped only for sustained search / withdrawal.
      const slow = (state === PursuitState.SEARCH && !hunting) || state === PursuitState.RETURNING;
      cop.ai.speedCap = slow ? this.searchSpeed : Infinity;
      // Ram the moving player (no arrival easing -> no speed-matched "cruise"); but
      // ease onto stationary targets (last-known / search points / station) so the
      // cop settles instead of jittering across them.
      cop.ai.arriveEase = state !== PursuitState.ACTIVE;
      cop.update(delta, target);
    }

    // Once every cop has reached the station, the area is fully clear
    if (state === PursuitState.RETURNING) {
      const allHome = this.cops.every(c =>
        Phaser.Math.Distance.Between(c.sprite.x, c.sprite.y, this.station.x, this.station.y) < 90
      );
      if (allHome) this.pursuit.markIdle();
    }

    // --- Bust meter (lose condition) ---
    // Pinned = actively pursued, a cop right on you, and you're slow (boxed/stopped).
    const playerSpeed = this.car.getSpeed();
    const pinned = state === PursuitState.ACTIVE &&
                   nearestCopDist < this.bust.pinDistance &&
                   playerSpeed < this.bust.pinSpeed;
    this.bust.update(pinned, delta / 1000);
    if (this.bust.isBusted) {
      this.busted = true;
      this.bustedText.setAlpha(1);
      this.physics.pause();
      return;
    }
    this._drawBustBar();

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
      // Live per-cop label: role (when chasing) + control mode + speed
      if (cop.modeLabel && cop.debug) {
        const role = (state === PursuitState.ACTIVE && cop.role) ? cop.role + ' ' : '';
        cop.modeLabel.setPosition(cop.sprite.x, cop.sprite.y - 34);
        cop.modeLabel.setText(`${role}${cop.debug.mode} ${Math.round(cop.debug.speed)}`);
        cop.modeLabel.setColor(cop.hasLOS ? '#39ff14' : '#ff8c8c');
      }
    }
    // Last-known marker + escape-vector arrow while searching
    if (state === PursuitState.SEARCH && this.pursuit.hasLastKnown) {
      const lk = this.pursuit.lastKnown, dir = this.pursuit.lastKnownDir;
      this.aiDebug.lineStyle(2, 0xffd23f, 0.8);
      this.aiDebug.strokeCircle(lk.x, lk.y, 30);
      // arrow in the direction the player was last heading
      const ex = lk.x + Math.cos(dir) * 90, ey = lk.y + Math.sin(dir) * 90;
      this.aiDebug.lineStyle(3, 0xffd23f, 0.9);
      this.aiDebug.lineBetween(lk.x, lk.y, ex, ey);
      const ah = 0.5;
      this.aiDebug.lineBetween(ex, ey, ex - Math.cos(dir - ah) * 16, ey - Math.sin(dir - ah) * 16);
      this.aiDebug.lineBetween(ex, ey, ex - Math.cos(dir + ah) * 16, ey - Math.sin(dir + ah) * 16);
    }
    // Station marker
    this.aiDebug.lineStyle(2, 0x4a90ff, 0.6);
    this.aiDebug.strokeRect(this.station.x - 24, this.station.y - 24, 48, 48);

    const speed = this.car.getSpeed();

    // Camera: when following the player, add speed-based look-ahead and zoom-out.
    // When spectating a cop, sit centered on it at neutral zoom.
    if (!spectating) {
      const lookX = this.car.vx * 0.15;
      const lookY = this.car.vy * 0.15;
      this.cameras.main.setFollowOffset(-lookX, -lookY);
      const targetZoom = Phaser.Math.Linear(1.0, 0.62, Math.min(speed / 450, 1));
      this.cameras.main.zoom = Phaser.Math.Linear(this.cameras.main.zoom, targetZoom, 0.04);
    } else {
      this.cameras.main.setFollowOffset(0, 0);
      this.cameras.main.zoom = Phaser.Math.Linear(this.cameras.main.zoom, 1.0, 0.06);
    }


    // --- Pursuit HUD ---
    if (!this.cops.length) {
      this.statusText.setText('FREE DRIVE').setColor('#9aa0b5');
      this.cooldownText.setText('');
    } else if (state === PursuitState.ACTIVE || hunting) {
      // Hunting = they just lost sight and are still charging — read as pursuit.
      this.statusText.setText('● PURSUIT').setColor('#ff3b3b');
      this.cooldownText.setText('');
    } else if (state === PursuitState.SEARCH && !this.pursuit.ditched) {
      this.statusText.setText('EVADING').setColor('#ffd23f');
      this.cooldownText.setText(this.pursuit.cooldown.toFixed(1));
    } else if (state === PursuitState.SEARCH && this.pursuit.ditched) {
      this.statusText.setText('AREA HOT').setColor('#ff8c1a');
      this.cooldownText.setText(this.pursuit.hot.toFixed(0));
    } else if (state === PursuitState.RETURNING) {
      this.statusText.setText('WITHDRAWING').setColor('#9aa0b5');
      this.cooldownText.setText('');
    } else {
      this.statusText.setText('CLEAR').setColor('#39ff14');
      this.cooldownText.setText('');
    }

    // Debug overlay
    const view = this.camFocusIndex === 0 ? 'PLAYER' : `COP ${this.camFocusIndex - 1}`;
    const lines = [
      `FPS:   ${Math.round(this.game.loop.actualFps)}`,
      `Speed: ${Math.round(speed)} px/s`,
      `Cops:  ${this.cops.length}`,
      `State: ${state}`,
      `Bust:  ${Math.round(this.bust.value)}%${this.bust.pinned ? ' PINNED' : ''}`,
      `View:  ${view}${spectating ? ' (car frozen)' : ''}`,
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
    lines.push('', 'WASD / Arrows — Drive', 'Space — Handbrake', 'Shift — Brake', 'P — Pause', 'C — Cop console log', 'V — Cycle camera', 'R — Restart', 'M — Menu');
    this.debugText.setText(lines);

    // Throttled console telemetry for every cop
    if (this.copLog) {
      this._copLogTimer += delta;
      if (this._copLogTimer >= 350) {
        this._copLogTimer = 0;
        this.cops.forEach((cop, i) => {
          const d = cop.debug;
          if (!d) return;
          console.log(
            `[cop${i}] ${(cop.hasLOS ? 'LOS ' : '    ')}${d.mode.padEnd(14)} ` +
            `spd=${Math.round(d.speed).toString().padStart(3)} ` +
            `lim=${Math.round(d.cornerLimit).toString().padStart(3)} ` +
            `dist=${Math.round(d.dist).toString().padStart(4)} ` +
            `bend=${(d.bend * 180 / Math.PI).toFixed(0).padStart(3)}° ` +
            `err=${(d.angleErr * 180 / Math.PI).toFixed(0).padStart(4)}°` +
            (d.reverseTime > 0 ? ` rev=${d.reverseTime.toFixed(2)}` : '')
          );
        });
      }
    }
  }
}
