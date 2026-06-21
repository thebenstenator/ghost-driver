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
// Orthogonal to all of that, the visibility chain (DIRECT/CONVOY/LONE) decides HOW a
// cop reaches its target: see the player → drive straight at it; blind but can see a
// teammate who sees the player → follow that teammate's drivable breadcrumb trail;
// otherwise → solve its own road route.
export class PursuitDirector {
  constructor(navGrid, rects = null) {
    this.nav   = navGrid;
    this.rects = rects;          // building footprints — for target validation + convoy LOS

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
    this.overtakeSide      = 28;   // px lateral offset so it swings around you, not through you
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

    // --- Convoy relay (how a blind cop reaches the player) ---
    this.convoyEnabled   = false; // off by default — playtested better without the relay
                                  // churn; toggle on via Cop Tuning → Convoy
    this.followGap       = 90;   // px behind the leader a follower aims (no tailgating)
    this.convoyMaxHops   = 2;    // max relay length; longer chains fall back to own route
    this.convoyMaxFactor = 1.6;  // if the chain route is > this × straight-line dist, go direct
    this.convoyHold      = 0.5;  // s a CONVOY/LONE decision sticks before flipping (anti-flicker)
    this.convoyMinBlind  = 0.8;  // s a cop must be CONTINUOUSLY blind before it'll switch to convoy.
                                 // A cop that just lost sight keeps pursuing the player's position
                                 // (continue the chase) rather than instantly being yanked onto a
                                 // teammate's trail and swerving off — only genuinely-lost cops relay.
  }

  // Call once per frame during ACTIVE pursuit. Sets cop.role (for HUD/telemetry),
  // cop.pursuitMode (DIRECT/CONVOY/LONE) and cop.dirTarget.
  update(cops, playerCar, dt) {
    const px = playerCar.sprite.x, py = playerCar.sprite.y;
    const h  = this._heading(playerCar);
    const speed = playerCar.getSpeed();

    // How each cop reaches the player (visibility chain) — computed first so a CONVOY
    // cop can override its target with the leader's trail.
    this._assignConvoy(cops, px, py, dt);

    // Committed maneuver (single holder) — the aggressive overtake/brake-check. Resolved
    // before boxing so the holder is excluded from the box.
    const holder = this._updateManeuver(cops, px, py, h, speed, dt);

    // Event: do we sandwich the player this frame?
    const boxing = this._updateBox(cops, playerCar, px, py, dt);

    // Box FRONT-RUNNER: pick ONE near cop to take the front, so the box actually STOPS the
    // player instead of trailing them. Sticky — keep the same cop while it's near, so it
    // commits to getting around rather than thrashing the assignment.
    let boxFront = null;
    if (boxing) {
      const near = cops.filter(c => this._dist(c, px, py) <= this.boxEngageRange);
      boxFront = (this._boxFrontCop && near.includes(this._boxFrontCop)) ? this._boxFrontCop
               : near.length ? near.reduce((b, c) => this._along(c, px, py, h) > this._along(b, px, py, h) ? c : b, near[0])
               : null;
    }
    this._boxFrontCop = boxFront;

    for (const cop of cops) {
      let target, speedCap = Infinity, boost = 0;
      cop.parkAngle = null;   // cleared unless the roadblock branch parks this cop

      if (cop === holder && cop._maneuver) {
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
      } else if (cop.unitDef && cop.unitDef.ability === 'block') {
        // HEAVY mobile solo roadblock (draft). Latch a fixed road point ahead, drive there
        // (shared brain), then PARK BROADSIDE (CopCar park override reads cop.parkAngle).
        cop._blockCd = Math.max(0, (cop._blockCd || 0) - dt);
        if (cop._blockPoint) {
          cop._blockT += dt;
          const bp = cop._blockPoint;
          const passed = (px - bp.x) * Math.cos(cop._blockHeading) + (py - bp.y) * Math.sin(cop._blockHeading) > 30;
          if (passed || cop._blockT > this.blockMaxTime ||
              Math.hypot(px - bp.x, py - bp.y) > this.blockGiveUpDist) {
            cop._blockPoint = null; cop._blockCd = this.blockCooldown;   // release
          }
        } else if (this._along(cop, px, py, h) > this.blockAheadMin && cop._blockCd <= 0) {
          const tx = px + Math.cos(h) * this.blockSetupDist, ty = py + Math.sin(h) * this.blockSetupDist;
          const n = this.nav.pos(this.nav.nearestNode(tx, ty));
          cop._blockPoint = { x: n.x, y: n.y }; cop._blockHeading = h; cop._blockT = 0;
        }

        if (cop._blockPoint) {
          target = cop._blockPoint;
          if (Math.hypot(cop.sprite.x - target.x, cop.sprite.y - target.y) < this.blockParkDist) {
            cop.role = CopState.ROADBLOCK;
            // Broadside = perpendicular to the latched heading; pick the nearer of the two.
            const perp = cop._blockHeading + Math.PI / 2, alt = perp + Math.PI;
            const wrap = a => Math.atan2(Math.sin(a - cop.facing), Math.cos(a - cop.facing));
            cop.parkAngle = Math.abs(wrap(perp)) <= Math.abs(wrap(alt)) ? perp : alt;
          } else {
            cop.role = CopState.BLOCK;        // still driving to the block point
          }
        } else {
          cop.role = CopState.PURSUE; target = { x: px, y: py };  // behind → chase (then respawn ahead)
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

      // CONVOY override: a blind cop relays toward a teammate's drivable trail rather
      // than pathing on its own. Keeps its box/pursue intent for when it regains sight.
      if (cop.pursuitMode === 'CONVOY' && cop.convoyLeader) {
        const ct = this._convoyTarget(cop, cop.convoyLeader);
        if (ct) target = ct;
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

  // A unit whose speed edge must be expressed as committed maneuvers, not tailgating.
  _isAggressive(cop) { return !!(cop.unitDef && cop.unitDef.ability === 'intercept'); }

  // --- Box event ----------------------------------------------------------------
  // Enter when the player is slow OR a cop is pinning them, and >=2 cops are close
  // enough to actually sandwich. Hold for boxHold seconds after the trigger clears so
  // it doesn't flicker; drop immediately once the player has clearly broken away.
  _updateBox(cops, playerCar, px, py, dt) {
    const near   = cops.filter(c => this._dist(c, px, py) <= this.boxEngageRange);
    const speed  = playerCar.getSpeed();
    const pinned = near.some(c => this._dist(c, px, py) <= this.boxPinDist);
    const trigger = near.length >= 2 && (speed < this.boxTriggerSpeed || pinned);

    if (trigger)                              this._boxTimer = this.boxHold;
    else if (speed > this.boxReleaseSpeed)    this._boxTimer = 0;            // broke away → drop now
    else                                      this._boxTimer = Math.max(0, this._boxTimer - dt);

    return this._boxTimer > 0 && near.length >= 2;
  }

  // --- Visibility chain (DIRECT / CONVOY / LONE) --------------------------------
  // DIRECT — sees the player itself → drive straight at it.
  // CONVOY — blind, but sees a teammate that has a route to the player → follow it.
  // LONE   — blind with no visible relay → solve its own road route (fallback).
  // Shortest-cost relay via a tiny Bellman-Ford (n is ≤ a handful). The CONVOY↔LONE
  // decision is held for convoyHold seconds so an intermittent cop-to-cop sight line
  // can't flip it every frame (that flicker made convoy useless).
  _assignConvoy(cops, px, py, dt) {
    const n = cops.length;
    if (n === 0) return;

    // Track how long each cop has been continuously blind — convoy only engages once
    // a cop has genuinely lost the player, not the instant its sight-ray clips a wall.
    for (let i = 0; i < n; i++) {
      const c = cops[i];
      c._blindT = c.hasLOS ? 0 : (c._blindT || 0) + dt;
    }

    // Desired mode/leader for each cop this frame.
    const desired = new Array(n).fill('LONE');
    const dLeader = new Array(n).fill(null);

    if (this.convoyEnabled && this.rects) {
      const cost   = new Array(n).fill(Infinity);
      const hops   = new Array(n).fill(0);
      const leader = new Array(n).fill(-1); // -1 unset · -2 player · >=0 cop index
      for (let i = 0; i < n; i++) {
        if (cops[i].hasLOS) { cost[i] = this._dist(cops[i], px, py); leader[i] = -2; hops[i] = 1; }
      }
      for (let pass = 0; pass < n; pass++) {
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            if (i === j || cost[j] === Infinity || hops[j] >= this.convoyMaxHops) continue;
            if (!this._copsSee(cops[i], cops[j])) continue;
            const c = cost[j] + this._dist(cops[i], cops[j].sprite.x, cops[j].sprite.y);
            if (c < cost[i]) { cost[i] = c; leader[i] = j; hops[i] = hops[j] + 1; }
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (leader[i] === -2) desired[i] = 'DIRECT';
        // Only relay once the cop has been blind a beat — otherwise it stays LONE and
        // keeps pursuing the player's position (the chase continues through the blink).
        else if (leader[i] >= 0 && cops[i]._blindT >= this.convoyMinBlind &&
                 cost[i] <= this._dist(cops[i], px, py) * this.convoyMaxFactor) {
          desired[i] = 'CONVOY'; dLeader[i] = cops[leader[i]];
        }
      }
    } else {
      for (let i = 0; i < n; i++) desired[i] = cops[i].hasLOS ? 'DIRECT' : 'LONE';
    }

    // Commit with hysteresis. DIRECT (real sight) switches instantly either way; only
    // the CONVOY↔LONE flip-flop is damped.
    for (let i = 0; i < n; i++) {
      const cop = cops[i], want = desired[i];
      if (!cop.pursuitMode || want === 'DIRECT' || cop.pursuitMode === 'DIRECT' || want === cop.pursuitMode) {
        cop.pursuitMode = want;
        cop.convoyLeader = dLeader[i];
        cop._modeTimer = this.convoyHold;
      } else {
        cop._modeTimer = (cop._modeTimer || 0) - dt;
        if (cop._modeTimer <= 0) {
          cop.pursuitMode = want;
          cop.convoyLeader = dLeader[i];
          cop._modeTimer = this.convoyHold;
        }
        // else: keep the current mode/leader through the hold window
      }
    }
  }

  // Follow a leader's breadcrumb trail: aim at the furthest-along point (toward the
  // leader, a followGap short of it) this cop can see in a straight line. Every trail
  // point was physically driven, so the route is always drivable. Null if nothing
  // visible (caller keeps its own target).
  _convoyTarget(cop, leader) {
    const trail = leader._trail;
    if (!trail || trail.length < 2) return null;
    const head = trail[trail.length - 1];
    for (let k = trail.length - 1; k >= 0; k--) {
      const p = trail[k];
      if (Phaser.Math.Distance.Between(p.x, p.y, head.x, head.y) < this.followGap) continue;
      if (segmentClear(cop.sprite.x, cop.sprite.y, p.x, p.y, this.rects)) return { x: p.x, y: p.y };
    }
    return null;
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

  _copsSee(a, b) {
    return !this.rects || segmentClear(a.sprite.x, a.sprite.y, b.sprite.x, b.sprite.y, this.rects);
  }

  // How far ahead(+) / behind(-) a cop is along the player's heading.
  _along(cop, px, py, h) {
    return (cop.sprite.x - px) * Math.cos(h) + (cop.sprite.y - py) * Math.sin(h);
  }

  // Player travel direction — velocity when moving, facing when ~stationary.
  _heading(playerCar) {
    return playerCar.getSpeed() > 40
      ? Math.atan2(playerCar.vy, playerCar.vx)
      : playerCar.facing;
  }
}
