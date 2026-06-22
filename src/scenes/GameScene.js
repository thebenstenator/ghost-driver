import Phaser from "phaser";
import GUI from "lil-gui";
import { PlayerCar } from "../entities/PlayerCar.js";
import { CopCar } from "../entities/CopCar.js";
import { NavGrid } from "../ai/NavGrid.js";
import { segmentClear } from "../ai/lineOfSight.js";
import { CopAI } from "../ai/CopAI.js";
import { UNITS } from "../ai/units.js";
import { PursuitDirector, CopState } from "../ai/PursuitDirector.js";
import { Pursuit, PursuitState } from "../systems/Pursuit.js";
import { PursuitLevel } from "../systems/PursuitLevel.js";
import { BustMeter } from "../systems/BustMeter.js";
import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  BLOCK,
  ROAD,
  MARGIN,
  GRID_STEP,
} from "../config.js";
import { BUILDINGS } from "../world/city.js";

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: "GameScene" });
  }

  // Dev-mode flag, persisted in localStorage and toggled from the menu. Shared so the
  // menu checkbox and the scene read the exact same value.
  static DEV_KEY = "gd_devMode";
  static isDevMode() {
    try {
      return localStorage.getItem(GameScene.DEV_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  static setDevMode(on) {
    try {
      localStorage.setItem(GameScene.DEV_KEY, on ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
  }

  init(data) {
    // Cop count chosen in the menu (default 3 if launched directly)
    this.copCount = data && Number.isInteger(data.copCount) ? data.copCount : 3;
    // First load starts paused; restarts (R) pass autostart so they drop into play
    this._autostart = !!(data && data.autostart);
    // Pursuit Mode: escalating heat/level system (starts at 1 cop and grows). When
    // off, the legacy fixed-cop-count chase runs unchanged. Persisted across R.
    this.pursuitMode = !!(data && data.pursuitMode);
    // Sandbox / cop testbed (dev-only): no escalation, no auto-dispatch — you spawn
    // chosen unit TYPES by hand and tune their def live. Cops are pinned to a relentless
    // ACTIVE chase (no ditch/return/bust) so a unit is always exercising its behavior.
    this.sandbox = !!(data && data.sandbox);
  }

  create() {
    // Dev mode (set from the menu, persisted): when OFF, all dev overlays, labels and
    // tuning panels are suppressed for a clean playtest screen. Read FIRST — cop spawn
    // and HUD setup below branch on it. Game logic is identical either way.
    this.devMode = GameScene.isDevMode();
    // The testbed is reached from a dev-only menu button, so it always wants the dev
    // overlays/panels regardless of the persisted toggle.
    if (this.sandbox) this.devMode = true;

    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Everything in the WORLD goes in this layer; the HUD stays on the scene root. A
    // second UI camera (fixed zoom) renders only the root, and the main camera renders
    // only the world layer — so the HUD is immune to the speed-based zoom. (setScrollFactor
    // pins against scroll but NOT zoom.) UI camera is wired at the end of create().
    this.worldLayer = this.add.layer();

    this._buildWorld();

    // Player starts at the center road intersection
    this.car = new PlayerCar(this, WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    this.worldLayer.add(this.car.sprite);

    this.physics.add.collider(this.car.sprite, this.walls);
    // Player CAPSULE collider (custom): Arcade's body can't rotate, so the car is modelled
    // as 3 circles along its spine and pushed out of walls by hand (rounded → slides along
    // corners). The Arcade square above stays as a centre backstop. (Cars are the next step.)
    this.playerCapHalfLen = 15; // circle offset from centre along the car's facing
    this.playerCapR       = 12; // capsule radius (≈ half the car width)
    this.playerMass       = 1.5; // capsule-collision weight vs cops (heavier → shoves them)
    // Capsule SOLVER quality. Iterating a Gauss–Seidel position solve (with a small slop +
    // relaxation) does two things at once: it stops a packed cluster from jittering (single-
    // pass pushes never converge → buzz), and it lets a STACK propagate resistance so a swarm
    // actually contains you (the front cop "feels" the cops behind it). Friction adds tangential
    // grip so you can't frictionlessly slide out the seam.
    this.capIters    = 4;    // position-solve iterations per frame (1 = old behaviour)
    this.capSlop     = 0.5;  // px of penetration left uncorrected (kills micro-jitter)
    this.capRelax    = 0.8;  // fraction of remaining penetration corrected per iteration
    this.capFriction = 0.25; // 0..1 tangential grip applied at car↔car contacts
    // Scripted RAM impact (frontal only): a fast head-on from a cop dumps the player's speed on
    // top of the inelastic exchange AND bogs the engine briefly, so you can't instantly power
    // through. Scaled by closing speed × how head-on it is × the unit's ramStrength.
    this.ramSpeedKill  = 0.6;  // max fraction of remaining speed a full-intensity ram removes
    this.ramBogTime    = 0.5;  // s of reduced acceleration after a full-intensity ram
    this.ramBogAccel   = 0.35; // engine power multiplier while bogged (lower = harder to recover)
    this.ramRefSpeed   = 380;  // closing speed (px/s) that counts as a "full" ram
    this.ramMinClosing = 120;  // below this closing speed it's a nudge, not a ram
    this.capDebug = this.devMode ? this.add.graphics().setDepth(60) : null;
    if (this.capDebug) this.worldLayer.add(this.capDebug);

    // --- Cops + pursuit ---
    this.navGrid = new NavGrid();
    this.director = new PursuitDirector(this.navGrid, this.losRects);
    this.cops = [];
    this.wrecks = []; // disabled cops, kept as inert obstacles until they despawn
    this.spikes = []; // deployed spike strips (hazard wiring next; visible placeholder for now)
    this.spikeLifetime = 20; // s a dropped strip persists before it despawns
    this.roadblocks = []; // placed block formations (each = dynamic car bodies + visuals)
    // Roadblock cars are DYNAMIC bodies with mass — you SHOVE through them (losing speed),
    // not a brick wall. Player↔car collision is handled by the rotating CAPSULE (so when a
    // car spins broadside-off you can slip past its ends) — see _resolveCapsules. The Arcade
    // body is just a small square backstop + velocity/drag integrator; the walls collider
    // stops a shoved car flying off-road.
    this.roadblockGroup = this.physics.add.group();
    this.physics.add.collider(this.roadblockGroup, this.walls);
    this.sightRange = 900; // px — cop spotting range in clear line
    this.proximityRange = 70; // px — sensed THROUGH walls only at point-blank (can't
    // lose someone on your bumper). Kept small on purpose:
    // a large value meant the cop could never lose you up
    // close, so rounding a building could never break sight.
    // Beyond this, spotting needs a clear line (sightRange).
    this.awareGrace = 0.6; // s — stay aware this long after last perceiving (memory)
    this.sepRadius = 80; // separation: how close before cops repel
    this.sepStrength = 150; // separation: aim push strength
    // Tier-1 rejoin band: a cop that falls behind blends its HANDLING toward a near-
    // kinematic profile (not just speed) so it stops washing into walls and rejoins
    // cleanly. Blend ramps from rbStart (no change) to rbFull (max). Invisible in
    // practice — far cops are off-screen / screen-edge; you only feel that they
    // rejoin. This is the kinematic feel, used where it helps and can't be seen.
    this.rbStart = 700; // px from player where the blend starts
    this.rbFull = 1500; // px from player where the blend is maxed
    this.rbGrip = 0.9; // grip (low & high) at full blend — near on-rails
    this.rbTurnMult = 1.6; // turn-rate multiplier at full blend
    this.rbSpeedBoost = 90; // px/s added to top speed at full blend
    // Tier-2 rejoin (respawn): a cop that's far AND not chasing AND off-screen for a
    // sustained beat is relocated off-screen near the player rather than grinding the
    // whole way back. No handling tune can close a map-width gap; this does, and it
    // sidesteps the fragile long-haul nav entirely (the genre-standard "dispatch a
    // fresh unit"). Hard off-camera gate on BOTH ends so there's never a visible pop-in.
    this.respawnEnabled = true;
    this.respawnDist = 1400; // px from player beyond which a non-chasing cop is "lost"
    this.respawnTime = 4.0; // s a cop must stay lost+off-screen before it's relocated
    this.respawnBandMin = 1000; // nearest it will reappear from the player
    this.respawnBandMax = 1800; // farthest it will look for an off-screen spot
    this.respawnMargin = 110; // px a relocation spot must clear the camera view by
    this.respawnCooldown = 6.0; // s before a just-respawned cop can respawn again (anti-thrash —
    // when zoomed out, off-screen spots are far, so a cop can land
    // still-"lost" and otherwise re-trigger every few seconds)
    this.respawnMinGain = 350; // a relocation must be at least this much closer than the cop's
    // current distance, or it's not worth doing (skip and wait)
    this.respawnSpacing = 300; // a relocation spot must clear other cops by this much, so several
    // reinforcements don't all surface on the same road
    // Breadcrumb trails — each cop records its recent path so blind teammates can
    // convoy-follow a known-drivable route (see PursuitDirector._convoyTarget).
    this.trailSpacing = 35; // px of travel between recorded trail points
    this.trailMax = 36; // points kept per cop (~1260px of trail)
    this.interceptAheadDist = 850; // px down the player's travel that an 'ahead-of-travel'
    // unit (interceptor) spawns, to set up a head-on
    this.interceptEntrySpeed = 260; // px/s an ahead-spawned interceptor enters AT (rolling toward
    // you for the head-on, not parked) — moderate, not full speed

    // --- Cop health / ramming (scripted from velocities, NOT collider geometry) ---
    // Damage = relative impact speed, so a full head-on wrecks a patrol, a rear-end at
    // matched speed barely scratches it, a T-bone is between. Cops also hurt themselves
    // crashing into walls/each other, but ONLY mid-aggressive-action (the cost of choosing
    // to box/block/overtake) — ordinary driving into a wall is free.
    this.ramThreshold = 150; // relative impact speed (px/s) below which a hit does NOTHING
    this.ramScale = 0.12; // cop damage per px/s of relative impact above the threshold
    this.ramContactDist = 40; // px centre-distance counted as a player↔cop hit
    this.ramDmgCooldown = 0.4; // s between damage ticks on one cop (so a single ram = one tick)
    this.selfImpactDrop = 200; // px/s sudden speed loss in a frame that reads as a CRASH (> braking)
    this.selfScale = 0.12; // cop self-damage per px/s of crash, while mid-aggressive-action
    this.wreckDespawn = 30; // s a disabled wreck sits as an obstacle before it's removed
    this.wreckMass = 0.9; // disabled cop body mass — light, so you shove it aside
    this.disableReinforceMult = 1.3; // replacement after a disable takes this × the normal reinforce

    // --- Placed roadblocks (static set-pieces, NOT cap units; player-only collider) ---
    // A formation spans the street across `rbBlockedMin..Max` of its width (the rest is a
    // threadable gap), with ONE axis-aligned static rectangle as the collider — exact-fit
    // and cheap precisely because it's static + on the axis-aligned grid (no capsule/Matter).
    this.roadblockDist = 750;  // px ahead a testbed roadblock is placed
    this.rbCarMass     = 1.0;  // a normal block car's mass (you shove it, losing speed)
    this.rbHeavyMass   = 2.4;  // a heavy's mass — much harder to push through
    this.rbCarDrag     = 600;  // px/s² drag so a shoved car settles instead of sliding forever
    this.rbLifetime    = 30;   // s a placed block lasts before it despawns
    // Scripted spin (Arcade has no angular physics): an OFF-CENTRE hit torques the car so it
    // rotates out of the way — hardest/best at the ends (the MW rear-quarter).
    this.rbSpinFactor  = 0.0004; // hit offset × your speed → spin impulse (÷ car mass)
    this.rbSpinDamp    = 0.93;   // per-frame spin decay (so a spun car settles)
    this.rbSpinMax     = 9;      // rad/s cap on a car's spin
    this.pitTestLevel  = 5;      // sandbox-only stand-in for the pursuit level (drives PIT power)
    this.searchSpeed = 250; // cop speed cap while searching (clean corners)
    this.searchDepth = 2; // STARTING search radius (blocks out from last-known)
    this.searchMaxDepth = 10; // search grows out to this many blocks as ground is checked
    this.coverageTTL = 6; // s a searched node stays "covered" before it's worth re-checking
    this.searchDirBias = 75; // how strongly the search leans toward the last-known escape
    // direction (cops fan across the FORWARD arc, not full circle)
    this.searchDwell = 1.2; // s after losing the trail that EVERY cop heads to last-known
    // before fanning out — a sub-second LOS blip can't spin a cop around
    this.searchStall = 2; // s of no progress toward a search node before a cop ABANDONS it
    // (can't reach it — wedged in an alley / node behind a wall) and re-picks
    // Shared search-coverage map: time (search clock) each nav node was last SEEN
    // by any cop. Cops paint what they can see and head for the least-covered
    // node, so they divide the area instead of re-checking the same streets.
    this.coverage = new Float32Array(
      this.navGrid.cols * this.navGrid.rows,
    ).fill(-1e9);
    this._searchClock = 0;
    this._searchRadius = this.searchDepth; // current (expanding) radius this episode
    this.pursuit = new Pursuit(20, 30); // 20s to ditch, then 30s of hot search
    // Station the cops withdraw to once the heat cools (SE corner, for testing)
    this.station = this.navGrid.pos(
      this.navGrid.index(this.navGrid.cols - 1, this.navGrid.rows - 1),
    );

    // Escalation brain (Pursuit Mode only). Heat → level → cop cap; reinforcements
    // trickle in toward the cap on a timer + an instant one each level-up.
    this.pursuitLevel = this.pursuitMode ? new PursuitLevel() : null;
    // Seed the timer to the full interval so the 2nd cop arrives AFTER it, not instantly
    // (a 0 here dispatched a reinforcement on frame 1 → "started with 2 cops").
    this._reinforceTimer = this.pursuitLevel
      ? this.pursuitLevel.cfg().reinforce
      : 0;

    // Spawn the chosen number of cops, approaching from different sides. The player
    // starts at (cx,cy), so each cop faces that point — south faces north, west faces
    // east, east faces west — instead of all facing north. Pursuit Mode starts with
    // ONE cop (spawnPts[0] = south, so the lone chaser comes from behind a north-bound
    // player) and escalates; legacy mode uses the menu's fixed count.
    const cx = WORLD_WIDTH / 2,
      cy = WORLD_HEIGHT / 2;
    const spawnPts = [
      { x: cx, y: cy + 504 }, // south (the Pursuit-Mode lone cop)
      { x: cx - 504, y: cy }, // west
      { x: cx + 504, y: cy }, // east
    ];
    const startCops = this.sandbox ? 0 : this.pursuitMode ? 1 : this.copCount;
    for (let i = 0; i < startCops && i < spawnPts.length; i++) {
      const cop = this._spawnCop(spawnPts[i].x, spawnPts[i].y);
      cop.facing = Math.atan2(cy - spawnPts[i].y, cx - spawnPts[i].x); // face the player's start
      cop.sprite.setRotation(cop.facing + Math.PI / 2);
    }
    if (this.pursuitLevel) {
      // start the chase at the level-1 profile
      this.pursuit.cooldownDuration = this.pursuitLevel.cfg().cooldown;
      this._applyLevelTuning();
    }

    // The chase is already underway when the mission starts (if there are cops)
    if (this.cops.length)
      this.pursuit.begin(this.car.sprite.x, this.car.sprite.y);

    // Lose condition
    this.bust = new BustMeter();
    this.busted = false;

    // Debug graphics for AI steering targets + line of sight (dev only)
    this.aiDebug = this.devMode ? this.add.graphics().setDepth(50) : null;
    if (this.aiDebug) this.worldLayer.add(this.aiDebug);

    // Per-cop health bars — drawn in world space above each damaged cop (see _drawHealthBars).
    this.healthBars = this.add.graphics().setDepth(11);
    this.worldLayer.add(this.healthBars);

    // Deployed spike strips — drawn in world space under the cars (see _updateSpikes).
    this.spikeGfx = this.add.graphics().setDepth(7);
    this.worldLayer.add(this.spikeGfx);

    this._setupHud();

    // Camera follows with slight lag for a sense of speed
    this.cameras.main.startFollow(this.car.sprite, true, 0.1, 0.1);
    this.cameras.main.setZoom(1.0);

    this._setupInput();
    if (this.devMode) {
      this._setupDebugOverlay();
      this._setupTunePanel();
      if (this.sandbox) {
        this._setupTestbedPanel(); // spawn/clear chosen unit types
        this._setupUnitTunePanel(this._testbed.unitType); // tune the selected type's def
        this._setupManeuverPanel(); // tune director maneuver/box behavior
        this._setupHealthPanel(); // tune cop health / ramming / disabling
      } else {
        this._setupCopTunePanel();
        if (this.pursuitLevel) this._setupPursuitPanel();
      }
    }

    // --- HUD camera ---------------------------------------------------------------
    // A second camera at fixed zoom renders ONLY the HUD (scene-root objects); the main
    // camera renders ONLY the world layer. This keeps the HUD a constant on-screen size
    // regardless of the speed zoom-out (setScrollFactor doesn't counter zoom). Built
    // after all HUD objects exist (incl. the dev debugText).
    this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCamera.setScroll(0, 0);
    const hud = [
      this.statusText,
      this.cooldownText,
      this.ghostText,
      this.bustGfx,
      this.bustLabel,
      this.bustedText,
      this.pausedText,
      this.heatGfx,
      this.heatLabel,
      this.reinforceText,
    ];
    if (this.debugText) hud.push(this.debugText);
    if (this.copCountText) hud.push(this.copCountText);
    this.cameras.main.ignore(hud); // world cam skips HUD
    this.uiCamera.ignore(this.worldLayer); // UI cam skips the world (and its future children)

    // Tear down the DOM tuning panels when the scene restarts / returns to menu,
    // otherwise they stack up duplicates on every R / menu cycle.
    this.events.once("shutdown", () => {
      if (this.gui) this.gui.destroy();
      if (this.copGui) this.copGui.destroy();
      if (this.pursuitGui) this.pursuitGui.destroy();
      if (this.testbedGui) this.testbedGui.destroy();
      if (this.unitGui) this.unitGui.destroy();
      if (this.maneuverGui) this.maneuverGui.destroy();
      if (this.healthGui) this.healthGui.destroy();
    });

    // Start paused on first load; launching from the menu (autostart) plays now.
    this.paused = false;
    if (!this._autostart) this._togglePause();
  }

  _spawnCop(x, y, unitType = "patrol") {
    const cop = new CopCar(this, x, y, this.navGrid, this.losRects, unitType);
    this.worldLayer.add(cop.sprite); // world layer → rendered by main cam, not the UI cam
    cop.searchSlot = this.cops.length; // 0,1,2… — its angular sector when searching
    // Floating debug label so each cop's AI state is visible in the world (dev only)
    cop.modeLabel = this.devMode
      ? this.add
          .text(x, y, "", {
            fontFamily: "monospace",
            fontSize: "11px",
            color: "#ffffff",
            backgroundColor: "#000000aa",
            padding: { x: 3, y: 1 },
          })
          .setOrigin(0.5, 1)
          .setDepth(60)
      : null;
    if (cop.modeLabel) this.worldLayer.add(cop.modeLabel);
    this.physics.add.collider(cop.sprite, this.walls);
    // Player↔cop contact: bump heat in Pursuit Mode (the "minor collision" escalator),
    // throttled so a sustained scrape doesn't spike it every frame.
    this.physics.add.collider(cop.sprite, this.car.sprite, () => {
      if (this.pursuitLevel && this.time.now - (this._lastRamAt || 0) > 600) {
        this._lastRamAt = this.time.now;
        this.pursuitLevel.addHeat(this.pursuitLevel.ramHeat);
      }
    });
    // Cops bump off each other rather than stacking
    for (const other of this.cops)
      this.physics.add.collider(cop.sprite, other.sprite);
    this.cops.push(cop);
    return cop;
  }

  // The candidate nodes for a search: the last-known node + everything within the
  // current (expanding) search radius of it.
  _searchArea() {
    const lk = this.pursuit.lastKnown;
    const lkNode = this.navGrid.nearestNode(lk.x, lk.y);
    return [lkNode, ...this.navGrid.nodesInRange(lkNode, this._searchRadius)];
  }

  // Paint coverage: mark every search node this cop can actually SEE (within sight
  // range AND clear line of sight) as covered now. Shared across cops, so others
  // know that ground is checked.
  _paintCoverage(cop, area) {
    for (const idx of area) {
      const p = this.navGrid.pos(idx);
      const d = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        p.x,
        p.y,
      );
      if (
        d <= this.sightRange &&
        segmentClear(cop.sprite.x, cop.sprite.y, p.x, p.y, this.losRects)
      ) {
        this.coverage[idx] = this._searchClock;
      }
    }
  }

  // Goal for a cop still in an ACTIVE chase but WITHOUT its own sight line: drive to
  // the LAST-KNOWN location and see if it can re-acquire en route. Nothing clever — no
  // projecting ahead of where the player went (that aimed the cop at a node around the
  // corner, off to its side, so a cop two blocks back mid-street steered into the wall).
  // Last-known is the live chase point whenever ANY cop can see the player (it's updated
  // every sighting) and the frozen last sighting otherwise, so this also pulls a blind
  // cop toward an in-progress chase. CopAI routes there on the road network.
  _huntGoal() {
    const lk = this.pursuit.lastKnown;
    return { x: lk.x, y: lk.y };
  }

  // Where a cop drives once it's lost the trail (SEARCH). It heads for the
  // LEAST-COVERED node near the last-known spot — uncovered ground first, then
  // nearest + biased toward this cop's sector, while avoiding a node another cop
  // is already going to. With shared coverage the cops divide up the area instead
  // of re-checking the same streets, and they stay within `searchDepth` blocks of
  // where you vanished. Hunt vs slow only changes speed, not this plan.
  _cooldownTarget(cop) {
    const ARRIVE = 120;
    const lk = this.pursuit.lastKnown;

    // JUST-LOST DWELL: for the first searchDwell seconds of SEARCH, every cop drives
    // to the LAST-KNOWN spot — no frontier fan yet. A sub-second LOS blip (you cut a
    // corner) then can't spin a cop around toward a far search node before the chase
    // resumes; only a genuinely lost trail fans them out.
    if (this._searchClock < this.searchDwell) {
      cop._searchNode = null;
      return lk;
    }

    const area = this._searchArea();

    // COMMIT to the current target until we PHYSICALLY reach it. Don't abandon it
    // just because we now SEE it (that was the dithering bug: spotting the node a
    // block ahead marked it covered, so the cop re-picked and never committed to a
    // turn). Drive through the intersection, THEN choose the next node.
    //
    // ...BUT abandon it if we stop making progress toward it (wedged in an alley, or
    // the node sits behind a wall we can't thread). Without this, a cop that can't
    // reach its node recommits to it forever: drive at the wall, K-turn, drive at the
    // SAME wall, loop for 30s+. On abandon we mark it covered so nobody re-picks it.
    if (cop._searchNode != null && area.includes(cop._searchNode)) {
      const p = this.navGrid.pos(cop._searchNode);
      const d = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        p.x,
        p.y,
      );
      if (d >= ARRIVE) {
        if (d < (cop._searchBest ?? Infinity) - 20) {
          // closing in → keep committing
          cop._searchBest = d;
          cop._searchStallSince = this._searchClock;
        }
        const stalled =
          this._searchClock - (cop._searchStallSince ?? this._searchClock) >
          this.searchStall;
        if (!stalled) return p;
        this.coverage[cop._searchNode] = this._searchClock; // give up: mark covered, re-pick below
      }
    }

    // Pick the next node: uncovered ground first, then prefer CONTINUING in the
    // direction we're already facing (so we flow down a street instead of turning
    // back at each intersection), with a mild per-cop sector spread, and avoid a
    // node another cop is already going to.
    // Each cop's preferred direction: the escape vector, fanned across the FORWARD
    // arc so multiple cops split the likely area (1 cop -> straight down the escape
    // vector; N cops -> spread over ~180° centred on it) rather than one going the
    // opposite way. This makes the whole search prefer where you probably went.
    const n = Math.max(1, this.cops.length);
    const fanDir =
      this.pursuit.lastKnownDir +
      (((cop.searchSlot || 0) - (n - 1) / 2) / n) * Math.PI;
    let best = area[0],
      bestCost = Infinity;
    for (const idx of area) {
      const p = this.navGrid.pos(idx);
      const recency = this._searchClock - this.coverage[idx];
      const d = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        p.x,
        p.y,
      );
      const fwd = Math.abs(
        Phaser.Math.Angle.Wrap(
          Math.atan2(p.y - cop.sprite.y, p.x - cop.sprite.x) - cop.facing,
        ),
      );
      const dir = Math.abs(
        Phaser.Math.Angle.Wrap(Math.atan2(p.y - lk.y, p.x - lk.x) - fanDir),
      );
      if (d < 1) continue; // skip the node we're sitting on
      let cost =
        0.25 * d +
        90 * fwd +
        this.searchDirBias * dir -
        Math.min(recency, 30) * 2;
      const neverSeen = this.coverage[idx] <= -1e8;
      if (recency < this.coverageTTL)
        cost += 1e6; // freshly covered — avoid
      else if (!neverSeen) cost += 3000; // seen but stale — re-check only if no frontier left
      // never-seen nodes (the expanding frontier) get no penalty, so they win
      if (this.cops.some((o) => o !== cop && o._searchNode === idx))
        cost += 8000; // claimed by another cop
      if (cost < bestCost) {
        bestCost = cost;
        best = idx;
      }
    }
    cop._searchNode = best;
    cop._searchBest = Infinity;
    cop._searchStallSince = this._searchClock; // reset progress watch
    return this.navGrid.pos(best);
  }

  // Keep a cop's target just off the world wall. The edge lane IS navigable now (the
  // nav grid has a perimeter ring at MARGIN/2 from the wall), so this only trims the
  // last few px so a target can't sit on the boundary itself — it must not push targets
  // off the edge lane, or cops couldn't chase along the map edge.
  _clampWorld(t) {
    const M = 30;
    return {
      x: Phaser.Math.Clamp(t.x, M, WORLD_WIDTH - M),
      y: Phaser.Math.Clamp(t.y, M, WORLD_HEIGHT - M),
    };
  }

  // Boids-style separation: nudge a cop's aim point away from nearby cops so
  // they spread out and surround the target instead of piling onto one point
  // and jamming each other.
  _separate(cop, target) {
    const R = this.sepRadius,
      STRENGTH = this.sepStrength;
    let sx = 0,
      sy = 0;
    for (const other of this.cops) {
      if (other === cop) continue;
      const dx = cop.sprite.x - other.sprite.x;
      const dy = cop.sprite.y - other.sprite.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001 && d < R) {
        const w = (R - d) / R; // stronger the closer they are
        sx += (dx / d) * w;
        sy += (dy / d) * w;
      }
    }
    if (sx === 0 && sy === 0) return target;
    return { x: target.x + sx * STRENGTH, y: target.y + sy * STRENGTH };
  }

  // Append the cop's current position to its breadcrumb trail, sampled by distance
  // so the list stays short. Blind teammates follow this trail to relay in (convoy).
  _recordTrail(cop) {
    if (!cop._trail) cop._trail = [];
    const t = cop._trail,
      last = t[t.length - 1];
    if (
      !last ||
      Phaser.Math.Distance.Between(
        last.x,
        last.y,
        cop.sprite.x,
        cop.sprite.y,
      ) >= this.trailSpacing
    ) {
      t.push({ x: cop.sprite.x, y: cop.sprite.y });
      if (t.length > this.trailMax) t.shift();
    }
  }

  // Tier-1 rejoin band: lerp a cop's live handling from its base "in the fight"
  // profile toward a near-kinematic one as it falls behind, so far cops stop washing
  // into walls and rejoin cleanly. Writes the live stat fields each frame (Vehicle
  // reads them directly); the base copies on the cop are what we blend FROM, so the
  // tuning panel still owns the baseline.
  _applyRejoinBand(cop, dist) {
    const f = Phaser.Math.Clamp(
      (dist - this.rbStart) / Math.max(1, this.rbFull - this.rbStart),
      0,
      1,
    );
    cop.maxSpeed = cop.baseMaxSpeed + this.rbSpeedBoost * f;
    cop.gripLow = Phaser.Math.Linear(cop.baseGripLow, this.rbGrip, f);
    cop.gripHigh = Phaser.Math.Linear(cop.baseGripHigh, this.rbGrip, f);
    const turnMult = 1 + (this.rbTurnMult - 1) * f;
    cop.turnSpeedLow = cop.baseTurnSpeedLow * turnMult;
    cop.turnSpeed = cop.baseTurnSpeed * turnMult;
  }

  // Is a world point clear of the camera view by `margin` px (i.e. safely off-screen)?
  _offCamera(x, y, margin = 0) {
    const v = this.cameras.main.worldView;
    return (
      x < v.x - margin ||
      x > v.right + margin ||
      y < v.y - margin ||
      y > v.bottom + margin
    );
  }

  // Tier-2: relocate cops that have been lost (far + not chasing + off-screen) for a
  // sustained beat. Per cop, accumulate "lost" time; once over the threshold and the
  // cop itself is off-screen, try to warp it to a fresh off-screen road node near the
  // player (biased to the side it was coming from). Nothing happens if no off-screen
  // spot is available (e.g. player in the open) — it just waits, so no pop-in.
  _respawnLostCops(px, py, dt) {
    if (!this.respawnEnabled) return;
    for (const cop of this.cops) {
      cop._respawnCd = Math.max(0, (cop._respawnCd || 0) - dt);
      const dp = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        px,
        py,
      );
      const lost = dp > this.respawnDist && cop.pursuitMode !== "DIRECT";
      cop._lostT = lost ? (cop._lostT || 0) + dt : 0;
      // An 'ahead-of-travel' unit (interceptor) that's fallen behind respawns AHEAD to
      // retry the head-on, not behind via the flank relocator — that's its whole loop.
      const ahead = cop.unitDef && cop.unitDef.placement === "ahead-of-travel";
      if (
        cop._lostT > this.respawnTime &&
        cop._respawnCd <= 0 &&
        this._offCamera(cop.sprite.x, cop.sprite.y, this.respawnMargin) &&
        (ahead
          ? this._placeAhead(cop, px, py)
          : this._tryRespawnCop(cop, px, py))
      ) {
        cop._lostT = 0;
        cop._respawnCd = this.respawnCooldown;
        if (this.copLog) {
          const ndp = Phaser.Math.Distance.Between(
            cop.sprite.x,
            cop.sprite.y,
            px,
            py,
          );
          console.log(
            `[t=${(this.time.now / 1000).toFixed(2)}] RESPAWN cop${this.cops.indexOf(cop)} (was ${Math.round(dp)}px) -> ${Math.round(ndp)}px`,
          );
        }
      }
    }
  }

  // Find an off-screen road node near the player, biased to the bearing the cop is
  // currently coming from (so it re-enters from the same side), and drop the cop there
  // facing the player with fresh state. Returns false if no valid off-screen spot.
  _tryRespawnCop(cop, px, py) {
    const cur = Phaser.Math.Distance.Between(
      cop.sprite.x,
      cop.sprite.y,
      px,
      py,
    );
    // Bias to the bearing the cop came from, but jitter it so several cops respawning
    // at once don't all snap to the SAME road ("all 3 came out of the same alley").
    const base =
      Math.atan2(cop.sprite.y - py, cop.sprite.x - px) +
      (Math.random() - 0.5) * 0.7;
    const angOffsets = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3, Math.PI];
    for (const off of angOffsets) {
      const ang = base + off;
      for (let d = this.respawnBandMin; d <= this.respawnBandMax; d += 200) {
        const tx = Phaser.Math.Clamp(
          px + Math.cos(ang) * d,
          120,
          WORLD_WIDTH - 120,
        );
        const ty = Phaser.Math.Clamp(
          py + Math.sin(ang) * d,
          120,
          WORLD_HEIGHT - 120,
        );
        const p = this.navGrid.pos(this.navGrid.nearestNode(tx, ty));
        // Must be off-screen, a real improvement (no "1605 -> 1610" no-op), AND not
        // right on top of another cop (so reinforcements spread out, not pile up).
        if (
          Phaser.Math.Distance.Between(p.x, p.y, px, py) <
            cur - this.respawnMinGain &&
          this._offCamera(p.x, p.y, this.respawnMargin) &&
          !this.cops.some(
            (o) =>
              o !== cop &&
              Phaser.Math.Distance.Between(o.sprite.x, o.sprite.y, p.x, p.y) <
                this.respawnSpacing,
          )
        ) {
          this._placeCop(cop, p.x, p.y, px, py);
          return true;
        }
      }
    }
    return false;
  }

  // Hard-reset a cop at (x,y) facing the player, clearing all transient chase state.
  _placeCop(cop, x, y, px, py) {
    cop.sprite.body.reset(x, y); // moves the body + zeroes its velocity
    cop.vx = 0;
    cop.vy = 0;
    cop.facing = Math.atan2(py - y, px - x);
    cop.sprite.setRotation(cop.facing + Math.PI / 2);
    cop._trail = [];
    cop.pursuitMode = "LONE";
    cop.convoyLeader = null;
    cop._blindT = 0;
    cop._modeTimer = 0;
    cop._searchNode = null;
    const a = cop.ai;
    a._unstuck = null;
    a._stuckTime = 0;
    a._losTimer = 0;
    a._path = null;
    a._goalNode = -1;
    a._aimHist = [];
  }

  // --- Pursuit Mode: escalation + reinforcement (only runs when pursuitLevel exists) -
  // Push the current level's aggression knobs onto the cops + director + ditch timer.
  _applyLevelTuning() {
    const c = this.pursuitLevel.cfg();
    for (const cop of this.cops) cop.ai.reactionTime = c.reaction;
    this.director.boxTriggerSpeed = c.boxTrigger;
    this.pursuit.cooldownDuration = c.cooldown;
  }

  // Advance heat → level, dispatch/retire cops toward the level cap. `state` is the
  // pursuit state this frame. Heat rises in ACTIVE, freezes in pre-ditch cooldown,
  // bleeds once ditched/standing down — so a brief LOS flicker can't bleed a level.
  _updatePursuitLevel(state, dt) {
    const P = this.pursuitLevel;
    const phase =
      state === PursuitState.ACTIVE
        ? "ACTIVE"
        : state === PursuitState.SEARCH && !this.pursuit.ditched
          ? "HOLD"
          : "BLEED";
    const dLevel = P.update(phase, dt);
    if (dLevel !== 0) this._applyLevelTuning();

    const cap = P.cfg().cap;
    // Level-up: immediately call in one reinforcement (then the timer fills the rest).
    if (dLevel > 0 && this.cops.length < cap && state === PursuitState.ACTIVE) {
      this._dispatchReinforcement();
      this._reinforceTimer = P.cfg().reinforce;
    }
    // Bled down a level: retire the extra cop(s) — they peel off the chase.
    if (dLevel < 0) while (this.cops.length > cap) this._retireFarthestCop();

    // Trickle reinforcements up to the cap while actively pursuing.
    if (state === PursuitState.ACTIVE && this.cops.length < cap) {
      this._reinforceTimer -= dt;
      if (this._reinforceTimer <= 0) {
        this._dispatchReinforcement();
        this._reinforceTimer = P.cfg().reinforce;
      }
    } else if (this.cops.length >= cap) {
      this._reinforceTimer = P.cfg().reinforce; // hold full until a slot opens
    }
  }

  // Which unit type to dispatch next, so the active pack fills toward the level's
  // ROSTER composition instead of a flat count. Walks the roster (threat order is the
  // authoring order) and returns the first type the pack is short on; falls back to
  // patrol once every roster slot is met (or the roster is empty). A roster type whose
  // def doesn't exist yet (e.g. interceptor pre-Phase-D) resolves to a placeholder
  // patrol in `_spawnCop`/`unitDef`, so today this still produces an all-patrol pack —
  // identical to before the UnitDef refactor — while the plumbing is roster-ready.
  _nextReinforcementType() {
    const roster = this.pursuitLevel.cfg().roster;
    if (!roster) return "patrol";
    const have = {};
    for (const cop of this.cops)
      have[cop.unitType] = (have[cop.unitType] || 0) + 1;
    for (const type of Object.keys(roster)) {
      if ((have[type] || 0) < roster[type]) return type;
    }
    return "patrol";
  }

  // Create a fresh cop off-screen near the player (reuses the Tier-2 placement) and
  // drop it into the active pursuit — "dispatch a unit from that direction".
  _dispatchReinforcement() {
    const px = this.car.sprite.x,
      py = this.car.sprite.y;
    const cop = this._spawnCop(px, py, this._nextReinforcementType()); // temp position; relocated below
    cop.ai.reactionTime = this.pursuitLevel.cfg().reaction;
    if (cop.unitDef.placement === "ahead-of-travel") {
      // Interceptor enters AHEAD for a head-on, not from the flank.
      this._placeAhead(cop, px, py);
    } else {
      // Flank-offscreen: bias the spawn to a random bearing so reinforcements don't all
      // come from one spot.
      cop.sprite.setPosition(
        px + Math.cos(Math.random() * Math.PI * 2) * this.respawnBandMax,
        py + Math.sin(Math.random() * Math.PI * 2) * this.respawnBandMax,
      );
      if (!this._tryRespawnCop(cop, px, py)) {
        // No off-screen spot found — place at a clamped band point facing the player.
        const a = Math.random() * Math.PI * 2;
        const x = Phaser.Math.Clamp(
          px + Math.cos(a) * this.respawnBandMin,
          120,
          WORLD_WIDTH - 120,
        );
        const y = Phaser.Math.Clamp(
          py + Math.sin(a) * this.respawnBandMin,
          120,
          WORLD_HEIGHT - 120,
        );
        const p = this.navGrid.pos(this.navGrid.nearestNode(x, y));
        this._placeCop(cop, p.x, p.y, px, py);
      }
    }
    this._reinforceFlashUntil = this.time.now + 1400; // HUD flash near the heat bar
    if (this.copLog)
      console.log(
        `[t=${(this.time.now / 1000).toFixed(2)}] DISPATCH cop${this.cops.length - 1} (L${this.pursuitLevel.level}, ${this.cops.length} active)`,
      );
  }

  // Remove the cop farthest from the player from the active pursuit (used on bleed-down).
  _retireFarthestCop() {
    const px = this.car.sprite.x,
      py = this.car.sprite.y;
    let far = null,
      fd = -Infinity;
    for (const cop of this.cops) {
      const d = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        px,
        py,
      );
      if (d > fd) {
        fd = d;
        far = cop;
      }
    }
    if (!far) return;
    this.cops = this.cops.filter((c) => c !== far);
    if (far.modeLabel) far.modeLabel.destroy();
    far.sprite.destroy();
    if (this.copLog)
      console.log(
        `[t=${(this.time.now / 1000).toFixed(2)}] RETIRE cop (L${this.pursuitLevel.level}, ${this.cops.length} active)`,
      );
  }

  // --- Cop testbed (sandbox mode) --------------------------------------------------
  // Hand-driven roster for developing/tuning a single unit type, with no pursuit level
  // or dispatcher in the loop. Spawn N cops of a chosen TYPE, each entered via its
  // placement strategy; Clear wipes them.
  _testbedSpawn(type, count) {
    const px = this.car.sprite.x,
      py = this.car.sprite.y;
    for (let i = 0; i < count; i++) {
      const cop = this._spawnCop(px, py, type);
      this._placeByStrategy(cop, px, py);
    }
  }

  // Enter a freshly spawned cop according to its def's placement strategy. This only
  // picks WHERE it appears — the cop then drives with the same shared CopAI brain.
  _placeByStrategy(cop, px, py) {
    if (cop.unitDef.placement === "ahead-of-travel") {
      this._placeAhead(cop, px, py); // interceptor head-on entry (and respawn retry)
      return;
    }
    // flank-offscreen (default): a road node a few blocks out at a random bearing.
    const ang = Math.random() * Math.PI * 2;
    const d = 450 + Math.random() * 250;
    const tx = Phaser.Math.Clamp(
      px + Math.cos(ang) * d,
      120,
      WORLD_WIDTH - 120,
    );
    const ty = Phaser.Math.Clamp(
      py + Math.sin(ang) * d,
      120,
      WORLD_HEIGHT - 120,
    );
    const p = this.navGrid.pos(this.navGrid.nearestNode(tx, ty));
    this._placeCop(cop, p.x, p.y, px, py);
  }

  // 'ahead-of-travel' placement: drop a cop down the player's predicted travel, facing
  // back at the player and ALREADY ROLLING toward them — so it reads as a car driving in
  // for a head-on, not a parked wall. Used for the interceptor's initial entry AND its
  // respawn-ahead retry. Prefers an off-screen node ahead (walking outward) so it doesn't
  // pop in. Returns true (always places).
  _placeAhead(cop, px, py) {
    const car = this.car;
    const dir = car.getSpeed() > 40 ? Math.atan2(car.vy, car.vx) : car.facing;
    let spot = null;
    for (
      let d = this.interceptAheadDist;
      d <= this.interceptAheadDist + 900;
      d += 150
    ) {
      const tx = px + Math.cos(dir) * d,
        ty = py + Math.sin(dir) * d;
      const p = this.navGrid.pos(
        this.navGrid.nearestNodeAhead(tx, ty, px, py, dir),
      );
      if (!spot) spot = p;
      if (this._offCamera(p.x, p.y, 0)) {
        spot = p;
        break;
      } // first off-screen node ahead wins
    }
    this._placeCop(cop, spot.x, spot.y, px, py);
    // Enter at a moderate closing speed (not full), along its facing (toward the player),
    // so the head-on starts with momentum instead of from a dead stop.
    const s = this.interceptEntrySpeed;
    cop.vx = Math.cos(cop.facing) * s;
    cop.vy = Math.sin(cop.facing) * s;
    cop.sprite.body.setVelocity(cop.vx, cop.vy);
    return true;
  }

  // Remove every cop AND wreck (sprites, labels, tweens, stale director refs).
  _clearCops() {
    for (const cop of [...this.cops, ...this.wrecks]) {
      this.tweens.killTweensOf(cop.sprite);
      if (cop.modeLabel) cop.modeLabel.destroy();
      cop.sprite.destroy();
    }
    this.cops = [];
    this.wrecks = [];
    this._clearRoadblocks();
    this.director._maneuverHolder = null;
    this.director._boxFrontCop = null;
  }

  // A cop is in an aggressive ACTION (boxing / blocking / overtaking) — the only states in
  // which crashing into a wall or another cop costs it health. Plain pursuit driving is free.
  _isAggressiveRole(cop) {
    const r = cop.role;
    return (
      r === CopState.BOX_FRONT ||
      r === CopState.BOX_REAR ||
      r === CopState.BLOCK ||
      r === CopState.OVERTAKE ||
      r === CopState.PIT ||
      r === CopState.SPIKE ||
      r === CopState.DEPLOY
    );
  }

  // Cop SELF-damage + the per-cop damage cooldown. Player↔cop RAM damage is measured at the
  // genuine capsule contact instead (see _ramDamageCop, called from _resolveCapsules) — the old
  // proximity gate (ramContactDist) fired AFTER the solver had already bled the closing speed,
  // so rams read as softer than they hit. This path only handles a cop crashing itself into a
  // wall / another cop mid-aggression. Reads velocities at the TOP of the frame (pre-physics).
  _updateCopDamage(dt) {
    const px = this.car.sprite.x,
      py = this.car.sprite.y;
    let toDisable = null;
    for (const cop of this.cops) {
      cop._dmgCd = Math.max(0, (cop._dmgCd || 0) - dt);
      const spd = cop.getSpeed();
      const drop = (cop._prevSpeed ?? spd) - spd; // sudden loss of ACTUAL speed = a crash this frame
      cop._prevSpeed = spd;
      // Don't double-count a hit on the PLAYER as a self-crash — that's the ram path's job.
      const near =
        Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py) <
        this.ramContactDist;

      if (
        cop._dmgCd <= 0 &&
        !near &&
        drop > this.selfImpactDrop &&
        this._isAggressiveRole(cop)
      ) {
        // Mid-aggression crash into a wall / another cop.
        const dmg =
          ((drop - this.selfImpactDrop) * this.selfScale) / (cop.mass || 1);
        if (dmg > 0) {
          cop.health -= dmg;
          cop._dmgCd = this.ramDmgCooldown;
          if (cop.health <= 0) (toDisable ||= []).push(cop);
        }
      }
    }
    if (toDisable) for (const cop of toDisable) this._disableCop(cop);
  }

  // Player↔cop RAM damage, called from the capsule contact (_capsuleVsCapsule) at the real
  // moment of impact. Uses the PRE-collision closing speed (the caches the solver hasn't touched
  // yet), so a head-on does full damage no matter how fast the solver then bleeds it off. One
  // tick per ram via the shared _dmgCd cooldown. Disable is deferred (the caller drains the list
  // after the agent loop, so this.cops isn't mutated mid-resolve).
  _ramDamageCop(cop) {
    if (cop.disabled || (cop._dmgCd || 0) > 0) return;
    const rel = Math.hypot(
      (this._carLastVx ?? this.car.vx) - (cop._lastVx ?? cop.vx),
      (this._carLastVy ?? this.car.vy) - (cop._lastVy ?? cop.vy),
    );
    if (rel <= this.ramThreshold) return;
    cop.health -= ((rel - this.ramThreshold) * this.ramScale) / (cop.mass || 1);
    cop._dmgCd = this.ramDmgCooldown;
    if (cop.health <= 0) (this._capDisable ||= []).push(cop);
  }

  // Disable a cop: spin it out, drop it from the active pack, leave it as a low-mass wreck
  // obstacle that despawns after a timer. In pursuit it also spikes heat and slows the
  // replacement (onCopDisabled + the disableReinforceMult delay).
  _disableCop(cop) {
    if (cop.disabled) return;
    cop.disabled = true;
    cop.health = 0;
    cop.vx = 0;
    cop.vy = 0;
    cop.sprite.body.setVelocity(0, 0);
    cop.sprite.body.setDrag(400, 400); // bleed off any shove so it settles
    cop.sprite.body.mass = this.wreckMass;
    cop.sprite.setTintFill(0xff2a2a).setAlpha(0.7); // red = unmistakably disabled
    this.tweens.add({
      targets: cop.sprite,
      angle: cop.sprite.angle + (Math.random() < 0.5 ? -120 : 120),
      duration: 500,
      ease: "Cubic.easeOut",
    });
    if (cop.modeLabel) cop.modeLabel.setText("WRECK").setColor("#888");

    this.cops = this.cops.filter((c) => c !== cop);
    cop._wreckT = 0;
    this.wrecks.push(cop);
    if (this.director._maneuverHolder === cop)
      this.director._maneuverHolder = null;

    if (this.pursuitLevel) {
      this.pursuitLevel.onCopDisabled(); // heat spike
      this._reinforceTimer =
        this.pursuitLevel.cfg().reinforce * this.disableReinforceMult;
    }
    if (this.copLog)
      console.log(
        `[t=${(this.time.now / 1000).toFixed(2)}] DISABLED ${cop.unitType}`,
      );
  }

  // Age out wrecks: once past their despawn timer, remove them.
  _updateWrecks(dt) {
    if (!this.wrecks.length) return;
    let expired = false;
    for (const w of this.wrecks) {
      w._wreckT += dt;
      if (w._wreckT > this.wreckDespawn) {
        this.tweens.killTweensOf(w.sprite);
        if (w.modeLabel) w.modeLabel.destroy();
        w.sprite.destroy();
        expired = true;
      }
    }
    if (expired)
      this.wrecks = this.wrecks.filter((w) => w._wreckT <= this.wreckDespawn);
  }

  // --- Placed roadblocks --------------------------------------------------------------
  // The composition per difficulty (= pursuit level). Cars parked BROADSIDE end-to-end;
  // 2+ are biased to one side so a gap to slip through is left on the other. Heavies join
  // at the top tiers (heavier → harder to shove). (Spike-strip slots from L3 up are a TODO.)
  _roadblockComposition(difficulty) {
    switch (Phaser.Math.Clamp(Math.round(difficulty), 1, 5)) {
      case 1:  return ['car'];
      case 2:  return ['car', 'car'];
      case 3:  return ['car', 'car', 'car'];
      case 4:  return ['car', 'car', 'heavy'];
      default: return ['car', 'heavy', 'heavy'];
    }
  }

  // Drop a roadblock at road point (x,y) across the player's travel `heading`. Each vehicle
  // is a DYNAMIC body with mass (you SHOVE through, losing speed — heavies cost more), with
  // an invisible axis-aligned body for the exact broadside collider and a car sprite that
  // follows it. Heading snapped to the grid so the body is an exact fit (no capsule/Matter).
  _spawnRoadblock(x, y, heading, difficulty = 2) {
    const snapped = Math.round(heading / (Math.PI / 2)) * (Math.PI / 2); // nearest N/S/E/W
    const perp = snapped + Math.PI / 2, cpx = Math.cos(perp), cpy = Math.sin(perp);
    // These ARE normal cop cars (patrol / heavy) — same display + capsule dims as the live
    // units, so the block collides via the rotating capsule (slip through a spun car).
    const SPEC = {
      car:   { tex: 'cop_patrol', visW: 25, visL: 58, body: 23, capR: 11, capHalfLen: 16, mass: this.rbCarMass },
      heavy: { tex: 'cop_heavy',  visW: 32, visL: 67, body: 27, capR: 14, capHalfLen: 18, mass: this.rbHeavyMass },
    };
    const specs = this._roadblockComposition(difficulty).map((t) => SPEC[t]);
    const totalLen = specs.reduce((s, v) => s + v.visL, 0);
    const gap = Math.max(0, ROAD - totalLen);
    // 2+ vehicles hug one side → the gap to slip through is on the other. Centred if it
    // overhangs (sealed). `start` is the leading edge offset along perp from the node.
    const start = gap > 0
      ? (Math.random() < 0.5 ? -ROAD / 2 : ROAD / 2 - totalLen)
      : -totalLen / 2;

    const cars = [];
    let cursor = start;
    for (const s of specs) {
      const off = cursor + s.visL / 2;
      const ix = x + cpx * off, iy = y + cpy * off;
      cursor += s.visL;
      // Small SQUARE dynamic body (drag + velocity integrator + wall backstop); the rotating
      // capsule (capR/capHalfLen) does the real player/cop collision, so the body needn't be
      // the car's full footprint — a square that can't block slip-through, like the cops.
      const body = this.roadblockGroup.create(ix, iy, '_px').setDisplaySize(s.body, s.body);
      body.setTintFill(0xff3b3b).setAlpha(this.devMode ? 0.18 : 0).setDepth(8);
      body.body.setDrag(this.rbCarDrag, this.rbCarDrag);
      body.body.mass = s.mass;
      body.setCollideWorldBounds(true);
      this.worldLayer.add(body);
      const baseRot = perp + Math.PI / 2;          // broadside across the road
      const img = this.add.image(ix, iy, s.tex)
        .setDisplaySize(s.visW, s.visL).setDepth(9).setRotation(baseRot);
      this.worldLayer.add(img);
      const car = { body, img, baseRot, mass: s.mass, spin: 0, angVel: 0, _spinCd: 0,
                    capR: s.capR, capHalfLen: s.capHalfLen };
      body.rbCar = car;                            // so the spin trigger can find it
      cars.push(car);
    }
    const rb = { x, y, heading: snapped, cars };
    this.roadblocks.push(rb);
    return rb;
  }

  // Place a roadblock down the player's predicted travel (for the testbed Spawn button).
  _spawnRoadblockAhead(difficulty) {
    const car = this.car, px = car.sprite.x, py = car.sprite.y;
    const dir = car.getSpeed() > 40 ? Math.atan2(car.vy, car.vx) : car.facing;
    const tx = px + Math.cos(dir) * this.roadblockDist, ty = py + Math.sin(dir) * this.roadblockDist;
    const p = this.navGrid.pos(this.navGrid.nearestNode(tx, ty));
    this._spawnRoadblock(p.x, p.y, dir, difficulty);
  }

  _removeRoadblock(rb) {
    for (const c of rb.cars) { c.body.destroy(); c.img.destroy(); }
    this.roadblocks = this.roadblocks.filter((r) => r !== rb);
  }

  _clearRoadblocks() {
    for (const rb of [...this.roadblocks]) this._removeRoadblock(rb);
  }

  // An OFF-CENTRE ram torques a block car so it spins out of the way (Arcade has no angular
  // physics, so we script it). The cross product of (hit offset) × (your push) gives both
  // the direction and how off-centre the hit was — a centre hit barely spins, an END hit
  // (the rear-quarter) spins hard. Throttled so sustained contact doesn't wind it up.
  _onRoadblockHit(body) {
    const car = body.rbCar;
    if (!car || car._spinCd > 0) return;
    const pvx = this._carLastVx ?? this.car.vx, pvy = this._carLastVy ?? this.car.vy;
    if (Math.hypot(pvx, pvy) < 60) return;          // gentle nudge → no spin
    const ox = this.car.sprite.x - body.x, oy = this.car.sprite.y - body.y;
    const cross = ox * pvy - oy * pvx;              // off-centre × push → torque
    car.angVel += (cross * this.rbSpinFactor) / car.mass;
    car._spinCd = 0.2;
  }

  // Keep each car sprite on its (shoveable) body, advance its scripted spin, and despawn a
  // block after its lifetime (or if the player strays far).
  _updateRoadblocks(px, py, dt) {
    for (const rb of [...this.roadblocks]) {
      rb._t = (rb._t || 0) + dt;
      for (const c of rb.cars) {
        c._spinCd = Math.max(0, c._spinCd - dt);
        c.angVel = Phaser.Math.Clamp(c.angVel * Math.pow(this.rbSpinDamp, dt * 60), -this.rbSpinMax, this.rbSpinMax);
        c.spin += c.angVel * dt;
        c.img.setPosition(c.body.x, c.body.y).setRotation(c.baseRot + c.spin);
      }
      if (rb._t > this.rbLifetime || Phaser.Math.Distance.Between(px, py, rb.x, rb.y) > 3200)
        this._removeRoadblock(rb);
    }
  }

  // Deploy a spike strip at a drop request (a spike unit reached its deploy point ahead of you).
  // DRAFT: this lays down a ~car-width strip oriented across the player's path and tracks it; the
  // HAZARD effect (pop the player's tires on contact) is the next step. Kept as data + a drawn
  // placeholder so the deploy maneuver is fully testable now.
  _dropSpike({ x, y, heading }) {
    const angle = heading + Math.PI / 2; // strip lies ACROSS the direction of travel
    this.spikes.push({ x, y, angle, len: 76, depth: 12, t: 0 });
  }

  // Age out deployed strips and redraw them. (Collision/tire-pop wiring comes next.)
  _updateSpikes(px, py, dt) {
    const g = this.spikeGfx;
    g.clear();
    if (!this.spikes.length) return;
    for (const s of [...this.spikes]) {
      s.t += dt;
      if (s.t > this.spikeLifetime) { this.spikes = this.spikes.filter((o) => o !== s); continue; }
      // Fade out over the last 3s of life.
      const fade = Phaser.Math.Clamp((this.spikeLifetime - s.t) / 3, 0, 1);
      const cos = Math.cos(s.angle), sin = Math.sin(s.angle), hl = s.len / 2, hd = s.depth / 2;
      // strip body (drawn as an absolute-point polygon — no transform needed)
      g.fillStyle(0x222222, 0.55 * fade);
      const corners = [
        [-hl, -hd], [hl, -hd], [hl, hd], [-hl, hd],
      ].map(([lx, ld]) => ({ x: s.x + lx * cos - ld * sin, y: s.y + lx * sin + ld * cos }));
      g.fillPoints(corners.map((c) => new Phaser.Geom.Point(c.x, c.y)), true);
      // spike teeth (a row of little triangles along the strip) for readability
      g.fillStyle(0xc0c0c0, 0.9 * fade);
      const teeth = 9;
      for (let i = 0; i < teeth; i++) {
        const f = (i + 0.5) / teeth - 0.5;
        const bx = s.x + f * s.len * cos, by = s.y + f * s.len * sin;
        const tip = { x: bx - (hd + 4) * sin, y: by + (hd + 4) * cos };
        const b1 = { x: bx - 3 * cos - hd * sin, y: by - 3 * sin + hd * cos };
        const b2 = { x: bx + 3 * cos - hd * sin, y: by + 3 * sin + hd * cos };
        g.fillPoints([new Phaser.Geom.Point(tip.x, tip.y), new Phaser.Geom.Point(b1.x, b1.y), new Phaser.Geom.Point(b2.x, b2.y)], true);
      }
    }
  }

  // Custom CAPSULE collision for the player, cops AND roadblock cars — Arcade's box can't
  // cover a rotated car, so each is modelled as 3 circles along its spine and pushed out of
  // walls + apart from each other by hand. Rounded → slides along walls/corners. Additive to
  // the Arcade bodies (velocity-cancel is idempotent, so they cooperate, not fight). Roadblock
  // cars join as agents so a SPUN block car (capsule rotated end-on) lets the player slip past
  // its ends. The spine circle centres are kept as a flat [x,y,x,y,x,y] on the agent and
  // shifted whenever the agent is pushed, so all checks stay consistent.
  _resolveCapsules() {
    const agents = (this._capAgents ||= []);
    agents.length = 0;
    agents.push({ v: this.car, R: this.playerCapR, hl: this.playerCapHalfLen, m: this.playerMass, player: true });
    for (const cop of this.cops) agents.push({ v: cop, R: cop.capR, hl: cop.capHalfLen, m: cop.mass || 1 });
    // Roadblock cars: a per-frame shim exposing the Vehicle-like fields the resolver needs.
    // facing runs along the car's LENGTH (sprite rotation − π/2), so the capsule rotates with
    // the scripted spin. vx/vy seed from the Arcade body; the resolver writes back through it.
    for (const rb of this.roadblocks) for (const c of rb.cars) {
      const b = c.body;
      agents.push({
        v: { sprite: b, facing: c.baseRot + c.spin - Math.PI / 2, vx: b.body.velocity.x, vy: b.body.velocity.y },
        R: c.capR, hl: c.capHalfLen, m: c.mass, rbCar: c,
      });
    }
    for (const a of agents) {
      const s = a.v.sprite, fx = Math.cos(a.v.facing), fy = Math.sin(a.v.facing), d = a.hl;
      a.c = [s.x + fx * d, s.y + fy * d, s.x, s.y, s.x - fx * d, s.y - fy * d]; // front · centre · rear
      a.reach = a.hl + a.R;
    }
    // Gauss–Seidel: re-solve walls + car↔car several times so a packed stack settles instead
    // of jittering, and resistance propagates through it. Velocity-changing work (friction, ram,
    // roadblock spin) fires only on the FIRST iteration (firstIter) so it can't compound; the
    // idempotent normal-cancel + positional pushout run every iteration.
    const iters = Math.max(1, this.capIters | 0);
    for (let it = 0; it < iters; it++) {
      const firstIter = it === 0;
      for (const a of agents) this._capsuleVsWalls(a);
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const a = agents[i], b = agents[j];
          const dx = b.v.sprite.x - a.v.sprite.x, dy = b.v.sprite.y - a.v.sprite.y, rr = a.reach + b.reach;
          if (dx * dx + dy * dy <= rr * rr) this._capsuleVsCapsule(a, b, firstIter); // broad-phase cull
        }
      }
    }
    // Roadblock car visuals follow their (just-pushed) body — keep the art on the collider.
    for (const a of agents) if (a.rbCar) a.rbCar.img.setPosition(a.v.sprite.x, a.v.sprite.y);
    // Cops killed by ram damage this frame are disabled now (deferred so this.cops wasn't
    // mutated mid-resolve). Their stale agents finish this frame harmlessly as zeroed wrecks.
    if (this._capDisable) { for (const cop of this._capDisable) this._disableCop(cop); this._capDisable = null; }
    if (this.capDebug) {
      this.capDebug.clear();
      for (const a of agents) {
        this.capDebug.lineStyle(1, a.player ? 0x39ff14 : a.rbCar ? 0xff3b3b : 0x4a90ff, 0.7);
        for (let k = 0; k < 6; k += 2) this.capDebug.strokeCircle(a.c[k], a.c[k + 1], a.R);
      }
    }
  }

  // Move an agent (sprite + Arcade body + its tracked circle centres) by (dx,dy).
  _capShift(a, dx, dy) {
    const s = a.v.sprite, b = s.body;
    s.x += dx; s.y += dy; b.x += dx; b.y += dy;
    for (let k = 0; k < 6; k += 2) { a.c[k] += dx; a.c[k + 1] += dy; }
  }

  _capsuleVsWalls(a) {
    const s = a.v.sprite, R = a.R;
    for (const wall of this.losRects) {
      if (s.x + a.reach < wall.x || s.x - a.reach > wall.right ||
          s.y + a.reach < wall.y || s.y - a.reach > wall.bottom) continue;
      for (let k = 0; k < 6; k += 2) {
        const px = a.c[k], py = a.c[k + 1];
        const qx = Phaser.Math.Clamp(px, wall.x, wall.right), qy = Phaser.Math.Clamp(py, wall.y, wall.bottom);
        const dx = px - qx, dy = py - qy, dist2 = dx * dx + dy * dy;
        let nx, ny, pen;
        if (dist2 > 1e-4) { const dd = Math.sqrt(dist2); if (dd >= R) continue; nx = dx / dd; ny = dy / dd; pen = R - dd; }
        else {
          const dl = px - wall.x, dr = wall.right - px, dtp = py - wall.y, dbt = wall.bottom - py;
          const m = Math.min(dl, dr, dtp, dbt);
          if (m === dl) { nx = -1; ny = 0; pen = dl + R; } else if (m === dr) { nx = 1; ny = 0; pen = dr + R; }
          else if (m === dtp) { nx = 0; ny = -1; pen = dtp + R; } else { nx = 0; ny = 1; pen = dbt + R; }
        }
        const corr = Math.max(0, pen - this.capSlop) * this.capRelax; // slop + relaxation
        if (corr > 0) this._capShift(a, nx * corr, ny * corr);
        const vn = a.v.vx * nx + a.v.vy * ny;
        if (vn < 0) { a.v.vx -= vn * nx; a.v.vy -= vn * ny; a.v.sprite.body.velocity.set(a.v.vx, a.v.vy); }
      }
    }
  }

  _capsuleVsCapsule(a, b, firstIter) {
    const minD = a.R + b.R, inv = 1 / (a.m + b.m);
    // Positional pushout per overlapping circle-pair (slop + relaxation), tracking the DEEPEST
    // contact's normal — velocity work (normal-cancel/friction/ram) is applied ONCE on that.
    let cnx = 0, cny = 0, maxPen = -1;
    for (let i = 0; i < 6; i += 2) for (let j = 0; j < 6; j += 2) {
      const dx = b.c[j] - a.c[i], dy = b.c[j + 1] - a.c[i + 1], d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD || d2 < 1e-6) continue;
      const dd = Math.sqrt(d2), nx = dx / dd, ny = dy / dd, pen = minD - dd; // normal a→b
      const corr = Math.max(0, pen - this.capSlop) * this.capRelax;
      if (corr > 0) {
        this._capShift(a, -nx * corr * b.m * inv, -ny * corr * b.m * inv);
        this._capShift(b,  nx * corr * a.m * inv,  ny * corr * a.m * inv);
      }
      if (pen > maxPen) { maxPen = pen; cnx = nx; cny = ny; }
    }
    if (maxPen < 0) return;                                   // no contact this pass
    // Normal velocity solve (perfectly inelastic, momentum-conserving) — idempotent, every iter.
    const rvn = (b.v.vx - a.v.vx) * cnx + (b.v.vy - a.v.vy) * cny;
    if (rvn < 0) {
      a.v.vx += rvn * cnx * b.m * inv; a.v.vy += rvn * cny * b.m * inv;
      b.v.vx -= rvn * cnx * a.m * inv; b.v.vy -= rvn * cny * a.m * inv;
      a.v.sprite.body.velocity.set(a.v.vx, a.v.vy);
      b.v.sprite.body.velocity.set(b.v.vx, b.v.vy);
    }
    if (!firstIter) return;                                   // friction/ram/spin: once per frame
    // Tangential friction → the swarm grips, you can't frictionlessly slide out the seam.
    if (this.capFriction > 0) {
      const rvx = b.v.vx - a.v.vx, rvy = b.v.vy - a.v.vy;
      const rn = rvx * cnx + rvy * cny, tvx = rvx - rn * cnx, tvy = rvy - rn * cny;
      a.v.vx += tvx * this.capFriction * b.m * inv; a.v.vy += tvy * this.capFriction * b.m * inv;
      b.v.vx -= tvx * this.capFriction * a.m * inv; b.v.vy -= tvy * this.capFriction * a.m * inv;
      a.v.sprite.body.velocity.set(a.v.vx, a.v.vy);
      b.v.sprite.body.velocity.set(b.v.vx, b.v.vy);
    }
    // Scripted impacts (once per pair). Roadblock spin on the player ramming a block car; ram
    // bog when the player takes a frontal cop hit. (cnx,cny) is the a→b normal.
    if (a.player && b.rbCar) this._onRoadblockHit(b.rbCar.body);
    else if (b.player && a.rbCar) this._onRoadblockHit(a.rbCar.body);
    else if (a.player && !b.rbCar) { this._applyRamImpact(b.v, cnx, cny); this._ramDamageCop(b.v); }     // b is a cop
    else if (b.player && !a.rbCar) { this._applyRamImpact(a.v, -cnx, -cny); this._ramDamageCop(a.v); }   // a is a cop
  }

  // A FRONTAL high-closing-speed cop hit dumps extra player speed and bogs the engine briefly,
  // so a head-on actually costs you momentum you have to rebuild (interceptor = strong, heavy =
  // near-stop). (nx,ny) points from the player toward the cop. Uses PRE-collision velocities so
  // the magnitude reflects the real impact, not the already-resolved speeds.
  _applyRamImpact(cop, nx, ny) {
    const rs = cop.ramStrength || 0;
    if (rs <= 0) return;
    const pvx = this._carLastVx ?? this.car.vx, pvy = this._carLastVy ?? this.car.vy;
    const cvx = cop._lastVx ?? cop.vx, cvy = cop._lastVy ?? cop.vy;
    const closing = (pvx - cvx) * nx + (pvy - cvy) * ny;     // approach speed along the normal
    if (closing < this.ramMinClosing) return;                // a nudge, not a ram
    // How head-on is it? 1 = the cop is dead ahead of where the player is driving, 0 = side-swipe.
    const fwd = Math.cos(this.car.facing) * nx + Math.sin(this.car.facing) * ny;
    const frontal = Phaser.Math.Clamp(fwd, 0, 1);
    const intensity = rs * frontal * Phaser.Math.Clamp(closing / this.ramRefSpeed, 0, 1);
    if (intensity <= 0) return;
    const keep = Math.max(0, 1 - this.ramSpeedKill * intensity);
    this.car.vx *= keep; this.car.vy *= keep;
    this.car.sprite.body.velocity.set(this.car.vx, this.car.vy);
    this.car._ramBog = Math.max(this.car._ramBog || 0, this.ramBogTime * intensity);
  }

  // A small health bar floating above every active cop, so you can watch it deplete as
  // they take hits. Green → yellow → red; the empty portion shows as a dark track.
  _drawHealthBars() {
    const g = this.healthBars;
    g.clear();
    const w = 30,
      h = 5;
    for (const cop of this.cops) {
      const max = cop.maxHealth || 100;
      const frac = Phaser.Math.Clamp(cop.health / max, 0, 1);
      const x = cop.sprite.x - w / 2,
        y = cop.sprite.y - 40;
      g.fillStyle(0x000000, 0.7);
      g.fillRect(x - 1, y - 1, w + 2, h + 2); // background / empty track
      const col = frac > 0.5 ? 0x39ff14 : frac > 0.25 ? 0xffd23f : 0xff3b3b;
      g.fillStyle(col, 1);
      g.fillRect(x, y, w * frac, h);
    }
  }

  // Spawn-control panel: unit type + count + Spawn / Clear. Changing the type rebuilds
  // the Unit Tuning panel onto that type's def.
  _setupTestbedPanel() {
    this._testbed = this._testbed || { unitType: "patrol", count: 2 };
    const gui = new GUI({ title: "Cop Testbed", width: 240 });
    this.testbedGui = gui;
    gui
      .add(this._testbed, "unitType", Object.keys(UNITS))
      .name("Unit type")
      .onChange((t) => this._setupUnitTunePanel(t));
    gui.add(this._testbed, "count", 1, 8, 1).name("Count");
    gui
      .add(
        {
          spawn: () =>
            this._testbedSpawn(this._testbed.unitType, this._testbed.count),
        },
        "spawn",
      )
      .name("▶ Spawn");
    gui.add({ clear: () => this._clearCops() }, "clear").name("✕ Clear all");

    // Placed roadblock (static set-piece). Spawn one ahead at the chosen difficulty.
    this._rbDifficulty = this._rbDifficulty || 2;
    const rbf = gui.addFolder("Roadblock");
    rbf.add(this, "_rbDifficulty", 1, 5, 1).name("Difficulty (1–5)");
    rbf.add({ spawn: () => this._spawnRoadblockAhead(this._rbDifficulty) }, "spawn").name("▶ Spawn ahead");
    rbf.add({ clear: () => this._clearRoadblocks() }, "clear").name("✕ Clear roadblocks");
    rbf.add(this, "roadblockDist", 200, 2000, 25).name("Place ahead (px)");
    rbf.add(this, "rbCarMass", 0.4, 4, 0.1).name("Car mass (shove cost)");
    rbf.add(this, "rbHeavyMass", 1, 6, 0.1).name("Heavy mass");
    rbf.add(this, "rbCarDrag", 100, 1500, 50).name("Shoved-car drag");
    rbf.add(this, "rbLifetime", 5, 90, 5).name("Lifetime (s)");
    rbf.add(this, "rbSpinFactor", 0, 0.002, 0.0001).name("Spin on off-centre hit");
    rbf.close();

    // Swarm feel: capsule solver quality (anti-jitter + containment) and frontal-ram impact.
    const sw = gui.addFolder("Swarm / Ram physics");
    sw.add(this, "capIters", 1, 8, 1).name("Solver iterations");
    sw.add(this, "capSlop", 0, 3, 0.1).name("Penetration slop (px)");
    sw.add(this, "capRelax", 0.2, 1, 0.05).name("Position relax");
    sw.add(this, "capFriction", 0, 1, 0.05).name("Contact friction (grip)");
    sw.add(this, "playerMass", 0.5, 4, 0.1).name("Player mass");
    sw.add(this, "ramSpeedKill", 0, 1, 0.05).name("Ram speed-kill (max)");
    sw.add(this, "ramBogTime", 0, 1.5, 0.05).name("Ram engine-bog (s)");
    sw.add(this, "ramBogAccel", 0, 1, 0.05).name("Bog power mult");
    sw.add(this, "ramRefSpeed", 100, 700, 10).name("Full-ram closing speed");
    sw.add(this, "ramMinClosing", 0, 400, 10).name("Min closing for ram");
    sw.close();

    // Respawn-ahead retry (interceptor head-on loop). Binds straight to the live scene.
    const rs = gui.addFolder("Respawn-ahead (interceptor)");
    rs.add(this, "respawnEnabled").name("Respawn lost cops");
    rs.add(this, "respawnDist", 400, 3000, 50).name("Fell-behind dist (px)");
    rs.add(this, "respawnTime", 0.5, 12, 0.5).name("…for this long (s)");
    rs.add(this, "respawnCooldown", 0, 20, 0.5).name("Respawn cooldown (s)");
    rs.add(this, "interceptAheadDist", 200, 2000, 25).name(
      "Spawn-ahead dist (px)",
    );
    rs.add(this, "interceptEntrySpeed", 0, 600, 10).name("Entry speed (px/s)");
    rs.close();

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Live tuning for the director's maneuver/box behavior (drafting, overtake-and-block,
  // box-v2 crash-and-hold). Binds straight to the live PursuitDirector fields, so changes
  // take effect immediately. Persisted across refresh.
  _setupManeuverPanel() {
    const d = this.director;
    const gui = new GUI({ title: "Maneuvers", width: 290 });
    this.maneuverGui = gui;
    gui.close();

    const draft = gui.addFolder("Drafting (anti-bumper-grind)");
    draft.add(d, "draftMinSpeed", 0, 400, 10).name("Only draft above (px/s)");
    draft.add(d, "draftGap", 0, 300, 5).name("Follow distance (px)");
    draft.add(d, "draftMargin", 0, 200, 5).name("Close-up speed margin");

    const trig = gui.addFolder("Overtake — trigger");
    trig
      .add(d, "maneuverTrigSpeed", 0, 500, 10)
      .name("Only if player above (px/s)");
    trig.add(d, "maneuverRange", 100, 1200, 20).name("Cop within (px)");
    trig.add(d, "maneuverBehind", 0, 300, 5).name("Must be behind by (px)");
    trig.add(d, "maneuverCooldown", 0, 12, 0.5).name("Cooldown between (s)");
    trig.add(d, "maneuverMaxTime", 1, 12, 0.5).name("Give up after (s)");

    const exec = gui.addFolder("Overtake — execution");
    exec.add(d, "overtakeAhead", 80, 600, 10).name("Sprint-to ahead (px)");
    exec.add(d, "overtakeSide", 0, 200, 5).name("Swing-wide side (px)");
    exec.add(d, "overtakeBoost", 0, 500, 10).name("Speed boost (px/s)");
    exec.add(d, "overtakeDone", 0, 200, 5).name("Ahead-by to start block (px)");

    const block = gui.addFolder("Block / brake-check");
    block.add(d, "blockAhead", 0, 300, 5).name("Sit ahead by (px)");
    block
      .add(d, "blockSpeedFactor", 0.1, 1.0, 0.05)
      .name("Ease to × your speed");
    block.add(d, "blockMinSpeed", 0, 400, 10).name("…but ≥ (px/s)");
    block.add(d, "blockedSpeed", 0, 400, 10).name("Success: you slow below");
    block.add(d, "blockLost", -400, 0, 10).name("Fail: fell behind (along)");

    const box = gui.addFolder("Box v2 (crash-and-hold)");
    box.add(d, "boxTriggerSpeed", 0, 400, 10).name("Box when below (px/s)");
    box.add(d, "boxReleaseSpeed", 0, 500, 10).name("Break box above (px/s)");
    box.add(d, "boxEngageRange", 100, 1000, 20).name("Join box within (px)");
    box.add(d, "boxCloseMargin", 0, 400, 10).name("Rear close speed margin");
    box.add(d, "boxContactGap", 0, 150, 5).name("Rear hold gap (px)");
    box.add(d, "boxPress", 0, 200, 5).name("Rear press above pace (px/s)");
    box.add(d, "boxFrontAhead", 0, 150, 5).name("Front-runner ahead-by (px)");

    const rb = gui.addFolder("Heavy roadblock");
    rb.add(d, "blockSetupDist", 80, 600, 10).name("Latch point ahead (px)");
    rb.add(d, "blockParkDist", 30, 200, 5).name("Park within (px)");
    rb.add(d, "blockAheadMin", 0, 200, 5).name("Start when ahead-by (px)");
    rb.add(d, "blockMaxTime", 1, 15, 0.5).name("Hold a block (s)");
    rb.add(d, "blockCooldown", 0, 12, 0.5).name("Cooldown between (s)");

    const pit = gui.addFolder("PIT maneuver");
    pit.add(this, "pitTestLevel", 1, 5, 1).name("Sandbox level (power)");
    pit.add(d, "pitMinLevel", 1, 5, 1).name("Available from level");
    pit.add(d, "pitCooldown", 1, 30, 0.5).name("Pack cadence (s)");
    pit.add(d, "pitUnitCooldown", 1, 30, 0.5).name("Same-cop cooldown (s)");
    pit.add(d, "pitRange", 80, 600, 10).name("Attempt within (px)");
    pit.add(d, "pitMinSpeed", 0, 400, 10).name("Min speed (both) (px/s)");
    pit.add(d, "pitMaxTime", 0.5, 6, 0.5).name("Give up after (s)");
    pit.add(d, "pitBoost", 0, 300, 10).name("Commit speed boost (px/s)");
    const pg = pit.addFolder("Detection (rear quarter)");
    pg.add(d, "pitContactDist", 20, 100, 2).name("Swipe registers within (px)");
    pg.add(d, "pitCoDirMin", 0, 1, 0.05).name("Min co-directional");
    pg.add(d, "pitRearMax", -40, 60, 2).name("Max ahead-of-centre (px)");
    pg.add(d, "pitSideMin", 0, 60, 2).name("Side band min (px)");
    pg.add(d, "pitSideMax", 20, 120, 2).name("Side band max (px)");
    pg.add(d, "pitClosingMin", 0, 200, 5).name("Min turning-in (px/s)");
    pg.close();
    const ps = pit.addFolder("Spin severity");
    ps.add(d, "pitRefSpeed", 100, 700, 10).name("Full-power speed (px/s)");
    ps.add(d, "pitPowerFloor", 0, 1, 0.05).name("Min-level intensity floor");
    ps.add(d, "pitDurMin", 0.1, 1.5, 0.05).name("Control loss min (s)");
    ps.add(d, "pitDurMax", 0.1, 2, 0.05).name("Control loss max (s)");
    ps.add(d, "pitYawMin", 1, 12, 0.5).name("Yaw min (rad/s)");
    ps.add(d, "pitYawMax", 1, 16, 0.5).name("Yaw max (rad/s)");
    ps.add(d, "pitGripMult", 0, 1, 0.05).name("Grip during spin");
    ps.add(d, "pitSpeedScrub", 0.8, 1, 0.005).name("Speed retain / frame");
    ps.add(d, "pitLateralKick", 0, 300, 10).name("Tail kick (px/s)");
    ps.add(d, "pitVictimCooldown", 0, 4, 0.25).name("Re-PIT immunity (s)");
    ps.close();
    pit.close();

    const spike = gui.addFolder("Spike run (deploy)");
    spike.add(d, "spikeTrigSpeed", 0, 400, 10).name("Start if player above (px/s)");
    spike.add(d, "spikeDeployMinSpeed", 0, 400, 10).name("Abort if player below (px/s)");
    spike.add(d, "spikeRange", 100, 800, 20).name("Cop within (px)");
    spike.add(d, "spikeBehind", 0, 200, 5).name("Must be behind by (px)");
    spike.add(d, "spikeAhead", 60, 400, 10).name("Sprint lead (ahead of cop)");
    spike.add(d, "spikeSide", 0, 120, 2).name("Sprint swing-wide (px)");
    spike.add(d, "spikeBoost", 0, 300, 10).name("Sprint speed boost (px/s)");
    spike.add(d, "spikeDropAhead", 0, 200, 5).name("Deploy when ahead-by (px)");
    spike.add(d, "spikeDropLead", 0, 200, 5).name("Strip lands ahead-of-cop (px)");
    spike.add(d, "spikeProgressEps", 0, 40, 1).name("Progress = gain over (px)");
    spike.add(d, "spikeStallTime", 0.3, 5, 0.1).name("Give up if stalled (s)");
    spike.add(d, "spikeDeployHold", 0.5, 8, 0.5).name("Hold in front after drop (s)");
    spike.add(d, "spikeDropCd", 0, 12, 0.5).name("Cooldown between drops (s)");
    spike.add(d, "spikeReload", 1, 30, 0.5).name("Reload when empty (s)");
    spike.add(d, "spikeStripCount", 1, 8, 1).name("Strips per unit");
    spike.add(d, "spikeEaseAhead", 0, 300, 5).name("Ease-in-front ahead (px)");
    spike.add(d, "spikeEaseFactor", 0.1, 1, 0.05).name("Ease to × your speed");
    spike.add(this, "spikeLifetime", 3, 60, 1).name("Strip lifetime (s)");
    spike.close();

    gui
      .add({ copy: () => this._copyManeuverStats() }, "copy")
      .name("Copy Maneuvers → Console");

    this._persistPanel(gui, "gd_maneuverTune_v10"); // bumped: parallel-lane spike sprint + box excludes maneuverers

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "630px";
    gui.domElement.style.zIndex = "9999";
  }

  // Cop health / ramming panel: per-type health+mass (bound to the defs, so new spawns get
  // them — clear + respawn to apply), the player ram-damage model, the aggressive-crash
  // self-damage, and the disable/wreck knobs. Bound straight to the live scene/defs. (Scene
  // ram fields are code defaults in pursuit until baked, mirroring the maneuver panel.)
  _setupHealthPanel() {
    const gui = new GUI({ title: "Cop Health / Ramming", width: 290 });
    this.healthGui = gui;
    gui.close();

    const types = gui.addFolder("Per-type health / mass (respawn to apply)");
    for (const key of Object.keys(UNITS)) {
      const def = UNITS[key];
      const f = types.addFolder(def.name);
      f.add(def, "health", 20, 600, 10).name("Health");
      f.add(def, "mass", 0.2, 5, 0.1).name("Mass");
      f.close();
    }

    const ram = gui.addFolder("Player ram damage");
    ram.add(this, "ramThreshold", 0, 600, 10).name("No damage below (px/s)");
    ram.add(this, "ramScale", 0, 1, 0.01).name("Damage per px/s");
    ram.add(this, "ramContactDist", 20, 100, 2).name("Contact distance (px)");
    ram.add(this, "ramDmgCooldown", 0.1, 2, 0.1).name("Hit cooldown (s)");

    const self = gui.addFolder("Cop self-damage (aggro crashes)");
    self
      .add(this, "selfImpactDrop", 10, 200, 5)
      .name("Counts as crash above (px/s)");
    self.add(this, "selfScale", 0, 2, 0.05).name("Damage per px/s");

    const dis = gui.addFolder("Disable / wreck");
    dis.add(this, "wreckDespawn", 5, 120, 5).name("Wreck despawn (s)");
    dis
      .add(this, "wreckMass", 0.05, 2, 0.05)
      .name("Wreck mass (shove-ability)");
    dis.add(this, "disableReinforceMult", 1, 3, 0.1).name("Replace delay ×");

    gui
      .add({ copy: () => this._copyHealthStats() }, "copy")
      .name("Copy Health → Console");

    this._persistPanel(gui, "gd_healthTune_v2"); // bumped: patrol health / ramScale / wreckMass rebaked

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "950px";
    gui.domElement.style.zIndex = "9999";
  }

  // Dump the cop-health tuning: per-type health/mass (for src/ai/units.js) + the scene's
  // ram/disable model (for the GameScene defaults block), paste-ready.
  _copyHealthStats() {
    const perType = Object.keys(UNITS)
      .map(
        (k) =>
          `// UNITS.${k}: health: ${UNITS[k].health}, mass: ${UNITS[k].mass},`,
      )
      .join("\n");
    console.log(`// --- Cop health / ramming tuning ---
${perType}
// --- GameScene ram/disable model ---
this.ramThreshold = ${this.ramThreshold}; this.ramScale = ${this.ramScale}; this.ramContactDist = ${this.ramContactDist}; this.ramDmgCooldown = ${this.ramDmgCooldown};
this.selfImpactDrop = ${this.selfImpactDrop}; this.selfScale = ${this.selfScale};
this.wreckDespawn = ${this.wreckDespawn}; this.wreckMass = ${this.wreckMass}; this.disableReinforceMult = ${this.disableReinforceMult};`);
  }

  // Dump the director's maneuver/box tuning, paste-ready for the PursuitDirector ctor.
  _copyManeuverStats() {
    const d = this.director;
    console.log(`// --- Director maneuver/box tuning (paste into PursuitDirector constructor) ---
// Drafting
this.draftMinSpeed = ${d.draftMinSpeed}; this.draftGap = ${d.draftGap}; this.draftMargin = ${d.draftMargin};
// Overtake — trigger
this.maneuverTrigSpeed = ${d.maneuverTrigSpeed}; this.maneuverRange = ${d.maneuverRange}; this.maneuverBehind = ${d.maneuverBehind};
this.maneuverCooldown = ${d.maneuverCooldown}; this.maneuverMaxTime = ${d.maneuverMaxTime};
// Overtake — execution
this.overtakeAhead = ${d.overtakeAhead}; this.overtakeSide = ${d.overtakeSide}; this.overtakeBoost = ${d.overtakeBoost}; this.overtakeDone = ${d.overtakeDone};
// Block / brake-check
this.blockAhead = ${d.blockAhead}; this.blockSpeedFactor = ${d.blockSpeedFactor}; this.blockMinSpeed = ${d.blockMinSpeed}; this.blockedSpeed = ${d.blockedSpeed}; this.blockLost = ${d.blockLost};
// Box v2
this.boxTriggerSpeed = ${d.boxTriggerSpeed}; this.boxReleaseSpeed = ${d.boxReleaseSpeed}; this.boxEngageRange = ${d.boxEngageRange}; this.boxCloseMargin = ${d.boxCloseMargin}; this.boxContactGap = ${d.boxContactGap};`);
  }

  // Per-type tuning: binds a panel to UNITS[type]'s def (handling + the def-eligible AI
  // tunables), writes changes back to the DEF (so future spawns inherit them) AND to
  // every live cop of that type, persists per type, and dumps a paste-ready def block.
  // Rebuilt when the selected type changes.
  _setupUnitTunePanel(type) {
    if (this.unitGui) {
      this.unitGui.destroy();
      this.unitGui = null;
    }
    const def = UNITS[type];
    const h = def.handling;
    const look = (def.appearance ||= {});
    // Effective AI tunables = CopAI defaults overlaid with this def's `ai` overrides.
    const ai = new CopAI(this.navGrid, this.losRects, def.ai);

    const t = (this._unitTuning = {
      capR: look.capR ?? 11,
      capHalfLen: look.capHalfLen ?? 14,
      mass: def.mass ?? 1,
      ramStrength: def.ramStrength ?? 0,
      maxSpeed: h.maxSpeed,
      acceleration: h.acceleration,
      gripLow: h.gripLow,
      gripHigh: h.gripHigh,
      gripSpeedRef: h.gripSpeedRef,
      turnSpeedLow: h.turnSpeedLow,
      turnSpeed: h.turnSpeed,
      minSteerFactor: h.minSteerFactor,
      maxApproachSpeed: ai.maxApproachSpeed,
      cornerMinSpeed: ai.cornerMinSpeed,
      brakeDecel: ai.brakeDecel,
      arriveRadius: ai.arriveRadius,
      senseDist: ai.senseDist,
      directRange: ai.directRange,
      chaseRange: ai.chaseRange,
      reactionTime: ai.reactionTime,
      ramRange: ai.ramRange,
      turnBrakeAngle: ai.turnBrakeAngle,
      turnBrakeSpeed: ai.turnBrakeSpeed,
    });

    const gui = new GUI({ title: `Unit: ${def.name}`, width: 300 });
    this.unitGui = gui;
    const apply = () => this._applyUnitTuning(type);

    // Capsule collider (the 3-circle spine pushed out of walls + other cars). R = half the
    // car's WIDTH; half-length = how far front/rear circles sit from centre (≈ half LENGTH − R).
    const cap = gui.addFolder("Capsule (collider)");
    cap.add(t, "capR", 4, 30, 0.5).name("Radius (½ width)").onChange(apply);
    cap.add(t, "capHalfLen", 4, 40, 0.5).name("Spine ½-length").onChange(apply);
    cap.add(t, "mass", 0.5, 4, 0.1).name("Mass (shove/contain)").onChange(apply);
    cap.add(t, "ramStrength", 0, 1.5, 0.05).name("Frontal-ram strength").onChange(apply);

    const drive = gui.addFolder("Handling");
    drive.add(t, "maxSpeed", 100, 1200, 10).name("Max Speed").onChange(apply);
    drive
      .add(t, "acceleration", 10, 1500, 5)
      .name("Acceleration")
      .onChange(apply);
    drive
      .add(t, "turnSpeedLow", 0.5, 8.0, 0.05)
      .name("Turn Speed low")
      .onChange(apply);
    drive
      .add(t, "turnSpeed", 0.5, 8.0, 0.05)
      .name("Turn Speed high")
      .onChange(apply);
    drive
      .add(t, "minSteerFactor", 0, 1.0, 0.05)
      .name("Low-speed steer floor")
      .onChange(apply);

    const grip = gui.addFolder("Grip");
    grip
      .add(t, "gripLow", 0.02, 1.0, 0.01)
      .name("Grip (low speed)")
      .onChange(apply);
    grip
      .add(t, "gripHigh", 0.005, 1.0, 0.005)
      .name("Grip (high speed)")
      .onChange(apply);
    grip
      .add(t, "gripSpeedRef", 50, 600, 5)
      .name("High-speed grip at")
      .onChange(apply);

    const aiF = gui.addFolder("Driving AI");
    aiF
      .add(t, "maxApproachSpeed", 200, 800, 10)
      .name("Straight speed")
      .onChange(apply);
    aiF
      .add(t, "cornerMinSpeed", 80, 500, 5)
      .name("Corner min speed")
      .onChange(apply);
    aiF
      .add(t, "brakeDecel", 100, 800, 10)
      .name("Brake planning")
      .onChange(apply);
    aiF
      .add(t, "arriveRadius", 30, 150, 5)
      .name("Node arrive radius")
      .onChange(apply);
    aiF
      .add(t, "senseDist", 200, 1000, 20)
      .name("Corner sense ahead")
      .onChange(apply);
    aiF
      .add(t, "directRange", 50, 400, 10)
      .name("Direct-aim range")
      .onChange(apply);
    aiF
      .add(t, "chaseRange", 150, 2000, 25)
      .name("Beeline range (else paths)")
      .onChange(apply);
    aiF
      .add(t, "reactionTime", 0, 0.5, 0.01)
      .name("Reaction lag (s)")
      .onChange(apply);
    aiF.add(t, "ramRange", 40, 200, 5).name("Ram aim range").onChange(apply);
    aiF
      .add(t, "turnBrakeAngle", 0.3, 1.6, 0.05)
      .name("Turn-brake angle")
      .onChange(apply);
    aiF
      .add(t, "turnBrakeSpeed", 60, 400, 10)
      .name("Turn-brake speed")
      .onChange(apply);

    gui
      .add({ copy: () => this._copyUnitDef(type) }, "copy")
      .name("Copy UnitDef → Console");

    this._persistPanel(gui, `gd_unitTune_${type}_v4`); // bumped: added mass + ramStrength
    this._applyUnitTuning(type); // sync def + live cops to the (possibly restored) values

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "320px";
    gui.domElement.style.zIndex = "9999";
  }

  // Push the live unit-tuning object into the type's DEF (future spawns) and into every
  // live cop of that type (live + base handling fields, plus the AI tunables).
  _applyUnitTuning(type) {
    const t = this._unitTuning,
      def = UNITS[type];
    (def.appearance ||= {}).capR = t.capR;
    def.appearance.capHalfLen = t.capHalfLen;
    def.mass = t.mass;
    def.ramStrength = t.ramStrength;
    Object.assign(def.handling, {
      maxSpeed: t.maxSpeed,
      acceleration: t.acceleration,
      gripLow: t.gripLow,
      gripHigh: t.gripHigh,
      gripSpeedRef: t.gripSpeedRef,
      turnSpeedLow: t.turnSpeedLow,
      turnSpeed: t.turnSpeed,
      minSteerFactor: t.minSteerFactor,
    });
    Object.assign(def.ai, {
      maxApproachSpeed: t.maxApproachSpeed,
      baseApproach: t.maxApproachSpeed,
      cornerMinSpeed: t.cornerMinSpeed,
      brakeDecel: t.brakeDecel,
      arriveRadius: t.arriveRadius,
      senseDist: t.senseDist,
      directRange: t.directRange,
      chaseRange: t.chaseRange,
      reactionTime: t.reactionTime,
      ramRange: t.ramRange,
      turnBrakeAngle: t.turnBrakeAngle,
      turnBrakeSpeed: t.turnBrakeSpeed,
    });
    for (const cop of this.cops) {
      if (cop.unitType !== type) continue;
      cop.capR = t.capR;
      cop.capHalfLen = t.capHalfLen;
      cop.mass = t.mass;
      cop.ramStrength = t.ramStrength;
      if (cop.sprite.body) cop.sprite.body.mass = t.mass;
      cop.baseMaxSpeed = t.maxSpeed;
      cop.maxSpeed = t.maxSpeed;
      cop.acceleration = t.acceleration;
      cop.baseGripLow = t.gripLow;
      cop.gripLow = t.gripLow;
      cop.baseGripHigh = t.gripHigh;
      cop.gripHigh = t.gripHigh;
      cop.gripSpeedRef = t.gripSpeedRef;
      cop.baseTurnSpeedLow = t.turnSpeedLow;
      cop.turnSpeedLow = t.turnSpeedLow;
      cop.baseTurnSpeed = t.turnSpeed;
      cop.turnSpeed = t.turnSpeed;
      cop.minSteerFactor = t.minSteerFactor;
      const a = cop.ai;
      a.maxApproachSpeed = t.maxApproachSpeed;
      a.baseApproach = t.maxApproachSpeed;
      a.cornerMinSpeed = t.cornerMinSpeed;
      a.brakeDecel = t.brakeDecel;
      a.arriveRadius = t.arriveRadius;
      a.senseDist = t.senseDist;
      a.directRange = t.directRange;
      a.chaseRange = t.chaseRange;
      a.reactionTime = t.reactionTime;
      a.ramRange = t.ramRange;
      a.turnBrakeAngle = t.turnBrakeAngle;
      a.turnBrakeSpeed = t.turnBrakeSpeed;
    }
  }

  // Dump a paste-ready handling/ai block for the type's def in src/ai/units.js.
  _copyUnitDef(type) {
    const t = this._unitTuning;
    console.log(`// --- UNITS.${type} (paste into src/ai/units.js) ---
    // appearance capsule: capR: ${t.capR}, capHalfLen: ${t.capHalfLen}
    // mass: ${t.mass}, ramStrength: ${t.ramStrength}
    handling: {
      maxSpeed: ${t.maxSpeed}, acceleration: ${t.acceleration},
      gripLow: ${t.gripLow}, gripHigh: ${t.gripHigh}, gripSpeedRef: ${t.gripSpeedRef},
      turnSpeedLow: ${t.turnSpeedLow}, turnSpeed: ${t.turnSpeed}, minSteerFactor: ${t.minSteerFactor},
    },
    ai: {
      maxApproachSpeed: ${t.maxApproachSpeed}, baseApproach: ${t.maxApproachSpeed}, cornerMinSpeed: ${t.cornerMinSpeed},
      brakeDecel: ${t.brakeDecel}, arriveRadius: ${t.arriveRadius}, senseDist: ${t.senseDist},
      directRange: ${t.directRange}, chaseRange: ${t.chaseRange}, reactionTime: ${t.reactionTime},
      ramRange: ${t.ramRange}, turnBrakeAngle: ${t.turnBrakeAngle}, turnBrakeSpeed: ${t.turnBrakeSpeed},
    },`);
  }

  // Dev panel for the escalation feel. Binds straight to the live PursuitLevel (and its
  // per-level config rows), so there's no conflict with the cop-tuning panel.
  _setupPursuitPanel() {
    const P = this.pursuitLevel;
    const gui = new GUI({ title: "Pursuit Levels", width: 270 });
    this.pursuitGui = gui;
    gui.close();

    const relevel = () => this._applyLevelTuning();

    const heat = gui.addFolder("Heat / Bleed");
    heat.add(P, "activeRate", 0, 5, 0.1).name("Heat/s (active)");
    heat.add(P, "ramHeat", 0, 30, 1).name("Heat per ram");
    heat.add(P, "heatFloor", 0, 200, 5).name("Heat floor");
    heat.add(P.bleed, "fastFrac", 0, 1, 0.05).name("Bleed fast: ½level frac");
    heat.add(P.bleed, "fastRate", 0, 20, 0.5).name("Bleed fast rate /s");
    heat.add(P.bleed, "slowRate", 0, 5, 0.1).name("Bleed slow rate /s");

    // One folder per level — every lever live. `span` (time to next level) is omitted
    // on the top level (nothing to escalate to). reaction/cooldown/boxTrigger re-apply
    // to the live cops/director on change. Rosters are data (the intended unit mix);
    // until the unit TYPES exist the scene fills toward `cap` with placeholder patrols.
    for (let lv = 1; lv <= P.maxLevel; lv++) {
      const L = P.levels[lv];
      const f = gui.addFolder(`Level ${lv}`);
      if (lv < P.maxLevel) f.add(L, "span", 5, 600, 5).name("Time to next (s)");
      f.add(L, "cap", 1, 20, 1).name("Cop cap");
      f.add(L, "reinforce", 2, 40, 1).name("Reinforce (s)");
      f.add(L, "cooldown", 5, 90, 1).name("Cooldown (s)").onChange(relevel);
      f.add(L, "reaction", 0, 0.5, 0.01).name("Reaction (s)").onChange(relevel);
      f.add(L, "boxTrigger", 0, 400, 10)
        .name("Box trigger spd")
        .onChange(relevel);
      f.close();
    }

    this._persistPanel(gui, "gd_pursuitLevel3"); // bumped: per-level spans + bleed profile + L1-5

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "320px";
    gui.domElement.style.zIndex = "9999";
  }

  _buildWorld() {
    // Asphalt ground
    this.worldLayer.add(
      this.add
        .rectangle(
          WORLD_WIDTH / 2,
          WORLD_HEIGHT / 2,
          WORLD_WIDTH,
          WORLD_HEIGHT,
          0x1a1a24,
        )
        .setDepth(0),
    );

    // 1×1 white pixel used as the physics sprite for static bodies
    const px = this.add.graphics();
    px.fillStyle(0xffffff);
    px.fillRect(0, 0, 1, 1);
    px.generateTexture("_px", 1, 1);
    px.destroy();

    this.walls = this.physics.add.staticGroup();
    this.losRects = []; // building footprints for line-of-sight checks

    BUILDINGS.forEach(({ x, y, w, h }) => {
      const cx = x + w / 2;
      const cy = y + h / 2;

      // Visual building
      this.worldLayer.add(
        this.add
          .rectangle(cx, cy, w, h, 0x2c2c3e)
          .setStrokeStyle(1, 0x40405a)
          .setDepth(2),
      );

      // Physics body — scale the 1px texture to building size
      const body = this.walls.create(cx, cy, "_px");
      body.setDisplaySize(w, h).refreshBody();
      body.setVisible(false);

      this.losRects.push(new Phaser.Geom.Rectangle(x, y, w, h));
    });

    // Road lane dashes on the two center roads (visual only)
    this._drawRoadMarkings();
  }

  _drawRoadMarkings() {
    const g = this.add.graphics().setDepth(1);
    this.worldLayer.add(g);
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
    this.cursors = this.input.keyboard.createCursorKeys(); // includes .space
    this.wasd = this.input.keyboard.addKeys("W,A,S,D");
    this.shiftKey = this.input.keyboard.addKey(
      Phaser.Input.Keyboard.KeyCodes.SHIFT,
    );

    // Restart any time (same cop count); new run drops straight into play
    this.input.keyboard.on("keydown-R", () =>
      this.scene.restart({
        copCount: this.copCount,
        autostart: true,
        pursuitMode: this.pursuitMode,
        sandbox: this.sandbox,
      }),
    );
    // Back to the menu
    this.input.keyboard.on("keydown-M", () => this.scene.start("MenuScene"));
    // Pause toggle
    this.input.keyboard.on("keydown-P", () => this._togglePause());

    // Cop telemetry: press C to toggle throttled console logging of cop state. Works in
    // playtest mode too (console-only, no on-screen clutter) so traces can be captured
    // from the real, dev-tool-free experience.
    this.copLog = false;
    this._copLogTimer = 0;
    this.input.keyboard.on("keydown-C", () => {
      this.copLog = !this.copLog;
      console.log(`[cop telemetry] ${this.copLog ? "ON" : "OFF"}`);
    });

    // Spectate: press V to cycle the camera through player → each cop. While
    // viewing a cop, the car is frozen so you can watch a search without driving.
    this.camFocusIndex = 0; // 0 = player, 1..N = cop index + 1
    this.input.keyboard.on("keydown-V", () => {
      this.camFocusIndex = (this.camFocusIndex + 1) % (1 + this.cops.length);
      const sprite =
        this.camFocusIndex === 0
          ? this.car.sprite
          : this.cops[this.camFocusIndex - 1].sprite;
      this.cameras.main.startFollow(sprite, true, 0.1, 0.1);
    });
  }

  _setupDebugOverlay() {
    this.debugText = this.add
      .text(10, 46, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#39ff14",
        backgroundColor: "#00000099",
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(100)
      .setInteractive({ useHandCursor: true });
    // Collapsible: click the box (or press H) to fold it to a one-line header — handy
    // when the stats block covers the action during a playtest.
    this._statsCollapsed = false;
    const toggle = () => {
      this._statsCollapsed = !this._statsCollapsed;
    };
    this.debugText.on("pointerdown", toggle);
    this.input.keyboard.on("keydown-H", toggle);
  }

  // Keep the click hit-area matching the (variable-size) text after each setText.
  _syncStatsHit() {
    const i = this.debugText.input;
    if (i && i.hitArea) {
      i.hitArea.width = this.debugText.width;
      i.hitArea.height = this.debugText.height;
    }
  }

  _setupHud() {
    const { width } = this.scale;
    // Pursuit status (top centre)
    this.statusText = this.add
      .text(width / 2, 24, "", {
        fontFamily: "monospace",
        fontSize: "22px",
        fontStyle: "bold",
        color: "#ffffff",
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(100);

    // Heat / pursuit-level meter (Pursuit Mode only) — a thin bar under the status
    // showing progress toward the next level. Drawn each frame by _drawHeatBar.
    this.heatGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.heatLabel = this.add
      .text(width / 2, 44, "", {
        fontFamily: "monospace",
        fontSize: "11px",
        fontStyle: "bold",
        color: "#c8c8d4",
      })
      .setOrigin(1, 0.5)
      .setScrollFactor(0)
      .setDepth(101)
      .setAlpha(0);

    // "Reinforcements incoming" flash, shown beside the heat bar on each dispatch.
    this.reinforceText = this.add
      .text(width / 2, 62, "⚠ REINFORCEMENTS INCOMING", {
        fontFamily: "monospace",
        fontSize: "12px",
        fontStyle: "bold",
        color: "#ff5a1a",
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(101)
      .setAlpha(0);

    // Dev-only deployment counter, positioned in _drawCopCounter just right of the heat
    // bar (open space, clear of the centred pursuit HUD and the right-edge dev panel).
    if (this.devMode) {
      this.copCountText = this.add
        .text(0, 0, "", {
          fontFamily: "monospace",
          fontSize: "12px",
          fontStyle: "bold",
          color: "#c8c8d4",
          align: "left",
        })
        .setOrigin(0, 0.5)
        .setScrollFactor(0)
        .setDepth(101)
        .setAlpha(0);
    }

    // Large cooldown timer, shown only during the cooldown phase (below the heat bar)
    this.cooldownText = this.add
      .text(width / 2, 64, "", {
        fontFamily: "monospace",
        fontSize: "40px",
        fontStyle: "bold",
        color: "#ffd23f",
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(100);

    // Brief "GHOST" flash when a ditch completes
    this.ghostText = this.add
      .text(width / 2, this.scale.height / 2, "GHOST", {
        fontFamily: "monospace",
        fontSize: "96px",
        fontStyle: "bold",
        color: "#39ff14",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Bust meter bar (bottom centre) + its label
    this.bustGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.bustLabel = this.add
      .text(width / 2, this.scale.height - 52, "BUST", {
        fontFamily: "monospace",
        fontSize: "12px",
        fontStyle: "bold",
        color: "#ffffff",
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // BUSTED overlay
    this.bustedText = this.add
      .text(width / 2, this.scale.height / 2, "BUSTED\n\npress R to restart", {
        fontFamily: "monospace",
        fontSize: "56px",
        fontStyle: "bold",
        color: "#ff3b3b",
        align: "center",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(101)
      .setAlpha(0);

    // PAUSED overlay
    this.pausedText = this.add
      .text(width / 2, this.scale.height / 2, "PAUSED\n\npress P to play", {
        fontFamily: "monospace",
        fontSize: "56px",
        fontStyle: "bold",
        color: "#ffffff",
        align: "center",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(101)
      .setAlpha(0);
  }

  _togglePause() {
    if (this.busted) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.physics.pause();
      this.pausedText.setAlpha(1);
    } else {
      this.physics.resume();
      this.pausedText.setAlpha(0);
    }
  }

  _drawBustBar() {
    const g = this.bustGfx;
    g.clear();
    const v = this.bust.value;
    if (v <= 0) {
      this.bustLabel.setAlpha(0);
      return;
    }

    const { width, height } = this.scale;
    const w = 300,
      h = 16,
      x = (width - w) / 2,
      y = height - 40;
    const frac = v / 100;
    const col = frac < 0.5 ? 0xffd23f : frac < 0.8 ? 0xff8c1a : 0xff3b3b;

    g.fillStyle(0x000000, 0.5);
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle(col, 0.9);
    g.fillRect(x, y, w * frac, h);
    g.lineStyle(1, 0xffffff, 0.4);
    g.strokeRect(x, y, w, h);
    this.bustLabel.setAlpha(0.9);
  }

  _flashGhost() {
    this.ghostText.setAlpha(1).setScale(0.8);
    this.tweens.add({
      targets: this.ghostText,
      alpha: 0,
      scale: 1.4,
      duration: 1500,
      ease: "Cubic.easeOut",
    });
  }

  // Per-level heat-bar fill colours. Distinct hue per level so they read apart at a
  // glance: yellow → orange → red → magenta → violet (escalating, and none clashes with
  // the blue paused state or the green player UI).
  static HEAT_COLORS = [0xffe14d, 0xff9e1a, 0xff3b3b, 0xff36c0, 0x9b3cff];

  // Pursuit-Mode heat meter: thin bar under the status. Fill colour deepens with level;
  // turns BLUE while heat is paused (pre-ditch cooldown / lost LOS) or bleeding down
  // during withdraw. Every cleared level stays filled as the base, so each new level's
  // colour BUILDS ON TOP of the previous one instead of refilling an empty track. Flashes
  // "REINFORCEMENTS INCOMING" on each dispatch. `state` selects the colour phase.
  _drawHeatBar(state) {
    const g = this.heatGfx;
    g.clear();
    if (!this.pursuitLevel || !this.cops.length) {
      this.heatLabel.setAlpha(0);
      this.reinforceText.setAlpha(0);
      return;
    }

    const { width } = this.scale;
    const w = 200,
      h = 9,
      x = (width - w) / 2,
      y = 46;
    const P = this.pursuitLevel;
    const frac = P.heatFraction();
    const rising = state === PursuitState.ACTIVE;
    const lvIdx = Math.min(P.level, 5) - 1;
    const lvCol = GameScene.HEAT_COLORS[lvIdx];
    const col = rising ? lvCol : 0x4a90ff; // blue while paused / bleeding

    // Track border — thin outline so empty reads as background.
    g.lineStyle(1, 0xffffff, 0.22);
    g.strokeRect(x, y, w, h);

    // Base layer: every already-cleared level keeps its colour across the full bar, so
    // at level N the whole track reads as the N-1 colour and the current level's
    // progress layers over it (the "building on top" effect).
    if (lvIdx > 0) {
      g.fillStyle(GameScene.HEAT_COLORS[lvIdx - 1], 0.95);
      g.fillRect(x, y, w, h);
    }

    // Current level's progress on top of the base.
    g.fillStyle(col, 0.95);
    g.fillRect(x, y, w * frac, h);

    // Width of the visibly-filled bar (full once a base exists, else just the fill).
    const filledW = lvIdx > 0 ? w : w * frac;

    // Reinforcement flash: white pulse over the filled bar + the warning label, fading.
    const flashT = (this._reinforceFlashUntil || 0) - this.time.now;
    if (flashT > 0) {
      const a = Math.min(flashT / 1400, 1);
      g.fillStyle(0xffffff, a * 0.6);
      g.fillRect(x, y, filledW, h);
      this.reinforceText
        .setPosition(width / 2, y + 18)
        .setColor("#ff5a1a")
        .setAlpha(a);
    } else {
      this.reinforceText.setAlpha(0);
    }

    const label = !rising
      ? state === PursuitState.SEARCH && !this.pursuit.ditched
        ? "HOLD"
        : "COOLING"
      : P.atMax()
        ? "MAX HEAT"
        : "HEAT";
    this.heatLabel
      .setText(label)
      .setPosition(x - 8, y + h / 2)
      .setColor(`#${col.toString(16).padStart(6, "0")}`)
      .setAlpha(0.9);
  }

  // Dev-only deployment readout (top-right): total cops + how many are "special" (non-
  // patrol), with a per-type breakdown. A trimmed version of this is intended for the
  // final HUD, so keep it data-driven off the live roster.
  _drawCopCounter() {
    if (!this.copCountText) return;
    const total = this.cops.length;
    if (!total) {
      this.copCountText.setAlpha(0);
      return;
    }
    const counts = {};
    for (const c of this.cops)
      counts[c.unitType] = (counts[c.unitType] || 0) + 1;
    const special = total - (counts.patrol || 0);
    const breakdown = Object.keys(counts)
      .map((t) => `${counts[t]} ${t}`)
      .join("  ");
    this.copCountText
      .setText(`${total} COPS · ${special} SPECIAL\n${breakdown}`)
      .setPosition((this.scale.width + 200) / 2 + 14, 50) // just right of the centred heat bar
      .setColor(special > 0 ? "#ff9e1a" : "#c8c8d4")
      .setAlpha(0.9);
  }

  // Dev-only world overlay: LOS lines (green=visible, red=blocked), steering targets,
  // per-cop state labels, search coverage dots, last-known marker, station.
  _drawAiDebug(state, px, py) {
    this.aiDebug.clear();
    for (const cop of this.cops) {
      this.aiDebug.lineStyle(1, cop.hasLOS ? 0x39ff14 : 0xff3b3b, 0.35);
      this.aiDebug.lineBetween(cop.sprite.x, cop.sprite.y, px, py);
      if (cop.aiTarget) {
        this.aiDebug.lineStyle(1, 0xffaa00, 0.5);
        this.aiDebug.lineBetween(
          cop.sprite.x,
          cop.sprite.y,
          cop.aiTarget.x,
          cop.aiTarget.y,
        );
        this.aiDebug.fillStyle(0xffaa00, 0.8);
        this.aiDebug.fillCircle(cop.aiTarget.x, cop.aiTarget.y, 5);
      }
      // Live per-cop label: role (when chasing) + convoy mode + control mode + speed
      if (cop.modeLabel && cop.debug) {
        const role =
          state === PursuitState.ACTIVE && cop.role ? cop.role + " " : "";
        // Only show a convoy tag when it's not the ordinary "I can see you" case.
        const conv =
          state === PursuitState.ACTIVE &&
          cop.pursuitMode &&
          cop.pursuitMode !== "DIRECT"
            ? cop.pursuitMode + " "
            : "";
        cop.modeLabel.setPosition(cop.sprite.x, cop.sprite.y - 50); // above the health bar
        cop.modeLabel.setText(
          `${role}${conv}${cop.debug.mode} ${Math.round(cop.debug.speed)}`,
        );
        cop.modeLabel.setColor(cop.hasLOS ? "#39ff14" : "#ff8c8c");
      }
    }
    // Coverage paint: dot each search-area node — green = covered (seen recently),
    // red = still unsearched. Shows the cops dividing up the area.
    if (state === PursuitState.SEARCH) {
      for (const idx of this._searchArea()) {
        const p = this.navGrid.pos(idx);
        const covered =
          this._searchClock - this.coverage[idx] < this.coverageTTL;
        this.aiDebug.fillStyle(
          covered ? 0x39ff14 : 0xff3b3b,
          covered ? 0.5 : 0.28,
        );
        this.aiDebug.fillCircle(p.x, p.y, covered ? 16 : 10);
      }
    }
    // Last-known marker + escape-vector arrow while searching
    if (state === PursuitState.SEARCH && this.pursuit.hasLastKnown) {
      const lk = this.pursuit.lastKnown,
        dir = this.pursuit.lastKnownDir;
      this.aiDebug.lineStyle(2, 0xffd23f, 0.8);
      this.aiDebug.strokeCircle(lk.x, lk.y, 30);
      // arrow in the direction the player was last heading
      const ex = lk.x + Math.cos(dir) * 90,
        ey = lk.y + Math.sin(dir) * 90;
      this.aiDebug.lineStyle(3, 0xffd23f, 0.9);
      this.aiDebug.lineBetween(lk.x, lk.y, ex, ey);
      const ah = 0.5;
      this.aiDebug.lineBetween(
        ex,
        ey,
        ex - Math.cos(dir - ah) * 16,
        ey - Math.sin(dir - ah) * 16,
      );
      this.aiDebug.lineBetween(
        ex,
        ey,
        ex - Math.cos(dir + ah) * 16,
        ey - Math.sin(dir + ah) * 16,
      );
    }
    // Station marker
    this.aiDebug.lineStyle(2, 0x4a90ff, 0.6);
    this.aiDebug.strokeRect(this.station.x - 24, this.station.y - 24, 48, 48);
  }

  // Dev-only top-left text overlay: fps/speed/state + nearest-cop AI + controls.
  _drawDebugText(state, spectating, speed) {
    if (this._statsCollapsed) {
      this.debugText.setText("▸ stats (H)");
      this._syncStatsHit();
      return;
    }
    const view =
      this.camFocusIndex === 0 ? "PLAYER" : `COP ${this.camFocusIndex - 1}`;
    const lines = [
      "▾ stats — click / H to hide",
      `FPS:   ${Math.round(this.game.loop.actualFps)}`,
      `Speed: ${Math.round(speed)} px/s`,
      `Cops:  ${this.cops.length}`,
      `State: ${state}`,
      `Bust:  ${Math.round(this.bust.value)}%${this.bust.pinned ? " PINNED" : ""}`,
      `View:  ${view}${spectating ? " (car frozen)" : ""}`,
    ];

    // Nearest cop + its AI state
    let nearestCop = null,
      nearestDist = Infinity;
    for (const c of this.cops) {
      const d = Phaser.Math.Distance.Between(
        c.sprite.x,
        c.sprite.y,
        this.car.sprite.x,
        this.car.sprite.y,
      );
      if (d < nearestDist) {
        nearestDist = d;
        nearestCop = c;
      }
    }
    if (nearestCop) {
      const d = nearestCop.debug;
      lines.push(`Nearest cop: ${Math.round(nearestDist)} px`);
      if (d) {
        lines.push(
          `  mode:  ${d.mode}`,
          `  speed: ${Math.round(d.speed)}  limit: ${Math.round(d.cornerLimit)}`,
          `  bend:  ${((d.bend * 180) / Math.PI).toFixed(0)}°  err: ${((d.angleErr * 180) / Math.PI).toFixed(0)}°`,
        );
      }
    }
    if (this.car.isDrifting) lines.push("[HANDBRAKE DRIFT]");
    lines.push(
      "",
      "WASD / Arrows — Drive",
      "Space — Handbrake",
      "Shift — Brake",
      "P — Pause",
      "C — Cop decision log",
      "V — Cycle camera",
      "H — Toggle stats",
      "R — Restart",
      "M — Menu",
    );
    this.debugText.setText(lines);
    this._syncStatsHit();
  }

  _setupTunePanel() {
    const car = this.car;
    const gui = new GUI({ title: "Car Tuning", width: 280 });
    this.gui = gui;
    gui.close();

    const engine = gui.addFolder("Engine");
    engine.add(car, "acceleration", 10, 1500, 5).name("Acceleration");
    engine.add(car, "maxSpeed", 100, 1200, 10).name("Max Speed");
    engine.add(car, "hardBrakeForce", 50, 2000, 10).name("Hard Brake (Shift)");
    engine.add(car, "brakeForce", 10, 500, 5).name("S-key Brake Force");
    engine.add(car, "reverseAccel", 50, 1500, 10).name("Reverse Accel");
    engine.add(car, "maxReverseSpeed", 30, 600, 5).name("Max Reverse Speed");

    const steering = gui.addFolder("Steering");
    steering
      .add(car, "turnSpeedLow", 0.5, 8.0, 0.05)
      .name("Turn Speed low (rad/s)");
    steering
      .add(car, "turnSpeed", 0.5, 8.0, 0.05)
      .name("Turn Speed high (rad/s)");
    steering
      .add(car, "maxDriftAngle", 0.5, Math.PI * 0.95, 0.01)
      .name("Max Drift Angle (rad)");

    const drag = gui.addFolder("Drag");
    drag
      .add(car, "accelDragBase", 0.97, 0.9995, 0.0005)
      .name("Accel Drag Base");
    drag.add(car, "accelDragCurve", 0, 0.05, 0.001).name("Accel Drag Curve");
    drag.add(car, "coastDrag", 0.96, 0.9995, 0.0005).name("Coast Drag");
    drag.add(car, "handBrakeDrag", 0.97, 0.9995, 0.0005).name("Handbrake Drag");

    const grip = gui.addFolder("Grip");
    grip.add(car, "gripLow", 0.02, 0.6, 0.01).name("Grip (low speed)");
    grip.add(car, "gripHigh", 0.005, 0.2, 0.005).name("Grip (high speed)");
    grip.add(car, "gripSpeedRef", 50, 600, 5).name("High-speed grip at (px/s)");
    grip.add(car, "gripHandbrake", 0.001, 0.05, 0.001).name("Grip (handbrake)");
    grip.add(car, "entryKick", 0, 0.8, 0.01).name("Entry Kick (handbrake)");
    grip
      .add(car, "entryKickDuration", 0, 0.5, 0.01)
      .name("Entry Kick Duration (s)");
    grip
      .add(car, "entryKickCooldown", 0, 3.0, 0.05)
      .name("Entry Kick Cooldown (s)");

    gui
      .add(
        {
          copyStats: () => {
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
          },
        },
        "copyStats",
      )
      .name("Copy Stats → Console");

    // Capsule collider (the green dev circles) — live size, watch the overlay update.
    const cap = gui.addFolder("Capsule collider");
    cap.add(this, "playerCapR", 8, 40, 1).name("Radius (width)");
    cap.add(this, "playerCapHalfLen", 0, 40, 1).name("Spine half-length");

    // Persist across refresh (binds directly to the car, so load sets car fields).
    this._persistPanel(gui, "gd_carTuning_v2"); // bumped: player capsule -10% sizes rebaked

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.right = "8px";
    gui.domElement.style.zIndex = "9999";

    this.game.canvas.addEventListener("mousedown", () => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
    });
  }

  _setupCopTunePanel() {
    if (!this.cops.length) return;
    const c = this.cops[0],
      a = c.ai;

    // Single source of truth for the panel; changes are pushed to every cop.
    this.copTuning = {
      maxSpeed: c.baseMaxSpeed,
      acceleration: c.acceleration,
      gripLow: c.baseGripLow,
      gripHigh: c.baseGripHigh,
      gripSpeedRef: c.gripSpeedRef,
      turnSpeedLow: c.baseTurnSpeedLow,
      turnSpeed: c.baseTurnSpeed,
      minSteerFactor: c.minSteerFactor,
      cornerMinSpeed: a.cornerMinSpeed,
      maxApproachSpeed: a.baseApproach,
      brakeDecel: a.brakeDecel,
      arriveRadius: a.arriveRadius,
      senseDist: a.senseDist,
      directRange: a.directRange,
      chaseRange: a.chaseRange,
      reactionTime: a.reactionTime,
      sepRadius: this.sepRadius,
      sepStrength: this.sepStrength,
      rbStart: this.rbStart,
      rbFull: this.rbFull,
      rbGrip: this.rbGrip,
      rbTurnMult: this.rbTurnMult,
      rbSpeedBoost: this.rbSpeedBoost,
      respawnEnabled: this.respawnEnabled,
      respawnDist: this.respawnDist,
      respawnTime: this.respawnTime,
      searchSpeed: this.searchSpeed,
      searchDepth: this.searchDepth,
      searchMaxDepth: this.searchMaxDepth,
      coverageTTL: this.coverageTTL,
      searchDirBias: this.searchDirBias,
      searchDwell: this.searchDwell,
      searchStall: this.searchStall,
      boxTriggerSpeed: this.director.boxTriggerSpeed,
      boxEngageRange: this.director.boxEngageRange,
      boxAhead: this.director.boxAhead,
      boxBehind: this.director.boxBehind,
      convoyEnabled: this.director.convoyEnabled,
      followGap: this.director.followGap,
    };

    const gui = new GUI({ title: "Cop Tuning", width: 300 });
    this.copGui = gui;
    gui.close();
    const apply = () => this._applyCopTuning();

    const drive = gui.addFolder("Handling");
    drive
      .add(this.copTuning, "maxSpeed", 100, 1200, 10)
      .name("Max Speed")
      .onChange(apply);
    drive
      .add(this.copTuning, "acceleration", 10, 1500, 5)
      .name("Acceleration")
      .onChange(apply);
    drive
      .add(this.copTuning, "turnSpeedLow", 0.5, 8.0, 0.05)
      .name("Turn Speed low")
      .onChange(apply);
    drive
      .add(this.copTuning, "turnSpeed", 0.5, 8.0, 0.05)
      .name("Turn Speed high")
      .onChange(apply);
    drive
      .add(this.copTuning, "minSteerFactor", 0, 1.0, 0.05)
      .name("Low-speed steer floor")
      .onChange(apply);

    const grip = gui.addFolder("Grip");
    grip
      .add(this.copTuning, "gripLow", 0.02, 1.0, 0.01)
      .name("Grip (low speed)")
      .onChange(apply);
    grip
      .add(this.copTuning, "gripHigh", 0.005, 1.0, 0.005)
      .name("Grip (high speed)")
      .onChange(apply);
    grip
      .add(this.copTuning, "gripSpeedRef", 50, 600, 5)
      .name("High-speed grip at")
      .onChange(apply);

    const corner = gui.addFolder("Driving AI");
    corner
      .add(this.copTuning, "maxApproachSpeed", 200, 800, 10)
      .name("Straight speed")
      .onChange(apply);
    corner
      .add(this.copTuning, "cornerMinSpeed", 80, 500, 5)
      .name("Corner min speed")
      .onChange(apply);
    corner
      .add(this.copTuning, "brakeDecel", 100, 800, 10)
      .name("Brake planning")
      .onChange(apply);
    corner
      .add(this.copTuning, "arriveRadius", 30, 150, 5)
      .name("Node arrive radius")
      .onChange(apply);
    corner
      .add(this.copTuning, "senseDist", 200, 1000, 20)
      .name("Corner sense ahead")
      .onChange(apply);
    corner
      .add(this.copTuning, "directRange", 50, 400, 10)
      .name("Direct-aim range")
      .onChange(apply);
    corner
      .add(this.copTuning, "chaseRange", 150, 2000, 25)
      .name("Beeline range (else paths)")
      .onChange(apply);
    corner
      .add(this.copTuning, "reactionTime", 0, 0.5, 0.01)
      .name("Reaction lag (s)")
      .onChange(apply);

    const pack = gui.addFolder("Pack & Search");
    pack
      .add(this.copTuning, "boxTriggerSpeed", 0, 400, 10)
      .name("Box: trigger below speed")
      .onChange(apply);
    pack
      .add(this.copTuning, "boxEngageRange", 100, 1200, 20)
      .name("Box: engage range")
      .onChange(apply);
    pack
      .add(this.copTuning, "boxAhead", 0, 300, 5)
      .name("Box: front cut-ahead")
      .onChange(apply);
    pack
      .add(this.copTuning, "boxBehind", 0, 300, 5)
      .name("Box: rear gap")
      .onChange(apply);
    pack
      .add(this.copTuning, "sepRadius", 0, 250, 5)
      .name("Separation radius")
      .onChange(apply);
    pack
      .add(this.copTuning, "sepStrength", 0, 400, 5)
      .name("Separation strength")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchSpeed", 80, 600, 10)
      .name("Search speed cap")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchDepth", 1, 6, 1)
      .name("Search start (blocks)")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchMaxDepth", 1, 10, 1)
      .name("Search max (blocks)")
      .onChange(apply);
    pack
      .add(this.copTuning, "coverageTTL", 1, 20, 1)
      .name("Search memory (s)")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchDirBias", 0, 150, 5)
      .name("Escape-dir bias")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchDwell", 0, 4, 0.1)
      .name("Search dwell (s)")
      .onChange(apply);
    pack
      .add(this.copTuning, "searchStall", 1, 8, 0.5)
      .name("Search give-up (s)")
      .onChange(apply);

    const convoy = gui.addFolder("Convoy (blind cops)");
    convoy
      .add(this.copTuning, "convoyEnabled")
      .name("Convoy following")
      .onChange(apply);
    convoy
      .add(this.copTuning, "followGap", 30, 300, 10)
      .name("Follow gap behind leader")
      .onChange(apply);

    const rejoin = gui.addFolder("Rejoin (far cops)");
    rejoin
      .add(this.copTuning, "rbStart", 0, 2500, 50)
      .name("Blend start (px)")
      .onChange(apply);
    rejoin
      .add(this.copTuning, "rbFull", 100, 3500, 50)
      .name("Blend full (px)")
      .onChange(apply);
    rejoin
      .add(this.copTuning, "rbGrip", 0.1, 1.0, 0.05)
      .name("Grip at full")
      .onChange(apply);
    rejoin
      .add(this.copTuning, "rbTurnMult", 1.0, 3.0, 0.1)
      .name("Turn × at full")
      .onChange(apply);
    rejoin
      .add(this.copTuning, "rbSpeedBoost", 0, 400, 10)
      .name("Speed boost at full")
      .onChange(apply);

    const respawn = gui.addFolder("Respawn (lost cops)");
    respawn
      .add(this.copTuning, "respawnEnabled")
      .name("Respawn lost cops")
      .onChange(apply);
    respawn
      .add(this.copTuning, "respawnDist", 500, 3000, 50)
      .name("Lost distance (px)")
      .onChange(apply);
    respawn
      .add(this.copTuning, "respawnTime", 1, 12, 0.5)
      .name("Lost time (s)")
      .onChange(apply);

    // Bust meter — bound straight to the live BustMeter (fill scales with crowding cops).
    const bustF = gui.addFolder("Bust meter");
    bustF.add(this.bust, "pinDistance", 20, 200, 5).name("Pin distance (px)");
    bustF.add(this.bust, "pinSpeed", 0, 300, 10).name("Pinnable below (px/s)");
    bustF
      .add(this.bust, "surroundRange", 40, 300, 10)
      .name("Crowd count range (px)");
    bustF.add(this.bust, "fillBase", 0, 60, 1).name("Fill: 1 cop /s");
    bustF
      .add(this.bust, "fillPerCop", 0, 40, 1)
      .name("Fill: + per extra cop /s");
    bustF.add(this.bust, "fillMax", 10, 120, 5).name("Fill: max /s");
    bustF.add(this.bust, "drainRate", 0, 200, 5).name("Drain /s");
    bustF.close();

    gui
      .add(
        {
          copyStats: () => {
            const t = this.copTuning;
            console.log(`// --- Cop handling (CopCar stats) ---
maxSpeed: ${t.maxSpeed}, acceleration: ${t.acceleration},
gripLow: ${t.gripLow}, gripHigh: ${t.gripHigh}, gripSpeedRef: ${t.gripSpeedRef},
turnSpeedLow: ${t.turnSpeedLow}, turnSpeed: ${t.turnSpeed}, minSteerFactor: ${t.minSteerFactor},
// --- Cop behaviour (CopAI) ---
maxApproachSpeed: ${t.maxApproachSpeed}, cornerMinSpeed: ${t.cornerMinSpeed}, brakeDecel: ${t.brakeDecel},
arriveRadius: ${t.arriveRadius}, senseDist: ${t.senseDist}, directRange: ${t.directRange}, chaseRange: ${t.chaseRange}, reactionTime: ${t.reactionTime},
// --- Formation + convoy (PursuitDirector) ---
boxTriggerSpeed: ${t.boxTriggerSpeed}, boxEngageRange: ${t.boxEngageRange}, boxAhead: ${t.boxAhead}, boxBehind: ${t.boxBehind},
convoyEnabled: ${t.convoyEnabled}, followGap: ${t.followGap},
// --- Separation + rejoin band + search (GameScene) ---
sepRadius: ${t.sepRadius}, sepStrength: ${t.sepStrength},
rbStart: ${t.rbStart}, rbFull: ${t.rbFull}, rbGrip: ${t.rbGrip}, rbTurnMult: ${t.rbTurnMult}, rbSpeedBoost: ${t.rbSpeedBoost},
respawnEnabled: ${t.respawnEnabled}, respawnDist: ${t.respawnDist}, respawnTime: ${t.respawnTime},
searchSpeed: ${t.searchSpeed}, searchDepth: ${t.searchDepth}, searchMaxDepth: ${t.searchMaxDepth}, coverageTTL: ${t.coverageTTL}, searchDirBias: ${t.searchDirBias}, searchDwell: ${t.searchDwell}, searchStall: ${t.searchStall}`);
          },
        },
        "copyStats",
      )
      .name("Copy Cop Stats → Console");

    // Persist across refresh. Key bumped to v16: huntLead removed (blind cops now go
    // straight to last-known, no forward projection).
    this._persistPanel(gui, "gd_copTuning17"); // bumped: added Bust meter folder

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Wire a lil-gui panel to localStorage: restore on open, save on change, and a
  // Reset button that clears the saved values and restores the code defaults
  // (important after a defaults change — a stale save would otherwise mask it).
  _persistPanel(gui, key) {
    const defaults = gui.save(); // snapshot the code defaults BEFORE applying any save
    try {
      const saved = localStorage.getItem(key);
      if (saved) gui.load(JSON.parse(saved));
    } catch (e) {
      /* corrupt/unavailable storage — ignore, use defaults */
    }
    gui.onChange(() => {
      try {
        localStorage.setItem(key, JSON.stringify(gui.save()));
      } catch (e) {
        /* ignore */
      }
    });
    gui
      .add(
        {
          reset: () => {
            gui.load(defaults); // restore + apply code defaults
            try {
              localStorage.removeItem(key);
            } catch (e) {
              /* ignore */
            }
          },
        },
        "reset",
      )
      .name("⟲ Reset to defaults");
  }

  _applyCopTuning() {
    const t = this.copTuning;
    for (const cop of this.cops) {
      // Write BOTH the live stat and its base copy — the Tier-1 rejoin blend lerps
      // the live fields each frame from these bases, so the panel must own the bases.
      cop.baseMaxSpeed = t.maxSpeed;
      cop.maxSpeed = t.maxSpeed;
      cop.acceleration = t.acceleration;
      cop.baseGripLow = t.gripLow;
      cop.gripLow = t.gripLow;
      cop.baseGripHigh = t.gripHigh;
      cop.gripHigh = t.gripHigh;
      cop.gripSpeedRef = t.gripSpeedRef;
      cop.baseTurnSpeedLow = t.turnSpeedLow;
      cop.turnSpeedLow = t.turnSpeedLow;
      cop.baseTurnSpeed = t.turnSpeed;
      cop.turnSpeed = t.turnSpeed;
      cop.minSteerFactor = t.minSteerFactor;
      const a = cop.ai;
      a.cornerMinSpeed = t.cornerMinSpeed;
      a.baseApproach = t.maxApproachSpeed;
      a.brakeDecel = t.brakeDecel;
      a.arriveRadius = t.arriveRadius;
      a.senseDist = t.senseDist;
      a.directRange = t.directRange;
      a.chaseRange = t.chaseRange;
      a.reactionTime = t.reactionTime;
    }
    this.sepRadius = t.sepRadius;
    this.sepStrength = t.sepStrength;
    this.rbStart = t.rbStart;
    this.rbFull = t.rbFull;
    this.rbGrip = t.rbGrip;
    this.rbTurnMult = t.rbTurnMult;
    this.rbSpeedBoost = t.rbSpeedBoost;
    this.respawnEnabled = t.respawnEnabled;
    this.respawnDist = t.respawnDist;
    this.respawnTime = t.respawnTime;
    this.searchSpeed = t.searchSpeed;
    this.searchDepth = t.searchDepth;
    this.searchMaxDepth = t.searchMaxDepth;
    this.coverageTTL = t.coverageTTL;
    this.searchDirBias = t.searchDirBias;
    this.searchDwell = t.searchDwell;
    this.searchStall = t.searchStall;
    this.director.boxTriggerSpeed = t.boxTriggerSpeed;
    this.director.boxEngageRange = t.boxEngageRange;
    this.director.boxAhead = t.boxAhead;
    this.director.boxBehind = t.boxBehind;
    this.director.convoyEnabled = t.convoyEnabled;
    this.director.followGap = t.followGap;
  }

  update(_time, delta) {
    // Frozen after a bust (R restarts) or while paused (P resumes) — both keys
    // are handled by their keydown listeners, so just hold here.
    if (this.busted || this.paused) return;

    // Cop ram-damage / disabling, and ageing out wrecks. Run FIRST, before anyone's
    // velocity is touched this frame, so a hit's onset reads the true approach speed.
    this._updateCopDamage(delta / 1000);
    this._updateWrecks(delta / 1000);
    this._updateRoadblocks(this.car.sprite.x, this.car.sprite.y, delta / 1000);
    this._updateSpikes(this.car.sprite.x, this.car.sprite.y, delta / 1000);

    // While spectating a cop (camera not on the player), freeze the car so the
    // observer can't accidentally drive or re-trigger anything.
    const spectating = this.camFocusIndex !== 0;
    const controls = spectating
      ? {
          up: false,
          down: false,
          left: false,
          right: false,
          handbrake: false,
          brake: false,
        }
      : {
          up: this.cursors.up.isDown || this.wasd.W.isDown,
          down: this.cursors.down.isDown || this.wasd.S.isDown,
          left: this.cursors.left.isDown || this.wasd.A.isDown,
          right: this.cursors.right.isDown || this.wasd.D.isDown,
          handbrake: this.cursors.space.isDown,
          brake: this.shiftKey.isDown,
        };

    // Ram bog: after a frontal cop ram the engine briefly loses power so you can't instantly
    // power back through. Scale acceleration down for this update only, then restore (so the
    // tuning panel's value is untouched), and bleed the timer.
    let _bogAccel = null;
    if ((this.car._ramBog || 0) > 0) {
      _bogAccel = this.car.acceleration;
      this.car.acceleration *= this.ramBogAccel;
      this.car._ramBog = Math.max(0, this.car._ramBog - delta / 1000);
    }
    this.car.update(delta, controls);
    if (_bogAccel != null) this.car.acceleration = _bogAccel;
    this._carLastVx = this.car.vx;
    this._carLastVy = this.car.vy; // pre-collision cache (see _updateCopDamage)

    // --- Perception: a cop is AWARE of the player if it has a clear sight line
    // within range, OR the player is within close proximity (omnidirectional —
    // you can't lose someone beside you). Awareness persists for awareGrace after
    // the last perception, so a momentary ray break (corner clip, spin-out) does
    // not drop the chase. ---
    const px = this.car.sprite.x,
      py = this.car.sprite.y;
    const dt = delta / 1000;
    let anyAware = false,
      anyLOS = false;
    let nearestCopDist = Infinity;
    for (const cop of this.cops) {
      const d = Phaser.Math.Distance.Between(
        cop.sprite.x,
        cop.sprite.y,
        px,
        py,
      );
      if (d < nearestCopDist) nearestCopDist = d;
      const sees =
        d <= this.proximityRange ||
        (d <= this.sightRange &&
          segmentClear(cop.sprite.x, cop.sprite.y, px, py, this.losRects));
      cop.awareTimer = sees
        ? this.awareGrace
        : Math.max(0, (cop.awareTimer || 0) - dt);
      cop.hasLOS = sees; // instantaneous real line of sight
      cop.aware = cop.awareTimer > 0; // includes the memory grace
      if (cop.aware) anyAware = true;
      if (sees) anyLOS = true;
    }

    // Record each cop's breadcrumb trail (for convoy-following) BEFORE the director
    // runs, so a leader's trail is current when a follower picks its target.
    for (const cop of this.cops) this._recordTrail(cop);

    // --- Pursuit state machine. `aware` (grace) keeps it ACTIVE through flickers;
    // only a real line of sight (`anyLOS`) moves the last-known marker, so a juke
    // behind a building commits the cops to where they GENUINELY last saw you. ---
    // Sandbox pins the pursuit ACTIVE (force awareness) so spawned units relentlessly
    // chase — no ditch/search/return — keeping a unit always exercising its behavior
    // while you tune it. lastKnown still only moves on a REAL sighting, so blind-nav is
    // unchanged. (Cops still navigate to last-known when they personally lose sight.)
    const state = this.pursuit.update(
      this.sandbox || anyAware,
      anyLOS,
      px,
      py,
      dt,
    );
    if (this.pursuit.justDitched) this._flashGhost();
    // Player's heading/speed at the last REAL sighting (the search/track vector).
    if (anyLOS) {
      this.pursuit.lastKnownDir =
        this.car.getSpeed() > 40
          ? Math.atan2(this.car.vy, this.car.vx)
          : this.car.facing;
      this.pursuit.lastKnownSpeed = this.car.getSpeed();
    }

    // On entering SEARCH, start a fresh coverage map + clock + radius, and send
    // every cop to the LAST-KNOWN LOCATION first — the chase keeps priority, so
    // they drive to where they last saw you (regaining sight en route resumes the
    // chase) and only begin the node search once they actually arrive there.
    if (
      state === PursuitState.SEARCH &&
      this._prevState !== PursuitState.SEARCH
    ) {
      this.coverage.fill(-1e9);
      this._searchClock = 0;
      this._searchRadius = this.searchDepth;
      const lkNode = this.navGrid.nearestNode(
        this.pursuit.lastKnown.x,
        this.pursuit.lastKnown.y,
      );
      for (const cop of this.cops) cop._searchNode = lkNode;
    }
    this._prevState = state;

    // Pursuit Mode: advance heat/level and dispatch/retire reinforcements. Runs before
    // the director so a cop dispatched this frame is included in coordination/targets.
    if (this.pursuitLevel) this._updatePursuitLevel(state, dt);

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
      // PIT availability + severity are LEVEL-derived (heat is the source of truth). In the
      // sandbox there's no PursuitLevel, so pitTestLevel stands in so the maneuver can be felt
      // at each tier. pitPower ramps 0→1 from the min level to L5.
      const lvl = this.pursuitLevel ? this.pursuitLevel.level : this.pitTestLevel;
      const minL = this.director.pitMinLevel;
      this.director.pitEnabled = lvl >= minL;
      this.director.pitPower = Phaser.Math.Clamp((lvl - minL) / Math.max(1, 5 - minL), 0, 1);
      this.director.update(this.cops, this.car, delta / 1000);
      // A spike unit that reached its deploy point queued a drop — build the strip + clear it.
      for (const cop of this.cops) {
        if (cop._spikeDrop) { this._dropSpike(cop._spikeDrop); cop._spikeDrop = null; }
      }
    }

    // While searching, advance the coverage clock and let every cop paint what it
    // can see BEFORE anyone picks a target — so they react to each other's coverage.
    if (state === PursuitState.SEARCH) {
      this._searchClock += dt;
      const area = this._searchArea();
      for (const cop of this.cops) this._paintCoverage(cop, area);
      // EXPAND: once most of the current radius has been seen, grow it a ring so
      // the cops spiral outward instead of re-checking the same area forever.
      if (this._searchRadius < this.searchMaxDepth) {
        const seen = area.reduce(
          (c, idx) => c + (this.coverage[idx] > -1e8 ? 1 : 0),
          0,
        );
        if (seen >= area.length * 0.7) this._searchRadius++;
      }
    }

    for (const cop of this.cops) {
      let target = null;
      // Roadblock park state only applies while the chase is live; drop it otherwise so a
      // heavy that loses the chase stops parking and searches/returns normally.
      if (state !== PursuitState.ACTIVE) { cop.parkAngle = null; cop._blockPoint = null; }
      // ACTIVE: a cop that can SEE the player uses the Director's live, coordinated
      // target; a cop WITHOUT its own sight line heads for a drivable last-known goal
      // (never the live position, which may be inside a building) and lets CopAI route
      // there on the road network. Keeps the chase priority while the cop is blind.
      if (state === PursuitState.ACTIVE)
        target = cop.hasLOS ? cop.dirTarget : this._huntGoal();
      else if (state === PursuitState.SEARCH)
        target = this._cooldownTarget(cop);
      else if (state === PursuitState.RETURNING) target = this.station;
      // Separation spreads cops apart so they don't pile up — but a CONVOY follower is
      // deliberately tracking a single drivable line, so nudging its target sideways
      // would shove it into a wall. Skip separation for convoy cops; clamp always.
      const convoying =
        state === PursuitState.ACTIVE && cop.pursuitMode === "CONVOY";
      if (target) {
        if (!convoying) target = this._separate(cop, target);
        target = this._clampWorld(target);
      }
      // Full speed while chasing OR hunting; capped only for sustained search / withdrawal.
      // In ACTIVE the director may impose a maneuver/drafting cap (overtake-block, anti-
      // bumper-grind) — honour it so a fast unit spends its speed on maneuvers, not tailing.
      const slow =
        (state === PursuitState.SEARCH && !hunting) ||
        state === PursuitState.RETURNING;
      cop.ai.speedCap = slow
        ? this.searchSpeed
        : state === PursuitState.ACTIVE && cop.maneuverSpeedCap != null
          ? cop.maneuverSpeedCap
          : Infinity;
      // Tier-1 rejoin: blend handling toward near-kinematic the farther this cop is.
      this._applyRejoinBand(
        cop,
        Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py),
      );
      // Overtake speed boost: a committed overtaker gets extra top-end so it can actually
      // pass the player. Applied AFTER the rejoin band (which rewrites maxSpeed from base),
      // and raises the AI's approach cap to match so maxApproachSpeed isn't the bottleneck.
      const boost = state === PursuitState.ACTIVE ? cop.maneuverBoost || 0 : 0;
      cop.maxSpeed += boost;
      cop.ai.maxApproachSpeed = cop.ai.baseApproach + boost;
      cop.update(delta, target);
      cop._lastVx = cop.vx;
      cop._lastVy = cop.vy; // pre-collision cache (see _updateCopDamage)
    }

    // Custom rotated-car capsule collision: now that the player AND every cop have
    // integrated this frame, push every agent's 3-circle spine out of walls and apart
    // from each other (Arcade's AABB can't cover a rotated car). ADDITIVE to Arcade.
    this._resolveCapsules();

    // Tier-2 rejoin: a cop that's been far + not chasing + off-screen for a while is
    // relocated off-screen near the player instead of grinding all the way back.
    if (state === PursuitState.ACTIVE) this._respawnLostCops(px, py, dt);

    // Once every cop has reached the station, the area is fully clear. A cop wedged in
    // a tight alley on the way home (the K-turn can't always escape) would otherwise
    // strand the pursuit in RETURNING forever — so a returning cop that's stuck for a
    // beat just warps home. The chase is over and it's off-screen, so it's invisible.
    if (state === PursuitState.RETURNING) {
      for (const cop of this.cops) {
        cop._returnStuckT =
          cop.getSpeed() < 30 ? (cop._returnStuckT || 0) + dt : 0;
        if (
          cop._returnStuckT > 3 &&
          Phaser.Math.Distance.Between(
            cop.sprite.x,
            cop.sprite.y,
            this.station.x,
            this.station.y,
          ) > 90
        ) {
          this._placeCop(cop, this.station.x, this.station.y, px, py);
          cop._returnStuckT = 0;
        }
      }
      const allHome = this.cops.every(
        (c) =>
          Phaser.Math.Distance.Between(
            c.sprite.x,
            c.sprite.y,
            this.station.x,
            this.station.y,
          ) < 90,
      );
      if (allHome) this.pursuit.markIdle();
    }

    // --- Bust meter (lose condition) ---
    // Pinned = actively pursued, a cop right on you, and you're slow (boxed/stopped).
    const playerSpeed = this.car.getSpeed();
    // No arrest in the testbed — getting boxed shouldn't pause physics mid-tune.
    const pinned =
      !this.sandbox &&
      state === PursuitState.ACTIVE &&
      nearestCopDist < this.bust.pinDistance &&
      playerSpeed < this.bust.pinSpeed;
    // How many cops are crowding you — scales the fill rate (1 cop = slow burn, a swarm
    // busts fast). Counted within surroundRange; only matters while pinned.
    let pinCount = 0;
    if (pinned) {
      for (const cop of this.cops) {
        if (
          Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py) <
          this.bust.surroundRange
        )
          pinCount++;
      }
    }
    this.bust.update(pinned, pinCount, delta / 1000);
    if (this.bust.isBusted) {
      this.busted = true;
      this.bustedText.setAlpha(1);
      this.physics.pause();
      return;
    }
    this._drawBustBar();
    this._drawHeatBar(state);
    this._drawHealthBars();
    if (this.devMode) this._drawCopCounter();

    // Dev overlay: LOS lines, steering targets, per-cop labels, search coverage.
    if (this.devMode) this._drawAiDebug(state, px, py);

    const speed = this.car.getSpeed();

    // Camera: when following the player, add speed-based look-ahead and zoom-out.
    // When spectating a cop, sit centered on it at neutral zoom.
    if (!spectating) {
      const lookX = this.car.vx * 0.15;
      const lookY = this.car.vy * 0.15;
      this.cameras.main.setFollowOffset(-lookX, -lookY);
      const targetZoom = Phaser.Math.Linear(
        1.0,
        0.62,
        Math.min(speed / 450, 1),
      );
      this.cameras.main.zoom = Phaser.Math.Linear(
        this.cameras.main.zoom,
        targetZoom,
        0.04,
      );
    } else {
      this.cameras.main.setFollowOffset(0, 0);
      this.cameras.main.zoom = Phaser.Math.Linear(
        this.cameras.main.zoom,
        1.0,
        0.06,
      );
    }

    // --- Pursuit HUD ---
    if (!this.cops.length) {
      this.statusText.setText("FREE DRIVE").setColor("#9aa0b5");
      this.cooldownText.setText("");
    } else if (state === PursuitState.ACTIVE || hunting) {
      // Hunting = they just lost sight and are still charging — read as pursuit.
      const lv = this.pursuitLevel ? ` · L${this.pursuitLevel.level}` : "";
      this.statusText.setText(`● PURSUIT${lv}`).setColor("#ff3b3b");
      this.cooldownText.setText("");
    } else if (state === PursuitState.SEARCH && !this.pursuit.ditched) {
      this.statusText.setText("EVADING").setColor("#ffd23f");
      this.cooldownText.setText(this.pursuit.cooldown.toFixed(1));
    } else if (state === PursuitState.SEARCH && this.pursuit.ditched) {
      this.statusText.setText("AREA HOT").setColor("#ff8c1a");
      this.cooldownText.setText(this.pursuit.hot.toFixed(0));
    } else if (state === PursuitState.RETURNING) {
      this.statusText.setText("WITHDRAWING").setColor("#9aa0b5");
      this.cooldownText.setText("");
    } else {
      this.statusText.setText("CLEAR").setColor("#39ff14");
      this.cooldownText.setText("");
    }

    // Dev text overlay (top-left stats + controls reference).
    if (this.devMode && this.debugText)
      this._drawDebugText(state, spectating, speed);

    // Cop decision trace. Logs a line only when a cop's DECISION or its EFFECT
    // changes — so the console reads as a cause→effect sequence (what fired, what
    // it caused) instead of a number wall. Fields:
    //   state (+HUNT/+DITCHED) · role · flank-case · AI mode · LOS · cmd→act speed
    //   · WALL (against a building/bound) · STUCK (wants to move but isn't, ~crash)
    if (this.copLog) {
      const t = (this.time.now / 1000).toFixed(2);
      const dt = delta / 1000;
      const stateTag =
        this.pursuit.state +
        (this.pursuit.hunting ? "+HUNT" : "") +
        (this.pursuit.ditched ? "+DITCHED" : "");
      this.cops.forEach((cop, i) => {
        const d = cop.debug || {};
        const cmd = Math.round(d.speed || 0); // speed the AI is asking for
        const act = Math.round(cop.getSpeed()); // speed it's actually doing
        const b = cop.sprite.body.blocked;
        const wall = b && !b.none; // touching a building / world bound

        // STUCK: it wants to move (cmd high) but barely is (act low) for a beat.
        if (cmd > 60 && act < 40) cop._slowT = (cop._slowT || 0) + dt;
        else cop._slowT = 0;
        const stuck = (cop._slowT || 0) > 0.25;

        // Behaviour state (PURSUE / BOX_F / BOX_R), ACTIVE only.
        const role =
          this.pursuit.state === PursuitState.ACTIVE && cop.role
            ? cop.role
            : "—";
        const los = cop.hasLOS ? "LOS" : "los✗";
        // Convoy relay mode (DIRECT/CONVOY/LONE), ACTIVE only — shows who's chasing
        // directly vs. following a teammate's trail vs. on their own.
        const conv =
          this.pursuit.state === PursuitState.ACTIVE && cop.pursuitMode
            ? cop.pursuitMode
            : "—";
        // Coarse phase for the change-signature only. The raw throttle mode
        // (CHASE/PURSUE/CRUISE/BRAKE) flickers every few frames at a speed cap, which
        // would spam a new line each flip and bury the events that matter. Collapse
        // it to what we actually want to catch — wedge-recovery vs ordinary driving —
        // so a line prints on real decision changes. The raw mode still shows in the line.
        const phase =
          d.mode === "UNSTK_BK" || d.mode === "UNSTK_FW"
            ? "UNSTK"
            : d.mode === "STANDDOWN"
              ? "STANDDOWN"
              : "DRIVE";
        const sig = `${stateTag}|${role}|${conv}|${phase}|${los}|${wall ? "W" : ""}|${stuck ? "S" : ""}`;
        if (sig !== cop._sig) {
          cop._sig = sig;
          console.log(
            `[t=${t} cop${i}] ${stateTag} ${role} ${conv} ${d.mode} ${los} ` +
              `cmd=${cmd} act=${act} dist=${Math.round(d.dist || 0)}` +
              (wall ? " WALL" : "") +
              (stuck ? " STUCK" : ""),
          );
        }
      });
    }
  }
}
