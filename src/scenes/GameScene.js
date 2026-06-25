import Phaser from "phaser";
import GUI from "lil-gui";
import { PlayerCar } from "../entities/PlayerCar.js";
import { CopCar } from "../entities/CopCar.js";
import { NavGrid } from "../ai/NavGrid.js";
import { segmentClear } from "../ai/lineOfSight.js";
import { CopAI } from "../ai/CopAI.js";
import { UNITS } from "../ai/units.js";
import { TOOLTIPS } from "../ui/tooltips.js";
import { PursuitDirector, CopState } from "../ai/PursuitDirector.js";
import { Pursuit, PursuitState } from "../systems/Pursuit.js";
import { PursuitLevel } from "../systems/PursuitLevel.js";
import { BustMeter } from "../systems/BustMeter.js";
import { CarLights } from "../fx/CarLights.js";
import { ScreenEdgeFx } from "../fx/ScreenEdgeFx.js";
import { GameAudio } from "../audio/GameAudio.js";
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
import { BUILDINGS, GARAGES } from "../world/city.js";

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
    // Shared light-tuning multipliers (brightness/size), adjusted live in the car panel.
    this.lightTuning = { head: 1, headLen: 1, headWid: 1, brake: 1, flash: 1 };
    this.car.lights = new CarLights(this, this.car, "player", this.worldLayer, this.lightTuning);
    // Procedural audio (synth engine + panned cop sirens). Torn down on scene shutdown
    // so a restart doesn't leak running oscillators.
    this.audio = new GameAudio(this);
    this.events.once("shutdown", () => this.audio && this.audio.destroy());

    this.physics.add.collider(this.car.sprite, this.walls);
    // Player CAPSULE collider (custom): Arcade's body can't rotate, so the car is modelled
    // as 3 circles along its spine and pushed out of walls by hand (rounded → slides along
    // corners). The Arcade square above stays as a centre backstop. (Cars are the next step.)
    this.playerCapHalfLen = 13; // circle offset from centre along the car's facing (player −10%)
    this.playerCapR       = 10; // capsule radius (≈ half the car width)
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

    // --- Gadget: Oil Slick (player) — drop a splotchy patch behind you; a cop that drives
    // over it loses grip (slides) + some speed for a duration. Charges per run (no economy
    // yet). All levers live in the Gadgets dev panel. ---
    this.oilSlicks = [];        // active patches: { x, y, r, t, blobs }
    this.oilMaxCharges = 3;     // charges at the start of a run
    this.oilCharges = this.oilMaxCharges;
    this.oilPatchRadius = 26;   // px radius (~1.5× car width across)
    this.oilLifetime = 30;      // s the patch stays on the road before fading out
    this.oilGripLost = 0.9;     // peak slipperiness (absolute ice grip) the instant a cop hits oil
    this.oilSpeedLost = 0;      // fraction of speed scrubbed on first contact (0 = keep momentum)
    this.oilEffectTime = 30;    // s the slide takes to DECAY from full strength back to normal

    // --- Gadget: Nitro Boost (player) — a short burst that scales BOTH acceleration and top
    // speed for a few seconds (one charge). Applied non-destructively in the update loop: it
    // multiplies the live car stats for that frame only, then restores them, so the tuning
    // panel's base values are never mutated (same approach as the ram-bog). All levers in the
    // Gadgets dev panel. ---
    this.nitroMaxCharges = 3;   // charges at the start of a run
    this.nitroCharges = this.nitroMaxCharges;
    this.nitroDuration = 2.5;   // s a single boost lasts
    this.nitroAccelMult = 1.3;  // acceleration ×multiplier while boosting (the "kick")
    this.nitroSpeedMult = 1.4;  // top-speed ×multiplier while boosting (the new ceiling)
    this.nitroTimer = 0;        // s remaining on the active boost (0 = not boosting)

    this.spikes = []; // deployed spike strips (cop hazard)
    this.spikeLifetime = 20; // s a dropped strip persists before it despawns
    this.spikeStripLen = 28; // px across — a cop-deployed strip is ~car-width (DODGEABLE). Roadblock
                             // spike strips (future, L3+) stay wider; they pass their own width.
    // --- Cop spike HAZARD effect: driving over a strip BLOWS YOUR TIRES — a heavy, lasting cripple
    // (capped top speed + degraded grip/accel + a pull to one side). It robs the momentum that keeps
    // you un-bustable, so spikes SET UP a bust rather than deal one. Intended counter is the (future)
    // Repair Kit gadget — _repairTires() clears it instantly; until then it heals slowly on its own
    // over spikeCrippleDuration so it isn't a soft-lock. Applied non-destructively in the update loop
    // (multiplies live car stats for the frame, then restores — same approach as nitro/ram-bog). ---
    this.spikeContactPad = 14;     // px added to the strip half-depth for the player-overlap test
    this.spikeHitScrub = 0.3;      // fraction of speed scrubbed on the contact jolt
    this.spikeWobble = 0.12;       // rad of one-shot random yaw kick on contact (the blowout lurch)
    this.spikeCrippleDuration = 25;// s a blowout takes to fully heal on its own (heavy/long)
    this.spikeSpeedCap = 0.5;      // top-speed × at full blowout (eases back to 1 as it heals)
    this.spikeAccelMult = 0.55;    // acceleration × at full blowout
    this.spikeGripMult = 0.6;      // grip × at full blowout (looser → slides more)
    this.spikePull = 0.25;         // rad/s steer pull to one side at full blowout (counter-steerable)
    this.spikeCrippleTime = 0;     // s remaining on the active blowout (0 = tires fine)
    this._spikePullSign = 1;       // which side the pull goes (set per hit)
    this._onSpikes = false;        // rising-edge tracker so a drive-over fires once, not every frame
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
    // Kill Lights (stealth): with the player's lights off the cop sight RADIUS collapses to
    // killLightsRange when crawling, and blends BACK toward sightRange as the player speeds up
    // (illumSpeedRef = speed at which a dark car is as visible as a lit one). Proximity (70px)
    // is untouched — you can't vanish on a cop's bumper. See _detectRange().
    this.killLightsRange = 340; // px — clear-LOS spotting range for a slow, lights-off player
    this.illumSpeedRef = 300;   // px/s — at/above this speed lights-off gives no stealth benefit
    this.sepRadius = 80; // separation: how close before cops repel
    this.sepStrength = 150; // separation: aim push strength
    // Cop-cop YIELD (un-piling): a cop jammed nose-to-tail behind a teammate that's
    // strictly closer to the player eases its throttle so the capsule resolver can flow
    // the stack front-to-back instead of everyone pressing inward and locking. Tightly
    // gated (near the player, barely moving, teammate within ~a car length DIRECTLY
    // ahead, strictly closer) + ease-off-only (no steer/reverse) so it can't regress the
    // swarm into a passive pack or shove anyone into a wall. See _shouldYield().
    this.yieldEnabled = true;
    this.yieldRange = 320; // px — only un-pile cops this close to the player (it's a contact knot)
    this.yieldStuckSpeed = 35; // px/s — only a cop barely moving is "jammed"
    this.yieldGap = 52; // px — teammate must be this close ahead to count as blocking
    this.yieldCone = 0.55; // cos of half-angle — teammate must be roughly straight ahead
    this.yieldHold = 0.3; // s — keep yielding this long after the block clears (anti-flicker)
    this.yieldSpeed = 20; // px/s — eased throttle cap while yielding
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
    this.heavyRespawnCooldown = 15; // s pack-wide gate so only ONE heavy respawns ahead at a time
    // (two heavy roadblocks ahead at once is overpowered)
    this._heavyRespawnCd = 0;
    this.respawnMinGain = 350; // a relocation must be at least this much closer than the cop's
    // current distance, or it's not worth doing (skip and wait)
    this.respawnSpacing = 300; // a relocation spot must clear other cops by this much, so several
    // reinforcements don't all surface on the same road
    this.interceptAheadDist = 850; // px down the player's travel that an 'ahead-of-travel'
    // unit (interceptor) spawns, to set up a head-on
    this.interceptEntrySpeed = 260; // px/s an ahead-spawned interceptor enters AT (rolling toward
    // you for the head-on, not parked) — moderate, not full speed
    // Spike unit entry: it spawns AHEAD driving the SAME way as you (leads, doesn't ram), closer
    // than the interceptor (you should SEE it ahead), and with a drop cooldown so you get a chance
    // to ditch before it can spike you.
    this.spikeSpawnAhead   = 320; // px ahead of you a spike unit spawns
    this.spikeEntrySpeed   = 320; // px/s it's already rolling forward at on entry
    this.spikeRespawnDropCd = 6;  // s it CAN'T deploy after spawning (your window to ditch)

    // --- Cop health / ramming (scripted from velocities, NOT collider geometry) ---
    // Damage = relative impact speed, so a full head-on wrecks a patrol, a rear-end at
    // matched speed barely scratches it, a T-bone is between. Cops also hurt themselves
    // crashing into walls/each other, but ONLY mid-aggressive-action (the cost of choosing
    // to box/block/overtake) — ordinary driving into a wall is free.
    this.ramThreshold = 150; // relative impact speed (px/s) below which a hit does NOTHING
    this.ramScale = 0.12; // cop damage per px/s of relative impact above the threshold
    this.ramContactDist = 40; // px centre-distance counted as a player↔cop hit
    this.ramDmgCooldown = 0.7; // s between damage ticks on one cop (so a single ram = one tick)
    this.selfImpactDrop = 200; // px/s sudden speed loss in a frame that reads as a CRASH (> braking)
    this.selfScale = 0.05; // cop self-damage per px/s of crash, while mid-aggressive-action
    // Cop↔cop (and cop↔roadblock) ram damage is SEPARATE from the player's ram, so cops crashing
    // into each other can be tuned without touching how hard YOUR rams hit.
    this.copCopRamThreshold = 250; // closing speed (px/s) a cop↔cop crash needs to deal damage (higher
    // than the player's 150, so pack jostling is free — only a real high-speed wreck counts)
    this.copCopRamMult = 0.6; // cop↔cop damage as a fraction of the base ram damage (0 = cops never hurt each other)
    this.wreckDespawn = 30; // s a disabled wreck sits as an obstacle before it's removed
    this.wreckMass = 0.8; // disabled cop body mass — light, so you shove it aside
    this.copHealthPerLevel = 0.1; // +fraction of base health per pursuit level above 1 (heat buff:
    // a cop spawned at L3 has +20% health). Applied at spawn from the level then; 0 = off.
    this.disableReinforceMult = 0.4; // after a disable, wait only this × the normal reinforce interval
    // (capped — never slower). <1 = refill the gap fast so disabling doesn't make the chase easier.

    // --- Placed roadblocks (static set-pieces, NOT cap units; player-only collider) ---
    // A formation spans the street across `rbBlockedMin..Max` of its width (the rest is a
    // threadable gap), with ONE axis-aligned static rectangle as the collider — exact-fit
    // and cheap precisely because it's static + on the axis-aligned grid (no capsule/Matter).
    this.roadblockDist = 750;  // px ahead a testbed roadblock is placed
    this.rbCarMass     = 1.5;  // a normal block car's mass (you shove it, losing speed)
    this.rbHeavyMass   = 2.7;  // a heavy's mass — much harder to push through
    this.rbCarDrag     = 600;  // px/s² drag so a shoved car settles instead of sliding forever
    this.rbLifetime    = 30;   // s a placed block lasts before it despawns
    this.rbDamageMult  = 1.5;  // ram-through damage multiplier for block cars (toughness = health, NOT shove mass)
    this.rbSpikeChance = 0.4;  // chance a non-anchor roadblock slot is a SPIKE STRIP (difficulty 3+)
    this.rbSpikeWidth  = 76;   // px across — roadblock spike strips stay WIDE (vs the car-width cop drop)
    // Pursuit-side roadblock auto-spawn: from level roadblockMinLevel, drop one ahead every
    // roadblockInterval s while you're moving. Difficulty is derived from the level (L3 light →
    // L5 max), so blocks intensify as the chase escalates.
    this.roadblockMinLevel = 3;   // lowest pursuit level that auto-spawns roadblocks
    this.roadblockInterval = 22;  // s between auto-spawned roadblocks
    this.maxActiveRoadblocks = 1; // don't auto-spawn another while this many are already up (a block
    // lives ~rbLifetime, longer than the interval, so without this two would coexist on screen)
    this.roadblockMinSpeed = 120; // only place ahead while you're actually moving this fast
    this._roadblockTimer   = 8;   // s until the next auto-spawn (small initial delay)
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

    // Oil slicks — drawn under the cars (a stain on the road); see _updateOilSlicks.
    this.oilGfx = this.add.graphics().setDepth(6);
    this.worldLayer.add(this.oilGfx);

    this._setupHud();

    // Pursuit screen-edge glow — driven by the pursuit state each frame (see update + ScreenEdgeFx).
    // Created unconditionally (it's gameplay juice, not dev-only); its dev panel is gated below.
    this.screenFx = new ScreenEdgeFx(this);

    // Camera follows with slight lag for a sense of speed
    this.cameras.main.startFollow(this.car.sprite, true, 0.1, 0.1);
    this.cameras.main.setZoom(1.0);

    this._setupInput();
    if (this.devMode) {
      this._setupDebugOverlay();
      this._setupTunePanel();
      this._setupGadgetPanel();
      if (this.sandbox) {
        this._setupTestbedPanel(); // spawn/clear chosen unit types
        this._setupUnitTunePanel(this._testbed.unitType); // tune the selected type's def
        this._setupManeuverPanel(); // tune director maneuver/box behavior
        this._setupHealthPanel(); // tune cop health / ramming / disabling
      } else {
        this._setupCopTunePanel();
        if (this.pursuitLevel) this._setupPursuitPanel();
      }
      this._setupScreenFxPanel();
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
      this.killLightsText,
      this.spikeText,
      this.garageText,
      this.oilText,
      this.nitroText,
      this.screenFx.gfx,
    ];
    if (this.debugText) hud.push(this.debugText);
    if (this.copCountText) hud.push(this.copCountText);
    this.cameras.main.ignore(hud); // world cam skips HUD
    this.uiCamera.ignore(this.worldLayer); // UI cam skips the world (and its future children)

    // Tear down the DOM tuning panels when the scene restarts / returns to menu,
    // otherwise they stack up duplicates on every R / menu cycle.
    this.events.once("shutdown", () => {
      if (this.gui) this.gui.destroy();
      if (this.gadgetGui) this.gadgetGui.destroy();
      if (this.screenFxGui) this.screenFxGui.destroy();
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
    // Heat health buff: a cop spawned at higher pursuit level is tankier (+copHealthPerLevel per
    // level above 1), baked at spawn. Pursuit-only (sandbox has no level).
    if (this.pursuitLevel && this.copHealthPerLevel) {
      const buff = 1 + this.copHealthPerLevel * (this.pursuitLevel.level - 1);
      cop.maxHealth = Math.round(cop.maxHealth * buff);
      cop.health = cop.maxHealth;
    }
    this.worldLayer.add(cop.sprite); // world layer → rendered by main cam, not the UI cam
    cop.lights = new CarLights(this, cop, "cop", this.worldLayer, this.lightTuning);
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

  // Cop-cop YIELD test: should THIS cop ease off because it's jammed behind a teammate
  // that's closer to the player? All gates must hold (any one failing = drive normally):
  //   1. near the player (yieldRange) — un-piling only matters in the contact knot.
  //   2. barely moving (yieldStuckSpeed) — a cop with room is not jammed.
  //   3. a teammate within yieldGap, roughly straight ahead toward the player (yieldCone),
  //      and STRICTLY closer to the player than us (index breaks exact ties) — so only the
  //      rear car of a stack yields, never both, and a cop pinning YOU (no teammate ahead)
  //      never yields. Hysteresis (yieldHold) keeps it from flickering at the gate edge.
  _shouldYield(cop, px, py, dt) {
    if (!this.yieldEnabled) { cop._yieldT = 0; return false; }
    const cx = cop.sprite.x, cy = cop.sprite.y;
    const myD = Math.hypot(px - cx, py - cy);
    let blocked = false;
    if (myD < this.yieldRange && cop.getSpeed() < this.yieldStuckSpeed) {
      // unit toward the player — "ahead" means toward where the cop wants to go
      const tx = (px - cx) / (myD || 1), ty = (py - cy) / (myD || 1);
      const myIdx = this.cops.indexOf(cop);
      for (const other of this.cops) {
        if (other === cop) continue;
        const ox = other.sprite.x, oy = other.sprite.y;
        const dx = ox - cx, dy = oy - cy;
        const d = Math.hypot(dx, dy);
        if (d < 0.001 || d > this.yieldGap) continue;        // not adjacent
        if ((dx / d) * tx + (dy / d) * ty < this.yieldCone) continue; // not ahead of me
        const otherD = Math.hypot(px - ox, py - oy);
        const closer = otherD < myD || (otherD === myD && this.cops.indexOf(other) < myIdx);
        if (closer) { blocked = true; break; }
      }
    }
    cop._yieldT = blocked ? this.yieldHold : Math.max(0, (cop._yieldT || 0) - dt);
    return cop._yieldT > 0;
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

  // Effective clear-LOS spotting range. Lights on → full sightRange. Lights off → the cop
  // sight radius collapses toward killLightsRange when the player is slow, and blends BACK
  // up to sightRange as speed approaches illumSpeedRef (a dark car flooring it is still seen).
  // Soft by design: a cop already within the shrunk radius keeps its sight; you gain only at
  // the margins — so killing lights speeds the ditch, it doesn't break a point-blank stare.
  _detectRange() {
    if (!this.car.lightsOff) return this.sightRange;
    const t = Math.min(1, this.car.getSpeed() / this.illumSpeedRef);
    return Phaser.Math.Linear(this.killLightsRange, this.sightRange, t);
  }

  // The garage whose interior the point is inside, or null.
  _garageAt(x, y) {
    for (const g of this.garages) if (g.interior.contains(x, y)) return g;
    return null;
  }

  // Tier-2: relocate cops that have been lost (far + not chasing + off-screen) for a
  // sustained beat. Per cop, accumulate "lost" time; once over the threshold and the
  // cop itself is off-screen, try to warp it to a fresh off-screen road node near the
  // player (biased to the side it was coming from). Nothing happens if no off-screen
  // spot is available (e.g. player in the open) — it just waits, so no pop-in.
  _respawnLostCops(px, py, dt) {
    if (!this.respawnEnabled) return;
    this._heavyRespawnCd = Math.max(0, this._heavyRespawnCd - dt);
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
      const isHeavy = cop.unitType === "heavy";
      // Heavy respawns are rate-limited pack-wide: only ONE may come back at a time, then not
      // again for heavyRespawnCooldown — two heavy roadblocks ahead at once is overpowered.
      if (isHeavy && this._heavyRespawnCd > 0) continue;
      if (
        cop._lostT > this.respawnTime &&
        cop._respawnCd <= 0 &&
        this._offCamera(cop.sprite.x, cop.sprite.y, this.respawnMargin) &&
        (ahead
          ? this._placeAheadFor(cop, px, py)
          : this._tryRespawnCop(cop, px, py))
      ) {
        cop._lostT = 0;
        cop._respawnCd = this.respawnCooldown;
        if (isHeavy) this._heavyRespawnCd = this.heavyRespawnCooldown;
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

  // Hard-reset a cop at (x,y), clearing all transient chase state. Faces the player by default;
  // pass `facing` (radians) to override — e.g. a spike unit spawns facing the way you're driving.
  _placeCop(cop, x, y, px, py, facing = null) {
    cop.sprite.body.reset(x, y); // moves the body + zeroes its velocity
    cop.vx = 0;
    cop.vy = 0;
    cop.facing = facing != null ? facing : Math.atan2(py - y, px - x);
    cop.sprite.setRotation(cop.facing + Math.PI / 2);
    cop.pursuitMode = "LONE";
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
      // Interceptor enters AHEAD for a head-on; spike leads ahead same-direction.
      this._placeAheadFor(cop, px, py);
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
    if (far.lights) far.lights.destroy();
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

  // Wedge test: spawn cops nosed into the four faces of a FAR building (all faces beyond sight
  // range, so NOBODY has LOS — the blind case), each facing its wall with recovery forced on. Clears
  // other cops first so no one is feeding live sightings, and seeds the last-known to your position
  // so the blind cops navigate toward you. Watch them back off the wall, find open road, and route
  // in — without a live pursuit, and without anyone able to just beeline at you.
  _testbedWedge() {
    const px = this.car.sprite.x, py = this.car.sprite.y;
    this._clearCops(); // clean slate → no cop has LOS (a pure blind-recovery test)
    const m = 16;
    const facesOf = (b) => [
      { x: b.x - m,          y: b.y + b.h / 2, face: 0 },            // left wall, facing +x (into it)
      { x: b.x + b.w + m,    y: b.y + b.h / 2, face: Math.PI },      // right wall, facing −x
      { x: b.x + b.w / 2,    y: b.y - m,        face: Math.PI / 2 }, // top wall, facing +y
      { x: b.x + b.w / 2,    y: b.y + b.h + m,  face: -Math.PI / 2 },// bottom wall, facing −y
    ];
    // Pick the NEAREST building whose every face is beyond sight range (blind but easy to spectate);
    // fall back to the farthest building if the player is mid-map with nothing far enough.
    const minFace = (b) => Math.min(...facesOf(b).map((f) => Phaser.Math.Distance.Between(px, py, f.x, f.y)));
    const cdist = (b) => Phaser.Math.Distance.Between(px, py, b.x + b.w / 2, b.y + b.h / 2);
    let pick = null, pickD = Infinity;
    for (const b of BUILDINGS) {
      if (minFace(b) > this.sightRange + 60 && cdist(b) < pickD) { pickD = cdist(b); pick = b; }
    }
    if (!pick) pick = BUILDINGS.reduce((a, b) => (cdist(b) > cdist(a) ? b : a));
    // Seed the last-known to the player so the BLIND cops have somewhere to navigate (you).
    this.pursuit.lastKnown.x = px; this.pursuit.lastKnown.y = py; this.pursuit.hasLastKnown = true;
    for (const f of facesOf(pick)) {
      const cop = this._spawnCop(f.x, f.y, this._testbed.unitType);
      this._placeCop(cop, f.x, f.y, px, py, f.face); // place + face the wall
      cop.ai._unstuck = { startX: f.x, startY: f.y, age: 0 }; // force recovery (set AFTER _placeCop, which clears it)
    }
  }

  // Pile test: stack several cops nose-to-tail in a tight column DIRECTLY behind the player,
  // all facing (and aiming at) the player, so they jam into one contact knot — every car
  // pressing toward the same point. With the yield rule on, the rear cars should ease off and
  // let the column flow front-to-back instead of locking. Clears other cops first. They keep
  // LOS (point-blank), so this is purely a cop-cop un-piling test, not a blind-nav one.
  _testbedPile() {
    const px = this.car.sprite.x, py = this.car.sprite.y;
    this._clearCops();
    // Column heads straight "down" from the player in a random direction; cops sit one body-
    // length apart, nosing forward toward the player at the head of the column.
    const ang = Math.random() * Math.PI * 2;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const gap = 46, start = 70; // first cop 70px back, then a body-length each
    const n = 4;
    for (let i = 0; i < n; i++) {
      const d = start + i * gap;
      const x = px + ux * d, y = py + uy * d;
      const cop = this._spawnCop(x, y, this._testbed.unitType);
      this._placeCop(cop, x, y, px, py); // facing defaults toward the player (the head of the column)
    }
  }

  // Enter a freshly spawned cop according to its def's placement strategy. This only
  // picks WHERE it appears — the cop then drives with the same shared CopAI brain.
  _placeByStrategy(cop, px, py) {
    if (cop.unitDef.placement === "ahead-of-travel") {
      this._placeAheadFor(cop, px, py); // interceptor head-on / spike leads ahead
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

  // Route an 'ahead-of-travel' entry by unit: a spike unit spawns ahead driving the SAME way as
  // you (to lead + deploy), everything else spawns ahead facing back for a head-on.
  _placeAheadFor(cop, px, py) {
    return cop.unitDef && cop.unitDef.ability === "spike"
      ? this._placeAheadSpike(cop, px, py)
      : this._placeAhead(cop, px, py);
  }

  // Spike-unit entry: spawn AHEAD of the player, facing the DIRECTION OF TRAVEL and already
  // rolling that way (it leads you, it doesn't ram). It enters with a drop COOLDOWN so it can't
  // spike you the instant it appears — you get a few seconds to ditch or reroute first.
  _placeAheadSpike(cop, px, py) {
    const car = this.car;
    const dir = car.getSpeed() > 40 ? Math.atan2(car.vy, car.vx) : car.facing;
    // Prefer the first OFF-CAMERA node ahead (walk outward) so it doesn't pop in on a wide FOV; it
    // then closes in via its brake-check behaviour. Falls back to spikeSpawnAhead if none is off-screen.
    let spot = null;
    for (let d = this.spikeSpawnAhead; d <= this.spikeSpawnAhead + 900; d += 150) {
      const p = this.navGrid.pos(
        this.navGrid.nearestNodeAhead(px + Math.cos(dir) * d, py + Math.sin(dir) * d, px, py, dir),
      );
      if (!spot) spot = p;
      if (this._offCamera(p.x, p.y, 0)) { spot = p; break; }
    }
    this._placeCop(cop, spot.x, spot.y, px, py, dir); // face the way the player is going
    const s = this.spikeEntrySpeed;
    cop.vx = Math.cos(dir) * s;
    cop.vy = Math.sin(dir) * s;
    cop.sprite.body.setVelocity(cop.vx, cop.vy);
    cop._spikeCd = this.spikeRespawnDropCd; // can't deploy for N seconds (chance to ditch)
    cop._spikeStrips = cop.unitDef.spikeStrips ?? this.director.spikeStripCount;
    return true;
  }

  // Remove every cop AND wreck (sprites, labels, tweens, stale director refs).
  _clearCops() {
    for (const cop of [...this.cops, ...this.wrecks]) {
      this.tweens.killTweensOf(cop.sprite);
      if (cop.modeLabel) cop.modeLabel.destroy();
      if (cop.lights) cop.lights.destroy();
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

  // Cop SELF-damage + the per-cop damage cooldown. Player↔cop (and cop↔cop / cop↔roadblock) RAM
  // damage is measured at the genuine capsule contact instead (see _agentRamDamage) — the old
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

  // RAM damage to a cop, called from the capsule contact at the real moment of impact. `copAgent`
  // is the cop taking damage; `otherAgent` is whatever hit it (player, another cop, or a roadblock
  // car). Uses the PRE-collision closing speed (agent.preVx/preVy — the solver hasn't bled it yet),
  // so a head-on does full damage no matter how fast the solver then arrests it. One tick per
  // contact via the shared _dmgCd cooldown. Disable is deferred (the caller drains _capDisable
  // after the agent loop, so this.cops isn't mutated mid-resolve).
  _agentRamDamage(copAgent, otherAgent, threshold = this.ramThreshold, mult = 1) {
    const cop = copAgent.v;
    if (cop.disabled || (cop._dmgCd || 0) > 0) return;
    const rel = Math.hypot(copAgent.preVx - otherAgent.preVx, copAgent.preVy - otherAgent.preVy);
    if (rel <= threshold) return;
    cop.health -= ((rel - threshold) * this.ramScale * mult) / (cop.mass || 1);
    cop._dmgCd = this.ramDmgCooldown;
    if (cop.health <= 0) (this._capDisable ||= []).push(cop);
  }

  // RAM damage to a ROADBLOCK CAR (it has health tied to its unit type). Same closing-speed model
  // as a cop — so you (or another cop) can RAM THROUGH a block car, clearing the slot. `rbAgent`
  // is the block car's capsule agent; `otherAgent` is whatever hit it. Destruction is deferred.
  _rbDamage(rbAgent, otherAgent) {
    const c = rbAgent.rbCar;
    if (c._dead || c.health == null || (c._dmgCd || 0) > 0) return;
    const rel = Math.hypot(rbAgent.preVx - otherAgent.preVx, rbAgent.preVy - otherAgent.preVy);
    if (rel <= this.ramThreshold) return;
    // NOT divided by the car's (high) shove mass — that's for resisting the PUSH, not the damage.
    // Toughness comes from health (heavy 220 vs car 100); rbDamageMult lets you ram through in a
    // few committed hits rather than a dozen.
    c.health -= (rel - this.ramThreshold) * this.ramScale * this.rbDamageMult;
    c._dmgCd = this.ramDmgCooldown;
    if (c.health <= 0) { c._dead = true; (this._capRbDead ||= []).push(c); }
  }

  // A wrecked block car is removed from its formation (the slot opens — ram-through counterplay).
  _destroyRbCar(car) {
    for (const rb of this.roadblocks) {
      const i = rb.cars.indexOf(car);
      if (i < 0) continue;
      rb.cars.splice(i, 1);
      car.body.destroy();
      car.img.destroy();
      if (rb.cars.length === 0 && (!rb.strips || rb.strips.length === 0)) this._removeRoadblock(rb);
      return;
    }
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
    cop.mass = this.wreckMass; // the capsule resolver reads cop.mass — a wreck is light, shoves easily
    // TINT (multiply), not tintFill — keep the car's actual MODEL, just redden it (a wrecked cruiser,
    // not a flat silhouette). Per-type art shows through since each cop keeps its own texture.
    cop.sprite.setTint(0xff5555).setAlpha(0.85); // red = unmistakably disabled
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
      // Refill the gap FASTER after a disable (Math.min → never slower than the pending timer), so
      // wrecking a cop doesn't thin the pack into an easy ditch — especially at low-cap early levels.
      this._reinforceTimer = Math.min(
        this._reinforceTimer,
        this.pursuitLevel.cfg().reinforce * this.disableReinforceMult,
      );
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
        if (w.lights) w.lights.destroy();
        w.sprite.destroy();
        expired = true;
      }
    }
    if (expired)
      this.wrecks = this.wrecks.filter((w) => w._wreckT <= this.wreckDespawn);
  }

  // --- Placed roadblocks --------------------------------------------------------------
  // The composition per difficulty. Cars parked BROADSIDE end-to-end; 2+ are biased to one
  // side so a gap to slip through is left on the other. Heavies join at the top tiers. From
  // difficulty 3+, a non-anchor slot MAY (by chance, not always) be a SPIKE STRIP instead of a
  // vehicle — always keep ≥1 car (the first slot is the anchor).
  _roadblockComposition(difficulty) {
    const d = Phaser.Math.Clamp(Math.round(difficulty), 1, 5);
    let comp;
    switch (d) {
      case 1:  comp = ['car']; break;
      case 2:  comp = ['car', 'car']; break;
      case 3:  comp = ['car', 'car', 'car']; break;
      case 4:  comp = ['car', 'car', 'heavy']; break;
      default: comp = ['car', 'heavy', 'heavy'];
    }
    if (d >= 3) {
      for (let i = 1; i < comp.length; i++)
        if (Math.random() < this.rbSpikeChance) comp[i] = 'spike';
    }
    return comp;
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
      // health is tied to the unit the block car IS (patrol / heavy), so a heavy block car is the
      // tank to ram through and a patrol car gives way faster.
      car:   { tex: 'cop_patrol', visW: 25, visL: 58, body: 23, capR: 11, capHalfLen: 16, mass: this.rbCarMass, health: UNITS.patrol.health },
      heavy: { tex: 'cop_heavy',  visW: 32, visL: 67, body: 27, capR: 14, capHalfLen: 18, mass: this.rbHeavyMass, health: UNITS.heavy.health },
      spike: { spike: true, visL: this.rbSpikeWidth }, // a strip filling this slot (no vehicle)
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
    const strips = [];
    let cursor = start;
    for (const s of specs) {
      const off = cursor + s.visL / 2;
      const ix = x + cpx * off, iy = y + cpy * off;
      cursor += s.visL;
      if (s.spike) {
        // Spike-strip slot: lay a wide strip across this part of the road (no vehicle). Tracked
        // on the block so it lives + dies with it. (Hazard effect TBD — visual for now.)
        strips.push(this._dropSpike({ x: ix, y: iy, heading: snapped }, s.visL, this.rbLifetime));
        continue;
      }
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
                    capR: s.capR, capHalfLen: s.capHalfLen, health: s.health, maxHealth: s.health };
      body.rbCar = car;                            // so the spin trigger can find it
      cars.push(car);
    }
    const rb = { x, y, heading: snapped, cars, strips };
    this.roadblocks.push(rb);
    return rb;
  }

  // Roadblock difficulty derived from the pursuit level: L3 light → L4 escalating (sub-phase via
  // progress through the level) → L5 max. Sandbox falls back to the testbed difficulty dial.
  _roadblockDifficulty() {
    if (!this.pursuitLevel) return this._rbDifficulty || 2;
    const lvl = this.pursuitLevel.level;
    if (lvl <= 3) return 1;
    if (lvl === 4) return this.pursuitLevel.heatFraction() > 0.5 ? 3 : 2;
    return 5; // L5 — max
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
    if (rb.strips && rb.strips.length)
      this.spikes = this.spikes.filter((s) => !rb.strips.includes(s));
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
  _dropSpike({ x, y, heading }, len = this.spikeStripLen, life = this.spikeLifetime) {
    const angle = heading + Math.PI / 2; // strip lies ACROSS the direction of travel
    const strip = { x, y, angle, len, depth: 12, t: 0, life };
    this.spikes.push(strip);
    return strip;
  }

  // Age out deployed strips, redraw them, and pop the player's tires on contact.
  _updateSpikes(px, py, dt) {
    const g = this.spikeGfx;
    g.clear();
    // Heal an active blowout slowly over time (the Repair Kit will clear it instantly later).
    if (this.spikeCrippleTime > 0)
      this.spikeCrippleTime = Math.max(0, this.spikeCrippleTime - dt);
    if (!this.spikes.length) { this._onSpikes = false; return; }
    let onAny = false;
    for (const s of [...this.spikes]) {
      s.t += dt;
      const life = s.life ?? this.spikeLifetime;
      if (s.t > life) { this.spikes = this.spikes.filter((o) => o !== s); continue; }
      // Contact: distance from the player to the strip's line segment (length len, across travel).
      const cos = Math.cos(s.angle), sin = Math.sin(s.angle), hl = s.len / 2, hd = s.depth / 2;
      const d = this._pointSegDist(px, py, s.x - hl * cos, s.y - hl * sin, s.x + hl * cos, s.y + hl * sin);
      if (d < hd + this.spikeContactPad) onAny = true;
      // Fade out over the last 3s of life.
      const fade = Phaser.Math.Clamp((life - s.t) / 3, 0, 1);
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
    // Rising edge: blow the tires the frame the player first touches a strip (not every frame on it).
    if (onAny && !this._onSpikes) this._blowTires();
    this._onSpikes = onAny;
  }

  // Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by).
  _pointSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // Cop spike hit → BLOW THE TIRES: a one-shot jolt (speed scrub + lurch) then a heavy, lasting
  // cripple the update loop applies (capped speed + degraded grip/accel + a pull to one side).
  _blowTires() {
    if (this.busted || this.paused) return;
    this.spikeCrippleTime = this.spikeCrippleDuration; // refresh to full severity
    this._spikePullSign = Math.random() < 0.5 ? -1 : 1; // which side blew
    const keep = 1 - this.spikeHitScrub;                // jolt: scrub momentum on contact
    this.car.vx *= keep; this.car.vy *= keep;
    if (this.car.sprite.body) this.car.sprite.body.setVelocity(this.car.vx, this.car.vy);
    this.car.facing += (Math.random() * 2 - 1) * this.spikeWobble; // brief physical lurch
  }

  // Clear a blowout instantly — the hook the (future) Repair Kit gadget calls.
  _repairTires() { this.spikeCrippleTime = 0; }

  // Gadget: drop an oil slick BEHIND the player (one charge). The patch is a cluster of dark
  // blobs (a splotchy mess) ~1.5× the car width across; cops that drive over it slide.
  _deployOilSlick() {
    if (this.busted || this.paused) return;
    if (this.oilCharges <= 0) return;
    this.oilCharges--;
    const f = this.car.facing;
    const off = 32; // px behind the car centre so it lands at the rear, not under you
    const x = this.car.sprite.x - Math.cos(f) * off;
    const y = this.car.sprite.y - Math.sin(f) * off;
    const r = this.oilPatchRadius;
    // Splotch: several overlapping circles jittered within the patch (visual only → Math.random).
    const blobs = [];
    const n = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      blobs.push({
        dx: (Math.random() * 2 - 1) * r * 0.55,
        dy: (Math.random() * 2 - 1) * r * 0.55,
        r: r * (0.35 + Math.random() * 0.45),
      });
    }
    this.oilSlicks.push({ x, y, r, t: 0, blobs });
  }

  // Gadget: fire a NITRO boost (one charge). Refreshes the boost timer to full; the update loop
  // reads nitroTimer and scales the car's acceleration + top speed while it runs. Blocked while
  // a boost is already active so you can't burn a second charge stacking on top of the first.
  _fireNitro() {
    if (this.busted || this.paused) return;
    if (this.nitroCharges <= 0) return;
    if (this.nitroTimer > 0) return; // already boosting — don't waste a charge
    this.nitroCharges--;
    this.nitroTimer = this.nitroDuration;
  }

  // Age + redraw the slicks, and apply their effect to cops: a one-shot speed scrub on the
  // frame a cop first touches oil, then a lingering grip-loss timer (cop._oilT) that the cop
  // update loop reads to slash grip each frame (it slides). Player is immune (its own oil).
  _updateOilSlicks(dt) {
    const g = this.oilGfx;
    g.clear();
    for (let i = this.oilSlicks.length - 1; i >= 0; i--) {
      const s = this.oilSlicks[i];
      s.t += dt;
      if (s.t > this.oilLifetime) { this.oilSlicks.splice(i, 1); continue; }
      const fade = Phaser.Math.Clamp((this.oilLifetime - s.t) / 1.5, 0, 1); // fade the last 1.5s
      g.fillStyle(0x050507, 0.8 * fade);
      for (const b of s.blobs) g.fillCircle(s.x + b.dx, s.y + b.dy, b.r);
      // a faint oily sheen on top
      g.fillStyle(0x2a2a3a, 0.25 * fade);
      for (const b of s.blobs) g.fillCircle(s.x + b.dx - b.r * 0.2, s.y + b.dy - b.r * 0.2, b.r * 0.4);
    }

    for (const cop of this.cops) {
      cop._oilT = Math.max(0, (cop._oilT || 0) - dt);
      let inOil = false;
      for (const s of this.oilSlicks) {
        const dx = cop.sprite.x - s.x, dy = cop.sprite.y - s.y;
        if (dx * dx + dy * dy <= s.r * s.r) { inOil = true; break; }
      }
      if (inOil) {
        if (!cop._inOil) { // rising edge: one-shot speed scrub on contact
          const keep = 1 - this.oilSpeedLost;
          cop.vx *= keep; cop.vy *= keep;
          if (cop.sprite.body) cop.sprite.body.setVelocity(cop.vx, cop.vy);
        }
        cop._oilT = this.oilEffectTime; // refresh to full while on the patch; decays after leaving
      }
      cop._inOil = inOil;
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
    agents.push({ v: this.car, R: this.playerCapR, hl: this.playerCapHalfLen, m: this.playerMass, player: true, preVx: this.car.vx, preVy: this.car.vy });
    for (const cop of this.cops) agents.push({ v: cop, R: cop.capR, hl: cop.capHalfLen, m: cop.mass || 1, cop, preVx: cop.vx, preVy: cop.vy });
    // Roadblock cars: a per-frame shim exposing the Vehicle-like fields the resolver needs.
    // facing runs along the car's LENGTH (sprite rotation − π/2), so the capsule rotates with
    // the scripted spin. vx/vy seed from the Arcade body; the resolver writes back through it.
    for (const rb of this.roadblocks) for (const c of rb.cars) {
      const b = c.body;
      agents.push({
        v: { sprite: b, facing: c.baseRot + c.spin - Math.PI / 2, vx: b.body.velocity.x, vy: b.body.velocity.y },
        R: c.capR, hl: c.capHalfLen, m: c.mass, rbCar: c, preVx: b.body.velocity.x, preVy: b.body.velocity.y,
      });
    }
    // Wrecks (disabled cops): inert but still proper rotated cars, so you can't phase through one
    // and you slip past its ends. Facing comes from the SPRITE's actual rotation — the spin-out
    // tween turned the sprite, not cop.facing. Low mass (wreckMass) → it shoves out of the way.
    for (const w of this.wrecks) {
      const s = w.sprite;
      agents.push({
        v: { sprite: s, facing: s.rotation - Math.PI / 2 - (w.textureRotation || 0), vx: s.body.velocity.x, vy: s.body.velocity.y },
        R: w.capR, hl: w.capHalfLen, m: w.mass || this.wreckMass, wreck: true,
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
    // Block cars rammed to 0 health are removed now (deferred for the same reason) — the slot opens.
    if (this._capRbDead) { for (const c of this._capRbDead) this._destroyRbCar(c); this._capRbDead = null; }
    if (this.capDebug) {
      this.capDebug.clear();
      for (const a of agents) {
        this.capDebug.lineStyle(1, a.player ? 0x39ff14 : a.rbCar ? 0xff3b3b : a.wreck ? 0x882222 : 0x4a90ff, 0.7);
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
    // Scripted impacts (once per pair). (cnx,cny) is the a→b normal. Damage is computed from the
    // PRE-collision closing speed (agent.preVx/preVy), gated by ramThreshold — so normal pack
    // jostling (low relative speed) is free, but a real high-speed crash hurts.
    const aCop = !!a.cop, bCop = !!b.cop;                       // live (damageable) cop agents
    if (a.player && b.rbCar) { this._onRoadblockHit(b.rbCar.body); this._rbDamage(b, a); }
    else if (b.player && a.rbCar) { this._onRoadblockHit(a.rbCar.body); this._rbDamage(a, b); }
    else if (a.player && bCop) { this._applyRamImpact(b.v, cnx, cny); this._agentRamDamage(b, a); }
    else if (b.player && aCop) { this._applyRamImpact(a.v, -cnx, -cny); this._agentRamDamage(a, b); }
    else if (aCop && bCop) { // cop↔cop crash hurts both — own threshold/mult (decoupled from player ram)
      this._agentRamDamage(a, b, this.copCopRamThreshold, this.copCopRamMult);
      this._agentRamDamage(b, a, this.copCopRamThreshold, this.copCopRamMult);
    }
    else if (aCop && b.rbCar) { this._agentRamDamage(a, b, this.copCopRamThreshold, this.copCopRamMult); this._rbDamage(b, a); }
    else if (bCop && a.rbCar) { this._agentRamDamage(b, a, this.copCopRamThreshold, this.copCopRamMult); this._rbDamage(a, b); }
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
    // Roadblock car health — shown on every block car (a block is only 1–3 cars, so it's clear
    // feedback that they're damageable, not clutter).
    for (const rb of this.roadblocks) for (const c of rb.cars) {
      if (c.health == null) continue;
      const frac = Phaser.Math.Clamp(c.health / c.maxHealth, 0, 1);
      const x = c.body.x - w / 2, y = c.body.y - 36;
      g.fillStyle(0x000000, 0.7);
      g.fillRect(x - 1, y - 1, w + 2, h + 2);
      g.fillStyle(frac > 0.5 ? 0x39ff14 : frac > 0.25 ? 0xffd23f : 0xff3b3b, 1);
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
    gui
      .add({ wedge: () => this._testbedWedge() }, "wedge")
      .name("▣ Wedge test (recovery)");
    gui
      .add({ pile: () => this._testbedPile() }, "pile")
      .name("▤ Pile test (yield)");

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
    rbf.add(this, "rbDamageMult", 0, 5, 0.1).name("Ram-through damage ×");
    rbf.add(this, "rbSpikeChance", 0, 1, 0.05).name("Spike-strip chance (diff 3+)");
    rbf.add(this, "roadblockInterval", 5, 60, 1).name("Auto-spawn every (s)");
    rbf.add(this, "maxActiveRoadblocks", 1, 4, 1).name("Max active at once");
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
    rs.add(this, "heavyRespawnCooldown", 0, 40, 1).name("Heavy respawn gate (s)");
    rs.close();

    gui
      .add({ copy: () => this._copyTestbedStats() }, "copy")
      .name("Copy Testbed → Console");

    this._applyTooltips(gui); // testbed panel isn't persisted, so apply tooltips directly

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Paste-ready dump of the testbed's scene-level tunables (roadblock / swarm-physics / respawn).
  _copyTestbedStats() {
    console.log(`// --- Testbed scene tunables (paste into GameScene create) ---
// roadblock
this.roadblockDist = ${this.roadblockDist}; this.rbCarMass = ${this.rbCarMass}; this.rbHeavyMass = ${this.rbHeavyMass}; this.rbCarDrag = ${this.rbCarDrag};
this.rbLifetime = ${this.rbLifetime}; this.rbSpinFactor = ${this.rbSpinFactor}; this.rbSpikeChance = ${this.rbSpikeChance}; this.roadblockInterval = ${this.roadblockInterval};
// swarm / capsule + ram impact
this.capIters = ${this.capIters}; this.capSlop = ${this.capSlop}; this.capRelax = ${this.capRelax}; this.capFriction = ${this.capFriction}; this.playerMass = ${this.playerMass};
this.ramSpeedKill = ${this.ramSpeedKill}; this.ramBogTime = ${this.ramBogTime}; this.ramBogAccel = ${this.ramBogAccel}; this.ramRefSpeed = ${this.ramRefSpeed}; this.ramMinClosing = ${this.ramMinClosing};
// respawn-ahead
this.respawnDist = ${this.respawnDist}; this.respawnTime = ${this.respawnTime}; this.respawnCooldown = ${this.respawnCooldown};
this.interceptAheadDist = ${this.interceptAheadDist}; this.interceptEntrySpeed = ${this.interceptEntrySpeed}; this.heavyRespawnCooldown = ${this.heavyRespawnCooldown};`);
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

    const pit = gui.addFolder("PIT maneuver");
    pit.add(this, "pitTestLevel", 1, 5, 1).name("Sandbox level (power)");
    pit.add(d, "pitMinLevel", 1, 5, 1).name("Available from level");
    pit.add(d, "pitCooldown", 1, 30, 0.5).name("Pack cadence (s)");
    pit.add(d, "pitUnitCooldown", 1, 30, 0.5).name("Same-cop cooldown (s)");
    pit.add(d, "pitRange", 80, 600, 10).name("Attempt within (px)");
    pit.add(d, "pitMinSpeed", 0, 400, 10).name("Min speed (both) (px/s)");
    pit.add(d, "pitMaxTime", 0.5, 6, 0.5).name("Press for up to (s)");
    pit.add(d, "pitGiveUp", 0.1, 2, 0.1).name("End if contact lost (s)");
    pit.add(d, "pitBoost", 0, 300, 10).name("Commit speed boost (px/s)");
    const pg = pit.addFolder("Detection (rear quarter)");
    pg.add(d, "pitContactDist", 20, 100, 2).name("Push registers within (px)");
    pg.add(d, "pitCoDirMin", 0, 1, 0.05).name("Min co-directional");
    pg.add(d, "pitRearMax", -40, 60, 2).name("Max ahead-of-centre (px)");
    pg.add(d, "pitSideMin", 0, 60, 2).name("Side band min (px)");
    pg.add(d, "pitSideMax", 20, 120, 2).name("Side band max (px)");
    pg.close();
    const ps = pit.addFolder("Push force");
    ps.add(d, "pitRefSpeed", 100, 700, 10).name("Full-force speed (px/s)");
    ps.add(d, "pitPowerFloor", 0, 1, 0.05).name("Min-level force floor");
    ps.add(d, "pitYawRate", 0, 4, 0.05).name("Push yaw at full (rad/s)");
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
    spike.add(d, "spikeDropAhead", 0, 400, 5).name("Deploy when ahead-by (px)");
    spike.add(d, "spikeGlobalCooldown", 0, 40, 0.5).name("Global deploy cooldown (s)");
    spike.add(d, "spikeCloseFactor", 0.3, 1, 0.02).name("Close-in speed × yours");
    spike.add(d, "spikeCloseBuffer", 0, 200, 5).name("Brake-check switch (px)");
    spike.add(this, "spikeStripLen", 10, 100, 2).name("Strip width (px)");
    spike.add(d, "spikeProgressEps", 0, 40, 1).name("Progress = gain over (px)");
    spike.add(d, "spikeStallTime", 0.3, 5, 0.1).name("Give up if stalled (s)");
    spike.add(d, "spikeDeployHold", 0.5, 8, 0.5).name("Hold in front after drop (s)");
    spike.add(d, "spikeDropCd", 0, 12, 0.5).name("Cooldown between drops (s)");
    spike.add(d, "spikeReload", 1, 30, 0.5).name("Reload when empty (s)");
    spike.add(d, "spikeStripCount", 1, 8, 1).name("Strips per unit");
    spike.add(d, "spikeEaseAhead", 0, 300, 5).name("Ease-in-front ahead (px)");
    spike.add(d, "spikeEaseFactor", 0.1, 1, 0.05).name("Ease to × your speed");
    spike.add(d, "spikeLeadDist", 50, 400, 10).name("Lead aim-ahead (px)");
    spike.add(this, "spikeLifetime", 3, 60, 1).name("Strip lifetime (s)");
    spike.add(this, "spikeSpawnAhead", 100, 800, 10).name("Spawn-ahead dist (px)");
    spike.add(this, "spikeEntrySpeed", 0, 600, 10).name("Spawn entry speed (px/s)");
    spike.add(this, "spikeRespawnDropCd", 0, 12, 0.5).name("Spawn drop cooldown (s)");
    spike.close();

    gui
      .add({ copy: () => this._copyManeuverStats() }, "copy")
      .name("Copy Maneuvers → Console");

    this._persistPanel(gui, "gd_maneuverTune_v14"); // bumped: spikeCloseFactor, spikeCloseBuffer + maxActiveRoadblocks

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
    types.add(this, "copHealthPerLevel", 0, 0.5, 0.05).name("+Health / pursuit level");

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

    const cc = gui.addFolder("Cop↔cop / cop↔roadblock ram");
    cc.add(this, "copCopRamThreshold", 0, 600, 10).name("No damage below (px/s)");
    cc.add(this, "copCopRamMult", 0, 2, 0.05).name("Damage × (0 = off)");

    const dis = gui.addFolder("Disable / wreck");
    dis.add(this, "wreckDespawn", 5, 120, 5).name("Wreck despawn (s)");
    dis
      .add(this, "wreckMass", 0.05, 2, 0.05)
      .name("Wreck mass (shove-ability)");
    dis.add(this, "disableReinforceMult", 0, 2, 0.05).name("Replace-after-disable ×");

    gui
      .add({ copy: () => this._copyHealthStats() }, "copy")
      .name("Copy Health → Console");

    this._persistPanel(gui, "gd_healthTune_v8"); // bumped: disableReinforceMult inverted (faster refill)

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
this.wreckDespawn = ${this.wreckDespawn}; this.wreckMass = ${this.wreckMass}; this.disableReinforceMult = ${this.disableReinforceMult};
this.copHealthPerLevel = ${this.copHealthPerLevel};
this.copCopRamThreshold = ${this.copCopRamThreshold}; this.copCopRamMult = ${this.copCopRamMult};`);
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

    this._persistPanel(gui, `gd_unitTune_${type}_v5`); // bumped: heavy capsule widened (capR 14->15)
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

    gui
      .add({ copy: () => this._copyPursuitLevels() }, "copy")
      .name("Copy Levels → Console");

    this._persistPanel(gui, "gd_pursuitLevel4"); // bumped: reinforce values rebaked

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "320px";
    gui.domElement.style.zIndex = "9999";
  }

  // Paste-ready dump of the live pursuit-level tuning (numbers only — rosters/roadblock flags
  // stay authored in code). Drop into PursuitLevel.defaultConfig.
  _copyPursuitLevels() {
    const P = this.pursuitLevel, b = P.bleed;
    let s = `// --- Pursuit levels (paste numbers into PursuitLevel.defaultConfig) ---
activeRate: ${P.activeRate}, ramHeat: ${P.ramHeat}, heatFloor: ${P.heatFloor}, disableHeat: ${P.disableHeat},
bleed: { fastFrac: ${b.fastFrac}, fastRate: ${b.fastRate}, slowRate: ${b.slowRate} },\n`;
    for (let lv = 1; lv <= P.maxLevel; lv++) {
      const L = P.levels[lv], span = lv < P.maxLevel ? L.span : 0;
      s += `// L${lv}: span ${span}, cap ${L.cap}, reinforce ${L.reinforce}, cooldown ${L.cooldown}, reaction ${L.reaction}, boxTrigger ${L.boxTrigger}\n`;
    }
    console.log(s);
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

    // Parking garages — hollow enclosures with a door. Walls join losRects + the wall group
    // (so they block sight, collide, and push cars out via the capsule resolver, like any
    // building); a distinct floor tint + door threshold mark them. The hide logic (seen-
    // entering rule) runs in the awareness loop against each garage's interior zone.
    this.garages = GARAGES.map((g) => {
      this.worldLayer.add(
        this.add.rectangle(g.x + g.w / 2, g.y + g.h / 2, g.w, g.h, 0x24303f).setDepth(1.6),
      );
      for (const r of g.walls) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        this.worldLayer.add(
          this.add.rectangle(cx, cy, r.w, r.h, 0x4a5e74).setStrokeStyle(1, 0x6a82a0).setDepth(2),
        );
        const body = this.walls.create(cx, cy, "_px");
        body.setDisplaySize(r.w, r.h).refreshBody();
        body.setVisible(false);
        this.losRects.push(new Phaser.Geom.Rectangle(r.x, r.y, r.w, r.h));
      }
      // Yellow door threshold for readability.
      this.worldLayer.add(
        this.add.rectangle(g.door.x + g.door.w / 2, g.door.y + g.door.h / 2, g.door.w, 4, 0xffd23f).setDepth(1.7),
      );
      return { interior: new Phaser.Geom.Rectangle(g.interior.x, g.interior.y, g.interior.w, g.interior.h), blown: false };
    });
    this._inGarage = null;

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

    // Mute toggle (N) — M is already the menu key.
    this.input.keyboard.on("keydown-N", () => {
      if (this.audio) this.audio.setMuted(!this.audio.muted);
    });

    // Kill Lights (L) — toggle the player's lights off for stealth (shrinks cop detection).
    this.input.keyboard.on("keydown-L", () => {
      this.car.lightsOff = !this.car.lightsOff;
    });

    // Gadget — Oil Slick (O): drop a patch behind you (one charge per press).
    this.input.keyboard.on("keydown-O", () => this._deployOilSlick());

    // Gadget — Nitro Boost (B): a short burst of extra accel + top speed (one charge per press).
    this.input.keyboard.on("keydown-B", () => this._fireNitro());
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

    // Kill Lights (L) stealth indicator — bottom-centre, only shown while lights are off.
    this.killLightsText = this.add
      .text(width / 2, this.scale.height - 28, "◐ LIGHTS OFF", {
        fontFamily: "monospace",
        fontSize: "14px",
        fontStyle: "bold",
        color: "#7fd8ff",
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Blown-tires warning — bottom-centre (above the garage/lights rows), only while crippled.
    this.spikeText = this.add
      .text(width / 2, this.scale.height - 72, "⚠ BLOWN TIRES", {
        fontFamily: "monospace",
        fontSize: "14px",
        fontStyle: "bold",
        color: "#ff5a3c",
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Parking-garage status — shown only while inside a garage (HIDDEN vs SEEN).
    this.garageText = this.add
      .text(width / 2, this.scale.height - 50, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        fontStyle: "bold",
        color: "#39ff14",
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Gadget charges (bottom-left) — Oil Slick count.
    this.oilText = this.add
      .text(16, this.scale.height - 16, "", {
        fontFamily: "monospace",
        fontSize: "15px",
        fontStyle: "bold",
        color: "#d8c27a",
      })
      .setOrigin(0, 1)
      .setScrollFactor(0)
      .setDepth(100);

    // Gadget charges (bottom-left, stacked above the oil row) — Nitro Boost count.
    this.nitroText = this.add
      .text(16, this.scale.height - 36, "", {
        fontFamily: "monospace",
        fontSize: "15px",
        fontStyle: "bold",
        color: "#7fd8ff",
      })
      .setOrigin(0, 1)
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
      // Live per-cop label: role (when chasing) + visibility + control mode + speed
      if (cop.modeLabel && cop.debug) {
        const role =
          state === PursuitState.ACTIVE && cop.role ? cop.role + " " : "";
        // Only show the visibility tag when it's not the ordinary "I can see you" case (LONE).
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
      .add(car, "turnSpeedHandbrake", 0.5, 8.0, 0.05)
      .name("Turn Speed high — handbrake");
    steering
      .add(car, "maxDriftAngle", 0.5, Math.PI * 0.95, 0.01)
      .name("Max Drift Angle (rad)");
    steering
      .add(car, "pivotOffset", 0, 40, 1)
      .name("Rear pivot (nose-lead)"); // 0 = centre yaw (floaty); higher = front leads more

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
this.turnSpeedHandbrake = ${s.turnSpeedHandbrake};
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

    // Lights & Sound — light knobs multiply the baked values (read live each frame by
    // CarLights); sound knobs bind to GameAudio (engine/siren vols read live, master +
    // mute applied via setters on change, which also fire on panel load).
    const ls = gui.addFolder("Lights & Sound");
    const lt = this.lightTuning;
    ls.add(lt, "head", 0, 2, 0.05).name("Headlight brightness");
    ls.add(lt, "headLen", 0.3, 2.5, 0.05).name("Headlight length");
    ls.add(lt, "headWid", 0.3, 2.5, 0.05).name("Headlight spread");
    ls.add(lt, "brake", 0, 2, 0.05).name("Brake/tail brightness");
    ls.add(lt, "flash", 0, 2, 0.05).name("Cop flasher brightness");
    const au = this.audio;
    ls.add(au, "masterVolume", 0, 1, 0.01).name("Master volume")
      .onChange((v) => au.setMasterVolume(v));
    ls.add(au, "engineVol", 0, 2, 0.05).name("Engine volume");
    ls.add(au, "sirenVol", 0, 2, 0.05).name("Siren volume");
    ls.add(au, "muted").name("Mute (N)").onChange((v) => au.setMuted(v));

    // Stealth — Kill Lights (L) detection tuning.
    const st = gui.addFolder("Stealth (Kill Lights)");
    st.add(this, "killLightsRange", 100, 900, 10).name("Lights-off range (px)");
    st.add(this, "illumSpeedRef", 100, 600, 10).name("Re-lit at speed (px/s)");

    // Persist across refresh (binds directly to the car, so load sets car fields).
    this._persistPanel(gui, "gd_carTuning_v8"); // bumped: Stealth (Kill Lights) folder

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.right = "8px";
    gui.domElement.style.zIndex = "9999";

    this.game.canvas.addEventListener("mousedown", () => {
      const active = document.activeElement;
      if (active && active !== document.body) active.blur();
    });
  }

  // Gadgets dev panel — live levers for the player's gadgets. Binds straight to the scene
  // fields the gameplay reads each frame.
  _setupGadgetPanel() {
    const gui = new GUI({ title: "Gadgets", width: 280 });
    this.gadgetGui = gui;
    gui.close();

    const oil = gui.addFolder("Oil Slick (O)");
    oil
      .add(this, "oilMaxCharges", 1, 10, 1)
      .name("Charges")
      .onChange((v) => (this.oilCharges = v)); // refill on tune (and on panel load)
    oil.add(this, "oilPatchRadius", 10, 90, 1).name("Patch radius (px)");
    oil.add(this, "oilLifetime", 2, 30, 1).name("Patch lifetime (s)");
    oil.add(this, "oilGripLost", 0, 1, 0.05).name("Slide lock (0–1)");
    oil.add(this, "oilSpeedLost", 0, 1, 0.05).name("Speed lost on hit (0–1)");
    oil.add(this, "oilEffectTime", 0.2, 30, 0.1).name("Effect duration (s)");

    const nitro = gui.addFolder("Nitro Boost (B)");
    nitro
      .add(this, "nitroMaxCharges", 1, 10, 1)
      .name("Charges")
      .onChange((v) => (this.nitroCharges = v)); // refill on tune (and on panel load)
    nitro.add(this, "nitroDuration", 0.5, 8, 0.1).name("Boost duration (s)");
    nitro.add(this, "nitroAccelMult", 1, 4, 0.05).name("Accel ×");
    nitro.add(this, "nitroSpeedMult", 1, 3, 0.05).name("Top speed ×");

    // Cop spike HAZARD effect (not a player gadget — the cripple you take from driving over a
    // strip). Lives here so it's tunable in normal pursuit playtest. A "Test blowout" button
    // triggers it without needing a spike unit on the road.
    const spk = gui.addFolder("Cop Spikes (hazard)");
    spk.add(this, "spikeCrippleDuration", 2, 60, 1).name("Cripple duration (s)");
    spk.add(this, "spikeSpeedCap", 0.2, 1, 0.05).name("Top speed × (full)");
    spk.add(this, "spikeAccelMult", 0.2, 1, 0.05).name("Accel × (full)");
    spk.add(this, "spikeGripMult", 0.2, 1, 0.05).name("Grip × (full)");
    spk.add(this, "spikePull", 0, 1, 0.02).name("Pull to side (rad/s)");
    spk.add(this, "spikeHitScrub", 0, 0.8, 0.05).name("Contact speed scrub");
    spk.add(this, "spikeWobble", 0, 0.5, 0.02).name("Contact lurch (rad)");
    spk.add({ test: () => this._blowTires() }, "test").name("Test blowout");
    spk.add({ repair: () => this._repairTires() }, "repair").name("Repair (clear)");

    this._persistPanel(gui, "gd_gadgetTune_v8"); // bumped: added Cop Spikes hazard levers

    // Anchored to the BOTTOM-RIGHT so the panel grows UPWARD when folders expand and stays
    // clear of the bottom-left spawn panel. CRITICAL: clear top/left to "auto" — lil-gui's
    // autoPlace default is top:0, and leaving it set while also setting `bottom` stretches the
    // element to full viewport height (the "gray bar down the whole side" bug). bottom:48 keeps
    // the title clickable above the screen edge.
    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "auto";
    gui.domElement.style.left = "auto";
    gui.domElement.style.bottom = "48px";
    gui.domElement.style.right = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Pursuit screen-edge FX dev panel — every lever for the edge glow (brightness, band sizes,
  // retreat speeds per phase, colours) bound straight to the live ScreenEdgeFx instance.
  _setupScreenFxPanel() {
    const fx = this.screenFx;
    const gui = new GUI({ title: "Pursuit Screen FX", width: 300 });
    this.screenFxGui = gui;
    gui.close();

    gui.add(fx, "intensity", 0, 1, 0.01).name("Edge brightness");
    gui.add(fx, "holdThickness", 2, 80, 1).name("Hold thickness (px)");
    gui.add(fx, "flashThickness", 10, 160, 1).name("Flash thickness (px)");
    gui.add(fx, "colorLerp", 0.01, 0.5, 0.01).name("Colour fade rate");
    gui.add(fx, "growSpeed", 50, 2000, 10).name("Grow speed (px/s)");
    gui.add(fx, "breatheAmp", 0, 12, 0.5).name("Breathe amount (px)");
    gui.add(fx, "breathePeriod", 1, 12, 0.5).name("Breathe period (s)");
    gui.add(fx, "cornerRadius", 0, 120, 1).name("Corner radius (px)");

    const ret = gui.addFolder("Flash retreat speed (px/s)");
    ret.add(fx, "redRetreatSpeed", 10, 600, 5).name("Red (pursuit)");
    ret.add(fx, "blueRetreatSpeed", 10, 600, 5).name("Blue (cooldown)");
    ret.add(fx, "whiteRetreatSpeed", 10, 600, 5).name("White (withdraw)");

    const cols = gui.addFolder("Colours");
    cols.addColor(fx, "pursueColor").name("Pursuit (red)");
    cols.addColor(fx, "holdColor").name("Lost sight (blue)");
    cols.addColor(fx, "cooldownColor").name("Cooldown (blue)");
    cols.addColor(fx, "withdrawColor").name("Withdraw (white)");

    gui
      .add({ copy: () => this._copyScreenFx() }, "copy")
      .name("Copy Screen FX → Console");

    this._persistPanel(gui, "gd_screenFx_v3"); // bumped: baked tuned values + corner radius

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.right = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Paste-ready dump of the live screen-FX tuning. Drop into the ScreenEdgeFx constructor.
  _copyScreenFx() {
    const f = this.screenFx;
    const hex = (c) => "0x" + (c >>> 0).toString(16).padStart(6, "0");
    const s = `// --- Pursuit screen-edge FX (paste into ScreenEdgeFx constructor) ---
this.intensity = ${f.intensity};
this.holdThickness = ${f.holdThickness};
this.flashThickness = ${f.flashThickness};
this.growSpeed = ${f.growSpeed};
this.redRetreatSpeed = ${f.redRetreatSpeed};
this.blueRetreatSpeed = ${f.blueRetreatSpeed};
this.whiteRetreatSpeed = ${f.whiteRetreatSpeed};
this.colorLerp = ${f.colorLerp};
this.breatheAmp = ${f.breatheAmp};
this.breathePeriod = ${f.breathePeriod};
this.cornerRadius = ${f.cornerRadius};
this.pursueColor = ${hex(f.pursueColor)};
this.holdColor = ${hex(f.holdColor)};
this.cooldownColor = ${hex(f.cooldownColor)};
this.withdrawColor = ${hex(f.withdrawColor)};`;
    console.log(s);
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
      yieldEnabled: this.yieldEnabled,
      yieldRange: this.yieldRange,
      yieldStuckSpeed: this.yieldStuckSpeed,
      yieldGap: this.yieldGap,
      yieldCone: this.yieldCone,
      yieldHold: this.yieldHold,
      yieldSpeed: this.yieldSpeed,
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
    pack.add(this.copTuning, "yieldEnabled").name("Yield: un-pile cops").onChange(apply);
    pack.add(this.copTuning, "yieldRange", 100, 600, 10).name("Yield: near-player (px)").onChange(apply);
    pack.add(this.copTuning, "yieldStuckSpeed", 5, 120, 5).name("Yield: jammed below (px/s)").onChange(apply);
    pack.add(this.copTuning, "yieldGap", 20, 120, 2).name("Yield: teammate gap (px)").onChange(apply);
    pack.add(this.copTuning, "yieldCone", 0, 1, 0.05).name("Yield: ahead cone (cos)").onChange(apply);
    pack.add(this.copTuning, "yieldHold", 0, 1, 0.05).name("Yield: hold (s)").onChange(apply);
    pack.add(this.copTuning, "yieldSpeed", 0, 120, 5).name("Yield: eased cap (px/s)").onChange(apply);
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
// --- Formation (PursuitDirector) ---
boxTriggerSpeed: ${t.boxTriggerSpeed}, boxEngageRange: ${t.boxEngageRange}, boxAhead: ${t.boxAhead}, boxBehind: ${t.boxBehind},
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
    this._persistPanel(gui, "gd_copTuning23"); // bumped: added cop-cop yield (un-pile) levers

    gui.domElement.style.position = "fixed";
    gui.domElement.style.top = "8px";
    gui.domElement.style.left = "8px";
    gui.domElement.style.zIndex = "9999";
  }

  // Wire a lil-gui panel to localStorage: restore on open, save on change, and a
  // Reset button that clears the saved values and restores the code defaults
  // (important after a defaults change — a stale save would otherwise mask it).
  // Set a native hover tooltip on every controller whose bound property has an entry in TOOLTIPS.
  // One map covers the property everywhere it appears across all panels.
  _applyTooltips(gui) {
    for (const c of gui.controllersRecursive()) {
      const t = TOOLTIPS[c.property];
      if (t && c.domElement) c.domElement.title = t;
    }
  }

  _persistPanel(gui, key) {
    this._applyTooltips(gui); // tooltips for every panel that persists (i.e. all the tuning panels)
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
    this.yieldEnabled = t.yieldEnabled;
    this.yieldRange = t.yieldRange;
    this.yieldStuckSpeed = t.yieldStuckSpeed;
    this.yieldGap = t.yieldGap;
    this.yieldCone = t.yieldCone;
    this.yieldHold = t.yieldHold;
    this.yieldSpeed = t.yieldSpeed;
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
  }

  update(_time, delta) {
    // Frozen after a bust (R restarts) or while paused (P resumes) — both keys
    // are handled by their keydown listeners, so just hold here.
    if (this.busted || this.paused) {
      // Idle the engine + cut sirens so audio doesn't drone on a frozen scene.
      if (this.audio) {
        this.audio.updateEngine(0, this.car.maxSpeed, false);
        this.audio.updateSirens(this.car.sprite, this.cops, false);
      }
      return;
    }

    // Cop ram-damage / disabling, and ageing out wrecks. Run FIRST, before anyone's
    // velocity is touched this frame, so a hit's onset reads the true approach speed.
    this._updateCopDamage(delta / 1000);
    this._updateWrecks(delta / 1000);
    this._updateRoadblocks(this.car.sprite.x, this.car.sprite.y, delta / 1000);
    this._updateSpikes(this.car.sprite.x, this.car.sprite.y, delta / 1000);
    this._updateOilSlicks(delta / 1000);

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

    // Nitro boost: while the timer runs, scale up acceleration AND top speed for this update
    // only, then restore (so the panel's base values stay intact). Bleed the timer. Composes
    // with the ram-bog above — restore in reverse order (nitro first, then bog) below.
    let _nitroAccel = null,
      _nitroSpeed = null;
    if (this.nitroTimer > 0) {
      this.nitroTimer = Math.max(0, this.nitroTimer - delta / 1000);
      _nitroAccel = this.car.acceleration;
      _nitroSpeed = this.car.maxSpeed;
      this.car.acceleration *= this.nitroAccelMult;
      this.car.maxSpeed *= this.nitroSpeedMult;
    }

    // Spike blowout: a heavy cripple while the timer runs, easing out as it heals. Scales accel,
    // top speed AND grip down by severity (1=fresh→0=healed) and adds a counter-steerable pull to
    // one side via the car's external yaw. Restored after update (reverse order: spike→nitro→bog).
    let _spk = null;
    if (this.spikeCrippleTime > 0) {
      const sev = Math.min(1, this.spikeCrippleTime / this.spikeCrippleDuration);
      const ease = (mult) => 1 - (1 - mult) * sev; // = mult at sev 1, → 1 (no effect) at sev 0
      _spk = {
        a: this.car.acceleration, m: this.car.maxSpeed,
        gl: this.car.gripLow, gh: this.car.gripHigh,
      };
      this.car.acceleration *= ease(this.spikeAccelMult);
      this.car.maxSpeed *= ease(this.spikeSpeedCap);
      this.car.gripLow *= ease(this.spikeGripMult);
      this.car.gripHigh *= ease(this.spikeGripMult);
      this.car._pitYaw = (this.car._pitYaw || 0) + this._spikePullSign * this.spikePull * sev;
    }

    this.car.update(delta, controls);
    if (_spk != null) {
      this.car.acceleration = _spk.a;
      this.car.maxSpeed = _spk.m;
      this.car.gripLow = _spk.gl;
      this.car.gripHigh = _spk.gh;
    }
    if (_nitroAccel != null) {
      this.car.acceleration = _nitroAccel;
      this.car.maxSpeed = _nitroSpeed;
    }
    if (_bogAccel != null) this.car.acceleration = _bogAccel;
    this._carLastVx = this.car.vx;
    this._carLastVy = this.car.vy; // pre-collision cache (see _updateCopDamage)

    // Engine synth tracks the player's speed + throttle.
    this.audio.updateEngine(this.car.getSpeed(), this.car.maxSpeed, controls.up);

    // Kill Lights stealth indicator (bottom-centre) follows the lights-off state.
    this.killLightsText.setAlpha(this.car.lightsOff ? 1 : 0);

    // Blown-tires warning — visible while a spike blowout is active, pulsing for urgency.
    this.spikeText.setAlpha(
      this.spikeCrippleTime > 0 ? 0.55 + 0.45 * Math.abs(Math.sin(_time / 180)) : 0,
    );

    // Gadget charges (bottom-left): filled/empty pips for the Oil Slick.
    this.oilText
      .setText(
        "OIL " +
          "◉".repeat(this.oilCharges) +
          "○".repeat(Math.max(0, this.oilMaxCharges - this.oilCharges)),
      )
      .setColor(this.oilCharges > 0 ? "#d8c27a" : "#6a6450");

    // Nitro Boost pips — brighten while a boost is actively firing.
    this.nitroText
      .setText(
        "NITRO " +
          "◉".repeat(this.nitroCharges) +
          "○".repeat(Math.max(0, this.nitroMaxCharges - this.nitroCharges)),
      )
      .setColor(
        this.nitroTimer > 0
          ? "#ffffff"
          : this.nitroCharges > 0
            ? "#7fd8ff"
            : "#4a5a66",
      );

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
    // Effective clear-LOS spotting range this frame — shrinks when the player kills the
    // lights and crawls (Kill Lights stealth); full sightRange otherwise. Computed once.
    const effSight = this._detectRange();
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
        (d <= effSight &&
          segmentClear(cop.sprite.x, cop.sprite.y, px, py, this.losRects));
      cop.awareTimer = sees
        ? this.awareGrace
        : Math.max(0, (cop.awareTimer || 0) - dt);
      cop.hasLOS = sees; // instantaneous real line of sight
      cop.aware = cop.awareTimer > 0; // includes the memory grace
      if (cop.aware) anyAware = true;
      if (sees) anyLOS = true;
    }

    // --- Parking-garage hide. The walls already block sight; this resolves the
    // seen-entering rule. On the frame you cross INTO a garage interior, snapshot whether a
    // cop genuinely had sight (anyLOS) → "blown". Then, while inside:
    //   • not blown (hidden) → force awareness off: the cooldown runs out and you ditch.
    //   • blown → keep awareness ON (no real LOS, so no beeline): cops hold ACTIVE and
    //     converge on the entrance (last-known = the door) and wait — you can't wait them out.
    const gar = this._garageAt(px, py);
    if (gar && gar !== this._inGarage) gar.blown = anyLOS; // snapshot sight at the moment of entry
    this._inGarage = gar;
    this._garageHidden = false;
    if (gar) {
      for (const cop of this.cops) {
        cop.hasLOS = false; // behind walls — never beeline at a garaged player (even at proximity)
        cop.awareTimer = gar.blown ? this.awareGrace : Math.max(0, (cop.awareTimer || 0) - dt);
        cop.aware = cop.awareTimer > 0;
      }
      anyLOS = false;
      anyAware = gar.blown;            // blown: camp; hidden: drop to search → ditch
      this._garageHidden = !gar.blown;
    }
    // Garage HUD cue.
    if (!gar) this.garageText.setAlpha(0);
    else if (this._garageHidden)
      this.garageText.setText("◼ HIDDEN").setColor("#39ff14").setAlpha(1);
    else this.garageText.setText("◼ SEEN — MOVE").setColor("#ff5555").setAlpha(1);

    // --- Pursuit state machine. `aware` (grace) keeps it ACTIVE through flickers;
    // only a real line of sight (`anyLOS`) moves the last-known marker, so a juke
    // behind a building commits the cops to where they GENUINELY last saw you. ---
    // Sandbox pins the pursuit ACTIVE (force awareness) so spawned units relentlessly
    // chase — no ditch/search/return — keeping a unit always exercising its behavior
    // while you tune it. lastKnown still only moves on a REAL sighting, so blind-nav is
    // unchanged. (Cops still navigate to last-known when they personally lose sight.)
    // Capture the cooling state BEFORE the update — a re-spot resets `ditched` to false
    // inside update(), so this is the only place to know heat WAS bleeding (full ditch).
    const wasBleeding = this.pursuit.ditched;
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
    // Re-spotted after a real ditch: a cop regained sight while the heat was COOLING (ditched/
    // bleeding) and snapped the pursuit back to ACTIVE — the "oh crap, found again" moment.
    // Gated on wasBleeding so a brief LOS flicker mid-chase (pre-ditch SEARCH, heat merely held)
    // doesn't fire it every time you round a corner.
    if (state === PursuitState.ACTIVE && this._prevState === PursuitState.SEARCH && wasBleeding) {
      // Pan the alert onto the cop that re-spotted you (nearest one with real LOS) so it
      // sits in the mix with the sirens rather than playing dead-centre/detached.
      let spotter = null, sd = Infinity;
      for (const cop of this.cops) {
        if (!cop.hasLOS) continue;
        const d = Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, px, py);
        if (d < sd) { sd = d; spotter = cop; }
      }
      const pan = spotter ? Phaser.Math.Clamp((spotter.sprite.x - px) / 900, -1, 1) : 0;
      this.audio.playSpotted(pan);
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
      // Auto-spawn roadblocks ahead from L3+, on a timer, while you're moving. Difficulty rises
      // with the level (L3 light → L5 max). Cleared by their lifetime; spawning stops on ditch.
      if (
        this.pursuitLevel &&
        this.pursuitLevel.level >= this.roadblockMinLevel &&
        this.pursuitLevel.cfg().roadblocks
      ) {
        this._roadblockTimer -= delta / 1000;
        if (this._roadblockTimer <= 0) {
          if (
            this.car.getSpeed() > this.roadblockMinSpeed &&
            this.roadblocks.length < this.maxActiveRoadblocks
          ) {
            this._spawnRoadblockAhead(this._roadblockDifficulty());
            this._roadblockTimer = this.roadblockInterval;
          } else {
            this._roadblockTimer = 3; // a block's still up / you're slow → re-check soon, don't stack
          }
        }
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
      // Separation spreads cops apart so they don't pile up; clamp always.
      if (target) {
        target = this._separate(cop, target);
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
      // Cop-cop YIELD: a cop jammed nose-to-tail behind a teammate that's closer to you eases off
      // its throttle so the capsule resolver can separate the pile (front-to-back flow), instead of
      // everyone pressing inward and locking. Ease-off only (no steer/reverse → can't shove anyone
      // into a wall). A cop pinning YOU has no teammate ahead, so it never yields. See _shouldYield.
      if (this._shouldYield(cop, px, py, delta / 1000))
        cop.ai.speedCap = Math.min(cop.ai.speedCap, this.yieldSpeed);
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

      // Oil slick — COAST. Capture the cop's velocity BEFORE integrating; after, throw away the
      // AI's throttle/brake/steer result and keep the BALLISTIC velocity (same direction AND
      // speed, lightly dragged). It's on ice: no grip, no power, no brakes — it just carries its
      // momentum until it hits a wall or the effect ends. The body still steers (nose turns),
      // but travel is locked. Blended by oilLock (= oilGripLost) so <1 leaves a little control;
      // FULL strength the whole time the cop is oiled (no decay).
      const _oilPvx = cop.vx, _oilPvy = cop.vy;
      cop.update(delta, target);
      const oilLock = (cop._oilT || 0) > 0 ? this.oilGripLost : 0;
      if (oilLock > 0.01 && Math.hypot(_oilPvx, _oilPvy) > 25) {
        // Maintain the cop's CURRENT velocity (direction AND speed) — no accel, no brakes, no
        // drag: it just carries its momentum across the oil at the speed it came in at.
        cop.vx = Phaser.Math.Linear(cop.vx, _oilPvx, oilLock);
        cop.vy = Phaser.Math.Linear(cop.vy, _oilPvy, oilLock);
        cop.sprite.body.setVelocity(cop.vx, cop.vy);
      }
      cop._lastVx = cop.vx;
      cop._lastVy = cop.vy; // pre-collision cache (see _updateCopDamage)
    }

    // Custom rotated-car capsule collision: now that the player AND every cop have
    // integrated this frame, push every agent's 3-circle spine out of walls and apart
    // from each other (Arcade's AABB can't cover a rotated car). ADDITIVE to Arcade.
    this._resolveCapsules();

    // Car lights: pin every car's additive glow sprites to its final post-collision
    // position/facing (headlights, brake lamps, cop flashers). Wrecks keep their lights
    // object so they go dark via the disabled check inside update().
    this.car.lights.update();
    for (const cop of this.cops) cop.lights.update();
    for (const w of this.wrecks) if (w.lights) w.lights.update();

    // Cop sirens wail while the pursuit has eyes out (ACTIVE) or is searching; the pool
    // tracks the nearest cops, panned by their offset from the player.
    this.audio.updateSirens(
      this.car.sprite,
      this.cops,
      state === PursuitState.ACTIVE || state === PursuitState.SEARCH,
    );

    // Tier-2 rejoin: a cop that's been far + not chasing + off-screen for a while is
    // relocated off-screen near the player instead of grinding all the way back.
    // Gated on a REAL current sighting (anyLOS), not just ACTIVE: ACTIVE persists
    // through the 0.6s awareGrace and intermittent re-sightings, so without this a
    // lost cop could teleport onto your escape route while you're shaking the pack
    // and nobody can actually see you. No eyes on the player ⇒ no relocation.
    if (state === PursuitState.ACTIVE && anyLOS) this._respawnLostCops(px, py, dt);

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
    // Screen-edge pursuit glow — mode mirrors the heat-bar phase. PURSUE flashes red on a NEW
    // chase / a re-spot AFTER a ditch (not on a brief HOLD re-acquire); HOLD is the blue lost-sight
    // hold; COOLDOWN flashes blue as the ditch lands; WITHDRAW flashes white then fades to nothing.
    let fxMode;
    if (!this.cops.length || state === PursuitState.IDLE)
      fxMode = ScreenEdgeFx.OFF;
    else if (state === PursuitState.ACTIVE) fxMode = ScreenEdgeFx.PURSUE;
    else if (state === PursuitState.SEARCH)
      fxMode = this.pursuit.ditched
        ? ScreenEdgeFx.COOLDOWN
        : ScreenEdgeFx.HOLD;
    else if (state === PursuitState.RETURNING) fxMode = ScreenEdgeFx.WITHDRAW;
    else fxMode = ScreenEdgeFx.OFF;
    this.screenFx.setMode(fxMode);
    this.screenFx.update(delta / 1000);
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
        // Visibility (DIRECT/LONE), ACTIVE only — directly sighting the player vs blind.
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
