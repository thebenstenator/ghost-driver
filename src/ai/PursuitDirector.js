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

    // --- Box (sandwich) event ---
    this.boxTriggerSpeed = 150;  // player speed (px/s) below which a box is worth setting up
    this.boxReleaseSpeed = 260;  // player must exceed this to break the box (hysteresis)
    this.boxPinDist      = 90;   // a cop this close to the player counts as "pinning" (also triggers)
    this.boxEngageRange  = 520;  // only cops within this of the player take box slots
    this.boxHold         = 0.8;  // s the box persists after the trigger clears (anti-flicker)
    this.boxAhead        = 110;  // px ahead of the player the front cop cuts to
    this.boxBehind       = 70;   // px behind the player the rear cop tucks to
    this.boxHysteresis   = 60;   // px of along-heading advantage a challenger needs to steal the
                                 // front/rear slot from the current holder — stops two side-by-side
                                 // boxers rapidly swapping slots (and swinging their targets ±180px)
    this._boxTimer       = 0;    // > 0 while boxing (counts down when the trigger is absent)
    this._frontCop       = null; // current box slot holders (sticky, see _pickBoxers)
    this._rearCop        = null;

    // --- Convoy relay (how a blind cop reaches the player) ---
    this.convoyEnabled   = true;
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

    // How each cop reaches the player (visibility chain) — computed first so a CONVOY
    // cop can override its target with the leader's trail.
    this._assignConvoy(cops, px, py, dt);

    // Event: do we sandwich the player this frame, and if so, who blocks?
    const boxing = this._updateBox(cops, playerCar, px, py, dt);
    let frontCop = null, rearCop = null;
    if (boxing) ({ frontCop, rearCop } = this._pickBoxers(cops, px, py, h));

    for (const cop of cops) {
      let target;
      if (cop === frontCop) {
        cop.role = CopState.BOX_FRONT;
        target = this._clearTarget(px, py, { x: px + Math.cos(h) * this.boxAhead, y: py + Math.sin(h) * this.boxAhead });
      } else if (cop === rearCop) {
        cop.role = CopState.BOX_REAR;
        target = this._clearTarget(px, py, { x: px - Math.cos(h) * this.boxBehind, y: py - Math.sin(h) * this.boxBehind });
      } else {
        cop.role = CopState.PURSUE;
        target = { x: px, y: py };           // everyone just chases the player's real position
      }

      // CONVOY override: a blind cop relays toward a teammate's drivable trail rather
      // than pathing on its own. Keeps its box/pursue intent for when it regains sight.
      if (cop.pursuitMode === 'CONVOY' && cop.convoyLeader) {
        const ct = this._convoyTarget(cop, cop.convoyLeader);
        if (ct) target = ct;
      }
      cop.dirTarget = target;
    }
  }

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

  // Front = the near cop most ahead along the player's heading; rear = the one most
  // behind. Slots are STICKY: the current holder keeps its slot unless a challenger
  // beats its along-projection by boxHysteresis, so two side-by-side boxers don't
  // rapid-swap front/rear (which swung their targets ±180px each flip).
  _pickBoxers(cops, px, py, h) {
    const near  = cops.filter(c => this._dist(c, px, py) <= this.boxEngageRange);
    const along = c => this._along(c, px, py, h);
    if (near.length === 0) { this._frontCop = this._rearCop = null; return { frontCop: null, rearCop: null }; }

    // Best raw candidates this frame.
    let bestFront = near[0], bestRear = near[0];
    for (const c of near) {
      if (along(c) > along(bestFront)) bestFront = c;
      if (along(c) < along(bestRear))  bestRear  = c;
    }
    // Keep the current holder if it's still near; only yield on a clear margin.
    let frontCop = near.includes(this._frontCop) ? this._frontCop : bestFront;
    let rearCop  = near.includes(this._rearCop)  ? this._rearCop  : bestRear;
    if (bestFront !== frontCop && along(bestFront) > along(frontCop) + this.boxHysteresis) frontCop = bestFront;
    if (bestRear  !== rearCop  && along(bestRear)  < along(rearCop)  - this.boxHysteresis) rearCop  = bestRear;
    if (frontCop === rearCop) rearCop = null; // only one distinct near cop — no rear block

    this._frontCop = frontCop; this._rearCop = rearCop;
    return { frontCop, rearCop };
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
