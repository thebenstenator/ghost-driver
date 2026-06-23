import Phaser from 'phaser';
import { segmentClear } from './lineOfSight.js';

// Behaviour states a cop can be in during an active chase. Level-1 cops use just
// two ideas: everyone PURSUEs the player until an EVENT (you slow/crash, or a cop
// pins you) flips the pack into a BOX — one cop cuts in front, one tucks in behind.
// No standing per-cop roles, no continuous slot optimisation — that churn was the
// source of the flank thrash and the wall-grinding flank targets.
export const CopState = {
  PURSUE:    'PURSUE',
  BOX_FRONT: 'BOX_F',
  BOX_REAR:  'BOX_R',
  // Committed overtake-and-block maneuver (aggressive units only): sprint AHEAD, then
  // ease in front to brake-check the player. Transient + single-holder, like a box.
  OVERTAKE:  'OVERTAKE',
  BLOCK:     'BLOCK',
  // Heavy parked BROADSIDE across the lane (mobile solo roadblock).
  ROADBLOCK: 'ROADBLK',
  // Committed PIT attempt: one cop swipes the player's rear quarter to spin them out.
  PIT:       'PIT',
  // Spike-unit run: sprint AHEAD (SPIKE) then drop a strip + ease in front (DEPLOY).
  SPIKE:     'SPIKE',
  DEPLOY:    'DEPLOY',
  // Spike unit that's already ahead (spawned ahead): leads you, same direction, until its drop
  // cooldown expires, then deploys.
  LEAD:      'LEAD',
};

// PursuitDirector — the coordination brain for an active chase.
//
// Default: every cop drives at the player's actual position (boids separation keeps
// them from stacking, so they arrive as a pack from slightly different angles). When
// the player is cornered — slowed, crashed, or already pinned by a cop — the Director
// raises a BOX: the cop most ahead of the player cuts in front to block, the cop most
// behind tucks onto the bumper, the rest keep pursuing. The box releases (with a
// little hysteresis) once the player breaks away.
//
// Orthogonal to all of that, the visibility flag (DIRECT/LONE) decides HOW a cop reaches
// its target: see the player → drive straight at it; otherwise → solve its own road route
// to the last-known position.
export class PursuitDirector {
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects;          // building footprints — for target validation (clear-target / LOS)

    // --- Box (sandwich) event — v2: CRASH-and-HOLD, no offset swerve ---
    // A boxing cop drives straight at the PLAYER (no perpendicular cut-in point to swing
    // toward — that swing, near walls, was the "psychotic" thrash). Front/rear is decided
    // by which side the cop is already on and only changes its SPEED, not its target — so
    // a front↔rear flip no longer swerves anything. A cop ahead brake-checks to stop you;
    // a cop behind closes to contact then matches your pace so it can't SHOVE you around
    // (the "pushed to the map edge" bug).
    this.boxTriggerSpeed = 150;  // player speed (px/s) below which a box is worth setting up
    this.boxReleaseSpeed = 260;  // player must exceed this to break the box (hysteresis)
    this.boxPinDist      = 90;   // a cop this close to the player counts as "pinning" (also triggers)
    this.boxEngageRange  = 520;  // only cops within this of the player join the box
    this.boxHold         = 0.8;  // s the box persists after the trigger clears (anti-flicker)
    this.boxCloseMargin  = 140;  // px/s a rear boxer may exceed your speed by to CLOSE to contact…
    this.boxContactGap   = 30;   // …easing toward your pace within this gap
    this.boxPress        = 45;   // px/s a rear boxer presses ABOVE your pace at contact, so it PINS
                                 // you against the front blocker instead of just trailing (bounded,
                                 // so it can't shove you across the map like the old rear-ram)
    this.boxFrontAhead   = 30;   // along-px a box cop must reach to count as "in front" (then it blocks)
    this.boxAhead        = 110;  // vestigial (box v2 has no offset) — kept so the legacy cop panel binds
    this.boxBehind       = 70;   // vestigial — as above
    this._boxTimer       = 0;    // > 0 while boxing (counts down when the trigger is absent)
    this._boxFrontCop    = null; // the cop committed to taking the FRONT of the box (sticky)

    // --- Overtake-and-block maneuver (aggressive units only; see _updateManeuver) ---
    // The fix for "a faster cop just rides my bumper": its speed edge is SPENT on a
    // committed maneuver (sprint ahead → brake-check) that opens a counterplay window
    // and feeds the box/bust loop, instead of grinding the player. At most ONE cop runs
    // it at a time, and it COMMITS until a clear success/failure (no per-frame churn —
    // the lesson from the reverted cutoff role). It only sets a drivable GOAL + a speed
    // cap for the shared CopAI; it is never new steering.
    this.maneuverTrigSpeed = 220;  // only block when the player is at least this fast (the grind case)
    this.maneuverRange     = 160;  // cop must be within this of the player to start/own a maneuver
    this.maneuverBehind    = 20;   // px the cop must be BEHIND the player to start an overtake
    this.overtakeAhead     = 260;  // px ahead of the player the overtaker sprints to (full speed)
    this.overtakeSide      = 40;   // px lateral offset so it swings around you, not through you. MUST clear
                                   // the capsule envelope (player capR + cop capR ≈ 23) or the cop can't get
                                   // beside you — it rams your rear and friction pins it there. 40 leaves margin.
    this.overtakeBoost     = 100;  // EXTRA top speed (px/s) while overtaking, so it can actually pass
    this.overtakeDone      = 50;   // px ahead the cop must reach to switch OVERTAKE → BLOCK
    this.blockAhead        = 90;   // px ahead the blocker sits to cut you off
    this.blockSpeedFactor  = 0.55; // blocker eases to this fraction of your speed (brake-check)
    this.blockMinSpeed     = 150;  // …but never below this (don't dead-stop in front)
    this.blockedSpeed      = 170;  // your speed below which the block SUCCEEDED → hand to box/bust
    this.blockLost         = -140; // along-heading value below which the blocker has FALLEN behind (fail)
    this.maneuverMaxTime   = 5.0;  // s a maneuver may run before timing out (fail)
    this.maneuverCooldown  = 12.0; // s after a maneuver before that cop can start another
    // Drafting (plain tail): a faster aggressive unit matches the player's pace rather
    // than grinding the bumper — speed is reserved for the maneuver. Only bites at speed.
    this.draftMinSpeed     = 150;  // below this the cop closes freely (slow play is box/bust's job)
    this.draftGap          = 15;   // px behind the player a drafting cop settles (right on the bumper)
    this.draftMargin       = 70;   // px/s over the player's speed it may use to close when farther back
    this._maneuverHolder   = null; // the single cop currently running a maneuver

    // --- Heavy mobile solo roadblock (ability 'block'; see the heavy branch in update) ---
    // When the heavy is ahead it LATCHES a fixed road point ahead of you, drives there, and
    // parks BROADSIDE across the lane (a park override stops + turns it). Committed to that
    // spot until you pass it / it times out, then it pursues and respawns ahead to retry.
    this.blockSetupDist  = 230;  // px ahead of you the heavy latches its block point
    this.blockParkDist   = 75;   // px from the block point at which it parks broadside
    this.blockAheadMin    = 40;  // along-px ahead of you it must be to START a roadblock
    this.blockMaxTime    = 6.0;  // s a parked block holds before giving up (you never came)
    this.blockGiveUpDist = 1100; // px from the block point beyond which it gives up
    this.blockCooldown   = 3.0;  // s after a block before it sets up another

    // --- PIT maneuver (Pursuit Intervention Technique; see _updatePit) ---
    // One cop at a time presses the player's REAR QUARTER co-directionally and PUSHES — applying a
    // steady yaw force that rotates the player. NO scripted spin animation: it's a force the player
    // can fight with COUNTERSTEER (the push adds to facing; your steering subtracts from it). It's a
    // committed transient (single attacker, commits then cools down) like the overtake — NOT a
    // standing role. Availability + force are level-gated: GameScene sets pitEnabled (L2+) and
    // pitPower (0 at the min level → 1 at L5), so a low-level push is easily countersteered and a
    // high-level one overwhelms your steering.
    this.pitMinLevel      = 2;     // lowest pursuit level at which a PIT may be attempted (L2+)
    this.pitEnabled       = false; // set per-frame by GameScene from the derived level
    this.pitPower         = 0;     // 0..1 level severity, set per-frame by GameScene
    this.pitCooldown      = 7.0;   // s between PIT attempts across the WHOLE pack (the cadence)
    this.pitUnitCooldown  = 12.0;  // s before the SAME cop may attempt another
    this.pitRange         = 240;   // px — attacker must be this close to the player to commit
    this.pitMinSpeed      = 180;   // px/s — both the player and the attacker must be moving
    this.pitMaxTime       = 2.5;   // s an attempt presses before releasing (→ cadence cooldown)
    this.pitGiveUp        = 0.6;   // s of LOST rear-quarter contact before the attempt ends
    this.pitBoost         = 80;    // EXTRA top speed while committing, so it has the pace to press in
    // Detection geometry (rear-quarter classifier). All vs the PLAYER frame.
    this.pitContactDist   = 46;    // px centre-distance at which the push registers (square is loose)
    this.pitCoDirMin      = 0.3;   // min facing·facing (co-directional → PIT, not a head-on)
    this.pitRearMax       = 12;    // along-px the attacker may be AHEAD of player centre (rear-biased)
    this.pitSideMin       = 16;    // px lateral: clearly to one SIDE (not dead behind)
    this.pitSideMax       = 58;    // px lateral: …but still in contact, not way out wide
    // Push force (scaled by attacker speed × level power between the floor and full).
    this.pitRefSpeed      = 420;   // attacker speed (px/s) that counts as a "full-force" push
    this.pitPowerFloor    = 0.45;  // force multiplier at the lowest enabled level (so L2 still pushes)
    this.pitYawRate       = 1.4;   // rad/s yaw at FULL force — compare to your high-speed turn (~0.95):
                                   // L5 overwhelms your countersteer, L2 (×floor) is easily held
    this._pitAttacker     = null;  // the single cop currently committed to a PIT
    this._pitCd           = 0;     // pack-wide cadence timer

    // --- Spike run (ability 'spike'; see _updateSpikeRun) ---
    // A spike unit's special: a VARIANT of the overtake where the brake-check becomes a DROP.
    // It sprints AHEAD (reusing the overtake sprint geometry), and once in front it deploys a
    // spike strip into the player's path then eases in front so they drive onto it. Single
    // holder, commits then cools down — same discipline as the overtake/PIT. The actual strip
    // is created by GameScene from a per-cop drop request (cop._spikeDrop), so scene-object
    // creation stays in the scene; the hazard effect is wired next.
    this.spikeTrigSpeed   = 180;   // only START a run when the player is at least this fast
    this.spikeDeployMinSpeed = 160; // ABORT the run if the player drops below this (slightly < trig for
                                   // hysteresis). Spikes are for a MOVING target — if you've been boxed
                                   // to a crawl, hand off to the box/bust instead of dropping on top of you.
    this.spikeRange       = 320;   // px the cop must be within to start a run
    this.spikeBehind      = 20;    // px the cop must be BEHIND the player to start (it has to get ahead)
    this.spikeAhead       = 130;   // px ahead of the COP it aims (in the adjacent lane) — its forward lead
    this.spikeSide        = 44;    // px lateral swing while sprinting — MUST clear the capsule envelope
                                   // (~23px) or it can't get beside you to pass. The drop projects back
                                   // onto your centreline anyway, so a wide swing still lands the strip in-lane.
    this.spikeBoost       = 150;   // EXTRA top speed while sprinting — its own lever so it can actually get clear
    this.spikeDropAhead   = 225;   // along-px ahead the cop must get before it DEPLOYS — a committed pass,
                                   // so the strip lands well in front of you (dodgeable), not on your nose
    // Give-up is PROGRESS-based, not a fixed clock: while the cop keeps gaining ground toward the
    // front (along increasing) it commits; it only bails once it STALLS (no real gain for a beat) —
    // so a cop that's slowly winning the overtake isn't abandoned, but one stuck alongside is.
    this.spikeProgressEps = 8;     // px of forward gain that counts as real progress (ignores jitter)
    this.spikeStallTime   = 1.5;   // s of NO progress before the run gives up
    this.spikeDeployHold  = 3.0;   // s the deployer holds in front after dropping (if you don't pass it)
    this.spikeDropCd      = 2.5;   // s between drops (and between runs) for one unit
    this.spikeReload      = 12.0;  // s reload after a unit empties its strip count
    this.spikeStripCount  = 3;     // strips a unit carries before the reload (per-unit default in units.js)
    this.spikeEaseAhead   = 70;    // px ahead the deployer eases to after dropping (forward-block)
    this.spikeEaseFactor  = 0.7;   // it eases to this fraction of your speed so the pack catches up
    // LEAD: a spike unit that's already ahead (it spawned ahead) drives to stay this far in front,
    // matching your pace, until its drop cooldown clears — then it deploys at the deploy distance.
    this.spikeLeadDist    = 150;   // px ahead of ITSELF a closing spike unit aims (keeps it driving forward)
    this.spikeCloseFactor = 0.78;  // while still well ahead it drives at this × your speed so you CLOSE the gap
    this.spikeCloseBuffer = 60;    // px past blockAhead at which it switches from closing-in to brake-checking
    this.spikeLeadMin     = 0;     // along-px above which a spike unit is treated as "ahead" (engages)
    this.spikeGlobalCooldown = 20; // s between ANY spike deploy across the WHOLE pack (so strips can't
                                   // carpet the road — one strip down, then a pack-wide cadence)
    this._spikeGlobalCd   = 0;     // pack-wide deploy timer
    this._spikeHolder     = null;  // the single cop currently running a spike deploy
  }

  // Call once per frame during ACTIVE pursuit. Sets cop.role (for HUD/telemetry),
  // cop.pursuitMode (DIRECT/LONE) and cop.dirTarget.
  update(cops, playerCar, dt) {
    const px = playerCar.sprite.x, py = playerCar.sprite.y;
    const h  = this._heading(playerCar);
    const speed = playerCar.getSpeed();

    // How each cop reaches the player: DIRECT (sees it) vs LONE (blind → own road route).
    this._assignVisibility(cops);

    // Committed PIT attempt (single attacker, pack-wide cadence). Resolved first so the
    // attacker is excluded from the maneuver/box. Sets playerCar._pitYaw while pressing.
    const pitAttacker = this._updatePit(cops, playerCar, px, py, h, speed, dt);

    // Committed spike run (single holder, spike units) — sprint ahead then deploy a strip.
    const spiker = this._updateSpikeRun(cops, px, py, h, speed, dt);

    // Committed maneuver (single holder) — the aggressive overtake/brake-check. Resolved
    // before boxing so the holder is excluded from the box.
    const holder = this._updateManeuver(cops, px, py, h, speed, dt);

    // Cops COMMITTED to a solo maneuver are excluded from the box — otherwise an attacker
    // getting close (a PIT/overtake/spike has to) trips the box's "pinned" trigger and pulls
    // the OTHER cops (and itself, on release) into a sandwich mid-attempt. The box only forms
    // from FREE cops. (With 2 cops where 1 is attacking, that leaves <2 free → no box, exactly
    // as it should: don't sandwich while you're busy setting up a hit.)
    const busy = new Set();
    if (pitAttacker) busy.add(pitAttacker);
    if (spiker)      busy.add(spiker);
    if (holder)      busy.add(holder);
    // A spike unit that's leading ahead is also "busy" — don't pull it into a box.
    for (const c of cops)
      if (c.unitDef && c.unitDef.ability === 'spike' && this._along(c, px, py, h) > this.spikeLeadMin) busy.add(c);

    // Event: do we sandwich the player this frame? (free cops only)
    const boxing = this._updateBox(cops, playerCar, px, py, dt, busy);

    // Box FRONT-RUNNER: pick ONE near FREE cop to take the front, so the box actually STOPS the
    // player instead of trailing them. Sticky — keep the same cop while it's near, so it
    // commits to getting around rather than thrashing the assignment.
    let boxFront = null;
    if (boxing) {
      const near = cops.filter(c => !busy.has(c) && this._dist(c, px, py) <= this.boxEngageRange);
      boxFront = (this._boxFrontCop && near.includes(this._boxFrontCop)) ? this._boxFrontCop
               : near.length ? near.reduce((b, c) => this._along(c, px, py, h) > this._along(b, px, py, h) ? c : b, near[0])
               : null;
    }
    this._boxFrontCop = boxFront;

    for (const cop of cops) {
      let target, speedCap = Infinity, boost = 0;
      cop.parkAngle = null;   // cleared unless the roadblock branch parks this cop

      if (cop === pitAttacker) {
        // Committed PIT: drive straight INTO the player's rear quarter (the swipe). The cop
        // is already off to one side (selection guaranteed it), so aiming at the player gives
        // its velocity a lateral component toward the centreline — the "turning-in" the
        // detector needs. The strike + spin fired in _updatePit; here we just steer + commit pace.
        cop.role = CopState.PIT;
        target = { x: px, y: py };
        boost = this.pitBoost;
      } else if (cop === spiker && cop._spikeRun) {
        // Spike run: SPIKE = sprint ahead (boost, swing wide like an overtake); DEPLOY = it has
        // dropped and now eases in front so the player drives onto the strip. The drop itself is
        // requested in _updateSpikeRun (cop._spikeDrop) and built by GameScene.
        if (cop._spikeRun.phase === 'SPIKE') {
          cop.role = CopState.SPIKE;
          const perp = h + Math.PI / 2;
          const lat  = (cop.sprite.x - px) * Math.cos(perp) + (cop.sprite.y - py) * Math.sin(perp);
          const side = lat >= 0 ? 1 : -1;
          // Pull out into the adjacent lane and drive FORWARD past the player (not at a point
          // across their path, which shoved them sideways).
          target = this._overtakeTarget(cop, px, py, h, side, this.spikeSide, this.spikeAhead);
          boost = this.spikeBoost;
        } else {
          cop.role = CopState.DEPLOY;
          target = this._clearTarget(px, py, { x: px + Math.cos(h) * this.spikeEaseAhead, y: py + Math.sin(h) * this.spikeEaseAhead });
          speedCap = Math.max(this.blockMinSpeed, speed * this.spikeEaseFactor);
        }
      } else if (cop.unitDef && cop.unitDef.ability === 'spike' &&
                 this._along(cop, px, py, h) > this.spikeLeadMin) {
        // Spike unit that's AHEAD (it spawned ahead). Rather than passively hold a big lead, it
        // CLOSES IN and gets in your way: brake-checks at blockAhead, and drops a strip whenever
        // its deploy is off the (long) global cooldown. (When it can't deploy it isn't idle — it's
        // an active brake-check; and once behind it's free to PIT, see the PIT exclusion.)
        const along = this._along(cop, px, py, h);
        const canDeploy = (cop._spikeCd || 0) <= 0 && this._spikeGlobalCd <= 0 &&
                          (cop._spikeStrips == null || cop._spikeStrips > 0);
        boost = this.spikeBoost; // ceiling so it can keep pace / close on a fast player
        if (along > this.blockAhead + this.spikeCloseBuffer) {
          // Well ahead → close the gap: drive FORWARD (aim ahead of the cop, no U-turn) but slow
          // below your pace so you catch up to brake-check range.
          cop.role = CopState.LEAD;
          target = this._clearTarget(px, py, { x: cop.sprite.x + Math.cos(h) * this.spikeLeadDist, y: cop.sprite.y + Math.sin(h) * this.spikeLeadDist });
          speedCap = Math.max(this.blockMinSpeed, speed * this.spikeCloseFactor);
        } else {
          // In range → brake-check (get in your way). Drop a strip if the cooldown's ready.
          cop.role = CopState.BLOCK;
          target = this._clearTarget(px, py, { x: px + Math.cos(h) * this.blockAhead, y: py + Math.sin(h) * this.blockAhead });
          speedCap = Math.max(this.blockMinSpeed, speed * this.blockSpeedFactor);
          if (canDeploy) {
            cop.role = CopState.DEPLOY;
            this._requestSpikeDrop(cop, h);
            this._spikeGlobalCd = this.spikeGlobalCooldown;
            cop._spikeCd = (cop._spikeStrips <= 0) ? this.spikeReload : this.spikeDropCd;
            if (cop._spikeStrips <= 0) cop._spikeStrips = (cop.unitDef.spikeStrips ?? this.spikeStripCount); // reloaded
          }
        }
      } else if (cop === holder && cop._maneuver) {
        // Committed maneuver wins over box/pursue. It only chooses WHERE (a drivable
        // point) and a throttle CAP/boost — the shared CopAI still does the driving.
        const m = cop._maneuver;
        if (m.phase === 'OVERTAKE') {
          cop.role = CopState.OVERTAKE;     // sprint past (with a boost) to get ahead
          // Swing to the side the cop is already on, so it pulls around rather than
          // bumping through you. _clearTarget keeps the offset point out of a building.
          const perp = h + Math.PI / 2;
          const lat  = (cop.sprite.x - px) * Math.cos(perp) + (cop.sprite.y - py) * Math.sin(perp);
          const side = lat >= 0 ? 1 : -1;
          target = this._clearTarget(px, py, {
            x: px + Math.cos(h) * this.overtakeAhead + Math.cos(perp) * this.overtakeSide * side,
            y: py + Math.sin(h) * this.overtakeAhead + Math.sin(perp) * this.overtakeSide * side,
          });
          boost = this.overtakeBoost;       // extra top speed so it actually passes you
        } else {
          cop.role = CopState.BLOCK;        // ease in front to brake-check
          target = this._clearTarget(px, py, { x: px + Math.cos(h) * this.blockAhead, y: py + Math.sin(h) * this.blockAhead });
          speedCap = Math.max(this.blockMinSpeed, speed * this.blockSpeedFactor);
        }
      } else if (boxing && this._dist(cop, px, py) <= this.boxEngageRange) {
        // BOX v2: one cop takes the FRONT (running around if needed) to stop you; the rest
        // crash into you from behind and PRESS, pinning you against the front blocker.
        const along = this._along(cop, px, py, h);
        if (cop === boxFront && along < this.boxFrontAhead) {
          // Designated front cop, not in front yet → SPRINT around to a point ahead. Swings
          // wide (like the overtake) so it goes around, not through you. This is the box's
          // "get one in front" — the active move that was missing (cops felt hesitant).
          // Labeled BOX_F (not OVERTAKE) so the OVERTAKE role stays the interceptor's ability.
          cop.role = CopState.BOX_FRONT;
          const perp = h + Math.PI / 2;
          const lat  = (cop.sprite.x - px) * Math.cos(perp) + (cop.sprite.y - py) * Math.sin(perp);
          const side = lat >= 0 ? 1 : -1;
          target = this._clearTarget(px, py, {
            x: px + Math.cos(h) * this.overtakeAhead + Math.cos(perp) * this.overtakeSide * side,
            y: py + Math.sin(h) * this.overtakeAhead + Math.sin(perp) * this.overtakeSide * side,
          });
          boost = this.overtakeBoost;
        } else if (cop === boxFront) {
          // Front cop, in front → brake-check and HOLD the front (without u-turning), the
          // wall the rear cops pin you against.
          cop.role = CopState.BOX_FRONT;
          target = this._clearTarget(px, py, { x: px + Math.cos(h) * this.blockAhead, y: py + Math.sin(h) * this.blockAhead });
          speedCap = Math.max(this.blockMinSpeed, speed * this.blockSpeedFactor);
        } else {
          // Rear/side presser → crash straight into the player and press a touch ABOVE your
          // pace so it pins you forward into the blocker (not just trails). Bounded by
          // boxPress, so it can't shove you across the map like the old rear-ram.
          cop.role = CopState.BOX_REAR;
          target = { x: px, y: py };
          const d = this._dist(cop, px, py);
          speedCap = speed + this.boxPress + this.boxCloseMargin * Phaser.Math.Clamp((d - this.boxContactGap) / 120, 0, 1);
        }
      } else {
        cop.role = CopState.PURSUE;
        target = { x: px, y: py };           // everyone just chases the player's real position
        // Drafting: a plainly-tailing aggressive unit matches the player's pace rather
        // than grinding the bumper (speed is reserved for the maneuver). Only at speed —
        // when the player is slow the cop must close freely for the box/bust to do its job.
        if (this._isAggressive(cop) && speed > this.draftMinSpeed) {
          const along = this._along(cop, px, py, h);
          const d = this._dist(cop, px, py);
          if (along < 0 && d < this.maneuverRange) {
            const over = d - this.draftGap;
            speedCap = speed + this.draftMargin * Phaser.Math.Clamp(over / 200, 0, 1);
          }
        }
      }

      cop.dirTarget = target;
      cop.maneuverSpeedCap = speedCap;   // consumed by GameScene as the ACTIVE speed cap
      cop.maneuverBoost = boost;         // extra max speed (overtake), applied in GameScene
    }
  }

  // The committed overtake-and-block maneuver. At most ONE cop holds it; once started it
  // COMMITS (OVERTAKE → BLOCK) until a clear success/failure, then that cop cools down —
  // no per-frame re-optimisation (the churn that sank the reverted cutoff role). Aggressive
  // units only. Returns the current holder (or null).
  _updateManeuver(cops, px, py, h, speed, dt) {
    for (const c of cops) c._maneuverCd = Math.max(0, (c._maneuverCd || 0) - dt);

    let holder = this._maneuverHolder;
    // Drop a holder that vanished or lost sight (it can't run a positional maneuver blind).
    if (holder && (!cops.includes(holder) || !holder.hasLOS || !holder._maneuver)) {
      if (holder._maneuver) { holder._maneuver = null; holder._maneuverCd = this.maneuverCooldown; }
      holder = this._maneuverHolder = null;
    }

    if (holder) {
      const m = holder._maneuver;
      m.t += dt;
      const along = this._along(holder, px, py, h);          // + ahead of player · − behind
      if (m.phase === 'OVERTAKE' && along > this.overtakeDone) m.phase = 'BLOCK';
      const success  = speed < this.blockedSpeed;            // player slowed → hand off to box/bust
      const fellBack = m.phase === 'BLOCK' && along < this.blockLost;
      const timedOut = m.t > this.maneuverMaxTime;
      if (success || fellBack || timedOut) {
        holder._maneuver = null;
        holder._maneuverCd = this.maneuverCooldown;
        holder = this._maneuverHolder = null;
      }
    }

    // TRIGGER: no holder → pick the best-placed aggressive unit (behind, close, off CD)
    // while the player is fast. Decided ONCE; then it commits above.
    if (!holder && speed >= this.maneuverTrigSpeed) {
      let best = null, bestAlong = -Infinity;
      for (const c of cops) {
        if (c === this._pitAttacker) continue; // a PIT attacker can't also run an overtake
        if (!this._isAggressive(c) || (c._maneuverCd || 0) > 0 || !c.hasLOS) continue;
        const d = this._dist(c, px, py);
        if (d > this.maneuverRange) continue;
        const along = this._along(c, px, py, h);
        if (along > -this.maneuverBehind) continue;          // must be genuinely behind to overtake
        if (along > bestAlong) { bestAlong = along; best = c; } // closest-to-even → best shot at passing
      }
      if (best) { best._maneuver = { phase: 'OVERTAKE', t: 0 }; holder = this._maneuverHolder = best; }
    }
    return holder;
  }

  // The committed PIT attempt. Pack-wide cadence (_pitCd) limits it to one attempt every
  // pitCooldown seconds. The chosen cop drives into the player's rear quarter and, while in
  // contact, PUSHES — setting playerCar._pitYaw (a yaw force the player countersteers). The
  // attempt holds for pitMaxTime, or ends early if it loses the rear quarter for pitGiveUp.
  _updatePit(cops, playerCar, px, py, h, speed, dt) {
    this._pitCd = Math.max(0, this._pitCd - dt);
    for (const c of cops) c._pitCd = Math.max(0, (c._pitCd || 0) - dt);
    playerCar._pitYaw = 0; // cleared unless an active PIT pushes this frame

    if (!this.pitEnabled) { if (this._pitAttacker) this._endPit(); return null; }

    let a = this._pitAttacker;
    if (a) {
      // Drop an attacker that vanished or lost sight (it can't line up the press blind).
      if (!cops.includes(a) || !a.hasLOS) { this._endPit(); a = null; }
      else {
        a._pitT = (a._pitT || 0) + dt;
        const dir = this._pitPush(a, playerCar, px, py);  // rear-quarter contact → push dir, else 0
        if (dir !== 0) {
          a._pitLostT = 0;
          // Force scales with the attacker's speed and the level power (floor..1).
          const intensity = Phaser.Math.Clamp(a.getSpeed() / this.pitRefSpeed, 0, 1)
                          * Phaser.Math.Linear(this.pitPowerFloor, 1, Phaser.Math.Clamp(this.pitPower, 0, 1));
          playerCar._pitYaw = this.pitYawRate * intensity * dir; // countersteerable yaw push
        } else {
          a._pitLostT = (a._pitLostT || 0) + dt;
        }
        if (a._pitT > this.pitMaxTime || (a._pitLostT || 0) > this.pitGiveUp) { this._endPit(); a = null; }
      }
    }

    // SELECT a new attacker: off cadence, player fast enough, a cop sitting at the rear quarter.
    if (!a && this._pitCd <= 0 && speed >= this.pitMinSpeed) {
      let best = null, bestD = Infinity;
      for (const c of cops) {
        if (c === this._maneuverHolder || c === this._spikeHolder || (c._pitCd || 0) > 0 || !c.hasLOS) continue;
        // Spike units only skip PIT while a deploy is actually available — once on the global
        // cooldown they're free to use other abilities (PIT / brake-check) instead of idling.
        if (c.unitDef && c.unitDef.ability === 'spike' && this._spikeGlobalCd <= 0) continue;
        if (c.getSpeed() < this.pitMinSpeed) continue;
        const d = this._dist(c, px, py);
        if (d > this.pitRange) continue;
        if (this._along(c, px, py, h) > this.pitRearMax) continue;        // must be at/behind the player
        const coDir = Math.cos(c.facing) * Math.cos(h) + Math.sin(c.facing) * Math.sin(h);
        if (coDir < this.pitCoDirMin) continue;                            // co-directional, not a head-on
        if (Math.abs(this._lateral(c, px, py, h)) < this.pitSideMin) continue; // to one side, not dead behind
        if (d < bestD) { bestD = d; best = c; }                           // closest gets the press
      }
      if (best) { best._pitT = 0; best._pitLostT = 0; this._pitAttacker = best; a = best; }
    }
    return a;
  }

  // Rear-quarter classifier in the PLAYER's local frame. Returns the push DIRECTION (±1: the rear
  // is shoved away from the attacker) while the attacker is in rear-quarter contact, else 0.
  _pitPush(a, playerCar, px, py) {
    const tf = playerCar.facing;
    const fx = Math.cos(tf), fy = Math.sin(tf);          // player forward
    const rx = -Math.sin(tf), ry = Math.cos(tf);         // player right
    const dx = a.sprite.x - px, dy = a.sprite.y - py;
    const alongT = dx * fx + dy * fy;                    // + ahead of player · − behind
    const lateralT = dx * rx + dy * ry;                  // + on player's right
    const coDir = Math.cos(a.facing) * fx + Math.sin(a.facing) * fy;

    if (!(Math.hypot(dx, dy) < this.pitContactDist &&
          coDir > this.pitCoDirMin &&
          alongT < this.pitRearMax &&
          Math.abs(lateralT) > this.pitSideMin &&
          Math.abs(lateralT) < this.pitSideMax &&
          a.getSpeed() > this.pitMinSpeed)) return 0;
    return -Math.sign(lateralT) || 1;                    // rear swings away from the attacker's side
  }

  // End the current PIT attempt: the attacker takes its long personal cooldown, the pack takes
  // the cadence cooldown (so the NEXT attempt — by anyone — waits pitCooldown).
  _endPit() {
    if (this._pitAttacker) { this._pitAttacker._pitCd = this.pitUnitCooldown; this._pitAttacker._pitT = 0; }
    this._pitAttacker = null;
    this._pitCd = this.pitCooldown;
  }

  // The committed spike run (ability 'spike'): a variant of the overtake where the brake-check
  // is replaced by a DROP. Single holder; sprint AHEAD, deploy a strip into the player's path,
  // ease in front, then cool down (or reload when the strip count empties). Returns the holder.
  _updateSpikeRun(cops, px, py, h, speed, dt) {
    for (const c of cops) c._spikeCd = Math.max(0, (c._spikeCd || 0) - dt);
    this._spikeGlobalCd = Math.max(0, this._spikeGlobalCd - dt);

    let s = this._spikeHolder;
    if (s) {
      // Drop a holder that vanished or lost sight (it can't line up a deploy blind).
      if (!cops.includes(s) || !s.hasLOS || !s._spikeRun) { this._endSpikeRun(s); s = null; }
      else {
        const run = s._spikeRun;
        run.t += dt;
        const along = this._along(s, px, py, h);
        if (run.phase === 'SPIKE') {
          // Player slowed to a crawl (got boxed) before we got ahead → abort. A strip dropped on a
          // near-stopped player is pointless; the box/bust owns that situation.
          if (speed < this.spikeDeployMinSpeed) { this._endSpikeRun(s); s = null; }
          else {
            // Track progress toward the front: any real forward gain resets the stall timer.
            if (along > run.bestAlong + this.spikeProgressEps) { run.bestAlong = along; run.stallT = 0; }
            else run.stallT += dt;
            if (along > this.spikeDropAhead) {
              if (this._spikeGlobalCd <= 0) {                      // pack-wide deploy cadence
                this._requestSpikeDrop(s, h);
                this._spikeGlobalCd = this.spikeGlobalCooldown;
                run.phase = 'DEPLOY'; run.deployT = 0;
              } else {
                this._endSpikeRun(s); s = null;                    // ahead but on cooldown → hand to LEAD
              }
            } else if (run.stallT > this.spikeStallTime) {
              this._endSpikeRun(s); s = null;   // stuck alongside, not gaining → give up
            }
          }
        } else { // DEPLOY: hold in front until the player passes the strip (falls behind) or time-out
          run.deployT += dt;
          if (along < this.blockLost || run.deployT > this.spikeDeployHold) { this._endSpikeRun(s); s = null; }
        }
      }
    }

    // TRIGGER: a spike unit, behind & near, with strips + sight, while the player is moving.
    if (!s && speed >= this.spikeTrigSpeed) {
      let best = null, bestAlong = -Infinity;
      for (const c of cops) {
        if (!c.unitDef || c.unitDef.ability !== 'spike') continue;
        if ((c._spikeCd || 0) > 0 || !c.hasLOS) continue;
        if (c._spikeStrips == null) c._spikeStrips = (c.unitDef.spikeStrips ?? this.spikeStripCount);
        if (c._spikeStrips <= 0) continue;
        if (this._dist(c, px, py) > this.spikeRange) continue;
        const along = this._along(c, px, py, h);
        if (along > -this.spikeBehind) continue;               // must be behind to get ahead
        if (along > bestAlong) { bestAlong = along; best = c; } // closest-to-even → best shot at passing
      }
      if (best) {
        best._spikeRun = { phase: 'SPIKE', t: 0, dropped: false, bestAlong: bestAlong, stallT: 0, deployT: 0 };
        this._spikeHolder = best; s = best;
      }
    }
    return s;
  }

  // Queue a strip drop IN THE PLAYER'S PATH (GameScene builds it + clears the request) and
  // decrement the unit's strip count. The strip lands on the player's centreline at the cop's
  // forward distance (+ a small lead), so a wide-swung deployer still drops it in the lane.
  // Queue a strip drop AT THE COP'S OWN POSITION (it's on a road → never inside a building, and it
  // reads as the cop laying it under itself), oriented across the player's travel. Since the cop is
  // ahead of you when it deploys, the strip still lands in your path.
  _requestSpikeDrop(cop, h) {
    if (cop._spikeStrips == null) cop._spikeStrips = (cop.unitDef.spikeStrips ?? this.spikeStripCount);
    if (cop._spikeStrips <= 0) return;
    cop._spikeDrop = { x: cop.sprite.x, y: cop.sprite.y, heading: h };
    cop._spikeStrips--;
  }

  // End a spike run: short cooldown between drops, or a long reload (refilling) once empty.
  _endSpikeRun(cop) {
    if (cop) {
      cop._spikeRun = null;
      if (cop._spikeStrips <= 0) {
        cop._spikeCd = this.spikeReload;
        cop._spikeStrips = (cop.unitDef.spikeStrips ?? this.spikeStripCount); // reloaded
      } else {
        cop._spikeCd = this.spikeDropCd;
      }
    }
    if (this._spikeHolder === cop) this._spikeHolder = null;
  }

  // A unit whose speed edge must be expressed as committed maneuvers, not tailgating.
  _isAggressive(cop) { return !!(cop.unitDef && cop.unitDef.ability === 'intercept'); }

  // --- Box event ----------------------------------------------------------------
  // Enter when the player is slow OR a cop is pinning them, and >=2 cops are close
  // enough to actually sandwich. Hold for boxHold seconds after the trigger clears so
  // it doesn't flicker; drop immediately once the player has clearly broken away.
  _updateBox(cops, playerCar, px, py, dt, busy = null) {
    const near   = cops.filter(c => (!busy || !busy.has(c)) && this._dist(c, px, py) <= this.boxEngageRange);
    const speed  = playerCar.getSpeed();
    const pinned = near.some(c => this._dist(c, px, py) <= this.boxPinDist);
    const trigger = near.length >= 2 && (speed < this.boxTriggerSpeed || pinned);

    if (trigger)                              this._boxTimer = this.boxHold;
    else if (speed > this.boxReleaseSpeed)    this._boxTimer = 0;            // broke away → drop now
    else                                      this._boxTimer = Math.max(0, this._boxTimer - dt);

    return this._boxTimer > 0 && near.length >= 2;
  }

  // --- Visibility (DIRECT / LONE) ----------------------------------------------
  // DIRECT — sees the player itself → drive straight at it.
  // LONE   — blind → solve its own road route to the last-known position.
  // (The old CONVOY relay — blind cops following a teammate's trail — was removed; blind
  // cops navigate to the shared last-known instead, which playtested cleaner.)
  _assignVisibility(cops) {
    for (const cop of cops) cop.pursuitMode = cop.hasLOS ? 'DIRECT' : 'LONE';
  }

  // A target in the lane `sideDist` to one side of the player, `lead` ahead of the COP's OWN
  // forward position. An overtaker driving at this pulls OUT into the adjacent lane and drives
  // FORWARD alongside you (passing) — instead of aiming at a fixed point ahead-of-you, whose
  // straight line runs through you and shoves you sideways. As the cop advances, the point
  // advances with it, so it keeps pulling ahead until it's clear.
  _overtakeTarget(cop, px, py, h, side, sideDist, lead) {
    const along = (cop.sprite.x - px) * Math.cos(h) + (cop.sprite.y - py) * Math.sin(h);
    const a = along + lead, perp = h + Math.PI / 2;
    return this._clearTarget(px, py, {
      x: px + Math.cos(h) * a + Math.cos(perp) * sideDist * side,
      y: py + Math.sin(h) * a + Math.sin(perp) * sideDist * side,
    });
  }

  // Pull a target in toward the player until the line player→target clears all
  // buildings, so box points never sit inside or behind a wall.
  _clearTarget(px, py, t) {
    if (!this.rects || segmentClear(px, py, t.x, t.y, this.rects)) return t;
    for (const f of [0.66, 0.33]) {
      const c = { x: px + (t.x - px) * f, y: py + (t.y - py) * f };
      if (segmentClear(px, py, c.x, c.y, this.rects)) return c;
    }
    return { x: px, y: py };
  }

  // --- small geometry helpers ---------------------------------------------------
  _dist(cop, x, y) { return Phaser.Math.Distance.Between(cop.sprite.x, cop.sprite.y, x, y); }

  // How far ahead(+) / behind(-) a cop is along the player's heading.
  _along(cop, px, py, h) {
    return (cop.sprite.x - px) * Math.cos(h) + (cop.sprite.y - py) * Math.sin(h);
  }

  // Signed lateral offset of a cop from the player's heading (+ right of travel, − left).
  _lateral(cop, px, py, h) {
    const perp = h + Math.PI / 2;
    return (cop.sprite.x - px) * Math.cos(perp) + (cop.sprite.y - py) * Math.sin(perp);
  }

  // Player travel direction — velocity when moving, facing when ~stationary.
  _heading(playerCar) {
    return playerCar.getSpeed() > 40
      ? Math.atan2(playerCar.vy, playerCar.vx)
      : playerCar.facing;
  }
}
